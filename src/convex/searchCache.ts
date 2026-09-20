import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Zero-cost search cache. A fingerprint of (query + category + language +
 * timeRange + page) maps to normalized citations. Any user's search within
 * the TTL is served from this table without touching the engines again —
 * the second identical search costs nothing and returns instantly.
 */

export const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes

/** Stable fingerprint for a search request. */
export function cacheKeyFor(
  query: string,
  opts: { category?: string; language?: string; timeRange?: string; page?: number },
): string {
  const norm = query.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    norm,
    opts.category ?? "general",
    opts.language ?? "all",
    opts.timeRange ?? "any",
    String(opts.page ?? 1),
  ].join("|");
}

export const read = internalQuery({
  args: { cacheKey: v.string() },
  handler: async (ctx, { cacheKey }) => {
    const doc = await ctx.db
      .query("searchCache")
      .withIndex("by_cache_key", (q) => q.eq("cacheKey", cacheKey))
      .first();
    if (!doc) return null;
    if (Date.now() - doc.createdAt > CACHE_TTL_MS) return null; // expired
    return {
      citations: doc.citations,
      engine: doc.engine,
      createdAt: doc.createdAt,
    };
  },
});

export const write = internalMutation({
  args: {
    cacheKey: v.string(),
    query: v.string(),
    citations: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        snippet: v.optional(v.string()),
        imageUrl: v.optional(v.string()),
        publishedAt: v.optional(v.string()),
      }),
    ),
    engine: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("searchCache")
      .withIndex("by_cache_key", (q) => q.eq("cacheKey", args.cacheKey))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        citations: args.citations,
        engine: args.engine,
        createdAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("searchCache", {
      ...args,
      createdAt: Date.now(),
    });
  },
});
