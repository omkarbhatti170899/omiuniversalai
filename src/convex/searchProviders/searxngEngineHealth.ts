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

type EngineState = {
  failures: number;
  suspendedUntil: number | null;
  lastError: string | null;
  lastOkAt: number | null;
};

const engines = new Map<string, EngineState>();

function stateFor(engine: string): EngineState {
  let s = engines.get(engine);
  if (!s) {
    s = { failures: 0, suspendedUntil: null, lastError: null, lastOkAt: null };
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
  s.lastError = String(reason ?? "unresponsive").slice(0, 120);
  if (s.failures >= ENGINE_FAILURE_THRESHOLD) s.suspendedUntil = now + ENGINE_COOLDOWN_MS;
}

/** Record that `engine` contributed results — clears its failure history. */
export function recordSearxEngineResponsive(engine: string, now = Date.now()): void {
  const id = normalizeEngineName(engine);
  if (!id) return;
  const s = stateFor(id);
  s.failures = 0;
  s.suspendedUntil = null;
  s.lastError = null;
  s.lastOkAt = now;
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
    for (const e of responsive) recordSearxEngineResponsive(e, now);
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

/** Read-only snapshot for the diagnostics/status surface. */
export function searxEngineHealthSnapshot(
  now = Date.now(),
): Array<{ engine: string; failures: number; suspended: boolean; lastError: string | null; lastOkAt: number | null }> {
  return [...engines.entries()]
    .map(([engine, s]) => ({
      engine,
      failures: s.failures,
      suspended: s.suspendedUntil !== null && now < s.suspendedUntil,
      lastError: s.lastError,
      lastOkAt: s.lastOkAt,
    }))
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
