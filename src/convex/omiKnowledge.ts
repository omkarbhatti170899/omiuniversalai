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

    // Stored blobs are deleted with their row so "clear" never leaves
    // orphaned uploads behind (same contract as omiFiles.remove).
    if (doc.fileId) await ctx.storage.delete(doc.fileId);
    await ctx.db.delete(id);
  },
});

/** Rename a document (or uploaded file) — the user's own label, editable. */
export const rename = mutation({
  args: { id: v.id("omiDocuments"), title: v.string() },
  handler: async (ctx, { id, title }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your document");

    const clean = title.trim().slice(0, 200);
    if (clean.length < 1) throw new Error("Give it a name.");
    await ctx.db.patch(id, { title: clean });
  },
});

/**
 * "Clear all" knowledge — deletes every document AND stored file the caller
 * owns. Scoped strictly to the caller's own rows via the by_user index, so one
 * user's wipe can never touch another user's knowledge.
 */
export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const mine = await ctx.db
      .query("omiDocuments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const d of mine) {
      if (d.fileId) await ctx.storage.delete(d.fileId);
      await ctx.db.delete(d._id);
    }
    return mine.length;
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
