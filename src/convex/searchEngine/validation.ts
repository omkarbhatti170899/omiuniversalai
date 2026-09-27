/**
 * Pre-answer validation gate.
 *
 * SEVEN CHECKS, ONE VERDICT
 * -------------------------
 * The report was explicit that Omi must verify, before answering a current
 * question, that the evidence is any good. Retrieval succeeding is not the
 * same as being able to answer, and a confident answer over weak evidence is
 * the failure mode this gate exists to stop.
 *
 * The checks, each independently falsifiable:
 *   1. RELEVANCE   — does any source actually address the question?
 *   2. YEAR        — is it about the year that was asked about?
 *   3. EVENT       — is it about the right event?
 *   4. RECENCY     — is it recent enough to be evidence for "current"?
 *   5. AUTHORITY   — is it a primary/reputable source?
 *   6. CORROBORATION — does an independent source agree?
 *   7. TIMESTAMPED — does it carry a date at all?
 *
 * The verdict is deliberately conservative and NEVER "confident" by default:
 *   "answer"        — all critical checks passed.
 *   "answer-caveated" — usable, but the failed checks must be shown.
 *   "refuse"        — a CRITICAL check failed (wrong year, nothing relevant,
 *                     or nothing fresh). Omi says it could not verify instead
 *                     of filling the gap from model memory.
 *
 * PURE and deterministic. No network, `now`-injectable.
 */

import type { WebCitation } from "../searchProviders/types";
import { domainOf, sourceTier, directnessScore, keywordSet } from "./quality";
import { matchTemporal } from "./temporal";
import { ageInDays } from "./freshness";
import type { CrossCheckReport } from "./crossCheck";

export type CheckId =
  | "relevance"
  | "year"
  | "event"
  | "recency"
  | "authority"
  | "corroboration"
  | "timestamp";

export type CheckResult = {
  id: CheckId;
  passed: boolean;
  /** True when failing this check alone forbids a confident answer. */
  critical: boolean;
  detail: string;
};

export type ValidationVerdict = "answer" | "answer-caveated" | "refuse";

export type ValidationReport = {
  verdict: ValidationVerdict;
  checks: CheckResult[];
  /** Plain-language statements of what could NOT be verified. */
  unverifiable: string[];
  /** How many sources carried a usable date. */
  datedSources: number;
  /** Distinct domains behind the usable evidence. */
  independentDomains: number;
  /** Fraction of checks passed, 0..1 — a confidence proxy, never a certainty. */
  passRate: number;
};

export type ValidationInput = {
  query: string;
  citations: WebCitation[];
  askedYears: number[];
  askedEvent: string | null;
  maxAgeDays: number;
  crossCheck?: CrossCheckReport;
  now?: number;
};

/**
 * Run the seven checks over the evidence actually retrieved.
 *
 * `freshestOnly` semantics are applied by the CALLER (the chat turn passes the
 * already-freshness-filtered set); this module judges what it is given and
 * never widens the pool.
 */
