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
  // PHASE 7: optional retention window (unix ms). Absent = keep forever.
  args: { content: v.string(), expiresInDays: v.optional(v.number()) },
  handler: async (ctx, { content, expiresInDays }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const trimmed = content.trim().slice(0, 500);
    if (trimmed.length < 2) {
      throw new Error("Memory needs at least a few characters.");
    }
    const expiresAt =
      typeof expiresInDays === "number" && expiresInDays > 0
        ? Date.now() + Math.min(expiresInDays, 365) * 86_400_000
        : undefined;
    return await ctx.db.insert("omiMemories", {
      userId,
      content: trimmed,
      source: "user",
      expiresAt,
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
/**
 * Internal read used by the chat action to ground Omi in approved memory.
 *
 * PHASE 7 (controlled memory): memories past their optional `expiresAt` are
 * EXCLUDED from grounding — controlled retention — but not deleted: the user
 * still owns them, sees them in the list, and purges explicitly. The prompt
 * therefore never cites a memory the user considers stale, while nothing is
 * destroyed behind their back.
 */
export const listInternal = internalQuery({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, { userId, limit }) => {
    const rows = await ctx.db
      .query("omiMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit * 2); // headroom so expired rows don't starve the take
    const now = Date.now();
    return rows
      .filter((m) => typeof m.expiresAt !== "number" || m.expiresAt > now)
      .slice(0, limit);
  },
});
