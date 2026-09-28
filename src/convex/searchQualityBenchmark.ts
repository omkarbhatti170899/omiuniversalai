"use node";

/**
 * SEARCH-QUALITY BENCHMARK — 120+ queries, retrieval AND answer level.
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The provider benchmark answers "is provider X good?". The freshness benchmark
 * answers "did a current question get current evidence?". Neither answers the
 * question a user actually has: **"is the ANSWER right, and can I see why?"**
 *
 * So this runs the whole pipeline for every query and records both halves:
 *
 *   RETRIEVAL   — which providers ran, what they returned, how much of it was
 *                 dated, what survived normalisation, and what the gates kept
 *                 (with the reason every dropped source was dropped)
 *   ANSWER      — the deterministic answer text the product falls back to, its
 *                 inline citation markers, whether those markers resolve to a
 *                 real source, whether every retained source carries a date,
 *                 the freshness verdict, and the ranking's relevance score
 *
 * HONESTY CONTRACT — the part that matters most
 * ---------------------------------------------
 * Retrieval metrics are MACHINE-CHECKABLE. Semantic correctness ("is the medal
 * tally actually 5 gold?") is NOT: it needs a human reading the answer against
 * the real world. Every row therefore carries
 * `answerCorrectness: "NOT-MACHINE-VERIFIABLE"` and the report says so at the
 * top. This benchmark can prove an answer is *grounded, cited, dated and
 * on-topic*; it cannot prove it is TRUE, and it never claims to.
 *
 * It also cannot be gamed by lowering a threshold: the freshness window, the
 * topical floor and the ranking weights are read from the shipped modules, so a
 * change that makes a query "pass" shows up here as a change in what was
 * retrieved and kept, not as a redefinition of success.
 *
 * SAFETY: internalAction only, never routed. No key, no env value, no raw
 * upstream body, no user data — queries, domains, dates, counts, reasons.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { runUniversalSearch, extractiveBrief } from "./universalSearch";
import { decideSearch } from "./searchEngine/decision";
import {
  freshnessPolicyFor,
  minAgeHours,
  ageInDays,
  noVerificationMessage,
} from "./searchEngine/freshness";
import { classifyCurrentIntent } from "./searchEngine/intent";
import { planRetrieval } from "./searchEngine/rewrite";
import { isOffTopic, topicKeywords, sharesTopic, keywordSet } from "./searchEngine/quality";
import { matchTemporal, isWrongYear } from "./searchEngine/temporal";
import type { WebCitation } from "./searchProviders/types";

/**
 * THE QUERY MATRIX: [category, temporal token, query].
 *
 * `temporal` is the word/phrase class under test — the brief names `today`,
 * `latest`, `current`, `now`, `live`, `recent`, `2026`, and queries with NO
 * temporal word at all. Coverage is deliberately uneven because the failure
 * classes are uneven: news/India/multilingual questions are where the measured
 * defects actually were.
 */
