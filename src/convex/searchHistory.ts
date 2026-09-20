import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Saved Omi Searches for the signed-in user, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    return await ctx.db
      .query("webSearches")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
  },
});

export const remove = mutation({
  args: { id: v.id("webSearches") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your search");

    await ctx.db.delete(id);
  },
});

/** Internal insert used by the search action (actions can't touch the DB directly). */
export const saveSearch = internalMutation({
  args: {
    userId: v.id("users"),
    query: v.string(),
    answer: v.string(),
    citations: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        snippet: v.optional(v.string()),
        imageUrl: v.optional(v.string()),
        publishedAt: v.optional(v.string()),
        providers: v.optional(v.array(v.string())),
        author: v.optional(v.string()),
      }),
    ),
    engine: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("webSearches", args);
  },
});
