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

/**
 * §10 Regenerate: the user turn a re-run should repeat. Ownership is implied
 * by the caller (the chat action resolves the conversation first), but the
 * conversation id is still matched here so a stale id can't cross threads.
 */
export const lastUserInternal = internalQuery({
  args: { conversationId: v.id("omiConversations") },
  handler: async (ctx, { conversationId }) => {
    const recent = await ctx.db
      .query("omiMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(20);
    return recent.find((m) => m.role === "user") ?? null;
  },
});

/**
 * §10 Edit/regenerate: drop everything that came after a user turn before
 * answering again, so a re-run never leaves two competing replies (or a
 * half-finished streaming placeholder) in the transcript.
 */
export const deleteAfterInternal = internalMutation({
  args: {
    conversationId: v.id("omiConversations"),
    afterMessageId: v.id("omiMessages"),
  },
  handler: async (ctx, { conversationId, afterMessageId }) => {
    const anchor = await ctx.db.get(afterMessageId);
    if (!anchor || anchor.conversationId !== conversationId) return 0;

    const all = await ctx.db
      .query("omiMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    let removed = 0;
    for (const m of all) {
      if (m._id === afterMessageId) continue;
      if (m._creationTime >= anchor._creationTime) {
        await ctx.db.delete(m._id);
        removed += 1;
      }
    }
    return removed;
  },
});

/**
 * §10 Regenerate: delete a user turn AND everything after it (inclusive),
 * so re-running the turn produces exactly one clean transcript instead of a
 * duplicated user message next to two competing Omi replies. Ownership is
 * enforced by the caller (regenerate resolves the conversation first) and the
 * conversation id is matched here so a stale id can never cross threads.
 */
export const deleteFromInternal = internalMutation({
  args: {
    conversationId: v.id("omiConversations"),
    fromMessageId: v.id("omiMessages"),
  },
  handler: async (ctx, { conversationId, fromMessageId }) => {
    const anchor = await ctx.db.get(fromMessageId);
    if (!anchor || anchor.conversationId !== conversationId) return 0;

    const all = await ctx.db
      .query("omiMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    let removed = 0;
    for (const m of all) {
      if (m._creationTime >= anchor._creationTime) {
        await ctx.db.delete(m._id);
        removed += 1;
      }
    }
    return removed;
  },
});

/**
 * §10 Edit message: rewrite a user turn in place (content and, when new
 * attachments are supplied, its attachment list). Only the author's own user
 * messages are ever patched — an Omi reply is not editable.
 */
export const patchUserInternal = internalMutation({
  args: {
    messageId: v.id("omiMessages"),
    actingUserId: v.id("users"),
    content: v.optional(v.string()),
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
  handler: async (ctx, { messageId, actingUserId, ...patch }) => {
    const doc = await ctx.db.get(messageId);
    if (!doc || doc.userId !== actingUserId) return false;
    if (doc.role !== "user") return false;
    await ctx.db.patch(messageId, patch);
    return true;
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
