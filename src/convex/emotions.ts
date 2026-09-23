import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Emotion analyses for the signed-in user, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    return await ctx.db
      .query("emotionAnalyses")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
  },
});

export const remove = mutation({
  args: { id: v.id("emotionAnalyses") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your analysis");

    await ctx.db.delete(id);
  },
});

/** Internal insert used by the emotionsAi action (actions can't touch the DB directly). */
export const saveAnalysis = internalMutation({
  args: {
    userId: v.id("users"),
    text: v.string(),
    emotion: v.string(),
    confidence: v.number(),
    rantScore: v.optional(v.number()),
    rantInterpretation: v.optional(v.string()),
    sentiment: v.optional(v.string()),
    sentimentScore: v.optional(v.number()),
    urgency: v.optional(v.string()),
    urgencyScore: v.optional(v.number()),
    signalFields: v.optional(v.string()),
    advice: v.optional(v.string()),
    omiNote: v.optional(v.string()),
    /** "ai" (model classification) or "heuristic" (local word/punctuation read). */
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("emotionAnalyses", args);
  },
});
