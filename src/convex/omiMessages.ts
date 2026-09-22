import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Messages of a conversation for the signed-in user, oldest first. */
export const listByConversation = query({
  args: { conversationId: v.id("omiConversations") },
  handler: async (ctx, { conversationId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    // Ownership check via the conversation doc.
    const conversation = await ctx.db.get(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new Error("Not your conversation");
    }

    return await ctx.db
      .query("omiMessages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .order("asc")
      .collect();
  },
});

export const remove = mutation({
  args: { id: v.id("omiMessages") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your message");

    await ctx.db.delete(id);
  },
});

/** Internal save used by the chat action. */
export const saveInternal = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("omiConversations"),
    role: v.union(v.literal("user"), v.literal("omi")),
    content: v.string(),
    reasoning: v.optional(v.string()),
    status: v.optional(v.union(v.literal("streaming"), v.literal("final"))),
    // PRIORITY 1 — chat attachments: ownership-checked references to the
    // user's own knowledge documents attached to this message. Only IDs the
    // sender owns ever reach this field (chat resolves them first).
    attachments: v.optional(
      v.array(
        v.object({
          documentId: v.id("omiDocuments"),
          title: v.string(),
          kind: v.union(v.literal("image"), v.literal("file")),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiMessages", args);
  },
});

/**
 * Public patch used ONLY by the conversation's own chat action while a
 * message is streaming (§40). Ownership enforced against the acting user; a
 * terminal status can never be overwritten (final is final).
 */
export const patchInternal = internalMutation({
  args: {
    messageId: v.id("omiMessages"),
    actingUserId: v.id("users"),
    content: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    status: v.optional(v.union(v.literal("streaming"), v.literal("final"))),
  },
  handler: async (ctx, { messageId, actingUserId, ...patch }) => {
    const doc = await ctx.db.get(messageId);
    if (!doc || doc.userId !== actingUserId) return;
    // Terminal states are immutable — final is final.
    if (doc.status === "final") return;
    await ctx.db.patch(messageId, patch);
  },
});

/** Internal read of recent context for the chat action. */
export const recentInternal = internalQuery({
  args: { conversationId: v.id("omiConversations"), limit: v.number() },
  handler: async (ctx, { conversationId, limit }) => {
    const docs = await ctx.db
      .query("omiMessages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .order("desc")
      .take(limit);
    return docs.reverse();
  },
});
