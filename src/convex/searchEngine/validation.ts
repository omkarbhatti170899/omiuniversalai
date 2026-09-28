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
  /**
   * The absolute timestamp of the NEWEST source, ISO. Required so the answer
   * can say "current as of <time>" rather than vaguely "recently" — a user
   * asking for a current figure needs to know how current it actually is.
   */
  newestSourceAt?: string;
  /** Age of that newest source, in hours, for display. */
  newestSourceAgeHours?: number;
};

export type ValidationInput = {
  query: string;
  citations: WebCitation[];
  askedYears: number[];
  askedEvent: string | null;
  maxAgeDays: number;
  /**
   * The freshness tier's target, in hours. When set, evidence older than this
   * is reported as unverifiable even if it falls inside `maxAgeDays`.
   */
  preferFreshHours?: number;
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
  const { citations, query, askedYears, askedEvent, maxAgeDays, preferFreshHours } = input;
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

  // 4. RECENCY — is the NEWEST evidence fresh enough for what was asked?
  //
  // The old check passed when ANY source fell inside the window. That is how a
  // 3-day-old article answered "give me India's LATEST medal tally": the set
  // contained one 3-day page and the check was satisfied by the mere existence
  // of a dated source. Recency is a property of the BEST evidence, not of the
  // set.
  const ages = citations.map((c) => ageInDays(c.publishedAt, now));
  const datedAges = ages.filter((a): a is number => a !== null);
  const newestDays = datedAges.length > 0 ? Math.min(...datedAges) : null;
  const freshEnough = newestDays !== null && newestDays <= maxAgeDays;
  // A "today" question must be answered by something from today, not merely
  // something inside a two-day bound.
  const meetsTierTarget = preferFreshHours === undefined || newestDays === null
    ? true
    : newestDays * 24 <= Math.max(preferFreshHours, 48);
  checks.push({
    id: "recency",
    passed: freshEnough && meetsTierTarget,
    critical: true,
    detail: freshEnough && meetsTierTarget
      ? `newest source is ${newestDays === null ? "?" : newestDays.toFixed(1)} day(s) old, within the ${maxAgeDays}-day window`
      : newestDays === null
        ? "no source carries a date, so recency is unverifiable"
        : meetsTierTarget
          ? `newest source is ${newestDays.toFixed(1)} day(s) old, outside the ${maxAgeDays}-day window`
          : `newest source is ${newestDays.toFixed(1)} day(s) old — too old for a question asking for current information`,
  });
  if (!freshEnough) {
    unverifiable.push("No source recent enough to speak to the current situation was found.");
  } else if (!meetsTierTarget) {
    unverifiable.push(
      `The newest source available is ${newestDays === null ? "?" : newestDays.toFixed(1)} days old, so this may not reflect today's situation.`,
    );
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
    newestSourceAt: newestIso(citations, now),
    newestSourceAgeHours: newestDays === null ? undefined : Number((newestDays * 24).toFixed(1)),
  };
}

/** Absolute ISO time of the newest dated source, or undefined. */
function newestIso(citations: WebCitation[], now: number): string | undefined {
  let best: { t: number; iso: string } | null = null;
  for (const c of citations) {
    if (!c.publishedAt) continue;
    const t = Date.parse(c.publishedAt);
    if (!Number.isFinite(t)) continue;
    // Ignore a far-future timestamp: it is a clock artefact, not freshness.
    if (t - now > 6 * 3_600_000) continue;
    if (!best || t > best.t) best = { t, iso: new Date(t).toISOString() };
  }
  return best?.iso;
}

/**
 * The user-facing refusal. It names what was checked, states plainly that the
 * answer is NOT being supplied, and never dresses a model-memory guess up as a
 * finding — which is the exact behaviour the report asked us to eliminate.
 */
export type MemoryProtectionDecision = {
  /** True when the answer must be replaced by the honest refusal text. */
  replace: boolean;
  /** Why the replacement fired — recorded to telemetry, shown nowhere. */
  reason: string;
};

/**
 * ENFORCED MEMORY PROTECTION (2026-09-28).
 *
 * Until now, "a current question with no verified evidence must not be answered
 * from model memory" lived only in the orchestrator note — i.e. it depended on
 * the model OBEYING the note. A disobedient, confused, or partially-streamed
 * model could still produce a confident, uncited, memory-flavoured answer to a
 * question we had just failed to verify.
 *
 * The contract is now enforced mechanically at the call site: when a current
 * turn ends with unverified evidence, anything the model produced that is NOT
 * itself the honest refusal is REPLACED by the refusal. No citation can rescue
 * the answer, because there are no sources to cite.
 */
export function enforceMemoryProtection(args: {
  /** The turn was a current-information turn with unverified evidence. */
  memoryProtected: boolean;
  /** The final answer text that is about to be shown to the user. */
  content: string;
}): MemoryProtectionDecision {
  const { memoryProtected, content } = args;
  if (!memoryProtected) return { replace: false, reason: "not required" };

  const text = content.trim();

  // Honest paths — already telling the truth, keep them.
  if (
    /^I could not verify/i.test(text) ||
    /^I could not find any live sources/i.test(text) ||
    /deliberately not filling this in from my training data/i.test(text)
  ) {
    return { replace: false, reason: "already an honest refusal" };
  }

  // The model produced SOMETHING for a question we could not verify. That is
  // precisely the memory answer the contract forbids — replace it.
  return {
    replace: true,
    reason: "current question with unverified evidence got a generated answer",
  };
}

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
