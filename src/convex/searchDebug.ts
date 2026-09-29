/**
 * INTERNAL search debug mode (never exposed over HTTP, never public).
 *
 * Runs the REAL search pipeline for a query and reports WHY the answer looks
 * the way it does: the freshness decision and its reasons, the year/event the
 * question was scoped to, which providers ran, which sources were selected,
 * which were rejected as stale or wrong-year (and why), cross-source
 * conflicts, latency, and the final validation verdict.
 *
 * This exists because "the answer was wrong" is not a debuggable report. An
 * engineer needs to know whether the classifier mislabelled the question, the
 * engines returned nothing, the ranker preferred a stale source, or the gates
 * dropped good evidence — and the four look identical from the outside.
 *
 * Safety contract, matching diagnostics.ts:
 *   • internalAction only — no client can call it
 *   • returns queries, domains, dates, titles, counts and reasons
 *   • never a provider key, an env value, a raw upstream body, or user data
 *   • `assertTraceIsSafe` is run before returning, and the action FAILS LOUDLY
 *     rather than returning a trace that trips it
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { runUniversalSearch } from "./universalSearch";
import { getConfiguredProviders } from "./searchProviders";
import { withTimeout } from "./searchEngine/resilience";
import { providerTimeoutMs } from "./searchEngine/providerTimeouts";
import { decideSearch } from "./searchEngine/decision";
import {
  freshnessPolicyFor,
  splitByFreshness,
  minAgeHours,
  freshnessStatement,
  ageInDays,
  type FreshnessSource,
} from "./searchEngine/freshness";
import { classifyCurrentIntent } from "./searchEngine/intent";
import { planRetrieval } from "./searchEngine/rewrite";
import { matchTemporal, isWrongYear } from "./searchEngine/temporal";
import { isOffTopic, isNonSequiturForBroadNews, topicKeywords } from "./searchEngine/quality";
import { crossCheckClaims, conflictNotice } from "./searchEngine/crossCheck";
import { validateEvidence, cannotVerifyMessage } from "./searchEngine/validation";
import { buildSearchTrace, assertTraceIsSafe, summarizeTrace } from "./searchEngine/debugTrace";
import type { WebCitation } from "./searchProviders/types";

/** The queries the bug report names, plus a history control. */
const REPORTED_QUERIES = [
  "What is the Indian contingent medals tally in Asian Games 2026?",
  "latest India cricket score",
  "current gold price in India",
  "latest election results",
  "today's weather",
  "latest Apple stock price",
  "current USD INR rate",
  "latest AI news",
  "current IPL standings",
  "latest flight status",
  // Control: a settled historical question must NOT be forced live.
  "Who won the 2016 Olympics men's 100m?",
];

/** Classify one query without touching the network — the cheapest possible check. */
export const classifyQuery = internalAction({
  args: { query: v.string() },
  handler: async (_ctx, { query }) => {
    const decision = decideSearch(query);
    const policy = freshnessPolicyFor(query, decision.intent);
    const classified = classifyCurrentIntent(query, decision.intent);
    return {
      query,
      decision: {
        needsSearch: decision.needsSearch,
        intent: decision.intent,
        category: decision.category,
        skipCache: decision.skipCache,
      },
      freshness: {
        requiresFreshness: policy.requiresFreshness,
        vertical: policy.vertical,
        liveData: policy.liveData,
        maxAgeDays: policy.maxAgeDays,
        strict: policy.strict,
        askedYears: policy.years,
        askedEvent: policy.event,
        reasons: classified.reasons,
        historical: classified.historical,
      },
    };
  },
});

/** Classify every reported query at once — the regression suite, live. */
export const classifyReported = internalAction({
  args: {},
  handler: async () => {
    return REPORTED_QUERIES.map((query) => {
      const decision = decideSearch(query);
      const policy = freshnessPolicyFor(query, decision.intent);
      return {
        query,
        requiresFreshness: policy.requiresFreshness,
        vertical: policy.vertical,
        askedYears: policy.years,
        askedEvent: policy.event,
        intent: decision.intent,
      };
    });
  },
});

/**
 * Run the full live pipeline for one query and return the debug trace.
 *
 * `limit` bounds the returned source list so the output stays readable; the
 * counts in the trace are always complete.
 */
/**
 * THE BRIEF'S TEN QUERIES, verbatim. Every recency class plus the two that
 * exposed the failure (a 2026-scoped event and a multilingual question).
 */
