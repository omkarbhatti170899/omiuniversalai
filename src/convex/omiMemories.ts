import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Memories for the signed-in user, newest first (user-facing). */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    return await ctx.db
      .query("omiMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
  },
});

export const create = mutation({
  args: { content: v.string() },
  handler: async (ctx, { content }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const trimmed = content.trim().slice(0, 500);
    if (trimmed.length < 2) {
      throw new Error("Memory needs at least a few characters.");
    }
    return await ctx.db.insert("omiMemories", {
      userId,
      content: trimmed,
      source: "user",
    });
  },
});

export const update = mutation({
  args: { id: v.id("omiMemories"), content: v.string() },
  handler: async (ctx, { id, content }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your memory");

    const trimmed = content.trim().slice(0, 500);
    if (trimmed.length < 2) {
      throw new Error("Memory needs at least a few characters.");
    }
    await ctx.db.patch(id, { content: trimmed });
  },
});

export const remove = mutation({
  args: { id: v.id("omiMemories") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your memory");

    await ctx.db.delete(id);
  },
});

/**
 * "Clear all" — deletes every memory the signed-in user owns in one action.
 * Scoped strictly to the caller's own rows (the by_user index), so one user's
 * wipe can never touch another user's memory. Returns the number removed.
 */
export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const mine = await ctx.db
      .query("omiMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const m of mine) await ctx.db.delete(m._id);
    return mine.length;
  },
});

/** Internal create used by the OMI tool executor (memory_save tool). */
export const createInternal = internalMutation({
  args: {
    userId: v.id("users"),
    content: v.string(),
  },
  handler: async (ctx, { userId, content }) => {
    const trimmed = content.trim().slice(0, 500);
    if (trimmed.length < 2) {
      throw new Error("Memory needs at least a few characters.");
    }
    return await ctx.db.insert("omiMemories", {
      userId,
      content: trimmed,
      source: "omi",
    });
  },
});
/** Internal read used by the chat action to ground Omi in approved memory. */
export const listInternal = internalQuery({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, { userId, limit }) => {
    return await ctx.db
      .query("omiMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);
  },
});