const RAW: Array<[string, string, string]> = [
  // --- CURRENT NEWS -------------------------------------------------------
  ["current-news", "today", "what is happening in the world today"],
  ["current-news", "today", "today's top stories"],
  ["current-news", "latest", "latest news"],
  ["current-news", "latest", "latest world news"],
  ["current-news", "latest", "latest international headlines"],
  ["current-news", "current", "current events around the world"],
  ["current-news", "current", "what is the current situation in the world"],
  ["current-news", "now", "what is going on right now"],
  ["current-news", "live", "live news updates"],
  ["current-news", "live", "live breaking coverage"],
  ["current-news", "recent", "recent global developments"],
  ["current-news", "recent", "recently announced policy changes"],
  ["current-news", "2026", "news in 2026"],
  ["current-news", "none", "major world events"],
  ["current-news", "none", "geopolitical developments"],
  ["current-news", "today", "what happened today"],
  ["current-news", "live", "breaking news"],
  ["current-news", "now", "news right now"],

  // --- INDIA --------------------------------------------------------------
  ["india", "latest", "latest India news"],
  ["india", "today", "India news today"],
  ["india", "current", "current situation in India"],
  ["india", "2026", "India news 2026"],
  ["india", "none", "India economy"],
  ["india", "latest", "latest Indian stock market news"],
  ["india", "today", "Indian railways news today"],
  ["india", "current", "current Indian rupee exchange rate"],
  ["india", "live", "live India cricket score"],
  ["india", "recent", "recent Indian government announcements"],
  ["india", "2026", "India budget 2026"],
  ["india", "none", "Indian space programme"],

  // --- SPORTS -------------------------------------------------------------
  ["sports", "today", "football results today"],
  ["sports", "latest", "latest cricket match result"],
  ["sports", "live", "live football scores"],
  ["sports", "current", "current Premier League standings"],
  ["sports", "latest", "latest IPL news"],
  ["sports", "2026", "Formula 1 2026 season results"],
  ["sports", "none", "NBA standings"],
  ["sports", "latest", "latest tennis tournament results"],
  ["sports", "today", "today's match fixtures"],
  ["sports", "current", "who won the most recent F1 race"],
  ["sports", "2026", "Asian Games 2026 medal tally India"],
  ["sports", "latest", "latest Asian Games 2026 results"],
  ["sports", "current", "current Olympic medal table"],
  ["sports", "none", "history of the World Cup final"],

  // --- FINANCE ------------------------------------------------------------
  ["finance", "today", "stock market today"],
  ["finance", "latest", "latest gold price"],
  ["finance", "current", "current USD to INR rate"],
  ["finance", "live", "live sensex level"],
  ["finance", "current", "current price of bitcoin"],
  ["finance", "latest", "latest inflation data"],
  ["finance", "2026", "interest rates 2026"],
  ["finance", "none", "S&P 500 index"],
  ["finance", "today", "rupee exchange rate today"],
  ["finance", "recent", "recently announced layoffs in tech"],
  ["finance", "none", "what is quantitative easing"],
  ["finance", "latest", "latest crypto market news"],

  // --- TECHNOLOGY ---------------------------------------------------------
  ["technology", "today", "today's technology news"],
  ["technology", "latest", "latest AI announcements"],
  ["technology", "current", "current top AI models"],
  ["technology", "2026", "AI news 2026"],
  ["technology", "none", "what is kubernetes"],
  ["technology", "latest", "latest smartphone launches"],
  ["technology", "recent", "recent open source releases"],
  ["technology", "current", "current version of TypeScript"],
  ["technology", "none", "rust vs go comparison"],
  ["technology", "latest", "latest chip manufacturing news"],
  ["technology", "today", "technology news today"],
  ["technology", "2026", "2026 technology trends"],

  // --- SCIENCE ------------------------------------------------------------
  ["science", "latest", "latest science news"],
  ["science", "current", "current space missions"],
  ["science", "today", "science news today"],
  ["science", "none", "what is CRISPR"],
  ["science", "2026", "space missions 2026"],
  ["science", "latest", "latest research on cancer treatment"],
  ["science", "recent", "recently published physics papers"],
  ["science", "none", "photosynthesis explained"],
  ["science", "current", "current Mars rover status"],
  ["science", "2026", "climate report 2026"],

  // --- WEATHER ------------------------------------------------------------
  ["weather", "today", "today's weather"],
  ["weather", "current", "current weather in Mumbai"],
  ["weather", "live", "live weather radar in London"],
  ["weather", "today", "weather in Delhi today"],
  ["weather", "none", "will it rain in Tokyo tomorrow"],
  ["weather", "current", "current temperature in New York"],
  ["weather", "today", "today's forecast for Sydney"],
  ["weather", "none", "what causes rain"],

  // --- REGIONS ------------------------------------------------------------
  ["usa", "latest", "latest US news"],
  ["usa", "today", "US news today"],
  ["usa", "current", "current US politics"],
  ["usa", "latest", "latest NASA mission"],
  ["usa", "2026", "US election news 2026"],
  ["europe", "latest", "latest European Union news"],
  ["europe", "today", "news in Europe today"],
  ["europe", "current", "current EU policy"],
  ["europe", "latest", "latest news from Germany"],
  ["europe", "none", "eurozone economy"],
  ["asia", "latest", "latest news from Asia"],
  ["asia", "today", "Asia news today"],
  ["asia", "current", "current situation in China"],
  ["asia", "latest", "latest news from Southeast Asia"],
  ["australia", "latest", "latest Australian news"],
  ["australia", "today", "Australia news today"],
  ["australia", "none", "Australian bushfire season"],
  ["australia", "current", "current Australian interest rate"],
  ["japan", "latest", "latest Japan news"],
  ["japan", "today", "Japan news today"],
  ["japan", "none", "Japanese economy"],
  ["japan", "2026", "Japan 2026 events"],
  ["south-korea", "latest", "latest South Korea news"],
  ["south-korea", "today", "South Korea news today"],
  ["south-korea", "none", "South Korean technology sector"],

  // --- MULTILINGUAL -------------------------------------------------------
  ["multilingual", "latest", "dernières nouvelles France"],
  ["multilingual", "latest", "aktuelle Nachrichten Deutschland"],
  ["multilingual", "latest", "日本の最新ニュース"],
  ["multilingual", "latest", "últimas noticias España"],
  ["multilingual", "latest", "ultime notizie Italia"],
  ["multilingual", "today", "nouvelles du jour en France"],
  ["multilingual", "current", "noticias actuales de México"],
  ["multilingual", "latest", "آخر الأخبار"],
  ["multilingual", "none", "what is the capital of Peru"],

  // --- OBSCURE ------------------------------------------------------------
  ["obscure", "current", "Kerguelen Islands current research station status"],
  ["obscure", "latest", "latest news about the Faroe Islands"],
  ["obscure", "none", "Svalbard Global Seed Vault capacity"],
  ["obscure", "today", "what happened in Tuvalu today"],
  ["obscure", "current", "current population of Pitcairn Islands"],
  ["obscure", "latest", "latest research on tardigrades"],

  // --- HISTORICAL (must NOT be forced live) -------------------------------
  ["historical", "none", "Who won the 2016 Olympics men's 100m?"],
  ["historical", "none", "what happened in the 2008 financial crisis"],
  ["historical", "none", "when was the Battle of Waterloo"],
  ["historical", "none", "history of the Roman Empire"],
  ["historical", "2026", "Asian Games 2018 medal tally"],
  ["historical", "none", "origin of the Olympic Games"],

  // --- CURRENT EVENTS (event-scoped, year-bearing) ------------------------
  ["current-events", "2026", "Indian contingent medals tally in Asian Games 2026"],
  ["current-events", "2026", "2026 Winter Olympics results"],
  ["current-events", "2026", "COP31 2026 outcome"],
  ["current-events", "current", "current status of the Rugby World Cup"],
  ["current-events", "latest", "latest on the Nobel Prize 2026"],
  ["current-events", "none", "upcoming general elections"],
];

