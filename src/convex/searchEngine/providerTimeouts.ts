/**
 * PER-PROVIDER TIMEOUT RESOLUTION — one place, one valid env-var name.
 * =========================================================================
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The fan-out used to read the override as
 * `process.env["SEARCH_TIMEOUT_MS_WIKIPEDIA-CURRENT-EVENTS"]`. That name is
 * INVALID: environment variable names cannot contain a hyphen, and Convex does
 * not return `undefined` for one — it THROWS, and the throw propagated out of
 * the fan-out and turned every search into a hard refusal.
 *
 * Sanitising inside `universalSearch.ts` fixed the symptom but left the rule
 * untestable: `universalSearch.ts` is a `"use node"` action that pulls in the
 * generated Convex API, so a unit test could not reach the helper without
 * dragging the whole runtime in. The naming rule is now here, pure and
 * importable, so it can be pinned directly by tests — including the exact
 * hyphenated id that caused the original outage.
 *
 * THE CONTRACT
 *   • An override name is ALWAYS `SEARCH_TIMEOUT_MS_` + the provider id with
 *     every non-alphanumeric character replaced by `_`, uppercased.
 *   • The result is ALWAYS a valid environment-variable name
 *     (`[A-Za-z_][A-Za-z0-9_]*`) — verified by `isValidEnvVarName`.
 *   • Reading an override can NEVER throw: a malformed or unreadable value
 *     falls back to the measured default. A timeout override is a tuning knob;
 *     it must never be able to fail a search.
 */

/** Prefix shared by every per-provider timeout override. */
export const TIMEOUT_ENV_PREFIX = "SEARCH_TIMEOUT_MS_";

/**
 * Per-provider timeout budgets, from MEASURED latency.
 *
 * A single uniform budget is a real defect, not a simplification. It was 12 s
 * for every provider, which is correct for the fast keyless indexes (mwmbl
 * ~130 ms, hackernews ~210 ms) and wrong for the two that carry the most weight
 * on a freshness question:
 *
 *   searxng  14.7 s (time_range=day), 26.4 s (no filter), 46.6 s (plain probe)
 *   gdelt    10.3 s (429) / 13.2 s (HTTP 200 JSON)
 *
 * Under a 12 s ceiling those two were cut off mid-flight, so a provider that
 * demonstrably answers was recorded as `timedOut` and reported as unavailable.
 * That is how GDELT reached a measured "0% availability" while a single manual
 * call returned HTTP 200 with valid JSON. The budget was the bug.
 *
 * These are ceilings, not targets — a fast instance still returns in
 * milliseconds, and the circuit breaker plus the measured health store demote
 * a provider that is consistently slow, so paying this cost is a measured
 * decision rather than a permanent one. Each is env-overridable so a
 * self-hosted SearXNG (sub-second in practice) can be tightened again —
 * see `timeoutEnvVarName` for the ONLY valid way to spell that override.
 */
export const PROVIDER_TIMEOUT_MS: Record<string, number> = {
  searxng: 30_000,
  gdelt: 20_000,
};

/**
 * Canonical override names for providers whose ids contain characters that are
 * not legal in an environment variable name.
 *
 * This exists so a human reading the code (or a diagnostic report) sees the
 * EXACT string to set, instead of re-deriving the sanitisation rule and getting
 * it wrong — which is precisely how `SEARCH_TIMEOUT_MS_WIKIPEDIA-CURRENT-EVENTS`
 * got into the codebase. The value is what `timeoutEnvVarName` computes; the
 * test suite asserts they agree, so the map can never drift from the rule.
 */
export const CURATED_TIMEOUT_ENV_NAMES: Record<string, string> = {
  "wikipedia-current-events": "SEARCH_TIMEOUT_MS_WIKIPEDIA_CURRENT_EVENTS",
  "duckduckgo-instant": "SEARCH_TIMEOUT_MS_DUCKDUCKGO_INSTANT",
};

/** True when `name` is a legal environment-variable name. */
export function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** The sanitised id fragment used in an override name. */
export function sanitizeEnvSuffix(providerId: string): string {
  return providerId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/**
 * The ONLY valid override name for a provider. Always a legal env-var name,
 * whatever the provider id contains.
 */
export function timeoutEnvVarName(providerId: string): string {
  return `${TIMEOUT_ENV_PREFIX}${sanitizeEnvSuffix(providerId)}`;
}

/**
 * Resolve the timeout for one provider: an override when set and sane, else the
 * measured provider ceiling, else the caller's fallback.
 *
 * The env lookup is defensive on purpose. A hyphenated id would make Convex
 * throw rather than return undefined, so the whole read is wrapped: a timeout
 * override must never be able to fail a search.
 */
export function providerTimeoutMs(id: string, fallback: number): number {
  try {
    const raw = process.env[timeoutEnvVarName(id)];
    const override = Number(raw ?? NaN);
    if (Number.isFinite(override) && override > 0) return override;
  } catch {
    // A malformed or unreadable override is ignored in favour of the measured
    // default — never fatal.
  }
  return PROVIDER_TIMEOUT_MS[id] ?? fallback;
}