export function validateEvidence(input: ValidationInput): ValidationReport {
  const now = input.now ?? Date.now();
  const { citations, query, askedYears, askedEvent, maxAgeDays } = input;
  const keywords = keywordSet(query);
  const checks: CheckResult[] = [];
  const unverifiable: string[] = [];

  // 1. RELEVANCE / DIRECTNESS — does anything here address the question?
  //
  // The floor is higher than it looks, because a live provider will return
  // *something* for almost any query. Keyword overlap plus "contains a number"
  // is not evidence of relevance when the engine is guessing — it is how a
  // question about the Asian Games ends up answered with a basketball
  // scoreline that happens to contain a year and a digit.
  const directScores = citations.map((c) => directnessScore(c, keywords));
  const bestDirect = directScores.length > 0 ? Math.max(...directScores) : 0;
  const relevanceOk = citations.length > 0 && bestDirect >= 0.4;
  checks.push({
    id: "relevance",
    passed: relevanceOk,
    critical: true,
    detail: relevanceOk
      ? `best source scores ${bestDirect.toFixed(2)} on directness`
      : "no retrieved source directly addresses the question",
  });
  if (!relevanceOk) unverifiable.push("No source clearly answers the question as asked.");

  // 2. YEAR — is it about the year asked about?
  if (askedYears.length > 0) {
    const verdicts = citations.map((c) => matchTemporal(c, askedYears, null).verdict);
    const wrongYear = verdicts.filter((v) => v === "wrong-year").length;
    const matched = verdicts.filter((v) => v === "match").length;
    const yearOk = matched > 0;
    checks.push({
      id: "year",
      passed: yearOk,
      critical: true,
      detail: yearOk
        ? `${matched} source(s) explicitly cover ${askedYears.join("/")}`
        : wrongYear > 0
          ? `every dated source is about a different year (${wrongYear} mismatched)`
          : "no source states which year it covers",
    });
    if (!yearOk) {
      unverifiable.push(
        `No source confirms coverage of ${askedYears.join("/")}; anything available may describe a different year.`,
      );
    }
  }

  // 3. EVENT — is it the right event?
  //
  // CRITICAL, because a live provider will cheerfully answer a question it
  // does not understand. Measured live: a query about the ASIAN GAMES 2026
  // medal tally was served Japanese B1 League basketball scorelines from the
  // sports feed. Every one was "published just now", so recency, recency-
  // weighted ranking and even the year check all passed — the only signal
  // that caught it was that NO source mentioned the Asian Games. A check that
  // detects the wrong answer but does not block it is decoration.
  if (askedEvent) {
    const verdicts = citations.map((c) => matchTemporal(c, [], askedEvent).verdict);
    const matched = verdicts.filter((v) => v === "match").length;
    const eventOk = matched > 0;
    checks.push({
      id: "event",
      passed: eventOk,
      critical: true,
      detail: eventOk
        ? `${matched} source(s) cover the "${askedEvent}"`
        : `no source names the "${askedEvent}" — the results are about something else`,
    });
    if (!eventOk) {
      unverifiable.push(
        `None of the results cover the "${askedEvent}" — they appear to be about a different event.`,
      );
    }
  }

  // 4. RECENCY — fresh enough to be evidence for a current question?
  const ages = citations.map((c) => ageInDays(c.publishedAt, now));
  const datedAges = ages.filter((a): a is number => a !== null);
  const freshEnough = datedAges.length > 0 && datedAges.some((a) => a <= maxAgeDays);
  checks.push({
    id: "recency",
    passed: freshEnough,
    critical: true,
    detail: freshEnough
      ? `at least one source is within ${maxAgeDays} day(s)`
      : datedAges.length > 0
        ? `every dated source is older than ${maxAgeDays} day(s)`
        : "no source carries a date, so recency is unverifiable",
  });
  if (!freshEnough) {
    unverifiable.push("No source recent enough to speak to the current situation was found.");
  }

  // 5. AUTHORITY — is at least one source primary or reputable?
  const bestTierWeight = citations.reduce((best, c) => Math.max(best, sourceTier(c.url).weight), 0);
  const authorityOk = bestTierWeight >= 0.85; // official / academic / reference / news
  checks.push({
    id: "authority",
    passed: authorityOk,
    critical: false,
    detail: authorityOk
      ? `best source tier weight ${bestTierWeight.toFixed(2)}`
      : "no primary or reputable source among the results",
  });
  if (!authorityOk) unverifiable.push("No primary or reputable source was found.");

  // 6. CORROBORATION — does an independent source agree?
  const domains = new Set(citations.map((c) => domainOf(c.url)));
  const corroborated = domains.size >= 2;
  checks.push({
    id: "corroboration",
    passed: corroborated,
    critical: false,
    detail: corroborated
      ? `${domains.size} independent domains`
      : domains.size === 1
        ? "only 1 domain in the result set"
        : "no sources were retrieved at all",
  });
  if (!corroborated) {
    unverifiable.push(
      domains.size === 1
        ? "Only one source is available, so this is unconfirmed."
        : "No sources were retrieved, so there is nothing to corroborate.",
    );
  }

  // 7. TIMESTAMPED — is the evidence dated at all?
  const datedSources = datedAges.length;
  checks.push({
    id: "timestamp",
    passed: datedSources > 0,
    critical: false,
    detail:
      datedSources > 0
        ? `${datedSources}/${citations.length} source(s) carry a date`
        : "no source carries a publication date",
  });
  if (datedSources === 0) {
    unverifiable.push("None of the sources showed a date, so their currency is unknown.");
  }

  // Cross-source disagreement is a validation failure in its own right: even a
  // fully-dated, high-authority set cannot be answered confidently when its
  // members contradict each other.
  if (input.crossCheck && input.crossCheck.conflicts.length > 0) {
    unverifiable.push(
      `Sources disagree: ${input.crossCheck.conflicts.map((c) => c.metric).join(", ")}.`,
    );
  }

  const criticalFailures = checks.filter((c) => c.critical && !c.passed);
  const hasConflict = (input.crossCheck?.conflicts.length ?? 0) > 0;
  const passRate = checks.length === 0 ? 0 : checks.filter((c) => c.passed).length / checks.length;

  let verdict: ValidationVerdict;
  if (criticalFailures.length > 0) {
    verdict = "refuse";
  } else if (hasConflict || unverifiable.length > 0) {
    verdict = "answer-caveated";
  } else {
    verdict = "answer";
  }

  return {
    verdict,
    checks,
    unverifiable,
    datedSources,
    independentDomains: domains.size,
    passRate,
  };
}

/**
 * The user-facing refusal. It names what was checked, states plainly that the
 * answer is NOT being supplied, and never dresses a model-memory guess up as a
 * finding — which is the exact behaviour the report asked us to eliminate.
 */
export function cannotVerifyMessage(
  query: string,
  report: ValidationReport,
): string {
  // When nothing was retrieved at all, listing seven failed checks is noise.
  // One clear statement of the outage is more useful than a wall of reasons.
  if (report.datedSources === 0 && report.independentDomains === 0) {
    return (
      `I could not find any live sources for "${query.trim()}", so I can't verify a current answer.\n\n` +
      "I am deliberately not filling this in from my training data — my knowledge has a cutoff and is not a live feed, " +
      "so a figure I recalled could easily be out of date, and a plausible-looking but unverified number is worse than none. " +
      "Press Retry Search, or switch a search provider in Settings."
    );
  }
  const head = `I could not verify a current, reliable answer to "${query.trim()}".`;
  const why = report.unverifiable.length > 0
    ? `Specifically: ${report.unverifiable.join(" ")}`
    : "Specifically: the available sources did not survive verification.";
  return (
    `${head} ${why}\n\n` +
    "I am deliberately not filling this in from my training data — my knowledge has a cutoff and is not a live feed, so a number I " +
    "recalled could easily be out of date, and a plausible-looking but unverified figure is worse than no figure. " +
    "Try narrowing it (name the specific event, team, pair or date), or press Retry Search."
  );
}
