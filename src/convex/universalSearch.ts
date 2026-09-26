"use node";

/**
 * Universal search core shared by every Omi feature that needs live web
 * knowledge. Provider-independent: fans out over configured sources
 * (SearXNG primary — self-hosted, zero cost), merges with URL dedupe +
 * syndication dedupe + domain diversity + tiered relevance ranking
 * (searchEngine/quality.ts), boosts cross-source agreement, caches
 * results, and produces either an AI-synthesized brief or an extractive
 * brief. Never fabricates: the brief is grounded in real citations only.
 */

import type {
  SearchOptions,
  WebCitation,
} from "./searchProviders/types";
import { getConfiguredProviders } from "./searchProviders";
import { fetchPageText } from "./searchProviders/pageFetcher";
import { complete } from "./aiProviders";
import { cacheKeyFor } from "./searchCache";
import {
  normalizeUrl,
  domainOf,
  keywordSet,
  scoreSource,
  dedupeSyndication,
} from "./searchEngine/quality";
import { internal } from "./_generated/api";
import { guardedCall } from "./searchEngine/resilience";
// §45 — single source of truth for product identity, shared by every surface.
import { creatorIdentityBlock } from "./omiIdentity";
import type { ActionCtx } from "./_generated/server";

export type UniversalResult = {
  query: string;
  citations: WebCitation[];
  engine: string;
  brief: string | null;
  cached: boolean;
  page: number;
  totalPages: number;
  /** Engines that ran, for observability. */
  enginesTried?: string[];
  /** Engines that returned at least one result. */
  enginesWithResults?: string[];
  /** Engines that were called and failed. */
  failedEngines?: string[];
  /** Total wall-clock ms of the fan-out. */
  searchMs?: number;
};

const PER_ENGINE_LIMIT = 6;
const MAX_CITATIONS = 8;

/**
 * Fans out across every configured engine, merges results with dedupe and
 * domain diversity, ranks by tiered relevance, serves from cache when
 * possible, and enriches the top results with extracted page text when
 * snippets are thin.
 */
