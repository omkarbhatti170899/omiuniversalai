"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { runUniversalSearch, extractiveBrief } from "./universalSearch";
import { fetchPageText } from "./searchProviders/pageFetcher";
import { getProviderStatus } from "./searchProviders";

/**
 * Omi Search Router — the single entry point for search in the app.
 *
 * Backed by the provider-independent layer:
 *   • SearXNG (self-hosted or public) as the primary engine — zero cost
 *   • Wikipedia + DuckDuckGo keyless fallbacks
 *   • DB-backed result cache (30 min TTL) shared across users
 *   • dedupe, domain diversity, relevance ranking
 *   • optional page retrieval/extraction for grounded answers
 *
 * No metered search API is involved at any point.
 */
export const searchWeb = action({
  args: {
    query: v.string(),
    category: v.optional(
      v.union(
        v.literal("general"),
        v.literal("news"),
        v.literal("images"),
        v.literal("videos"),
        v.literal("science"),
        v.literal("it"),
        v.literal("files"),
        v.literal("music"),
      ),
    ),
    language: v.optional(v.string()),
    timeRange: v.optional(
      v.union(
        v.literal("day"),
        v.literal("week"),
        v.literal("month"),
        v.literal("year"),
      ),
    ),
    page: v.optional(v.number()),
    deepRead: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { query, category, language, timeRange, page, deepRead },
  ): Promise<{
    searchId: string;
    cached: boolean;
    page: number;
    engine: string;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Sign in to use Omi Search.");
    }

    const trimmed = query.trim().slice(0, 500);
    if (trimmed.length < 2) {
      throw new Error("Type a question or topic to search.");
    }

    const result = await runUniversalSearch(ctx, trimmed, {
      category,
      language,
      timeRange,
      page: page ?? 1,
      enrichPages: deepRead === true,
    });

    const brief =
      result.brief ??
      extractiveBrief(trimmed, result.citations);
    const answer = `${brief}\n\n— via ${result.engine}`;

    const searchId = await ctx.runMutation(internal.searchHistory.saveSearch, {
      userId,
      query: trimmed,
      answer,
      citations: result.citations.map((c) => ({
        title: c.title,
        url: c.url,
        snippet: c.snippet?.slice(0, 1200),
        imageUrl: c.imageUrl,
        publishedAt: c.publishedAt,
      })),
      engine: result.engine,
    });

    return {
      searchId,
      cached: result.cached,
      page: result.page,
      engine: result.engine,
    };
  },
});

/**
 * Page retrieval for a single citation — "read this source in full".
 * Returns extracted readable text for grounding follow-up questions.
 */
export const readSource = action({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");
    void ctx;

    if (!/^https?:\/\//i.test(url)) {
      throw new Error("Invalid URL.");
    }
    const page = await fetchPageText(url, 6000);
    if (!page.ok) {
      throw new Error(
        `Couldn't extract that page (${page.error ?? "unknown"}).`,
      );
    }
    return { title: page.title, text: page.text, url: page.url };
  },
});

/** Engine status for the UI (SearXNG self-hosted vs public floor, etc.). */
export const engines = action({
  args: {},
  handler: async () => {
    void getProviderStatus;
    return getProviderStatus();
  },
});
