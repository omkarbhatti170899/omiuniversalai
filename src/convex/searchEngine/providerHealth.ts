/**
 * PROVIDER HEALTH — measured, not assumed.
 * =========================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The search layer used to have exactly two kinds of provider: things that
 * worked, and a hardcoded `true`. The DuckDuckGo provider reported itself
 * configured while every request returned an HTTP 202 bot challenge with zero
 * results. That is the failure this module exists to prevent: **a provider
 * being in the registry is not evidence that it works, and a provider being
 * slow is not evidence that it is broken.** Both are measurements.
 *
 * The circuit breaker in `resilience.ts` already answers "should I call this
 * provider right now?". This module answers the different and slower question:
 * "how is this provider actually performing, and should it keep its slot?".
 *
 * WHAT IS MEASURED (runtime)
 *   • availability      — share of calls that returned successfully
 *   • latency           — p50/p95 wall-clock, not an average (averages hide the
 *                         timeouts that matter)
 *   • timeout rate      — calls that hit the budget
 *   • error rate        — calls that failed for any other reason
 *   • result count      — mean results actually returned, not requested
 *   • freshness quality — share of results carrying a usable publication date
 *   • duplicate rate    — share of results whose URL was already seen this turn
 *                         (a high rate means the provider is echoing others and
 *                         contributes no independent corroboration)
 *
 * WHAT IS DECLARED (static, per provider, in PROVIDER_FACTS below)
 *   • API cost, usage/licence status, language coverage
 *
 * HONEST LIMITATION
 * -----------------
 * State is per server isolate, like the circuit breaker. Convex instances are
 * ephemeral and independently scheduled, so these numbers are a rolling window
 * of THIS isolate, not a fleet-wide truth. They are good enough to demote a
 * degrading provider and are honest about being a sample. Making them global
 * means persisting them, which is a deliberate later step, not a silent
 * assumption.
 */

/** Rolling window per provider. Small and in-memory by design. */
const WINDOW = 20;

export type ProviderObservation = {
  ok: boolean;
  timedOut: boolean;
  latencyMs: number;
  results: number;
  datedResults: number;
  duplicates: number;
  /** Mean final score of the results this provider contributed (0 when none,
   * or when the caller did not score them). Lets the health surface answer
   * "which provider returns SIGNAL, not just volume" — a provider that
   * answers fast with off-topic noise should rank below a slower one whose
   * results survive the gates. */
  relevanceScore?: number;
  /** When the call finished. Defaults to now if omitted. */
  at?: number;
};

export type ProviderHealth = {
  providerId: string;
  calls: number;
  successes: number;
  timeouts: number;
  errors: number;
  /** 0..1 */
  availability: number;
  /** 0..1 */
  timeoutRate: number;
  /** 0..1 */
  errorRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  avgResults: number;
  /** 0..1 — share of results that carried a publication date */
  freshnessQuality: number;
  /** 0..1 — share of results that duplicated another provider's URL */
  duplicateRate: number;
  /** Mean final ranking score this provider's results earned (0 when the
   * caller did not score them). "Which provider returns signal?" */
  relevanceAvg: number;
  lastOkAt: number | null;
  lastError: string | null;
};

type Bucket = { obs: ProviderObservation[] };

const buckets = new Map<string, Bucket>();

function bucketFor(id: string): Bucket {
  let b = buckets.get(id);
  if (!b) {
    b = { obs: [] };
    buckets.set(id, b);
  }
  return b;
}