export type QualityRow = {
  query: string;
  category: string;
  temporal: string;
  requiresFreshness: boolean;
  vertical: string;
  retrieval: {
    providersSearched: string[];
    providersFailed: string[];
    rawCount: number;
    normalizedCount: number;
    normalizedDated: number;
    keptCount: number;
    keptDomains: number;
    newestSourceAgeHours: number | null;
    relevanceAvg: number;
    /** Kept sources sharing no subject word with the question. Must be 0. */
    offTopicKept: number;
    /** Kept sources about a different year than asked. Must be 0. */
    wrongYearKept: number;
    freshnessMet: boolean;
    freshnessStatement: string | null;
    dropReasons: Record<string, number>;
    finalSources: Array<{
      title: string;
      url: string;
      domain: string;
      publishedAt: string | null;
      ageHours: number | null;
      relevance: number | null;
      providers: string[];
    }>;
  };
  answer: {
    text: string;
    length: number;
    isRefusal: boolean;
    citationMarkers: number[];
    /** Every [n] marker resolves to a listed source, and URLs are unique. */
    citationsResolve: boolean;
    duplicateUrls: number;
    /** Every retained source carries a date. An undated source is not current. */
    allSourcesDated: boolean;
    /** The answer states a freshness window when the question demanded one. */
    statesFreshness: boolean;
  };
  totalMs: number;
  /**
   * DELIBERATELY NOT A MACHINE VERDICT. Retrieval can be measured; whether the
   * answer is TRUE needs a human. This field exists so nobody mistakes the
   * other numbers for a correctness score.
   */
  answerCorrectness: "NOT-MACHINE-VERIFIABLE";
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}

