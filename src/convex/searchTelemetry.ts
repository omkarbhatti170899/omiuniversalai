import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Observability (spec §24): one row per search/research/URL run.
 * Never stores secrets — only timings, engine names, and counts.
 */

export const write = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    query: v.string(),
    mode: v.string(),
    engines: v.array(v.string()),
    failedEngines: v.array(v.string()),
    resultCount: v.number(),
    cacheHit: v.boolean(),
    searchMs: v.number(),
    aiMs: v.optional(v.number()),
    pagesFetched: v.optional(v.number()),
    extractionFailures: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, row) => {
    await ctx.db.insert("searchTelemetry", {
      ...row,
      query: row.query.slice(0, 300),
      error: row.error?.slice(0, 300),
      createdAt: Date.now(),
    });
  },
});

/** Recent rows for the admin/debug view. No secrets — timings and names only. */
export const recent = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return ctx.db
      .query("searchTelemetry")
      .withIndex("by_created", (q) => q.gte("createdAt", 0))
      .order("desc")
      .take(Math.min(limit ?? 50, 100));
  },
});