/** Record one provider call's outcome. Cheap; never throws. */
export function recordProviderObservation(
  providerId: string,
  obs: ProviderObservation,
): void {
  try {
    const b = bucketFor(providerId);
    b.obs.push(obs);
    if (b.obs.length > WINDOW) b.obs.splice(0, b.obs.length - WINDOW);
  } catch {
    // Telemetry must never break a search.
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function rate(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 1000;
}

export function providerHealth(providerId: string): ProviderHealth | null {
  const b = buckets.get(providerId);
  if (!b || b.obs.length === 0) return null;
  // The write path is guarded, but a malformed entry would still poison every
  // READ — and the read path is exposed on /status, where a throw would break
  // the diagnostic surface. Filter defensively rather than trust the writer.
  const obs = b.obs.filter(
    (o): o is ProviderObservation =>
      Boolean(o) && typeof o.latencyMs === "number" && typeof o.ok === "boolean",
  );
  if (obs.length === 0) return null;
  const calls = obs.length;
  const successes = obs.filter((o) => o.ok).length;
  const timeouts = obs.filter((o) => o.timedOut).length;
  const errors = calls - successes;
  const latencies = obs.map((o) => o.latencyMs).sort((a, b2) => a - b2);
  const totalResults = obs.reduce((s, o) => s + o.results, 0);
  const totalDated = obs.reduce((s, o) => s + o.datedResults, 0);
  const totalDupes = obs.reduce((s, o) => s + o.duplicates, 0);
  // Relevance: mean over RESULTS (not calls), so a provider contributing one
  // high-signal result is not diluted by many empty-but-fast calls.
  const scored = obs.filter((o) => typeof o.relevanceScore === "number" && o.results > 0);
  const totalScored = scored.reduce((s, o) => s + o.results, 0);
  const relevanceSum = scored.reduce((s, o) => s + (o.relevanceScore ?? 0) * o.results, 0);
  const lastOk = [...obs].reverse().find((o) => o.ok);
  const lastBad = [...obs].reverse().find((o) => !o.ok);

  return {
    providerId,
    calls,
    successes,
    timeouts,
    errors,
    availability: rate(successes, calls),
    timeoutRate: rate(timeouts, calls),
    errorRate: rate(errors, calls),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    avgResults: Math.round((totalResults / calls) * 10) / 10,
    freshnessQuality: rate(totalDated, totalResults),
    duplicateRate: rate(totalDupes, totalResults),
    relevanceAvg: totalScored === 0 ? 0 : Math.round((relevanceSum / totalScored) * 100) / 100,
    lastOkAt: lastOk ? (lastOk.at ?? Date.now()) : null,
    lastError: lastBad ? "recent failure observed" : null,
  };
}

export function allProviderHealth(): ProviderHealth[] {
  return [...buckets.keys()].map((id) => providerHealth(id)!).filter(Boolean);
}

/** Test/reset hook. Exposed so health state cannot leak between tests. */
export function resetProviderHealth(): void {
  buckets.clear();
}

// --- Static, declared facts -------------------------------------------------

export type ProviderFacts = {
  id: string;
  /** What it costs per query. "$0" is a claim and must stay true. */
  apiCost: string;
  /** The licence/permission the results are used under. */
  usageLicense: string;
  /** Languages the index actually covers. */
  languageCoverage: string;
  /** Does the provider return publication dates at all? */
  returnsTimestamps: boolean;
  /** Is it an independent index, or a proxy for someone else's? */
  independentIndex: boolean;
};

export const PROVIDER_FACTS: Record<string, ProviderFacts> = {
  searxng: {
    id: "searxng",
    apiCost: "$0 (self-hosted)",
    usageLicense: "AGPL software; depends on the enabled engine list",
    languageCoverage: "Multilingual, bounded by enabled engines",
    returnsTimestamps: true,
    independentIndex: false, // metasearch — bounded by its weakest engine
  },
  mwmbl: {
    id: "mwmbl",
    apiCost: "$0 (no key)",
    usageLicense:
      "Official public API (SearXNG declares use_official_api, no key). " +
      "Service is AGPL/open; commercial use of the SERVICE not explicitly granted — confirm before scale.",
    languageCoverage: "English only",
    // MEASURED 2026-09-27 against the live API: the response contains only
    // url, title, extract, source. There is NO date field of any kind. Mwmbl
    // therefore cannot serve a freshness-gated question, and is excluded from
    // every freshness tier in the product.
    returnsTimestamps: false,
    independentIndex: true,
  },
  "duckduckgo-instant": {
    id: "duckduckgo-instant",
    apiCost: "$0 (keyless, official)",
    usageLicense:
      "Official documented API (api.duckduckgo.com). Permitted. DuckDuckGo " +
      "asks for attribution.",
    languageCoverage: "Multi-language entities, EN-centric",
    // MEASURED 2026-09-27: Instant Answers carry no publication date.
    returnsTimestamps: false,
    // Not a web index at all — it serves encyclopedia-style entities.
    independentIndex: false,
  },
  gdelt: {
    id: "gdelt",
    apiCost: "$0",
    usageLicense: "Open data, no key",
    languageCoverage: "Multilingual global news",
    returnsTimestamps: true,
    independentIndex: true,
  },
  "wikipedia-current-events": {
    id: "wikipedia-current-events",
    apiCost: "$0",
    usageLicense: "CC BY-SA, attribution required",
    languageCoverage: "Multilingual",
    returnsTimestamps: true,
    independentIndex: true,
  },
};
