"use node";

/**
 * Omi Search Router — API v2. The single entry point for search in the app.
 *
 * Request flow (spec §2/§7):
 *   Decision Engine (intent, freshness, language) →
 *   universalSearch core (SearXNG primary + keyless floor, cache, dedupe,
 *   tiered ranking) → evidence-backed brief → telemetry row.
 *
 * Endpoints (actions):
 *   searchWeb    — main search (auto filters via the decision engine)
 *   suggest      — autocomplete (SearXNG /autocompleter)
 *   readSource   — retrieve + extract one page ("read this source")
 *   urlResearch  — URL analysis: validate → retrieve → extract → summarize
 *   engines      — provider/cost status for the UI
 *   health/ready — health + readiness probes (also mirrored over HTTP)
 *
 * Zero metered search API is involved at any point.
 */

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { runUniversalSearch, extractiveBrief } from "./universalSearch";
import { fetchPageText } from "./searchProviders/pageFetcher";
import { searxSuggestions } from "./searchProviders/searxng";
import { getProviderStatus } from "./searchProviders";
import { assertSafeUrl } from "./searchEngine/security";
import { decideSearch, isCalculation, extractUrl } from "./searchEngine/decision";
import { rateLimit, breakerStatus } from "./searchEngine/resilience";
import { buildEvidencePack, sourcesFooter } from "./searchEngine/evidence";
import { vly } from "../lib/vly-integrations";

// --- Helper: write one telemetry row (never breaks the request) ------------

async function recordTelemetry(
  ctx: any,
  row: {
    userId?: string | null;
    query: string;
    mode: string;
    engines: string[];
    failedEngines: string[];
    resultCount: number;
    cacheHit: boolean;
    searchMs: number;
    aiMs?: number;
    pagesFetched?: number;
    extractionFailures?: number;
    error?: string;
  },
) {
  try {
    await ctx.runMutation(internal.searchTelemetry.write, {
      ...row,
      userId: row.userId ?? undefined,
      engines: row.engines.slice(0, 6),
      failedEngines: row.failedEngines.slice(0, 6),
      resultCount: Math.min(row.resultCount, 500),
      searchMs: Math.min(Math.max(0, Math.round(row.searchMs)), 600_000),
    });
  } catch {
    // Observability must never break the request path.
  }
}

// --- Main search -----------------------------------------------------------

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
    safeSearch: v.optional(v.number()),
    page: v.optional(v.number()),
    deepRead: v.optional(v.boolean()),
    /** Explicit override of the decision engine (UI toggle). */
    forceSearch: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to use Omi Search.");

    const rl = rateLimit(`search:${userId}`);
    if (!rl.ok) {
      throw new Error(
        `Search rate limit reached — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    const trimmed = args.query.trim().slice(0, 500);
    if (trimmed.length < 2) {
      throw new Error("Type a question or topic to search.");
    }
    if (trimmed.length > 300) {
      throw new Error("That query is very long — try a shorter version.");
    }

    const started = Date.now();

    // --- Decision Engine: classify before any network call ----------------
    const decision = decideSearch(trimmed);

    // Calculations never need an engine — answer directly.
    if (decision.intent === "calculation") {
      const expr = trimmed.replace(/[^0-9+\-*/().,%^\s]/g, "").trim();
      let value = "";
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`"use strict"; return (${expr});`) as () => unknown;
        const out = fn();
        value = String(out);
      } catch {
        value = "";
      }
      const answer = value
        ? `${trimmed} = ${value}`
        : `${trimmed} — Omi couldn't evaluate this expression safely. Try a simpler form like (12*4)+7.`;
      await recordTelemetry(ctx, {
        userId,
        query: trimmed,
        mode: "calculation",
        engines: [],
        failedEngines: [],
        resultCount: 0,
        cacheHit: false,
        searchMs: Date.now() - started,
      });
      const searchId = await ctx.runMutation(internal.searchHistory.saveSearch, {
        userId,
        query: trimmed,
        answer,
        citations: [],
        engine: "Omi calculator (local, no search)",
      });
      return { searchId, cached: false, page: 1, engine: "calculator", intent: decision.intent };
    }

    if (!decision.needsSearch && !args.forceSearch) {
      throw new Error(
        `Omi classified this as a ${decision.intent} request that doesn't need a web search. Rephrase with what you want to look up, or toggle "Force search".`,
      );
    }

    // Effective filters: caller overrides > decision engine defaults.
    const category = args.category ?? decision.category;
    const timeRange = args.timeRange ?? decision.timeRange;
    const language = args.language ?? decision.language;
    const skipCache =
      decision.skipCache || args.page === undefined || args.page === 1
        ? decision.skipCache
        : true;

    const result = await runUniversalSearch(ctx, decision.cleanedQuery, {
      category,
      language,
      timeRange,
      safeSearch: args.safeSearch,
      page: args.page ?? 1,
      enrichPages: args.deepRead === true,
      skipCache,
      freshnessMatters: decision.intent === "current" || decision.intent === "news",
    });

    const brief = result.brief ?? extractiveBrief(decision.cleanedQuery, result.citations);
    const pack = buildEvidencePack(result.citations, { maxSources: 8 });
    const answer = `${brief}\n\n${sourcesFooter(pack)}\n— via ${result.engine}`;

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
      engine: `${result.engine} · intent: ${decision.intent}`,
    });

    await recordTelemetry(ctx, {
      userId,
      query: trimmed,
      mode: args.deepRead ? "deep-read" : decision.intent,
      engines: result.engine.split(" + "),
      failedEngines: [],
      resultCount: result.citations.length,
      cacheHit: result.cached,
      searchMs: Date.now() - started,
    });

    return {
      searchId,
      cached: result.cached,
      page: result.page,
      engine: result.engine,
      intent: decision.intent,
      reasons: decision.reasons,
    };
  },
});