export async function runUniversalSearch(
  ctx: ActionCtx,
  query: string,
  opts?: SearchOptions & {
    perEngineLimit?: number;
    maxCitations?: number;
    enrichPages?: boolean;
    skipCache?: boolean;
    /** Freshness-sensitive queries rank recency higher and skip cache. */
    freshnessMatters?: boolean;
    /**
     * When a current-information question is asked, only engines that can
     * actually serve that vertical are run. Weather must not be answered by a
     * general web index, and a market question should not be routed to a book
     * catalogue. `undefined` keeps the full fan-out (the old behaviour).
     */
    preferredProviders?: string[];
  },
): Promise<UniversalResult> {
  const perEngine = opts?.perEngineLimit ?? PER_ENGINE_LIMIT;
  const maxCitations = opts?.maxCitations ?? MAX_CITATIONS;
  const page = Math.max(1, opts?.page ?? 1);
  const enrichPages = opts?.enrichPages ?? false;
  const freshnessMatters = opts?.freshnessMatters ?? false;

  const engineOpts: SearchOptions = {
    category: opts?.category,
    language: opts?.language,
    timeRange: opts?.timeRange,
    page,
  };

  const allProviders = getConfiguredProviders();
  const preferred = opts?.preferredProviders;
  const providers = preferred
    ? allProviders.filter((p) => preferred.includes(p.id))
    : allProviders;
  if (providers.length === 0) {
    // A vertical-specific filter that matches nothing must fall back to the
    // full fan-out rather than silently returning "no results" — the engines
    // that do exist may still answer, and an empty list is not evidence.
    if (allProviders.length > 0) {
      return runUniversalSearch(ctx, query, { ...opts, preferredProviders: undefined });
    }
    throw new Error("No search engines are available right now.");
  }

  // --- Cache read (fresh/current queries bypass it per spec §14) ---------
  const cacheKey = cacheKeyFor(query, {
    category: engineOpts.category,
    language: engineOpts.language,
    timeRange: engineOpts.timeRange,
    page,
  });

  if (!opts?.skipCache && !freshnessMatters) {
    const cached = await ctx.runQuery(internal.searchCache.read, { cacheKey });
    if (cached) {
      return {
        query,
        citations: cached.citations,
        engine: `${cached.engine} (cached)`,
        brief: null,
        cached: true,
        page,
        totalPages: page + 1, // unknown; assume more pages exist
      };
    }
  }

  // --- Multi-engine fan-out ----------------------------------------------
  const fanOutStarted = Date.now();
  const keywords = keywordSet(query);

  // Resilience (§7/§30): every provider call is (1) circuit-broken — a
  // repeatedly failing engine is skipped for a cooldown instead of being
  // re-tried on every search — and (2) timed out so a hung provider can
  // never stall the pipeline. Failed engines degrade the result set; they
  // never block the fan-out (Promise.allSettled error isolation).
  const perProviderTimeoutMs = Number(
    process.env.SEARCH_PROVIDER_TIMEOUT_MS ?? 12_000,
  );
  const settled = await Promise.allSettled(
    providers.map((p) =>
      guardedCall(
        p.id,
        p.label,
        () => p.search(query, perEngine, engineOpts),
        perProviderTimeoutMs,
      ).then((result) => ({ engine: p, result })),
    ),
  );

  const merged: Array<{ c: WebCitation; engine: string; score: number }> = [];
  const seenUrls = new Map<string, number>(); // normalized URL -> engine count
  const mergedByUrl = new Map<string, WebCitation>(); // provenance target
  const enginesUsed: string[] = [];
  const failures: string[] = [];

  for (const s of settled) {
    if (s.status === "rejected") {
      failures.push(
        s.reason instanceof Error ? s.reason.message : "engine failed",
      );
      continue;
    }
    const { engine, result } = s.value;
    if (result.citations.length > 0) enginesUsed.push(engine.label);
    for (const c of result.citations) {
      const url = normalizeUrl(c.url);
      const engineCount = (seenUrls.get(url) ?? 0) + 1;
      seenUrls.set(url, engineCount);
      const existing = mergedByUrl.get(url);
      if (existing) {
        // Cross-source agreement (spec §10): the same URL surfaced by 2+
        // independent engines earns a confidence bump in ranking, and
        // provenance (§8/§29) records exactly which sources found it.
        // REPETITION ≠ TRUTH — agreement lifts priority, it never replaces
        // source-quality scoring.
        existing.providers = [
          ...(existing.providers ?? []),
          engine.label,
        ].slice(0, 6);
        continue;
      }
      const citation: WebCitation = { ...c, url, providers: [engine.label] };
      mergedByUrl.set(url, citation);
      merged.push({ c: citation, engine: engine.label, score: 0 });
    }
  }

  if (merged.length === 0) {
    // The failure detail matters: an operator reading this needs to know WHICH
    // engines were tried, not just that "search failed".
    throw new Error(
      `All search engines failed for this query. Tried: ${providers
        .map((p) => p.id)
        .join(", ")}${failures.length > 0 ? ` | ${failures.join(" | ").slice(0, 260)}` : ""}`,
    );
  }

  // --- Tiered ranking + cross-source agreement ---------------------------
  // scoreSource: relevance (0.5) + authority tier + freshness (weighted up
  // when freshness matters) + completeness. Same URL found by 2+ independent
  // engines earns a confidence bump (spec: cross-source priority).
  for (const item of merged) {
    let score = scoreSource(item.c, keywords, { freshnessMatters });
    const agreement = seenUrls.get(normalizeUrl(item.c.url)) ?? 1;
    if (agreement > 1) {
      score = Math.min(1, score + 0.08 * (agreement - 1));
    }
    item.score = score;
    // Persist the score into the citation so downstream UIs and evidence
    // packs can show relevance/provenance without recomputing it.
    item.c.relevance = Math.round(score * 100) / 100;
  }
  merged.sort((a, b) => b.score - a.score);

  // --- Syndication dedupe: same story across sites → best copy only ------
  const unique = dedupeSyndication(merged);

  // --- Domain diversity: max 2 per domain --------------------------------
  const perDomain = new Map<string, number>();
  const diverse: Array<{ c: WebCitation; engine: string }> = [];
  for (const item of unique) {
    const domain = domainOf(item.c.url);
    const count = perDomain.get(domain) ?? 0;
    if (count >= 2) continue;
    perDomain.set(domain, count + 1);
    diverse.push(item);
    if (diverse.length >= maxCitations) break;
  }

  let citations = diverse.map((d) => d.c);

  // --- Page extraction (optional): deepen thin snippets -------------------
  if (enrichPages && citations.length > 0) {
    const thin = citations.filter(
      (c) => (c.snippet?.length ?? 0) < 220,
    );
    const targets = thin.slice(0, 3);
    if (targets.length > 0) {
      const extracted = await Promise.allSettled(
        targets.map((c) => fetchPageText(c.url, 3500)),
      );
      const byUrl = new Map<string, string>();
      for (const e of extracted) {
        if (e.status === "fulfilled" && e.value.ok) {
          byUrl.set(normalizeUrl(e.value.url), e.value.text);
        }
      }
      citations = citations.map((c) => {
        const extra = byUrl.get(normalizeUrl(c.url));
        return extra
          ? { ...c, snippet: `${c.snippet ?? ""}\n\n${extra}`.slice(0, 1200) }
          : c;
      });
    }
  }

  const engine =
    enginesUsed.length > 0
      ? enginesUsed.slice(0, 4).join(" + ") +
        (enginesUsed.length > 4 ? ` +${enginesUsed.length - 4} more` : "")
      : "Omi keyless engine";

  // --- Cache write (fire-and-forget; never blocks the answer) ------------
  try {
    await ctx.runMutation(internal.searchCache.write, {
      cacheKey,
      query,
      citations: citations.map((c) => ({
        title: c.title,
        url: c.url,
        snippet: c.snippet,
        imageUrl: c.imageUrl,
        publishedAt: c.publishedAt,
        providers: c.providers,
        author: c.author,
      })),
      engine,
    });
  } catch {
    // Cache failures must never break a search.
  }

  // --- Brief: AI synthesis preferred, extractive fallback ----------------
  const brief =
    (await synthesizeBrief(query, citations)) ??
    extractiveBrief(query, citations);

  return {
    query,
    citations,
    engine,
    brief,
    cached: false,
    page,
    totalPages: page + 1, // assume more pages exist; UI decides
    // Observability (current-info fix): which engines ran, which produced
    // results and which failed. Without these, "search returned nothing" is
    // undiagnosable — which is exactly why this bug took a full bug report.
    enginesTried: providers.map((p) => p.id),
    enginesWithResults: enginesUsed,
    failedEngines: failures.map((f) => f.slice(0, 120)),
    searchMs: Date.now() - fanOutStarted,
  };
}

