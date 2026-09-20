import { v } from "convex/values";
import { query, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Deep Research run tracking (no Node runtime needed — pure DB access).
 * The orchestrator action in deepResearch.ts updates the run row after
 * every phase so the UI can subscribe to live progress.
 */

export const getRun = query({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, { runId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const run = await ctx.db.get(runId);
    if (!run || run.userId !== userId) return null;
    return run;
  },
});

export const listRuns = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return ctx.db
      .query("researchRuns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(10);
  },
});

export const createRun = internalMutation({
  args: { userId: v.id("users"), query: v.string(), plan: v.array(v.string()) },
  handler: async (ctx, { userId, query, plan }) => {
    return ctx.db.insert("researchRuns", {
      userId,
      query,
      status: "planning",
      stage: "Planning research queries",
      plan,
      searchesDone: 0,
      createdAt: Date.now(),
    });
  },
});

export const updateRun = internalMutation({
  args: {
    runId: v.id("researchRuns"),
    status: v.optional(
      v.union(
        v.literal("planning"),
        v.literal("searching"),
        v.literal("reading"),
        v.literal("synthesizing"),
        v.literal("done"),
        v.literal("failed"),
      ),
    ),
    stage: v.optional(v.string()),
    searchesDone: v.optional(v.number()),
    answer: v.optional(v.string()),
    summary: v.optional(v.string()),
    findings: v.optional(v.array(v.string())),
    conflicts: v.optional(v.array(v.string())),
    unverified: v.optional(v.array(v.string())),
    citations: v.optional(
      v.array(
        v.object({ title: v.string(), url: v.string(), snippet: v.optional(v.string()) }),
      ),
    ),
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  },
  handler: async (ctx, { runId, ...patch }) => {
    await ctx.db.patch(runId, patch);
  },
});
