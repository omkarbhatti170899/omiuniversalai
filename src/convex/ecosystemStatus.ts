import { query } from "./_generated/server";
import { getEcosystemStatus } from "./ecosystem";

/**
 * Ecosystem technologies (§15–23) served to the Settings UI from the pure
 * registry in ecosystem.ts. No auth needed: this is public metadata about
 * Omi's own architecture, not user data.
 */
export const status = query({
  args: {},
  handler: async () => {
    return getEcosystemStatus();
  },
});
