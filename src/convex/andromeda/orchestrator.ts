"use node";

/**
 * Andromeda — the orchestration layer (master plan §4).
 *
 * THE pipeline. Composes EXISTING Omi modules — nothing replaced, nothing
 * duplicated:
 *
 *   planQuery()            query understanding (andromeda/query.ts)
 *      ↓
 *   runUniversalSearch()   parallel retrieval across 10 keyless sources
 *                          (universalSearch.ts — SearXNG, Wikipedia,
 *                          Wikidata, arXiv, OpenAlex, Open Library, HN,
 *                          Openverse, Common Crawl, DuckDuckGo)
 *      ↓
 *   dedupeCitations()      URL + same-domain title dedupe (workflows/plan.ts)
 *      ↓
 *   applySourceGates()     quality floor + freshness + corroboration
 *                          (andromeda/gates.ts) — AUDITABLE
 *      ↓
 *   buildEvidencePack()    traceable evidence blocks (searchEngine/evidence.ts)
 *      ↓
 *   synthesizeResearchAnswer()  grounded synthesis + citation integrity
 *                               (searchEngine/evidence.ts)
 *      ↓
 *   verifyResult()         INDEPENDENT verification (verification.ts — the
 *                          same verifier guarding agents)
 *      ↓
 *   AndromedaResult        answer + citations + gate audit + verdict
 *
 * Cost control (user requirement): bounded parallel fan-out, dedupe before
 * synthesis, cache-respecting retrieval, synthesis + verification only run
 * when gates leave enough evidence. Every downstream failure degrades
 * gracefully (extractive floor / honest insufficiency), never throws.
 */

import type { WebCitation } from "../searchProviders/types";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { runUniversalSearch, extractiveBrief } from "../universalSearch";
import { fetchPageText } from "../searchProviders/pageFetcher";
import {
  buildEvidencePack,
  synthesizeResearchAnswer,
  sourcesFooter,
} from "../searchEngine/evidence";
import { verifyResult } from "../verification";
import { dedupeCitations } from "../workflows/plan";
import { planQuery, type AndromedaQueryPlan } from "./query";
import { applySourceGates, type GateResult } from "./gates";
import { deriveConfidence, suggestFollowUps } from "./insight";

export type AndromedaStage = {
  stage: string;
  detail: string;
  ms: number;
};

export type AndromedaResult = {
  ok: boolean;
  /** Human-readable failure/insufficiency reason when ok=false. */
  error?: string;
  query: string;
  plan: AndromedaQueryPlan;
  /** Number of raw citations retrieved across all subqueries. */
  rawCount: number;
  /** Count after dedupe. */
  dedupedCount: number;
  /** Gate audit — what passed, what was held back and why. */
  gates: GateResult | null;
  /** Pages read in full text. */
  pagesRead: number;
  /** The synthesized (or extractive-floor) answer with citations. */
  answer: string;
  summary: string;
  /**
   * `publishedAt` is preserved end-to-end so the UI can show how fresh each
   * source actually is. Dropping it turned a dated news source into an
   * undated link, which is what made "current" answers unjudgeable.
   */
  citations: Array<{
    idx: number;
    title: string;
    url: string;
    domain: string;
    publishedAt?: string;
  }>;
  sourcesFooter: string;
  /** Independent verification verdict on the final answer. */
  verification: { verdict: string; notes: string[] };
  /** Whether an AI model was available for synthesis. */
  usedAi: boolean;
  /** Measured answer-confidence label (never invented certainty). */
  confidence: { level: "high" | "moderate" | "low" | "unverified"; reason: string };
  /** Suggested follow-up questions that deepen or challenge the answer. */
  followUps: Array<{ question: string; why: string }>;
  stages: AndromedaStage[];
  totalMs: number;
};

const SEARCH_TIMEOUT_MS = 30_000;
const MAX_PAGES_READ = 6;
const MIN_EVIDENCE_FOR_SYNTHESIS = 3;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ]);
}

/**
 * Run the full Andromeda pipeline for one natural-language research query.
 * Never throws — every failure mode comes back as ok:false with the stage
 * trace showing exactly where the run stopped.
 */
