import { query } from "./_generated/server";
import { getAiStatus } from "./aiProviders/catalog";
import { getImageProviderStatus } from "./aiProviders/imageCatalog";

/**
 * Which AI provider is actually active and how each task routes to a model
 * (master spec §3/§4), plus which image providers are configured so the
 * Image Studio can say honestly which operations are live. Lives outside
 * "use node" so the UI can subscribe reactively — the catalogs are pure
 * metadata + env detection, safe in queries. Booleans and labels only: no
 * key, token or env value is ever returned.
 */
export const status = query({
  args: {},
  handler: async () => {
    return { ...getAiStatus(), imageProviders: getImageProviderStatus() };
  },
});
