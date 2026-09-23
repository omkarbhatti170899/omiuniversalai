/**
 * Model discovery — asks each provider which models it actually serves, so a
 * provider retiring a model can never silently break a capability again.
 *
 * Why this exists: hard-coded model IDs rot. Groq shut down the Llama 4 vision
 * family on 2026-07-17, and the configured vision IDs kept returning 404 while
 * /status still reported vision "available" — configured ≠ working, and the
 * failure only surfaced when a user uploaded an image. Discovery makes the
 * provider's own catalogue the source of truth instead of our assumptions.
 *
 * Doctrine — identical to the circuit breaker: discovery must NEVER be worse
 * than no discovery. Every failure path (network, timeout, rate limit, an
 * unexpected response shape) fails OPEN and returns the candidates unchanged,
 * so a hiccup in the listing endpoint can never disable a model that works.
 *
 * Known limitation (measured 2026-09-23): a provider's list is a SUPERSET of
 * what an account may actually call. Google still lists `gemini-2.5-flash`
 * while answering 404 "no longer available to new users" for it. Discovery
 * therefore narrows the candidates; it does not prove they work. The live
 * probe in omiSelfTest (`ai fallback`) is what turns that into a verified
 * PASS — see the docs for the incident.
 *
 * No node imports: importable from V8 actions, the HTTP router and tests.
 */

/** Success TTL: long, because model catalogues change on the order of weeks. */
const SUCCESS_TTL_MS = 10 * 60 * 1000;
/** Failure TTL: short, so a transient listing outage self-heals quickly. */
const FAILURE_TTL_MS = 60 * 1000;
const LIST_TIMEOUT_MS = 8_000;

type CacheEntry = { at: number; ids: Set<string> | null };

const cache = new Map<string, CacheEntry>();
/** De-dupes concurrent lookups so a burst of requests makes one HTTP call. */
const inflight = new Map<string, Promise<Set<string> | null>>();

/** The /models sibling of an OpenAI-compatible chat-completions endpoint. */
export function modelsEndpoint(chatCompletionsUrl: string): string {
  return chatCompletionsUrl.replace(/\/chat\/completions\/?$/, "/models");
}

/**
 * Narrow an ordered preference list to the models the provider actually
 * serves, preserving our preference order.
 *
 * Pure, so the two decisions that matter are unit-tested rather than buried
 * in a fetch:
 *   • `available` unknown (null/empty) → return candidates unchanged. We do
 *     not filter on information we do not have.
 *   • `available` known, but it agrees with NONE of our candidates → also
 *     return candidates unchanged. An empty result here would disable a
 *     provider outright; trying a model that then 404s costs one round-trip,
 *     whereas guessing wrong costs the whole capability.
 */
export function selectAvailableModels(
  candidates: string[],
  available: Set<string> | null,
): string[] {
  if (available === null || available.size === 0) return candidates;
  const present = candidates.filter((m) => available.has(m));
  return present.length > 0 ? present : candidates;
}

/**
 * Fetch the provider's live model IDs. Returns null — never throws — when the
 * list cannot be obtained, which callers treat as "unknown, do not filter".
 */
export async function fetchAvailableModelIds(
  providerId: string,
  chatCompletionsUrl: string,
  apiKey: string,
  now: number = Date.now(),
): Promise<Set<string> | null> {
  const entry = cache.get(providerId);
  if (entry) {
    const ttl = entry.ids === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
    if (now - entry.at < ttl) return entry.ids;
  }

  const existing = inflight.get(providerId);
  if (existing) return existing;

  const lookup = (async (): Promise<Set<string> | null> => {
    try {
      const res = await fetch(modelsEndpoint(chatCompletionsUrl), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: Array<{ id?: string }>;
        models?: Array<{ id?: string } | string>;
      };
      // OpenAI-compatible shape is { data: [{ id }] }; tolerate { models: [] }
      // in case a future provider differs rather than failing the lookup.
      const rows = body.data ?? body.models ?? [];
      const ids = new Set<string>();
      for (const row of rows) {
        const id = typeof row === "string" ? row : row?.id;
        if (typeof id === "string" && id.length > 0) ids.add(id);
      }
      return ids.size > 0 ? ids : null;
    } catch {
      return null;
    }
  })();

  inflight.set(providerId, lookup);
  try {
    const ids = await lookup;
    cache.set(providerId, { at: now, ids });
    return ids;
  } finally {
    inflight.delete(providerId);
  }
}

/**
 * Ordered candidates reduced to those the provider currently serves.
 * Fails open at every step — the returned list is always non-empty when the
 * input is non-empty.
 */
export async function filterToAvailableModels(
  providerId: string,
  chatCompletionsUrl: string,
  apiKey: string,
  candidates: string[],
): Promise<string[]> {
  if (candidates.length === 0) return candidates;
  const ids = await fetchAvailableModelIds(providerId, chatCompletionsUrl, apiKey);
  return selectAvailableModels(candidates, ids);
}

/**
 * Observability for /status: what discovery knows per provider. Exposes counts
 * and booleans only — never keys, never full catalogues.
 */
export function modelDiscoveryStatus(): Record<
  string,
  { verified: boolean; modelCount: number | null }
> {
  const out: Record<string, { verified: boolean; modelCount: number | null }> = {};
  for (const [id, entry] of cache) {
    out[id] = { verified: entry.ids !== null, modelCount: entry.ids?.size ?? null };
  }
  return out;
}

/** Test hook: forget cached lookups. */
export function clearModelDiscoveryCache(): void {
  cache.clear();
  inflight.clear();
}