export async function runAndromeda(
  ctx: Parameters<typeof runUniversalSearch>[0],
  rawQuery: string,
  opts?: { focus?: string; userId?: Id<"users"> },
): Promise<AndromedaResult> {
  const t0 = Date.now();
  const stages: AndromedaStage[] = [];
  const mark = (stage: string, detail: string, since: number) => {
    stages.push({ stage, detail, ms: Date.now() - since });
  };

  // --- 1. Query understanding ------------------------------------------------
  let s = Date.now();
  const plan = planQuery(rawQuery);
  if (plan.reject) {
    mark("query understanding", plan.reject.reason, s);
    return emptyResult(rawQuery, plan, stages, plan.reject.reason);
  }
  const objective = opts?.focus?.trim()
    ? `${plan.cleanedQuery} (focus: ${opts.focus.trim().slice(0, 120)})`
    : plan.cleanedQuery;
  mark(
    "query understanding",
    `${plan.kind} · ${plan.subqueries.length} angle(s) · freshness=${plan.freshnessMatters} · goal=${objective}`,
    s,
  );

  // --- 2. Parallel retrieval — internal knowledge FIRST, then the world ------
  s = Date.now();
  // Internal corpora (user's own documents) as the highest-trust source
  // (master plan §11 internal knowledge). Runs via the reserved
  // internal:// scheme; never leaves the workspace (§41).
  let internalPassages: Array<{ title: string; url: string; snippet: string }> = [];
  if (opts?.userId) {
    try {
      internalPassages = await ctx.runQuery(internal.andromeda.corpus.corpusSearch, {
        userId: opts.userId,
        query: plan.cleanedQuery,
        limit: 4,
      });
    } catch {
      internalPassages = [];
    }
  }

  const searches = await Promise.allSettled(
    plan.subqueries.map((q) =>
      withTimeout(
        runUniversalSearch(ctx, q, {
          perEngineLimit: 6,
          maxCitations: 8,
          skipCache: plan.freshnessMatters, // fresh questions skip cache
          freshnessMatters: plan.freshnessMatters,
        }),
        SEARCH_TIMEOUT_MS,
        `search "${q}"`,
      ).then((r) => r.citations),
    ),
  );
  const raw: WebCitation[] = [...internalPassages];
  for (const b of searches) {
    if (b.status === "fulfilled") raw.push(...b.value);
  }
  if (raw.length === 0) {
    mark("retrieval", "no results from any source", s);
    return emptyResult(rawQuery, plan, stages, "No sources found for this query. Omi will not fabricate an answer.");
  }
  mark("retrieval", `${raw.length} raw citations across ${searches.length} query angle(s)`, s);

  // --- 3. Dedupe ----------------------------------------------------------------
  s = Date.now();
  const deduped = dedupeCitations(raw);
  mark("dedupe", `${deduped.length} unique (removed ${raw.length - deduped.length} duplicates)`, s);

  // --- 4. Source gates (quality / freshness / corroboration) ---------------------
  s = Date.now();
  const gates = applySourceGates(deduped, {
    freshnessMatters: plan.freshnessMatters,
    corroborationRequired: plan.corroborationRequired,
  });
  mark(
    "source gates",
    `${gates.accepted.length} accepted · ${gates.rejected.length} held back · ${gates.independentDomains} independent domain(s)`,
    s,
  );
  if (gates.accepted.length < MIN_EVIDENCE_FOR_SYNTHESIS) {
    const why = gates.insufficient
      ? "Every retrieved source failed the quality/freshness gates."
      : "Not enough independent evidence survived retrieval and gates.";
    return {
      ...emptyResult(rawQuery, plan, stages, `${why} Omi will not answer from thin evidence.`),
      gates,
      rawCount: raw.length,
      dedupedCount: deduped.length,
    };
  }

  // --- 5. Read the most promising pages (fault-tolerant, capped) ------------------
  s = Date.now();
  const pageTexts = new Map<string, string>();
  const reads = await Promise.allSettled(
    gates.accepted.slice(0, MAX_PAGES_READ).map((c) => fetchPageText(c.url, 2500)),
  );
  for (const r of reads) {
    if (r.status === "fulfilled" && r.value.ok) pageTexts.set(r.value.url, r.value.text);
  }
  mark("retrieval depth", `${pageTexts.size} page(s) read in full`, s);

  // --- 6. Grounded synthesis (citation integrity enforced downstream) -------------
  s = Date.now();
  const pack = buildEvidencePack(gates.accepted, {
    perSourceChars: 650,
    maxSources: 10,
    pageTexts,
  });
  const research = await synthesizeResearchAnswer(plan.cleanedQuery, pack);
  mark(
    "synthesis",
    research ? `grounded synthesis over ${pack.items.length} evidence block(s)` : "AI unavailable — extractive floor",
    s,
  );

  const answer =
    research?.answer ??
    `${extractiveBrief(plan.cleanedQuery, gates.accepted)}\n\n(Note: Omi's AI layer is unavailable — this is a source extract, not full synthesis.)`;
  const summary =
    research?.summary ??
    `${gates.accepted.length} sources across ${gates.independentDomains} domains.`;
  const footer = sourcesFooter(pack);

  // --- 7. Independent verification (same verifier as the agent pipeline) ----------
  s = Date.now();
  const verification = await verifyResult(plan.cleanedQuery, answer, [
    `Evidence pack (${pack.items.length} sources):`,
    ...pack.items.map(
      (e) => `[${e.idx}] ${e.title} — ${e.domain}: ${e.excerpt.slice(0, 200)}`,
    ),
    ...gates.warnings,
  ]);
  mark("verification", `verdict: ${verification.verdict}`, s);

  return {
    ok: true,
    query: plan.cleanedQuery,
    plan,
    rawCount: raw.length,
    dedupedCount: deduped.length,
    gates,
    pagesRead: pageTexts.size,
    answer,
    summary,
    citations: pack.items.map((e) => ({
      idx: e.idx,
      title: e.title,
      url: e.url,
      domain: e.domain,
      publishedAt: e.publishedAt,
    })),
    sourcesFooter: footer,
    verification: { verdict: verification.verdict, notes: verification.notes },
    usedAi: research !== null,
    confidence: deriveConfidence(plan, gates, verification.verdict, research !== null),
    followUps: suggestFollowUps(plan, gates),
    stages,
    totalMs: Date.now() - t0,
  };
}

/** Shape a coherent failure/insufficiency result with the stage audit. */
function emptyResult(
  rawQuery: string,
  plan: AndromedaQueryPlan,
  stages: AndromedaStage[],
  error: string,
): AndromedaResult {
  return {
    ok: false,
    error,
    query: rawQuery,
    plan,
    rawCount: 0,
    dedupedCount: 0,
    gates: null,
    pagesRead: 0,
    answer: "",
    summary: "",
    citations: [],
    sourcesFooter: "",
    verification: { verdict: "unverified", notes: [] },
    usedAi: false,
    confidence: { level: "unverified", reason: error },
    followUps: [],
    stages,
    totalMs: 0,
  };
}