const FRESHNESS_MATRIX_QUERIES = [
  "Indian contingent medals tally in Asian Games 2026",
  "latest India news",
  "latest world news",
  "today's technology news",
  "latest sports result",
  "current market information",
  "latest science news",
  "current weather",
  "dernières nouvelles France",
  "Kerguelen Islands current research station status",
];

/**
 * FRESHNESS BENCHMARK — the full pipeline, one row per provider per query.
 *
 * The single-provider benchmark answers "is this provider good?" by calling the
 * adapter DIRECTLY. That is the wrong instrument for "why did the answer come
 * back old?", because it never runs the ranking, the freshness gate or the
 * topic/year floors — the parts that actually drop evidence. This action runs
 * the REAL pipeline and records, per query:
 *
 *   • what each provider RETURNED (raw count, how many carried a date, latency,
 *     error) — measured directly, so a provider cannot be credited or blamed
 *     for another one's behaviour
 *   • what survived normalisation (the merged, deduped citation set)
 *   • what the freshness gate and the year/topic floors KEPT, with each final
 *     source's own date and relevance score
 *   • the freshness verdict (newest surviving source, in hours)
 *
 * Deliberately reports rather than "passes": a run that keeps nothing is a
 * result, not a failure to be hidden. It never lowers a threshold to make a
 * query look good, and it labels what it cannot judge (an undated source is
 * counted as undated, never as current).
 */
