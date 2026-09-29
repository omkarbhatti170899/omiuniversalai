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
  dedupeSyndication,
} from "./searchEngine/quality";
import { internal } from "./_generated/api";
import { guardedCall, strictVerticalFallbackFor } from "./searchEngine/resilience";
import {
  scoreSourceDetailed,
  usefulnessPenalty,
  answerabilityPenalty,
  questionTypeFor,
} from "./searchEngine/quality";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
import { recordProviderObservation } from "./searchEngine/providerHealth";
import { providerTimeoutMs } from "./searchEngine/providerTimeouts";
import { drainSearxEngineDeltas } from "./searchProviders/searxngEngineHealth";
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
 * Per-provider timeout budgets and their override names now live in
 * `searchEngine/providerTimeouts.ts`.
 *
 * They were extracted because the override name is a correctness rule, not a
 * detail: provider ids legitimately contain hyphens
 * ("wikipedia-current-events", "duckduckgo-instant") and an environment
 * variable name may not, so the name must be sanitised to
 * `SEARCH_TIMEOUT_MS_WIKIPEDIA_CURRENT_EVENTS`. Spelling it with the hyphen
 * makes Convex THROW rather than return undefined — a throw that propagated
 * out of the fan-out and turned every search into a hard refusal. Keeping the
 * rule in a pure module lets the test suite pin the exact hyphenated id that
 * caused the outage, which this file cannot do (it is a `"use node"` action
 * that pulls in the generated Convex API).
 */

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
    /**
     * Absolute wall-clock deadline (Date.now() ms) for the WHOLE search — the
     * global budget every provider timeout is capped against. Set by callers
     * that run a second (escalation) pass so pass 2 cannot double the worst
     * case: pass 2 inherits the SAME deadline, so its providers get whatever
     * slice remains instead of a fresh full budget.
     */
    deadlineAt?: number;
    /** Freshness-sensitive queries rank recency higher and skip cache. */
    freshnessMatters?: boolean;
    /**
     * When a current-information question is asked, only engines that can
     * actually serve that vertical are run. Weather must not be answered by a
     * general web index, and a market question should not be routed to a book
     * catalogue. `undefined` keeps the full fan-out (the old behaviour).
     */
    preferredProviders?: string[];
    /**
     * When true, `preferredProviders` is a hard constraint: if none of them
     * answer, the search FAILS honestly instead of falling back to the full
     * fan-out. Without this, "today's weather" could be answered by a news
     * index and "what's the score" by a news article — precisely the
     * "ordinary web search is not a real-time database" failure the current
     * information contract forbids.
     *
     * 2026-09-28 amendment: strict no longer means "dead end". When the
     * vertical's structured feed is down, the orchestrator degrades once to
     * the vertical's dated general-web backstop (see
     * `strictVerticalFallbackFor`). The answer is still never faked and never
     * taken from an unrelated vertical.
     */
    strictVertical?: boolean;
    /**
     * The classified vertical ("weather" | "sports" | "markets" | …), used
     * only to choose the honest backstop when a strict vertical's feed fails.
     */
    verticalName?: string;
    /** Guards the strict-vertical backstop against infinite recursion. */
    attemptedBackstop?: boolean;
    /**
     * Years / the event the question is scoped to. When present, ranking
     * penalises sources about a DIFFERENT year or event, which is what stops
     * a 2018 Asian Games article from outranking the 2026 medal tally.
     * Recency cannot express this: a page published last week about the 2018
     * Games is fresh by timestamp and wrong by content.
     */
    askedYears?: number[];
    askedEvent?: string | null;
    /**
     * The USER's original question (not the rewritten retrieval string). The
     * ranker derives the QUESTION TYPE (ranking/result/value/…) from its
     * interrogative frame and enforces a HARD ANSWERABILITY FLOOR against it:
     * a page whose text cannot evidence the kind of answer asked for is
     * rejected no matter how fresh or on-topic. Measured (a504ac2): a Kim
     * Kardashian F1 article was selected as the sole evidence for "who is
     * leading the F1 2026 drivers championship" — fresh, dated, on-entity,
     * and incapable of answering a standings question.
     */
    userQuestion?: string;
    /**
     * Rewritten variants, fanned out to GENERAL-WEB providers only.
     *
     * A single phrasing under-recalls: different wordings surface different
     * sources. Structured providers (weather, rates, scores) still receive
     * `query` alone — they know what to ask for, and a rewrite only confuses
     * them. Bounded to keep latency predictable.
     */
    retrievalVariants?: string[];
    /** Provider ids that may receive the variants. */
    variantTargets?: string[];
    /**
     * How aggressively recency outranks everything else. Forwarded to the
     * ranker so "today" genuinely means today.
     */
    freshnessTier?: string;
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
    // MEASURED DEFECT (search-quality benchmark, 2026-09-28): a strict
    // vertical whose single provider is down used to throw "No source … is
    // available right now" with no second attempt — every weather query in
    // the benchmark failed that way while Open-Meteo itself was merely 429ing.
    // The vertical answer must still never be FAKED, but a down feed may
    // degrade to the dated general-web backstop.
    const backstop = strictVerticalFallbackFor(opts?.verticalName);
    if (backstop) {
      const available = allProviders.filter((p) => backstop.includes(p.id));
      // MEASURED DEFECT (2026-09-29): the configured providers list may be
      // EMPTY in an isolate whose env vars are missing (cold start, sandbox)
      // while the same deployment serves them elsewhere. Falling back to a
      // filtered-empty list re-enters with zero providers and throws. Use the
      // backstop ids directly — the recursive call re-resolves configured
      // providers there, and its own empty-guard is the honest failure.
      const backstopIds = available.length > 0 ? available.map((p) => p.id) : backstop;
      return runUniversalSearch(ctx, query, {
        ...opts,
        preferredProviders: backstopIds,
        strictVertical: false,
        verticalName: opts?.verticalName,
      });
    }
    // A strict vertical (weather, a requested scoreline) has exactly one
    // honest source type. If it is not available, say so — do not let a
    // different vertical answer in its place.
    if (opts?.strictVertical) {
      throw new Error(
        `No source that can serve a ${opts.preferredProviders?.join("/") ?? "current"} answer is available right now.`,
      );
    }
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
  const defaultProviderTimeoutMs = Number(
    process.env.SEARCH_PROVIDER_TIMEOUT_MS ?? 12_000,
  );
  // GLOBAL SEARCH DEADLINE (round 8): a caller-imposed wall-clock budget for
  // the WHOLE search. Every provider's timeout is capped at what remains of
  // the deadline, so a slow provider cannot outlive the budget — its Promise
  // is cut off by guardedCall's timer even if its own socket would keep the
  // request alive. `Promise.allSettled` already means one slow engine cannot
  // break others; the deadline means it cannot even make them WAIT for it.
  const globalDeadlineAt = opts?.deadlineAt; // absolute wall-clock ms
  const settled = await Promise.allSettled(
    providers.flatMap((p) => {
      // General-web providers additionally see each rewritten angle; a
      // structured provider gets exactly one call with the primary query.
      const variants =
        opts?.retrievalVariants && (opts?.variantTargets ?? []).includes(p.id)
          ? opts.retrievalVariants
          : [];
      const perProviderTimeoutMs = providerTimeoutMs(p.id, defaultProviderTimeoutMs);
      // Cap by the global deadline's remaining slice (min 1.5 s so a provider
      // called at the edge of the deadline still gets a real chance).
      const remainingBudget =
        globalDeadlineAt !== undefined
          ? Math.max(1_500, globalDeadlineAt - Date.now())
          : perProviderTimeoutMs;
      const effectiveTimeout = Math.min(perProviderTimeoutMs, remainingBudget);
      const calls = [query, ...variants].map((q) => {
        // Health is measured around the REAL call, so the numbers reflect what
        // the provider actually did rather than what its status page claims.
        // Failure is still isolated: a health-recording error can never fail a
        // search.
        const started = Date.now();
        return guardedCall(
          p.id,
          p.label,
          () => p.search(q, perEngine, engineOpts),
          effectiveTimeout,
        )
          .then((result) => {
            try {
              recordProviderObservation(p.id, {
                ok: true,
                timedOut: false,
                latencyMs: Date.now() - started,
                results: result.citations.length,
                datedResults: result.citations.filter((c) => Boolean(c.publishedAt)).length,
                // A provider that only echoes URLs another provider already
                // returned adds no independent corroboration. Measured here so
                // "which provider is actually adding signal" is answerable.
                duplicates: result.citations.filter((c) => seenUrls.has(normalizeUrl(c.url))).length,
                at: Date.now(),
              });
            } catch {
              /* telemetry must never break a search */
            }
            return { engine: p, result };
          })
          .catch((err) => {
            try {
              recordProviderObservation(p.id, {
                ok: false,
                timedOut: /timeout|timed out/i.test(
                  err instanceof Error ? err.message : String(err),
                ),
                latencyMs: Date.now() - started,
                results: 0,
                datedResults: 0,
                duplicates: 0,
                at: Date.now(),
              });
            } catch {
              /* telemetry must never break a search */
            }
            throw err;
          });
      });
      return calls;
    }),
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
          engine.id,
        ]
          .filter((p, i, all) => all.indexOf(p) === i)
          .slice(0, 6);
        continue;
      }
      // Provenance records the provider ID, not its display label. Ids are the
      // stable key that routing, the health store and the trace's contribution
      // rollup all join on; a label is presentation text that can be reworded
      // and is not unique. The adapter's own declared providers are preserved
      // so a provider that knows it answered under another name is not erased.
      const declared = (c.providers ?? []).filter((p) => p !== engine.label);
      const citation: WebCitation = {
        ...c,
        url,
        providers: [engine.id, ...declared.filter((p) => p !== engine.id)].slice(0, 6),
      };
      mergedByUrl.set(url, citation);
      merged.push({ c: citation, engine: engine.label, score: 0 });
    }
  }

  if (merged.length === 0) {
    // MEASURED DEFECT (search-quality benchmark, 2026-09-28): a strict
    // vertical whose ONLY provider failed (Open-Meteo 429, TheSportsDB empty,
    // breaker open) reached here and threw "All search engines failed" — no
    // second chance, the whole turn failed. The backstop below degrades to
    // the dated general-web floor instead. It can only fire ONCE (the flag is
    // cleared), so a failing backstop still surfaces honestly.
    const backstop =
      opts?.strictVertical
        ? strictVerticalFallbackFor(opts?.verticalName)
        : null;
    if (backstop) {
      const available = allProviders.filter(
        (p) => backstop.includes(p.id) && !providers.some((q) => q.id === p.id),
      );
      if (available.length > 0) {
        return runUniversalSearch(ctx, query, {
          ...opts,
          preferredProviders: available.map((p) => p.id),
          strictVertical: false,
          verticalName: opts?.verticalName,
          attemptedBackstop: true,
        });
      }
    }
    // MEASURED DEFECT (2026-09-29, FAIL 4/5): a freshness question narrowed to
    // ONE structured feed ("Formula 1 2026 season results", "NBA standings" →
    // sports-scores) that legitimately had no data died here with
    // "All search engines failed ... Tried: sports-scores" even though SearXNG
    // and LangSearch were configured and answering in the same deployment.
    // An empty vertical result is NOT evidence that the web has nothing. ONE
    // full fan-out retry is the honest degradation — and the recursion's own
    // empty guard is the honest failure if the whole web is silent too.
    if (
      !opts?.attemptedBackstop &&
      providers.length > 0 &&
      providers.length < allProviders.length
    ) {
      return runUniversalSearch(ctx, query, {
        ...opts,
        preferredProviders: undefined,
        strictVertical: false,
        attemptedBackstop: true,
      });
    }
    // The failure detail matters: an operator reading this needs to know WHICH
    // engines were tried, not just that "search failed".
    throw new Error(
      `All search engines failed for this query. Tried: ${providers
        .map((p) => p.id)
        .join(", ")}${failures.length > 0 ? ` | ${failures.join(" | ").slice(0, 260)}` : ""}`,
    );
  }

  const ranked: Array<{ c: WebCitation; engine: string; score: number }> = [];
  // --- Tiered ranking + cross-source agreement ---------------------------
  // scoreSourceDetailed: relevance + freshness + authority + sourceQuality +
  // directness, then temporal × usefulness multiplicative penalties. Same URL
  // found by 2+ independent engines earns a corroboration bump (spec:
  // cross-source priority). The full BREAKDOWN is persisted onto the citation
  // so the benchmark/UI can show WHY a source ranked where it did.
  for (const item of merged) {
    const bd = scoreSourceDetailed(item.c, keywords, {
      freshnessMatters,
      askedYears: opts?.askedYears,
      askedEvent: opts?.askedEvent,
      freshnessTier: opts?.freshnessTier,
      userQuestion: opts?.userQuestion,
    });
    const agreement = seenUrls.get(normalizeUrl(item.c.url)) ?? 1;
    if (agreement > 1) {
      bd.corroboration = round2(Math.min(0.08 * (agreement - 1), 0.24));
      bd.final = round2(Math.min(1, bd.final + bd.corroboration));
    }
    item.score = bd.final;
    // Persist the score into the citation so downstream UIs and evidence
    // packs can show relevance/provenance without recomputing it.
    item.c.relevance = bd.final;
    item.c.scoreBreakdown = bd;
    // The NOISE FLOOR: an obviously non-answering page (video-platform
    // result, clickbait, tag/category page) never enters the final set, no
    // matter how fresh. This is the measured "YouTube + actors workshop" fix:
    // for broad questions the topical floor cannot catch them, but a
    // usefulness penalty ≥0.45 means the page is noise by construction.
    if (usefulnessPenalty(item.c) >= 0.45) continue;
    // The ANSWERABILITY FLOOR (hard, measured a504ac2): freshness must NEVER
    // compensate for extremely poor answerability. A page penalised ≥0.45 by
    // the question-type check (no evidence vocabulary AND/OR untrustworthy
    // domain for the answer's kind) is rejected at selection, not merely
    // down-ranked — the same mechanical shape as the noise floor. Structured
    // feed rows (live scores, official standings) carry their answer by
    // construction and are exempt.
    if (
      opts?.userQuestion &&
      item.c.providers?.includes("sports-scores") !== true &&
      answerabilityPenalty(item.c, questionTypeFor(opts.userQuestion)) >= 0.45
    ) {
      continue;
    }
    ranked.push(item);
  }
  ranked.sort((a, b) => b.score - a.score);

  // --- Syndication dedupe: same story across sites → best copy only ------
  // Consumes `ranked` (score-sorted, noise-floored), not the raw merge —
  // dedupeSyndication requires best-first input to keep the best copy.
  const unique = dedupeSyndication(ranked);

  // --- Domain diversity: max 2 per domain --------------------------------
  const perDomain = new Map<string, number>();
  const diverse: Array<{ c: WebCitation; engine: string; score: number }> = [];
  for (const item of unique) {
    const domain = domainOf(item.c.url);
    const count = perDomain.get(domain) ?? 0;
    if (count >= 2) continue;
    perDomain.set(domain, count + 1);
    diverse.push(item);
    if (diverse.length >= maxCitations) break;
  }

  let citations = diverse.map((d) => d.c);

  // RELEVANCE per provider, into the health registry: the mean final score of
  // the citations each provider contributed to the FINAL set. This is what
  // makes "which engine returns signal, not just volume" answerable on the
  // status surface — a fast engine whose results are all floored should not
  // outrank a slower one whose results survive every gate. Telemetry can
  // never fail a search.
  try {
    const byProviderScores = new Map<string, { sum: number; n: number }>();
    for (const item of diverse) {
      for (const p of item.c.providers ?? []) {
        const row = byProviderScores.get(p) ?? { sum: 0, n: 0 };
        row.sum += item.score;
        row.n += 1;
        byProviderScores.set(p, row);
      }
    }
    for (const [providerId, { sum, n }] of byProviderScores) {
      recordProviderObservation(providerId, {
        ok: true,
        timedOut: false,
        latencyMs: 0,
        results: n,
        datedResults: 0,
        duplicates: 0,
        relevanceScore: n > 0 ? sum / n : 0,
        at: Date.now(),
      });
    }
  } catch {
    /* telemetry must never break a search */
  }

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

  // --- SearXNG engine-health flush (fire-and-forget; never blocks) -------
  // MEASURED (round 8): draining deltas only inside the snapshot action never
  // sees data — the snapshot runs in a different isolate than the searches.
  // Flush from HERE, where the responses were just recorded, so the persisted
  // per-engine health survives isolate restarts. Deltas are drained ONCE
  // here; the snapshot's own drain sees only isolate-local leftovers.
  try {
    const deltas = drainSearxEngineDeltas();
    if (deltas.size > 0) {
      await ctx.runMutation(internal.searchEnginePersistence.upsertFromDeltas, {
        deltas: [...deltas.entries()].map(([e, d]) => ({ engine: e, ...d })),
      });
    }
  } catch {
    /* observability is best-effort */
  }

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
    parts.forEach((s, partIndex) => {
      const lower = s.toLowerCase();
      let score = 0;
      for (const k of keywords) {
        if (lower.includes(k)) score += 2;
      }
      if (/\b(is|are|means|refers to|defined as)\b/i.test(s)) score += 1;
      // The LEAD sentence of a source is its headline fact. Without a baseline
      // it was dropped whenever it shared no keyword with the question — which
      // is exactly what happened to a live scoreboard: "Portland Thorns v
      // Houston Dash — in play (1H), 0 – 0." matched no question word, so the
      // no-AI answer omitted every score and showed only the caveat.
      if (partIndex === 0) score += 2;
      if (score > 0) sentences.push({ text: s, idx: idx + 1, score });
    });
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
