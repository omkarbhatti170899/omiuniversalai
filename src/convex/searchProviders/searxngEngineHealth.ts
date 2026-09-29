/**
 * SEARXNG UPSTREAM-ENGINE HEALTH — "do not keep calling an engine that is down".
 * =============================================================================
 *
 * SearXNG is a metasearch FRONT for a dozen upstream engines (google, bing,
 * duckduckgo, yandex, brave, startpage, …). Each of those can be slow, rate
 * limited, CAPTCHA'd or suspended independently, and the instance reports that
 * honestly in every JSON response:
 *
 *   { "results": [...], "unresponsive_engines": [["duckduckgo", "timeout"], …] }
 *
 * MEASURED DEFECT this module closes: the adapter ignored that field entirely.
 * A response naming a suspended engine was treated as an ordinary success, so
 * every later request re-asked the same dead engine and re-waited for its
 * timeout — and the provider's measured p95 climbed toward the 46 s the
 * diagnostic recorded. Retrying a permanently-failing engine is not resilience;
 * it is a latency tax with no upside.
 *
 * WHAT THIS DOES (and deliberately does NOT do)
 *   • Records which engines answered and which did not, per call, from the
 *     instance's own report — so "duckduckgo is suspended" becomes a fact with
 *     a timestamp rather than an inference from latency.
 *   • Suspends an engine here after it fails repeatedly, for a cooldown, so a
 *     genuinely dead engine stops costing us time.
 *   • Exposes the suspended set so the adapter can SCOPE the next request to
 *     the healthy engines using SearXNG's documented `!engine` search syntax.
 *   • Does NOT change which engines the INSTANCE runs. That is server-side
 *     configuration; this is strictly a client-side "stop asking the thing that
 *     keeps failing" policy, and it is fail-open: if a scoped request returns
 *     nothing, the adapter retries unscoped rather than returning an empty set.
 *
 * State is per server isolate, like the circuit breaker, and is documented as
 * such rather than presented as fleet-wide truth.
 */

/** Failures before an engine is suspended. Two, because one flake is common. */
export const ENGINE_FAILURE_THRESHOLD = 2;
/** How long a suspended engine stays out of the request. */
export const ENGINE_COOLDOWN_MS = 10 * 60_000;
/** Latency window kept per engine for the p50 (bounded, newest-wins). */
const LATENCY_WINDOW = 10;

type EngineState = {
  failures: number;
  /** Lifetime failure count — NEVER cleared by a success, so rates stay honest. */
  totalFailures: number;
  timeouts: number;
  successes: number;
  /** Wall-clock ms of the calls this engine answered, for the p50. */
  latencyMs: number[];
  /** Results this engine contributed across calls (avg = / successes). */
  resultsContributed: number;
  /** Of those, how many carried a publication date (freshness share). */
  datedResults: number;
  suspendedUntil: number | null;
  lastError: string | null;
  lastOkAt: number | null;
  lastFailAt: number | null;
};

const engines = new Map<string, EngineState>();

function stateFor(engine: string): EngineState {
  let s = engines.get(engine);
  if (!s) {
    s = {
      failures: 0,
      totalFailures: 0,
      timeouts: 0,
      successes: 0,
      latencyMs: [],
      resultsContributed: 0,
      datedResults: 0,
      suspendedUntil: null,
      lastError: null,
      lastOkAt: null,
      lastFailAt: null,
    };
    engines.set(engine, s);
  }
  return s;
}

/** Normalise the many spellings an instance may use for one engine. */
export function normalizeEngineName(name: string): string {
  return String(name ?? "").trim().toLowerCase();
}

/**
 * Record that the instance reported `engine` as unresponsive (timeout, 4xx,
 * CAPTCHA, rate limit …). After `ENGINE_FAILURE_THRESHOLD` reports the engine
 * is suspended until the cooldown elapses.
 */
export function recordSearxEngineUnresponsive(
  engine: string,
  reason: string,
  now = Date.now(),
): void {
  const id = normalizeEngineName(engine);
  if (!id) return;
  const s = stateFor(id);
  // A suspension that has already expired counts as a fresh start, so a slow
  // engine gets a clean slate rather than accumulating failures forever.
  if (s.suspendedUntil !== null && now >= s.suspendedUntil) {
    s.suspendedUntil = null;
    s.failures = 0;
  }
  s.failures += 1;
  s.totalFailures += 1;
  if (/timeout/i.test(String(reason ?? ""))) s.timeouts += 1;
  s.lastError = String(reason ?? "unresponsive").slice(0, 120);
  s.lastFailAt = now;
  if (s.failures >= ENGINE_FAILURE_THRESHOLD) s.suspendedUntil = now + ENGINE_COOLDOWN_MS;
}

/**
 * Record that `engine` contributed results — clears its failure history.
 *
 * `stats` carries the measured per-call contribution: how many results the
 * engine produced and how many of those carried a publication date. They feed
 * the operator metrics (avg result count, freshness share) WITHOUT ever
 * touching the suspension policy — a low-yield engine is a quality signal,
 * not a failure.
 */
