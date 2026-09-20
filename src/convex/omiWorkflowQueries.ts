import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Reactive reads for the Automation Engine UI (Phase 10). Kept out of the
 * "use node" runner module: Convex queries must not run in the Node runtime,
 * and these are pure database reads.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("omiWorkflows")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(25);
  },
});

export const get = query({
  args: { id: v.id("omiWorkflows") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const run = await ctx.db.get(id);
    if (!run || run.userId !== userId) return null;
    return run;
  },
});