// --- Autocomplete -----------------------------------------------------------

export const suggest = action({
  args: { query: v.string() },
  handler: async (_ctx, { query }) => {
    const q = query.trim().slice(0, 100);
    if (q.length < 2) return { suggestions: [] as string[] };
    const suggestions = await searxSuggestions(q);
    return { suggestions };
  },
});

// --- Single-page retrieval ---------------------------------------------------

/**
 * Page retrieval for a single citation — "read this source in full".
 * Returns extracted readable text for grounding follow-up questions.
 */
export const readSource = action({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");

    const rl = rateLimit(`read:${userId}`, 30);
    if (!rl.ok) {
      throw new Error(
        `Too many page reads — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    // SSRF guard: throws a safe message for internal/invalid URLs.
    const safe = assertSafeUrl(url);

    const page = await fetchPageText(safe.toString(), 6000);
    if (!page.ok) {
      throw new Error(
        `Couldn't extract that page (${page.error ?? "unknown"}).`,
      );
    }
    return { title: page.title, text: page.text, url: page.url, publishedAt: page.publishedAt };
  },
});

// --- URL research ------------------------------------------------------------

/**
 * URL analysis (spec §11/§13): validate → retrieve → extract → summarize →
 * answer questions about it. The summary is grounded ONLY in the page
 * content; when the AI layer is down, the first part of the extract is
 * returned with an explicit note instead of a fabricated summary.
 */
export const urlResearch = action({
  args: {
    url: v.string(),
    question: v.optional(v.string()),
  },
  handler: async (ctx, { url, question }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");

    const rl = rateLimit(`urlresearch:${userId}`, 10);
    if (!rl.ok) {
      throw new Error(
        `Too many URL analyses — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    const safe = assertSafeUrl(url);
    const started = Date.now();

    const page = await fetchPageText(safe.toString(), 8000);
    if (!page.ok) {
      await recordTelemetry(ctx, {
        userId,
        query: url.slice(0, 200),
        mode: "url-research",
        engines: [],
        failedEngines: [page.error ?? "extraction failed"],
        resultCount: 0,
        cacheHit: false,
        searchMs: Date.now() - started,
        error: page.error,
      });
      throw new Error(
        `Couldn't retrieve that page (${page.error ?? "unknown"}). Omi won't guess at its contents.`,
      );
    }

    let summary: string;
    const aiStarted = Date.now();
    try {
      const completion = await vly.ai.completion({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Omi's URL analyst. Summarize the page content below faithfully. Only state what the page actually says. 150 words max. If asked a specific question, answer it from the page; if the page doesn't cover it, say so plainly.",
          },
          {
            role: "user",
            content: `${question ? `Question: ${question}\n\n` : ""}Page title: ${page.title}\nURL: ${page.url}\n\nPage content:\n${page.text.slice(0, 6000)}`,
          },
        ],
        temperature: 0.2,
        maxTokens: 500,
      });
      const content = completion.success
        ? completion.data?.choices?.[0]?.message?.content ?? ""
        : "";
      summary =
        content.trim().length > 40
          ? content.trim()
          : `AI summary unavailable — here is the page extract:\n\n${page.text.slice(0, 1200)}`;
    } catch {
      summary = `AI summary unavailable — here is the page extract:\n\n${page.text.slice(0, 1200)}`;
    }

    await recordTelemetry(ctx, {
      userId,
      query: url.slice(0, 200),
      mode: "url-research",
      engines: [],
      failedEngines: [],
      resultCount: 1,
      cacheHit: false,
      searchMs: Date.now() - started,
      aiMs: Date.now() - aiStarted,
      pagesFetched: 1,
    });

    return {
      title: page.title,
      url: page.url,
      publishedAt: page.publishedAt,
      summary,
      retrievedAt: new Date().toISOString(),
    };
  },
});

// --- Status, health, readiness ----------------------------------------------

/** Engine + cost status for the UI (cost transparency panel). */
export const engines = action({
  args: {},
  handler: async () => {
    return getProviderStatus();
  },
});

/** Liveness: the router itself is up. */
export const health = action({
  args: {},
  handler: async () => {
    return {
      ok: true,
      service: "omi-search-router",
      version: "2.0",
      time: new Date().toISOString(),
    };
  },
});

/** Readiness: required components actually functional. */
export const ready = action({
  args: {},
  handler: async () => {
    const providers = getProviderStatus();
    const usable = providers.filter((p) => p.ready);
    const breakers = breakerStatus();
    const openBreakers = Object.entries(breakers)
      .filter(([, b]) => b.open)
      .map(([id]) => id);

    return {
      ready: usable.length > 0,
      engines: providers.map((p) => ({
        id: p.id,
        label: p.label,
        ready: p.ready,
        cost: p.cost,
        enabled: p.enabled,
        hint: p.hint,
      })),
      circuitBreakersOpen: openBreakers,
      primarySearchCostPerQuery: "$0",
      time: new Date().toISOString(),
    };
  },
});

/** URL extraction helper reused by omiChat's URL-analysis intent. */
export function urlFromQuery(query: string): string | null {
  return extractUrl(query);
}

export function looksLikeCalculation(query: string): boolean {
  return isCalculation(query);
}