export const runFreshnessBenchmark = internalAction({
  args: { queries: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const queries = args.queries?.length ? args.queries : FRESHNESS_MATRIX_QUERIES;
    const configured = getConfiguredProviders();
    const rows: Array<Record<string, unknown>> = [];

    for (const query of queries) {
      const started = Date.now();
      const decision = decideSearch(query);
      const policy = freshnessPolicyFor(query, decision.intent);
      const classified = classifyCurrentIntent(query, decision.intent);
      const retrievalPlan = planRetrieval(query, classified);

      // (1) PER-PROVIDER DIRECT MEASUREMENT — the raw supply, before any gate.
      const preferred = policy.requiresFreshness ? policy.preferredProviders : [];
      const targets = configured.filter(
        (p) => preferred.length === 0 || preferred.includes(p.id),
      );
      const providers: Array<Record<string, unknown>> = [];
      for (const p of targets) {
        const t0 = Date.now();
        try {
          const res = await withTimeout(
            p.search(retrievalPlan.primary, 5, {
              category: decision.category,
              timeRange: policy.timeRange ?? decision.timeRange,
              page: 1,
            }),
            providerTimeoutMs(p.id, 12_000),
            p.label,
          );
          providers.push({
            id: p.id,
            ok: res.citations.length > 0,
            latencyMs: Date.now() - t0,
            rawResults: res.citations.length,
            datedResults: res.citations.filter((c) => Boolean(c.publishedAt)).length,
            oldestAgeHours: newestOrOldest(res.citations, "oldest"),
            newestAgeHours: newestOrOldest(res.citations, "newest"),
            error: null,
          });
        } catch (e) {
          providers.push({
            id: p.id,
            ok: false,
            latencyMs: Date.now() - t0,
            rawResults: 0,
            datedResults: 0,
            oldestAgeHours: null,
            newestAgeHours: null,
            error: (e instanceof Error ? e.message : String(e)).slice(0, 120),
          });
        }
      }

      // (2) END-TO-END — the same call the chat turn makes.
      let normalized: WebCitation[] = [];
      let engineError: string | null = null;
      let enginesWithResults: string[] = [];
      let failedEngines: string[] = [];
      try {
        const universal = await runUniversalSearch(ctx, retrievalPlan.primary, {
          retrievalVariants: retrievalPlan.variants,
          variantTargets: retrievalPlan.variantTargets,
          perEngineLimit: 4,
          maxCitations: 12,
          userQuestion: query,
          category: decision.category,
          timeRange: policy.timeRange ?? decision.timeRange,
          skipCache: true,
          freshnessMatters: policy.requiresFreshness,
          askedYears: policy.years,
          askedEvent: policy.event,
          strictVertical: false,
          preferredProviders: policy.requiresFreshness ? policy.preferredProviders : undefined,
        });
        normalized = universal.citations;
        enginesWithResults = universal.enginesWithResults ?? [];
        failedEngines = universal.failedEngines ?? [];
      } catch (e) {
        engineError = e instanceof Error ? e.message : String(e);
      }

      // (3) THE GATES — judged exactly as the chat turn judges them, and the
      // REASON for every drop is recorded. "5 of 12 kept" is not diagnosable;
      // "the freshest dated source was dropped for sharing no topic word" is.
      const topic = topicKeywords(query);
      const yearScoped = policy.years.length > 0 || Boolean(policy.event);
      const decisions = normalized.map((c: WebCitation) => {
        const age = ageInDays(c.publishedAt);
        if (policy.requiresFreshness && (age === null || age > policy.maxAgeDays)) {
          return {
            c,
            selected: false,
            reason:
              age === null
                ? "dropped: undated (no publication date, so not current evidence)"
                : `dropped: outside the ${policy.maxAgeDays}-day window (${Math.round(age)}d old)`,
          };
        }
        if (isOffTopic(c, topic)) {
          return {
            c,
            selected: false,
            reason: `dropped: shares no topic word with the question (topic words: ${topic.join(", ") || "none"})`,
          };
        }
        if (yearScoped && isWrongYear(matchTemporal(c, policy.years, null))) {
          return { c, selected: false, reason: "dropped: about a different year than asked" };
        }
        return { c, selected: true, reason: "kept as current evidence" };
      });
      const kept: WebCitation[] = decisions.filter((d) => d.selected).map((d) => d.c);

      const newest = minAgeHours(kept, Date.now());
      const relevanceAvg =
        kept.length === 0
          ? 0
          : Math.round(
              (kept.reduce((s, c) => s + (c.relevance ?? 0), 0) / kept.length) * 1000,
            ) / 1000;

      rows.push({
        query,
        requiresFreshness: policy.requiresFreshness,
        vertical: policy.vertical,
        freshnessTier: policy.freshnessTier,
        timeRange: policy.timeRange ?? decision.timeRange ?? null,
        maxAgeDays: policy.maxAgeDays,
        preferFreshHours: policy.preferFreshHours,
        preferredProviders: preferred,
        // Raw supply, per provider.
        providers,
        // Normalisation + gates.
        normalizedCount: normalized.length,
        normalizedDated: normalized.filter((c) => Boolean(c.publishedAt)).length,
        keptCount: kept.length,
        keptDomains: new Set(kept.map((c) => c.url)).size,
        freshness: freshnessStatement(kept as FreshnessSource[], policy.maxAgeDays),
        newestSourceAgeHours: newest === null ? null : Math.round(newest * 10) / 10,
        relevanceAvg,
        finalSources: kept.map((c) => ({
          title: c.title.slice(0, 110),
          url: c.url,
          publishedAt: c.publishedAt ?? null,
          ageHours:
            c.publishedAt === undefined
              ? null
              : Math.round((ageInDays(c.publishedAt) ?? 0) * 24 * 10) / 10,
          relevance: c.relevance ?? null,
          providers: c.providers ?? [],
        })),
        // What was retrieved and then thrown away, and WHY. This is the part
        // that makes "the answer was old" debuggable instead of a mystery.
        dropped: decisions
          .filter((d) => !d.selected)
          .slice(0, 8)
          .map((d) => ({
            title: d.c.title.slice(0, 90),
            url: d.c.url,
            publishedAt: d.c.publishedAt ?? null,
            ageHours:
              d.c.publishedAt === undefined
                ? null
                : Math.round((ageInDays(d.c.publishedAt) ?? 0) * 24 * 10) / 10,
            providers: d.c.providers ?? [],
            reason: d.reason,
          })),
        enginesWithResults,
        failedEngines,
        engineError,
        totalMs: Date.now() - started,
      });
    }

    return {
      queries: queries.length,
      rows,
      note:
        "freshness is judged on the NEWEST surviving source, not on whether any source is recent. " +
        "An undated source is counted as undated: it is never presented as current. " +
        "freshness measures retrieval and gating, NOT whether the answer prose is correct.",
    };
  },
});

/** Newest or oldest publication age (hours) across a citation set, or null. */
function newestOrOldest(citations: WebCitation[], which: "newest" | "oldest"): number | null {
  const ages: number[] = [];
  for (const c of citations) {
    const d = ageInDays(c.publishedAt);
    if (d !== null) ages.push(d * 24);
  }
  if (ages.length === 0) return null;
  const v = which === "newest" ? Math.min(...ages) : Math.max(...ages);
  return Math.round(v * 10) / 10;
}

