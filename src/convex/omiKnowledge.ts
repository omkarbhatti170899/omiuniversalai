import { getAuthUserId } from "@convex-dev/auth/server";
import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Omi Knowledge — Phase 3 local knowledge base (master plan).
 *
 * Documents are stored in Convex and retrieved with local keyword scoring —
 * ZERO per-query cost: no vector database, no paid embedding API, no
 * OpenSearch/FAISS hosting required. The scorer lives in this module, so a
 * self-hosted semantic index can be swapped in later without touching the
 * chat runtime or the UI.
 *
 * Scoring: passage chunks are scored by keyword overlap (with a full-phrase
 * bonus and stop-word filtering). Deterministic, explainable, and free.
 */

const MAX_CONTENT_CHARS = 60_000;
const CHUNK_CHARS = 420;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "how", "in", "is", "it", "its", "of", "on", "or", "that", "the", "to", "was",
  "what", "when", "where", "which", "who", "why", "will", "with", "do", "does",
  "did", "can", "could", "should", "would", "me", "my", "your", "you", "i",
  "this", "these", "those", "their", "there", "about", "into", "over", "than",
]);

export type KnowledgePassage = {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
};

function keywordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Split a document into readable chunks (~sentences, capped size). */
function chunkContent(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const t = current.trim();
    if (t.length > 0) chunks.push(t);
    current = "";
  };

  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if ((current + " " + s).trim().length > CHUNK_CHARS) pushCurrent();
      current = `${current} ${s}`.trim();
      if (current.length > CHUNK_CHARS * 1.5) pushCurrent();
    }
    if (current.length > CHUNK_CHARS) pushCurrent();
  }
  pushCurrent();
  return chunks.slice(0, 120);
}

/**
 * Keyword-scored retrieval over a set of documents.
 * Exported for testing/reuse; deterministic and free.
 */
export function scorePassages(
  query: string,
  docs: Array<{ _id: { toString(): string }; title: string; content: string }>,
  limit: number,
): KnowledgePassage[] {
  const kws = keywordsOf(query);
  if (kws.length === 0) return [];
  const phrase = query.toLowerCase().replace(/\s+/g, " ").trim();

  const scored: KnowledgePassage[] = [];
  for (const doc of docs) {
    for (const chunk of chunkContent(doc.content)) {
      const lower = chunk.toLowerCase();
      let score = 0;
      for (const k of kws) {
        if (lower.includes(k)) score += 2;
      }
      // Full-phrase bonus: the passage likely contains the actual answer.
      if (phrase.length > 8 && lower.includes(phrase)) score += 5;
      if (score > 0) {
        scored.push({
          documentId: doc._id.toString(),
          title: doc.title,
          snippet: chunk.length > 400 ? `${chunk.slice(0, 400)}…` : chunk,
          score,
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// --- User-facing queries/mutations ------------------------------------------

/** Documents for the signed-in user, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    return await ctx.db
      .query("omiDocuments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
  },
});

/** Keyword-scored retrieval across the user's documents (free, local). */
export const search = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { query, limit }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const docs = await ctx.db
      .query("omiDocuments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    return scorePassages(query, docs, Math.min(limit ?? 6, 12));
  },
});

export const create = mutation({
  args: { title: v.string(), content: v.string() },
  handler: async (ctx, { title, content }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const cleanTitle = title.trim().slice(0, 200);
    const cleanContent = content.trim().slice(0, MAX_CONTENT_CHARS);
    if (cleanTitle.length < 1) throw new Error("Give the document a title.");
    if (cleanContent.length < 20) {
      throw new Error("Add at least a sentence or two of content.");
    }

    const wordCount = cleanContent.split(/\s+/).filter(Boolean).length;
    return await ctx.db.insert("omiDocuments", {
      userId,
      title: cleanTitle,
      content: cleanContent,
      source: "user",
      wordCount,
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("omiDocuments") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your document");

    await ctx.db.delete(id);
  },
});

// --- Internal read used by the chat action (actions can't query directly) ----

export const searchInternal = internalQuery({
  args: { userId: v.id("users"), query: v.string(), limit: v.number() },
  handler: async (ctx, { userId, query, limit }) => {
    const docs = await ctx.db
      .query("omiDocuments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    return scorePassages(query, docs, limit);
  },
});