export function recordSearxEngineResponsive(
  engine: string,
  stats: { latencyMs?: number; results?: number; dated?: number } = {},
  now = Date.now(),
): void {
  const id = normalizeEngineName(engine);
  if (!id) return;
  const s = stateFor(id);
  s.failures = 0;
  s.suspendedUntil = null;
  s.lastError = null;
  s.lastOkAt = now;
  s.successes += 1;
  if (typeof stats.latencyMs === "number" && Number.isFinite(stats.latencyMs) && stats.latencyMs >= 0) {
    s.latencyMs.push(Math.round(stats.latencyMs));
    if (s.latencyMs.length > LATENCY_WINDOW) s.latencyMs.splice(0, s.latencyMs.length - LATENCY_WINDOW);
  }
  if (typeof stats.results === "number" && Number.isFinite(stats.results) && stats.results >= 0) {
    s.resultsContributed += stats.results;
    s.datedResults += Math.max(0, Math.min(stats.dated ?? 0, stats.results));
  }
}

/**
 * Apply one instance response to the registry.
 *
 * `unresponsive` is SearXNG's `unresponsive_engines` — either `[[name, reason]]`
 * or `[name]`. `responsive` is the set of engines observed on returned results.
 * Unknown shapes are ignored rather than thrown on: telemetry must never be
 * able to fail a search.
 */
export function recordSearxResponse(
  unresponsive: unknown,
  responsive: Iterable<string>,
  stats: { latencyMs?: number; resultsByEngine?: Map<string, { results: number; dated: number }> } = {},
  now = Date.now(),
): void {
  try {
    if (Array.isArray(unresponsive)) {
      for (const entry of unresponsive) {
        if (typeof entry === "string") {
          recordSearxEngineUnresponsive(entry, "unresponsive", now);
        } else if (Array.isArray(entry)) {
          const [name, reason] = entry as [unknown, unknown];
          if (typeof name === "string") {
            recordSearxEngineUnresponsive(name, String(reason ?? "unresponsive"), now);
          }
        } else if (entry && typeof entry === "object") {
          const rec = entry as Record<string, unknown>;
          const name = rec.engine ?? rec.name;
          if (typeof name === "string") {
            recordSearxEngineUnresponsive(name, String(rec.reason ?? rec.error ?? "unresponsive"), now);
          }
        }
      }
    }
    for (const e of responsive) {
      const per = stats.resultsByEngine?.get(normalizeEngineName(e));
      recordSearxEngineResponsive(
        e,
        { latencyMs: stats.latencyMs, results: per?.results, dated: per?.dated },
        now,
      );
    }
  } catch {
    /* telemetry must never break a search */
  }
}

/** True when this engine is currently suspended and should not be asked for. */
export function searxEngineSuspended(engine: string, now = Date.now()): boolean {
  const s = engines.get(normalizeEngineName(engine));
  if (!s || s.suspendedUntil === null) return false;
  if (now >= s.suspendedUntil) return false;
  return true;
}

/** The currently suspended engine names, for scoping a request. */
export function suspendedSearxEngines(now = Date.now()): string[] {
  const out: string[] = [];
  for (const [id, s] of engines) {
    if (s.suspendedUntil !== null && now < s.suspendedUntil) out.push(id);
  }
  return out.sort();
}

/**
 * Read-only snapshot for the diagnostics/status surface — the eight metrics
 * the operator contract names, per engine:
 *   engine · success rate · timeout rate · latency (p50) · avg result count ·
 *   freshness (dated share) · last successful request · last failure
 * (+ suspended, which is the ACTION taken on the failure signals).
 */
export function searxEngineHealthSnapshot(
  now = Date.now(),
): Array<{
  engine: string;
  successes: number;
  failures: number;
  successRate: number;
  timeoutRate: number;
  latencyP50Ms: number | null;
  avgResults: number | null;
  freshnessShare: number | null;
  suspended: boolean;
  lastError: string | null;
  lastOkAt: number | null;
  lastFailAt: number | null;
}> {
  return [...engines.entries()]
    .map(([engine, s]) => {
      // Rates use the LIFETIME counters: the streak counters (`failures`) are
      // cleared by a success — that is the right suspension semantics, but it
      // would make a rate flip from 0% to 100% on one good call.
      const attempts = s.successes + s.totalFailures;
      const sortedLat = [...s.latencyMs].sort((a, b) => a - b);
      return {
        engine,
        successes: s.successes,
        failures: s.totalFailures,
        successRate: attempts > 0 ? Math.round((s.successes / attempts) * 100) / 100 : 0,
        timeoutRate:
          attempts > 0 ? Math.round((s.timeouts / attempts) * 100) / 100 : 0,
        latencyP50Ms: sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length / 2)] : null,
        avgResults:
          s.successes > 0 ? Math.round((s.resultsContributed / s.successes) * 10) / 10 : null,
        freshnessShare:
          s.resultsContributed > 0
            ? Math.round((s.datedResults / s.resultsContributed) * 100) / 100
            : null,
        suspended: s.suspendedUntil !== null && now < s.suspendedUntil,
        lastError: s.lastError,
        lastOkAt: s.lastOkAt,
        lastFailAt: s.lastFailAt,
      };
    })
    .sort((a, b) => Number(b.suspended) - Number(a.suspended) || b.failures - a.failures);
}

/** Test/reset hook — state must not leak between tests or between turns. */
export function resetSearxEngineHealth(): void {
  engines.clear();
}

/**
 * Build a SearXNG query SCOPED to a set of engines, using its documented `!`
 * engine-selection syntax (`!yandex paris`).
 *
 * Returns the query unchanged when there is nothing to scope by, so the caller
 * can use one code path and never accidentally send a bare bang.
 */
export function buildEngineScopedQuery(query: string, engineIds: string[]): string {
  const ids = [...new Set(engineIds.map(normalizeEngineName).filter((e) => e.length > 0))];
  if (ids.length === 0) return query;
  return `${ids.map((e) => `!${e}`).join(" ")} ${query}`;
}
