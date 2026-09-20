import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Tool-run records (master plan Phase 1 observability + Phase 11
 * self-improvement data). One row per tool execution — success or failure —
 * scoped to the owning user.
 */

/** Recent runs for the signed-in user, newest first. */
export const listMine = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("omiToolRuns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(Math.min(limit ?? 30, 100));
  },
});

/** Runs belonging to one task (agent detail view). */
export const listByTask = query({
  args: { taskId: v.id("omiTasks") },
  handler: async (ctx, { taskId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const task = await ctx.db.get(taskId);
    if (!task || task.userId !== userId) {
      throw new Error("Not your task.");
    }

    return await ctx.db
      .query("omiToolRuns")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .order("asc")
      .take(50);
  },
});

/** Internal recorder used by the tool executor. */
export const recordInternal = internalMutation({
  args: {
    userId: v.id("users"),
    taskId: v.optional(v.id("omiTasks")),
    agentId: v.optional(v.id("omiAgents")),
    tool: v.string(),
    argsSummary: v.optional(v.string()),
    ok: v.boolean(),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiToolRuns", args);
  },
});
