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
import { decideSearch } from "./searchEngine/decision";
import { freshnessPolicyFor, splitByFreshness, type FreshnessSource } from "./searchEngine/freshness";
import { classifyCurrentIntent } from "./searchEngine/intent";
import { planRetrieval } from "./searchEngine/rewrite";
import { matchTemporal, isWrongYear } from "./searchEngine/temporal";
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
    } catch (e) {
      engineError = e instanceof Error ? e.message : String(e);
    }

    const freshEnough = policy.requiresFreshness
      ? splitByFreshness(raw, policy.maxAgeDays).fresh
      : raw;
    const kept = policy.years.length > 0 || policy.event
      ? freshEnough.filter((c: WebCitation) => !isWrongYear(matchTemporal(c, policy.years, null)))
      : freshEnough;

    const crossCheck = crossCheckClaims(kept as FreshnessSource[], started);
    const validation = validateEvidence({
      query,
      citations: kept,
      askedYears: policy.years,
      askedEvent: policy.event,
      maxAgeDays: policy.maxAgeDays,
      crossCheck,
      now: started,
    });

    const keptUrls = new Set(kept.map((c) => c.url));
    const trace = buildSearchTrace({
      query,
      intent: decision.intent,
      classified,
      providersSearched: policy.requiresFreshness ? policy.preferredProviders : ["(full fan-out)"],
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
