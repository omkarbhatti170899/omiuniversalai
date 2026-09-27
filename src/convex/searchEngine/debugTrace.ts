/**
 * Search debug mode — the record of WHY an answer looks the way it does.
 *
 * Debugging search quality from the outside is guesswork: a user sees a wrong
 * answer and cannot tell whether the classifier mislabelled the question, the
 * engine returned nothing, the ranker preferred a stale source, or the gates
 * dropped good evidence. This trace answers that question directly.
 *
 * It records, per research request:
 *   query, intent, freshness requirement AND the reasons for it, which
 *   providers were searched, which sources were selected, each source's date,
 *   latency, result counts, REJECTED stale results with reasons, the final
 *   sources, and the verification/confidence state.
 *
 * SAFETY: this is an INTERNAL diagnostic. It is never returned to a user
 * surface and never contains provider keys, env values, raw upstream bodies or
 * personal data — only queries, domains, dates, counts and reasons. The
 * assertions at the bottom of this file are the contract that keeps it that
 * way, and they are unit-tested.
 */

import type { WebCitation } from "../searchProviders/types";
import { domainOf } from "./quality";
import { ageInDays, relativeAge } from "./freshness";
import type { CurrentIntent } from "./intent";
import type { ValidationReport } from "./validation";
import type { CrossCheckReport } from "./crossCheck";

export type SourceDecision = {
  url: string;
  domain: string;
  title: string;
  /** Human age, e.g. "3 days ago", or "date not shown by the source". */
  age: string;
  publishedAt?: string;
  /** Kept as evidence, or dropped, and why. */
  selected: boolean;
  reason: string;
  score?: number;
};

export type SearchDebugTrace = {
  query: string;
  intent: string | undefined;
  requiresFreshness: boolean;
  /** Why freshness was or was not required — the part that was previously invisible. */
  freshnessReasons: string[];
  vertical: string;
  liveData: string | null;
  askedYears: number[];
  askedEvent: string | null;
  providersSearched: string[];
  providersFailed: string[];
  rawCount: number;
  dedupedCount: number;
  /** Every source and what happened to it, including the ones dropped. */
  sources: SourceDecision[];
  selectedCount: number;
  /** Sources dropped for being stale / wrong-year / undated. */
  rejectedStaleCount: number;
  rejectedStale: Array<{ domain: string; url: string; reason: string; ageDays: number | null }>;
  independentDomains: number;
  searchMs: number;
  totalMs: number;
  conflicts: string[];
  verification: {
    verdict: string;
    passRate: number;
    failedChecks: string[];
    unverifiable: string[];
  };
};

export type TraceInput = {
  query: string;
  intent?: string;
  classified: CurrentIntent;
  providersSearched: string[];
  providersFailed?: string[];
  rawCount: number;
  dedupedCount: number;
  /** Ranked, pre-gate candidates with their temporal verdicts already applied. */
  candidates: Array<{ citation: WebCitation; selected: boolean; reason: string; score?: number }>;
  maxAgeDays: number;
  crossCheck?: CrossCheckReport;
  validation: ValidationReport;
  searchMs: number;
  totalMs: number;
  now?: number;
};

/** Build the trace. Pure — no clock read beyond the injected `now`. */
export function buildSearchTrace(input: TraceInput): SearchDebugTrace {
  const now = input.now ?? Date.now();

  const sources: SourceDecision[] = input.candidates.map(({ citation, selected, reason, score }) => ({
    url: citation.url,
    domain: domainOf(citation.url),
    title: citation.title,
    age: relativeAge(citation.publishedAt, now),
    publishedAt: citation.publishedAt,
    selected,
    reason,
    score,
  }));

  // "Stale" for debugging means "dropped for a time or year reason" — that is
  // the bucket an engineer actually needs to inspect after a bad answer.
  const rejectedStale = input.candidates
    .filter(({ selected, reason }) => !selected && /stale|wrong year|older than|undated|different year/i.test(reason))
    .map(({ citation, reason }) => ({
      domain: domainOf(citation.url),
      url: citation.url,
      reason,
      ageDays: ageInDays(citation.publishedAt, now),
    }));

  return {
    query: input.query,
    intent: input.intent,
    requiresFreshness: input.classified.requiresFreshness,
    freshnessReasons: input.classified.reasons,
    vertical: input.classified.vertical,
    liveData: input.classified.liveData,
    askedYears: input.classified.years,
    askedEvent: input.classified.event,
    providersSearched: input.providersSearched,
    providersFailed: input.providersFailed ?? [],
    rawCount: input.rawCount,
    dedupedCount: input.dedupedCount,
    sources,
    selectedCount: input.candidates.filter((c) => c.selected).length,
    rejectedStaleCount: rejectedStale.length,
    rejectedStale,
    independentDomains: new Set(input.candidates.filter((c) => c.selected).map((c) => domainOf(c.citation.url))).size,
    searchMs: input.searchMs,
    totalMs: input.totalMs,
    conflicts: (input.crossCheck?.conflicts ?? []).map((c) => `${c.metric}: ${c.readings.map((r) => `${r.value} (${r.domain})`).join(" vs ")}`),
    verification: {
      verdict: input.validation.verdict,
      passRate: Number(input.validation.passRate.toFixed(3)),
      failedChecks: input.validation.checks.filter((c) => !c.passed).map((c) => c.id),
      unverifiable: input.validation.unverifiable,
    },
  };
}

/** Keys that must never appear in a trace, whatever a caller passes in. */
const FORBIDDEN_TRACE_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "authorization",
  "env",
  "processEnv",
  "rawBody",
  "userId",
  "email",
];

/**
 * Safety contract: a trace is safe to log or return to an internal caller
 * only if it carries no credential-shaped or personal field. Exported so the
 * test suite can assert it, rather than trusting a comment.
 */
export function assertTraceIsSafe(trace: SearchDebugTrace): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_TRACE_KEYS.some((f) => lower.includes(f))) {
        found.push(`${path}.${key}`);
        continue;
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(trace, "trace");
  return found;
}

/** A one-line human summary for an internal log, never for a user surface. */
export function summarizeTrace(trace: SearchDebugTrace): string {
  return (
    `[search] "${trace.query}" intent=${trace.intent ?? "-"} fresh=${trace.requiresFreshness} ` +
    `vertical=${trace.vertical} years=${trace.askedYears.join("/") || "-"} ` +
    `raw=${trace.rawCount} kept=${trace.selectedCount} stale-rejected=${trace.rejectedStaleCount} ` +
    `domains=${trace.independentDomains} conflicts=${trace.conflicts.length} ` +
    `verdict=${trace.verification.verdict} searchMs=${trace.searchMs} totalMs=${trace.totalMs}`
  );
}
