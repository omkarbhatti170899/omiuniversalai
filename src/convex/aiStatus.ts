import { query } from "./_generated/server";
import { getAiStatus } from "./aiProviders/catalog";
import {
  getImageCapabilityReport,
  getImageProviderStatus,
} from "./aiProviders/imageCatalog";
import {
  isHealthFresh,
  providerHealthLabel,
  type ProviderHealth,
} from "./aiProviders/imageRouter";

/**
 * Which AI provider is actually active and how each task routes to a model
 * (master spec §3/§4), plus which image providers are configured so the
 * Image Studio can say honestly which operations are live. Lives outside
 * "use node" so the UI can subscribe reactively — the catalogs are pure
 * metadata + env detection, safe in queries. Booleans and labels only: no
 * key, token or env value is ever returned.
 *
 * The image providers carry their LAST-KNOWN live health as well: a key that
 * exists is not a capability that works, so a configured provider that just
 * answered 429 is reported as "rate limited" (evidence from a real attempt,
 * see omiImages.recordProviderHealth) instead of a green check nobody
 * verified. Stale observations are discarded rather than shown — an old
 * failure describes the past, not right now.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("omiImageProviderHealth").take(20);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));

    return {
      ...getAiStatus(),
      imageProviders: getImageProviderStatus().map((p) => {
        const row = byProvider.get(p.id);
        const fresh = isHealthFresh(row?.updatedAt, now);
        const state = fresh ? (row?.state as ProviderHealth) : undefined;
        const badge = providerHealthLabel(p.configured, state);
        return {
          ...p,
          /** Live state from a real attempt, or null when we have no evidence. */
          health: state ?? null,
          healthLabel: badge.label,
          healthTone: badge.tone,
          healthAgeMs: fresh && row ? now - row.updatedAt : null,
          healthError: fresh ? (row?.error ?? null) : null,
        };
      }),
      // Static capability truth (configured + declares the op). A live run may
      // still fail; the self-test / run result reports that separately.
      imageCapabilities: getImageCapabilityReport(),
    };
  },
});
