import { query } from "./_generated/server";
import { getProviderStatus } from "./searchProviders";

/**
 * Which web-search providers are configured. Lives outside "use node" so it
 * can be a reactive query — the UI uses it to show a graceful setup state
 * instead of a raw error when a key is missing.
 */
export const status = query({
  args: {},
  handler: async () => {
    return getProviderStatus();
  },
});
