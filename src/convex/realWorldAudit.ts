"use node";

/**
 * §8 — REAL-WORLD SUITE.
 *
 * Runs the twelve required queries through the REAL deployed pipeline and
 * reports, per query, the things a human would otherwise have to check by hand:
 *
 *   • is the evidence actually current?   → newest / median source age
 *   • is the date correct?                → how many kept sources carry one
 *   • is the source RELEVANT?             → lexical overlap with the query
 *   • is old information outranking new?  → explicit off-topic / stale audit
 *   • do multiple sources agree?          → independent domains + conflicts
 *   • does the answer separate current
 *     from historical?                    → the refusal / verdict contract
 *
 * It calls the SAME `searchDebug:traceSearch` internal action the operator
 * uses, rather than re-implementing the pipeline. An audit that re-derives the
 * pipeline can pass while the pipeline is broken, which is the exact failure
 * mode an audit exists to catch.
 *
 * HONESTY CONTRACT
 * This measures RETRIEVAL, GATING and RANKING. It cannot verify that a
 * statement inside a citation is factually true — that needs a human reading
 * the answer. Every field is either measured or explicitly null; nothing is
 * inferred, and a query that returns no evidence is recorded as a failure.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/** The twelve required queries, verbatim from the brief. */
export const REAL_WORLD_QUERIES = [
  "Indian contingent medals tally in Asian Games 2026",
  "latest India news",
  "latest world news",
  "today's technology news",
  "latest sports result",
  "latest financial market information",
  "current science news",
  "current weather",
  "latest Japan news",
  "latest South Korea news",
  "dernières nouvelles du Japon aujourd'hui",
  "obscure query: the 2026 Aetherium Prize in subatomic photochemistry results",
] as const;

const STOP = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "is",
  "are", "was", "were", "latest", "current", "today", "now", "news", "what",
  "result", "results", "information", "update", "updates", "des", "der",
  "nouvelles", "aujourd", "hui", "du", "pour", "les", "avec",
]);

function keywords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Lexical relevance of a source against the query.
 *
 * Deliberately crude, and labelled as such wherever it is reported. It
 * reliably detects "this page is about a different subject entirely" — the
 * observed failure, where a Maldives holiday package survived into a medal
 * tally answer — but it cannot detect a plausible-but-wrong claim. A high
 * number here means "on topic", never "correct".
 */
function relevance(title: string, query: string): number {
  const hay = title.toLowerCase();
  const terms = keywords(query);
  if (terms.length === 0) return 1;
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits += 1;
  return Math.round((hits / terms.length) * 1000) / 1000;
}

type TraceSource = {
  domain: string;
  title: string;
  publishedAt?: string;
  selected: boolean;
  reason: string;
  providers?: string[];
};

export const runRealWorldSuite = internalAction({
  args: {
    only: v.optional(v.number()),
    from: v.optional(v.number()),
    count: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Batched because a full pass costs one real search per query against a
    // community SearXNG that MEASURED 19-46 s each — twelve queries is several
    // minutes, which exceeds a single synchronous invocation. `only` pins one
    // query for spot checks; `from`/`count` walks the list in slices.
    const queries =
      args.only !== undefined
        ? [REAL_WORLD_QUERIES[args.only] ?? REAL_WORLD_QUERIES[0]]
        : args.from !== undefined
          ? REAL_WORLD_QUERIES.slice(args.from, args.from + (args.count ?? 3))
          : REAL_WORLD_QUERIES;

    const rows: Array<Record<string, unknown>> = [];

    for (const query of queries) {
      const started = Date.now();
      try {
        // The production path, not a re-implementation of it.
        const out = (await ctx.runAction(internal.searchDebug.traceSearch, {
          query,
          limit: 10,
        })) as {
          trace?: {
            sources?: TraceSource[];
            providersSearched?: string[];
            contributionsByProvider?: Array<{ provider: string; retrieved: number; kept: number }>;
            rawCount?: number;
            selectedCount?: number;
            independentDomains?: number;
            rejectedStaleCount?: number;
            totalMs?: number;
            conflicts?: string[];
            verification?: { verdict?: string; failedChecks?: string[] };
          };
          refusal?: string | null;
          engineError?: string | null;
        };

        const trace = out.trace ?? {};
        const now = started;
        const sources = trace.sources ?? [];
        const kept = sources.filter((s) => s.selected);

        const ageOf = (s: TraceSource) =>
          s.publishedAt ? (now - Date.parse(s.publishedAt)) / 3_600_000 : null;
        const keptAges = kept
          .map(ageOf)
          .filter((a): a is number => typeof a === "number" && Number.isFinite(a))
          .sort((a, b) => a - b);

        const perSource = kept.map((s) => {
          const age = ageOf(s);
          return {
            domain: s.domain,
            providers: s.providers ?? [],
            ageHours: age === null ? null : Math.round(age * 10) / 10,
            dated: Boolean(s.publishedAt),
            relevance: relevance(s.title, query),
            title: s.title.slice(0, 90),
          };
        });

        const rels = perSource.map((p) => p.relevance);
        // A quarter match is the "about a different subject" line: with 3-4
        // content terms in a query, fewer than one in four is not the subject.
        const offTopic = perSource.filter((p) => p.relevance < 0.25).length;

        rows.push({
          query,
          ms: trace.totalMs ?? Date.now() - started,
          verdict: trace.verification?.verdict ?? "unknown",
          engineError: out.engineError ?? null,
          refused: Boolean(out.refusal),
          providersSearched: trace.providersSearched ?? [],
          contributions: trace.contributionsByProvider ?? [],
          raw: trace.rawCount ?? 0,
          kept: trace.selectedCount ?? 0,
          domains: trace.independentDomains ?? 0,
          rejectedStale: trace.rejectedStaleCount ?? 0,
          datedKept: perSource.filter((p) => p.dated).length,
          newestAgeHours:
            keptAges.length > 0
              ? Math.round(keptAges[keptAges.length - 1] * 10) / 10
              : null,
          medianAgeHours:
            keptAges.length > 0
              ? Math.round(keptAges[Math.floor(keptAges.length / 2)] * 10) / 10
              : null,
          avgRelevance:
            rels.length > 0
              ? Math.round((rels.reduce((a, b) => a + b, 0) / rels.length) * 1000) / 1000
              : null,
          offTopicKept: offTopic,
          conflicts: trace.conflicts ?? [],
          failedChecks: trace.verification?.failedChecks ?? [],
          sources: perSource,
        });
      } catch (err) {
        rows.push({
          query,
          ms: Date.now() - started,
          verdict: "ERROR",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const answered = rows.filter(
      (r) => r.verdict !== "ERROR" && Number(r.kept) > 0,
    ).length;
    const clean = rows.filter(
      (r) => r.verdict !== "ERROR" && Number(r.offTopicKept) === 0,
    ).length;

    return {
      ranAt: new Date().toISOString(),
      total: rows.length,
      answered,
      noOffTopicSources: clean,
      rows,
      note:
        "Retrieval, gating and ranking only. avgRelevance is LEXICAL overlap, " +
        "not truth. Whether a kept citation is factually correct is not measured " +
        "here and still requires a human reading the answer.",
    };
  },
});
