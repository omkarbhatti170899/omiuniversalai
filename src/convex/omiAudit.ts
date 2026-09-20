import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Recent audit events for the signed-in user, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    return await ctx.db
      .query("omiAuditLog")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(40);
  },
});

/** Internal append used by the agent runtime. */
export const addInternal = internalMutation({
  args: {
    userId: v.id("users"),
    taskId: v.optional(v.id("omiTasks")),
    agentId: v.optional(v.id("omiAgents")),
    event: v.string(),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiAuditLog", args);
  },
});
