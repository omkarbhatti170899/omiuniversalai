import { getAuthUserId } from "@convex-dev/auth/server";
import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Conversations for the signed-in user, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    return await ctx.db
      .query("omiConversations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
  },
});

export const create = mutation({
  args: { title: v.optional(v.string()) },
  handler: async (ctx, { title }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    return await ctx.db.insert("omiConversations", {
      userId,
      title: title?.trim().slice(0, 80) || "New conversation",
    });
  },
});

export const remove = mutation({
  args: { id: v.id("omiConversations") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your conversation");

    // Cascade: delete messages belonging to this conversation.
    const messages = await ctx.db
      .query("omiMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", id))
      .collect();
    for (const m of messages) {
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(id);
  },
});

/** Internal lookup used by the chat action (actions can't query the DB directly). */
export const getInternal = internalQuery({
  args: { id: v.id("omiConversations") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});