export const traceSearch = internalAction({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { query, limit }) => {
    const started = Date.now();
    const decision = decideSearch(query);
    const policy = freshnessPolicyFor(query, decision.intent);
    const classified = classifyCurrentIntent(query, decision.intent);
    const max = limit ?? 12;

    let raw: WebCitation[] = [];
    let engineError: string | null = null;
    // What the fan-out ACTUALLY called, as opposed to what the policy listed.
    // Reporting the policy made the trace claim GDELT was searched on a turn
    // where GDELT is disabled and never invoked — a diagnostic that overstates
    // its own coverage is worse than none.
    let enginesTried: string[] | null = null;
    // Mirrors the chat turn: keyword-shaped retrieval, original text for
    // validation. The diagnostic must exercise the production path, or it
    // reports a behaviour the app does not have.
    const retrievalPlan = planRetrieval(query, classified);
    const retrieval = retrievalPlan.primary;
    try {
      const universal = await runUniversalSearch(ctx, retrieval, {
        retrievalVariants: retrievalPlan.variants,
        variantTargets: retrievalPlan.variantTargets,
        perEngineLimit: 4,
        maxCitations: max,
        userQuestion: query,
        category: decision.category,
        timeRange: policy.timeRange ?? decision.timeRange,
        skipCache: true,
        freshnessMatters: policy.requiresFreshness,
        askedYears: policy.years,
        askedEvent: policy.event,
        strictVertical: false,
        preferredProviders: policy.requiresFreshness ? policy.preferredProviders : undefined,
      });
      raw = universal.citations;
      enginesTried = universal.enginesTried ?? null;
    } catch (e) {
      engineError = e instanceof Error ? e.message : String(e);
    }

    const freshEnough = policy.requiresFreshness
      ? splitByFreshness(raw, policy.maxAgeDays).fresh
      : raw;
    // The diagnostic must judge evidence EXACTLY as the chat turn does. The
    // chat drops off-topic sources; if this only dropped wrong-year ones the
    // trace would report a 4-source set where the turn kept 2, and a
    // diagnostic that disagrees with production is worse than none.
    const topic = topicKeywords(query);
    const kept = freshEnough.filter(
      (c: WebCitation) =>
        !isOffTopic(c, topic) &&
        !isNonSequiturForBroadNews(c, topic, {
          requiresFreshness: policy.requiresFreshness,
        }) &&
        (policy.years.length === 0 && !policy.event
          ? true
          : !isWrongYear(matchTemporal(c, policy.years, null))),
    );

    const crossCheck = crossCheckClaims(kept as FreshnessSource[], started);
    const validation = validateEvidence({
      query,
      citations: kept,
      askedYears: policy.years,
      askedEvent: policy.event,
      maxAgeDays: policy.maxAgeDays,
      // The diagnostic must judge the evidence exactly as the chat turn does.
      // Omitting this made it report a 3-day-old set as fully "answer" when
      // the turn would have flagged it — a diagnostic that under-reports is
      // worse than none.
      preferFreshHours: policy.preferFreshHours,
      crossCheck,
      now: started,
    });

    const keptUrls = new Set(kept.map((c) => c.url));
    const trace = buildSearchTrace({
      query,
      intent: decision.intent,
      classified,
      providersSearched: enginesTried ?? (policy.requiresFreshness ? policy.preferredProviders : ["(full fan-out)"]),
      rawCount: raw.length,
      dedupedCount: raw.length,
      candidates: raw.slice(0, max).map((citation) => {
        const selected = keptUrls.has(citation.url);
        return {
          citation,
          selected,
          score: citation.relevance,
          reason: selected
            ? "kept as current evidence"
            : isWrongYear(matchTemporal(citation, policy.years, null))
              ? "dropped: about a different year than asked"
              : `dropped: outside the ${policy.maxAgeDays}-day window, undated, or past the result limit`,
        };
      }),
      maxAgeDays: policy.maxAgeDays,
      crossCheck,
      validation,
      searchMs: Date.now() - started,
      totalMs: Date.now() - started,
      now: started,
    });

    // The safety contract is enforced, not merely documented.
    const leaks = assertTraceIsSafe(trace);
    if (leaks.length > 0) {
      throw new Error(`search trace would leak disallowed fields: ${leaks.join(", ")}`);
    }

    return {
      summary: summarizeTrace(trace),
      retrievalQuery: retrieval,
      retrievalPlan,
      trace,
      conflicts: crossCheck.conflicts,
      conflictNotice: conflictNotice(crossCheck, started),
      validation,
      refusal: validation.verdict === "refuse" ? cannotVerifyMessage(query, validation) : null,
      engineError,
    };
  },
});
