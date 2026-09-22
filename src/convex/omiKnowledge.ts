import { getAuthUserId } from "@convex-dev/auth/server";
import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { retrieve, parseRetrievalMode } from "./searchEngine/retrieval";

/**
 * Omi Knowledge — Phase 3 local knowledge base (master plan).
 *
 * Documents are stored in Convex and retrieved with the local hybrid ranking
 * engine (searchEngine/retrieval.ts) — ZERO per-query cost: no vector
 * database, no paid embedding API, no OpenSearch/FAISS hosting required.
 * The engine lives behind the provider-neutral retriever seam, so a
 * self-hosted semantic index can be swapped in later without touching the
 * chat runtime or the UI.
 *
 * Scoring: BM25 (inverse document frequency, length normalization, term
 * saturation, full-phrase bonus) PLUS field weighting, typo tolerance and
 * proximity — deterministic, explainable and free. `retrievalMode` selects
 * `hybrid` (default), plain `bm25`, or the legacy keyword scorer.
 */

const MAX_CONTENT_CHARS = 60_000;

export type KnowledgePassage = {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
};

/**
 * §5 Projects — the context-isolation rule for knowledge retrieval, pure so
 * it is unit-tested rather than buried in a query handler:
 *
 *   • projectId set  → ONLY documents scoped to that project. Project context
 *     never mixes across projects.
 *   • projectId unset → only PERSONAL documents (no projectId). Personal chat
 *     does not silently absorb project files either — scoping cuts both ways.
 */
export function scopeDocumentsToProject<
  T extends { projectId?: Id<"omiProjects"> },
>(docs: T[], projectId?: Id<"omiProjects">): T[] {
  return projectId
    ? docs.filter((d) => d.projectId === projectId)
    : docs.filter((d) => d.projectId === undefined);
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

/** BM25-scored retrieval across the user's documents (free, local). */
export const search = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    retrievalMode: v.optional(v.string()),
  },
  handler: async (ctx, { query, limit, retrievalMode }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const docs = await ctx.db
      .query("omiDocuments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    return retrieve(
      query,
      docs,
      Math.min(limit ?? 6, 12),
      parseRetrievalMode(retrievalMode),
    );
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

// --- Internal read used by chat/tool actions (actions can't query directly) --

export const searchInternal = internalQuery({
  args: {
    userId: v.id("users"),
    query: v.string(),
    limit: v.number(),
    retrievalMode: v.optional(v.string()),
    /**
     * §5 Projects: when set, retrieval searches ONLY documents scoped to
     * that project — project context never mixes across projects. When
     * unset, all of the user's personal knowledge is searched (documents
     * with no projectId), exactly as before this field existed.
     */
    projectId: v.optional(v.id("omiProjects")),
  },
  handler: async (ctx, { userId, query, limit, retrievalMode, projectId }) => {
    const docs = await ctx.db
      .query("omiDocuments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    return retrieve(
      query,
      scopeDocumentsToProject(docs, projectId),
      limit,
      parseRetrievalMode(retrievalMode),
    );
  },
});
