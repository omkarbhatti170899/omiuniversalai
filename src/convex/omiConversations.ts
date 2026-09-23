import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

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
  args: {
    title: v.optional(v.string()),
    /** §5 Projects: create the conversation inside a project (ownership-checked). */
    projectId: v.optional(v.id("omiProjects")),
  },
  handler: async (ctx, { title, projectId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    if (projectId !== undefined) {
      const project = await ctx.db.get(projectId);
      if (!project || project.userId !== userId) {
        throw new Error("Not your project");
      }
    }

    return await ctx.db.insert("omiConversations", {
      userId,
      title: title?.trim().slice(0, 80) || "New conversation",
      projectId,
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

/** §10 Conversation titles are the user's own labels — editable, never guessed twice. */
export const rename = mutation({
  args: { id: v.id("omiConversations"), title: v.string() },
  handler: async (ctx, { id, title }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your conversation");

    const clean = title.trim().slice(0, 80);
    if (clean.length === 0) throw new Error("Give the conversation a name.");
    await ctx.db.patch(id, { title: clean });
  },
});

/**
 * §10 Stop generation. Cooperative: the running turn checks this flag at its
 * stage boundaries and finalizes with whatever it already produced. It cannot
 * interrupt an in-flight provider HTTP request, and it never pretends to —
 * the UI keeps showing "stopping" until the turn itself reports back.
 */
export const requestStop = mutation({
  args: { conversationId: v.id("omiConversations") },
  handler: async (ctx, { conversationId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const doc = await ctx.db.get(conversationId);
    if (!doc || doc.userId !== userId) throw new Error("Not your conversation");
    await ctx.db.patch(conversationId, { stopRequestedAt: Date.now() });
  },
});

/** Internal lookup used by the chat action (actions can't query the DB directly). */
export const getInternal = internalQuery({
  args: { id: v.id("omiConversations") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

/** Cleared when a turn starts, so a previous Stop never kills the next turn. */
export const clearStopInternal = internalMutation({
  args: { id: v.id("omiConversations") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { stopRequestedAt: undefined });
  },
});

/** Excerpt of a message around the search term (for the search results list). */
function snippetAround(text: string, needle: string, width = 150): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text.slice(0, width) + (text.length > width ? "…" : "");
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + needle.length + 90);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * §10 Search conversations — real content search, not a title filter.
 *
 * Message text is searched through the `search_content` index with `userId` as
 * a filter field, so the index itself enforces ownership: a query can only
 * ever match the searcher's own messages. Conversations are then joined from
 * the user's own list, which means a stale/foreign conversation id can never
 * be surfaced even if a message row were somehow reachable.
 */
export const searchMine = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { conversations: [], messageMatches: 0 };

    const q = query.trim().slice(0, 120);
    if (q.length < 2) return { conversations: [], messageMatches: 0 };

    const mine = await ctx.db
      .query("omiConversations")
      .withIndex("by_user", (qq) => qq.eq("userId", userId))
      .order("desc")
      .take(50);
    const owned = new Map(mine.map((c) => [c._id as string, c] as const));

    const hits = await ctx.db
      .query("omiMessages")
      .withSearchIndex("search_content", (s) =>
        s.search("content", q).eq("userId", userId),
      )
      .take(60);

    const buckets = new Map<
      string,
      {
        conversation: (typeof mine)[number];
        matches: Array<{
          messageId: Id<"omiMessages">;
          role: "user" | "omi";
          snippet: string;
          createdAt: number;
        }>;
      }
    >();

    for (const m of hits) {
      const conversation = owned.get(m.conversationId as string);
      if (!conversation) continue;
      const bucket = buckets.get(m.conversationId as string) ?? {
        conversation,
        matches: [],
      };
      if (bucket.matches.length < 3) {
        bucket.matches.push({
          messageId: m._id,
          role: m.role,
          snippet: snippetAround(m.content, q),
          createdAt: m._creationTime,
        });
      }
      buckets.set(m.conversationId as string, bucket);
    }

    // Title matches are included even when no message text matched.
    const needle = q.toLowerCase();
    for (const c of mine) {
      if (buckets.has(c._id as string)) continue;
      if (c.title.toLowerCase().includes(needle)) {
        buckets.set(c._id as string, { conversation: c, matches: [] });
      }
    }

    const conversations = [...buckets.values()]
      .sort((a, b) => b.matches.length - a.matches.length)
      .slice(0, 20);

    return { conversations, messageMatches: hits.length };
  },
});