async function synthesizeBrief(
  query: string,
  citations: WebCitation[],
): Promise<string | null> {
  try {
    const sourcesBlock = citations
      .map(
        (c, i) =>
          `[${i + 1}] ${c.title}\nURL: ${c.url}\nEXCERPT: ${c.snippet ?? ""}`,
      )
      .join("\n\n");

    // Routed as a summarization task — fast model, grounded synthesis.
    const completion = await complete({
      task: "summarization",
      messages: [
        {
          role: "system",
          content:
            creatorIdentityBlock() +
            "\n\nYou are Omi, the Universal AI inside Ominnovations Intelligence. You just received live web search results. Write a clear, direct answer to the user's question grounded ONLY in the provided excerpts. Cite sources inline using [1], [2] etc. matching the numbered sources. Keep it under 250 words. No preamble, no markdown headings.",
        },
        {
          role: "user",
          content: `Question: ${query}\n\nSources:\n${sourcesBlock}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 700,
    });

    if (!completion.ok) return null;
    const content = completion.content;
    return content.trim().length > 0 ? content.trim() : null;
  } catch {
    return null;
  }
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "how", "in", "is", "it", "its", "of", "on", "or", "that", "the", "to", "was",
  "what", "when", "where", "which", "who", "why", "will", "with", "do", "does",
  "did", "can", "could", "should", "would", "me", "my", "your", "you", "i",
]);

export function extractiveBrief(
  query: string,
  citations: WebCitation[],
): string {
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  type Scored = { text: string; idx: number; score: number };
  const sentences: Scored[] = [];

  citations.forEach((c, idx) => {
    if (!c.snippet) return;
    const parts = c.snippet
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 40 && s.length < 400);
    for (const s of parts) {
      const lower = s.toLowerCase();
      let score = 0;
      for (const k of keywords) {
        if (lower.includes(k)) score += 2;
      }
      if (/\b(is|are|means|refers to|defined as)\b/i.test(s)) score += 1;
      if (score > 0) sentences.push({ text: s, idx: idx + 1, score });
    }
  });

  sentences.sort((a, b) => b.score - a.score);

  const picked: Scored[] = [];
  const seenTexts: string[] = [];
  for (const s of sentences) {
    const norm = s.text.toLowerCase().slice(0, 60);
    if (seenTexts.some((t) => t === norm)) continue;
    seenTexts.push(norm);
    picked.push(s);
    if (picked.length >= 4) break;
  }

  if (picked.length === 0) {
    const lines = citations
      .map(
        (c, i) =>
          `[${i + 1}] ${c.title}${c.snippet ? ` — ${c.snippet.slice(0, 180)}` : ""}`,
      )
      .join("\n");
    return (
      "Here is what Omi found across the live web for your question:\n\n" +
      lines
    );
  }

  const body = picked.map((s) => `${s.text} [${s.idx}]`).join("\n\n");
  const sourceLine = citations
    .slice(0, 4)
    .map((c, i) => `[${i + 1}] ${c.title} (${domainOf(c.url)})`)
    .join("  ");

  return `${body}\n\nSources: ${sourceLine}`;
}