/** Marker indices like `[1]`, `[12]` — sorted, de-duplicated. */
export function citationMarkersIn(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

export const runSearchQualityBenchmark = internalAction({
  args: {
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
    categories: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const filtered = args.categories?.length
      ? RAW.filter(([cat]) => args.categories!.includes(cat))
      : RAW;
    const offset = Math.max(0, args.offset ?? 0);
    const limit = Math.max(1, args.limit ?? filtered.length);
    const slice = filtered.slice(offset, offset + limit);

    const rows: QualityRow[] = [];

    for (const [category, temporal, query] of slice) {
      const started = Date.now();
      const decision = decideSearch(query);
      const policy = freshnessPolicyFor(query, decision.intent);
      const classified = classifyCurrentIntent(query, decision.intent);
      const retrievalPlan = planRetrieval(query, classified);

      let raw: WebCitation[] = [];
      let enginesTried: string[] = [];
      let enginesWithResults: string[] = [];
      let failedEngines: string[] = [];
      let engineError: string | null = null;
      try {
        const universal = await runUniversalSearch(ctx, retrievalPlan.primary, {
          retrievalVariants: retrievalPlan.variants,
          variantTargets: retrievalPlan.variantTargets,
          perEngineLimit: 5,
          maxCitations: 12,
          category: decision.category,
          timeRange: policy.timeRange ?? decision.timeRange,
          skipCache: true,
          freshnessMatters: policy.requiresFreshness,
          askedYears: policy.years,
          askedEvent: policy.event,
          strictVertical: false,
          preferredProviders: policy.requiresFreshness
            ? policy.preferredProviders
            : undefined,
        });
        raw = universal.citations;
        enginesTried = universal.enginesTried ?? [];
        enginesWithResults = universal.enginesWithResults ?? [];
        failedEngines = universal.failedEngines ?? [];
      } catch (e) {
        engineError = e instanceof Error ? e.message : String(e);
      }

      // --- the gates, judged exactly as the chat turn judges them ----------
      const topic = topicKeywords(query);
      const yearScoped = policy.years.length > 0 || Boolean(policy.event);
      const dropReasons: Record<string, number> = {};
      const kept: WebCitation[] = [];
      for (const c of raw) {
        // `ageInDays` — the SAME helper the freshness engine uses — returns null
        // for a missing OR unparseable date. MEASURED BUG in this benchmark: it
        // counted a source as "dated" whenever `publishedAt` was a non-empty
        // string, so a provider returning an unparseable value looked like a
        // dated source while `minAgeHours` correctly ignored it. The diagnostic
        // must judge dates exactly as production does, or it reports a
        // freshness the product does not have.
        const age = policy.requiresFreshness ? ageInDays(c.publishedAt) : 0;
        let reason: string | null = null;
        if (policy.requiresFreshness && (age === null || age > policy.maxAgeDays)) {
          reason = age === null ? "undated" : "outside freshness window";
        } else if (isOffTopic(c, topic)) {
          reason = "shares no subject word";
        } else if (yearScoped && isWrongYear(matchTemporal(c, policy.years, null))) {
          reason = "different year";
        }
        if (reason) dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
        else kept.push(c);
      }

      const keywords = keywordSet(query);
      const newest = minAgeHours(kept, Date.now());
      const relevanceAvg =
        kept.length === 0
          ? 0
          : Math.round(
              (kept.reduce((s, c) => s + (c.relevance ?? 0), 0) / kept.length) * 1000,
            ) / 1000;

      // --- ANSWER LEVEL ----------------------------------------------------
      const answerText = extractiveBrief(query, kept);
      const refusal = noVerificationMessage(query, policy.vertical);
      const markers = citationMarkersIn(answerText);
      const urls = kept.map((c) => c.url);
      const duplicateUrls = urls.length - new Set(urls).size;
      const citationsResolve =
        markers.length === 0 ||
        (markers.every((m) => m >= 1 && m <= kept.length) && duplicateUrls === 0);

      rows.push({
        query,
        category,
        temporal,
        requiresFreshness: policy.requiresFreshness,
        vertical: policy.vertical,
        retrieval: {
          providersSearched: enginesTried.length > 0 ? enginesTried : enginesWithResults,
          providersFailed: [
            ...failedEngines.map((f) => f.slice(0, 80)),
            ...(engineError ? [engineError.slice(0, 120)] : []),
          ],
          rawCount: raw.length,
          normalizedCount: raw.length,
          normalizedDated: raw.filter((c) => ageInDays(c.publishedAt) !== null).length,
          keptCount: kept.length,
          keptDomains: new Set(urls).size,
          newestSourceAgeHours: newest === null ? null : Math.round(newest * 10) / 10,
          relevanceAvg,
          offTopicKept: kept.filter((c) => !sharesTopic(c, keywords)).length,
          wrongYearKept: yearScoped
            ? kept.filter((c) => isWrongYear(matchTemporal(c, policy.years, null))).length
            : 0,
          freshnessMet:
            !policy.requiresFreshness ||
            (newest !== null && newest <= policy.preferFreshHours),
          freshnessStatement: null,
          dropReasons,
          finalSources: kept.map((c) => ({
            title: c.title.slice(0, 110),
            url: c.url,
            domain: domainOf(c.url),
            publishedAt: c.publishedAt ?? null,
            ageHours: (() => {
              const d = ageInDays(c.publishedAt);
              return d === null ? null : Math.round(d * 24 * 10) / 10;
            })(),
            relevance: c.relevance ?? null,
            providers: c.providers ?? [],
          })),
        },
        answer: {
          text: answerText.slice(0, 900),
          length: answerText.length,
          isRefusal: answerText.trim() === refusal.trim(),
          citationMarkers: markers,
          citationsResolve,
          duplicateUrls,
          // A date is only "carried" if it PARSES. A present-but-unparseable
          // value is not a date the freshness gate will trust either.
          allSourcesDated: kept.every((c) => ageInDays(c.publishedAt) !== null),
          statesFreshness: /published|hours ago|days ago|today|yesterday/i.test(answerText),
        },
        totalMs: Date.now() - started,
        answerCorrectness: "NOT-MACHINE-VERIFIABLE",
      });
    }

    const byCategory: Record<string, { n: number; kept: number; fresh: number }> = {};
    const byTemporal: Record<string, { n: number; kept: number; fresh: number }> = {};
    for (const r of rows) {
      const f = r.retrieval.freshnessMet ? 1 : 0;
      const c = (byCategory[r.category] ??= { n: 0, kept: 0, fresh: 0 });
      c.n += 1;
      c.kept += r.retrieval.keptCount;
      c.fresh += f;
      const t = (byTemporal[r.temporal] ??= { n: 0, kept: 0, fresh: 0 });
      t.n += 1;
      t.kept += r.retrieval.keptCount;
      t.fresh += f;
    }

    return {
      total: filtered.length,
      ran: rows.length,
      offset,
      byCategory,
      byTemporal,
      /** Machine-checkable answer contract across the whole batch. */
      answerContract: {
        withCitations: rows.filter((r) => r.answer.citationMarkers.length > 0).length,
        citationsResolve: rows.filter((r) => r.answer.citationsResolve).length,
        allSourcesDated: rows.filter((r) => r.answer.allSourcesDated).length,
        zeroKept: rows.filter((r) => r.retrieval.keptCount === 0).length,
        offTopicKeptTotal: rows.reduce((s, r) => s + r.retrieval.offTopicKept, 0),
        wrongYearKeptTotal: rows.reduce((s, r) => s + r.retrieval.wrongYearKept, 0),
        duplicateUrlTotal: rows.reduce((s, r) => s + r.answer.duplicateUrls, 0),
      },
      rows,
      note:
        "Retrieval metrics are machine-checkable. answerCorrectness is NOT: proving an answer is TRUE " +
        "needs a human reading it against the real world. This benchmark proves an answer is grounded, " +
        "cited, dated and on-topic — never that it is correct.",
    };
  },
});
