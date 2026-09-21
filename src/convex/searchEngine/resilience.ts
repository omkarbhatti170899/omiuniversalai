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
