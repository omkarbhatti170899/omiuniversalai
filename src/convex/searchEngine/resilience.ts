/**
 * Resilience layer: engine circuit breaker, per-user rate limiting,
 * promise timeouts. State is per server isolate — a first line of
 * defense; documented in SEARCH_ENGINE.md.
 */

// --- Circuit breaker -------------------------------------------------------

type Breaker = { failures: number; openedAt: number | null };

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;
const breakers = new Map<string, Breaker>();

/** True when the engine may be called (closed or half-open). */
export function breakerAllow(engineId: string): boolean {
  const b = breakers.get(engineId);
  if (!b || b.openedAt === null) return true;
  if (Date.now() - b.openedAt >= COOLDOWN_MS) {
    // Half-open: allow a single probe; failure re-opens immediately.
    b.openedAt = null;
    b.failures = FAILURE_THRESHOLD - 1;
    return true;
  }
  return false;
}

export function breakerRecord(engineId: string, ok: boolean): void {
  const b = breakers.get(engineId) ?? { failures: 0, openedAt: null };
  if (ok) {
    b.failures = 0;
    b.openedAt = null;
  } else {
    b.failures += 1;
    if (b.failures >= FAILURE_THRESHOLD) b.openedAt = Date.now();
  }
  breakers.set(engineId, b);
}

export function breakerStatus(): Record<string, { open: boolean; failures: number }> {
  const out: Record<string, { open: boolean; failures: number }> = {};
  for (const [id, b] of breakers) {
    out[id] = { open: b.openedAt !== null, failures: b.failures };
  }
  return out;
}

// --- Rate limiting ---------------------------------------------------------

const buckets = new Map<string, number[]>();

export function rateLimit(
  key: string,
  maxPerMinute = Number(process.env.RATE_LIMIT_PER_MIN ?? 20),
): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= maxPerMinute) {
    return { ok: false, retryAfterMs: Math.max(1_000, 60_000 - (now - arr[0])) };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true, retryAfterMs: 0 };
}

// --- Timeouts ---------------------------------------------------------------

export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// --- Guarded provider call (circuit breaker + timeout, composed) -----------

/**
 * The ONE way any search/AI provider should be invoked: circuit-checked,
 * timed out, and outcome-recorded. Used by the universal fan-out so a
 * repeatedly failing or hung provider is skipped/cooled-down instead of
 * being re-tried on every request (§7, §30).
 */
export async function guardedCall<T>(
  providerId: string,
  label: string,
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!breakerAllow(providerId)) {
    throw new Error(`${label}: circuit open (cooling down)`);
  }
  try {
    const result = await withTimeout(fn(), timeoutMs, label);
    breakerRecord(providerId, true);
    return result;
  } catch (e) {
    breakerRecord(providerId, false);
    throw e;
  }
}

/**
 * Strict-vertical fallback decision (MEASURED DEFECT, search-quality
 * benchmark, 2026-09-28).
 *
 * When a strict vertical (weather, an explicitly requested scoreline) had
 * exactly one provider and that provider failed, the whole search threw
 * "All search engines failed" — for weather, EVERY vertical query in the
 * benchmark failed this way, even though the direct probe measured Open-Meteo
 * answering correctly moments before. A single rate-limited structured feed
 * was a total outage for the vertical.
 *
 * The contract stands: a structured answer must not be FAKED. But if the
 * vertical feed is down, the correct degradation is the dated general-web
 * backstop (news reporting about the thing), never silence and never an
 * unrelated vertical. Returns the backstop ids, or null when there is no
 * backstop and the search should keep failing honestly.
 */
export function strictVerticalFallbackFor(
  vertical: string | undefined,
): string[] | null {
  switch (vertical) {
    case "weather":
      return ["langsearch", "wikipedia-current-events", "searxng"];
    case "sports":
      return ["langsearch", "wikipedia-current-events", "searxng"];
    case "markets":
      return ["langsearch", "wikipedia-current-events", "searxng"];
    default:
      return null;
  }
}

/**
 * EARLY-CONTINUE GATE (round 10) — "one failed provider must not add its
 * timeout to the user's search."
 *
 * MEASURED: with the flaky free SearXNG base timing out at 5 s, a turn whose
 * healthy free providers (Wikipedia CE, LangSearch, structured feeds) had
 * already answered still WAITED the full 5 s per slow engine — IPL news took
 * 5.8 s while the identical query with SearXNG up took 2.4 s. That gap is pure
 * straggler cost, not evidence.
 *
 * The gate answers one question: given what has ALREADY answered, is what is
 * still pending worth its worst-case wait? It is deliberately conservative —
 * it only releases the wait when a MINIMUM number of providers have answered
 * AND a MINIMUM number of citations exist (with breadth: ≥2 distinct
 * providers), so a single lucky fast source can never starve a broad fan-out.
 * Release = `Promise.race` with a resolve-once promise per pending call; the
 * stragglers' results are still collected if they land, and their failures
 * are still recorded — this only stops the WAIT, never the isolation.
 */
export const EARLY_CONTINUE_MIN_PROVIDERS = 2;
export const EARLY_CONTINUE_MIN_CITATIONS = 4;
/** Never release the wait entirely — stragglers get at most this long. */
export const EARLY_CONTINUE_GRACE_MS = 1_200;

export function shouldEarlyContinue(
  answeredProviders: number,
  citationsSoFar: number,
  distinctProvidersWithResults: number,
  pendingProviders: number,
): boolean {
  if (pendingProviders <= 0) return false;
  if (answeredProviders < EARLY_CONTINUE_MIN_PROVIDERS) return false;
  if (distinctProvidersWithResults < 2) return false;
  return citationsSoFar >= EARLY_CONTINUE_MIN_CITATIONS;
}
