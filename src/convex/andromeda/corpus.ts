import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { retrieve } from "../searchEngine/retrieval";

/**
 * Internal knowledge as an Andromeda source (master plan §11: OpenSearch
 * "internal knowledge" — the in-platform equivalent over Convex + BM25).
 *
 * This runs INSIDE the orchestrator's parallel retrieval stage as a virtual
 * provider: highest trust tier (the user's own documents), zero network,
 * zero cost. Results carry the reserved `internal://` URL scheme — they
 * bypass external page reading and cite to the user's own library.
 *
 * Privacy (§41): retrieval stays inside the workspace; content never leaves
 * to any external provider — only Omi's own model layer sees excerpts, under
 * the same sanitization as every other source.
 */

export const INTERNAL_SCHEME = "internal://";

export const corpusSearch = internalQuery({
  args: {
    userId: v.id("users"),
    query: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, { userId, query, limit }) => {
    const docs = await ctx.db
      .query("omiDocuments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    const passages = retrieve(query, docs, limit, "bm25");
    return passages.map((p) => ({
      title: p.title,
      url: `${INTERNAL_SCHEME}${p.documentId}`,
      snippet: p.snippet,
    }));
  },
});
