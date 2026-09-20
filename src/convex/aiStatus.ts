import { query } from "./_generated/server";
import { getAiStatus } from "./aiProviders/catalog";

/**
 * Which AI provider is actually active and how each task routes to a model
 * (master spec §3/§4). Lives outside "use node" so the UI can subscribe
 * reactively — the catalog is pure metadata + env detection, safe in queries.
 */
export const status = query({
  args: {},
  handler: async () => {
    return getAiStatus();
  },
});
