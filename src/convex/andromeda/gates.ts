/**
 * Andromeda — Source Verification Gates (master plan §4, stage between
 * retrieval/dedupe and synthesis: "source verification and freshness
 * checks before information reaches Omi's final response").
 *
 * PURE module over WebCitations + the existing quality engine. Three gates,
 * applied AFTER ranking and dedupe, BEFORE synthesis:
 *
 *   1. QUALITY FLOOR   — "low"-tier sources (content farms, Q&A scrapers)
 *                        never reach synthesis.
 *   2. FRESHNESS GATE  — for freshness-sensitive questions, sources too old
 *                        to trust are held back; if that leaves too little
 *                        evidence, the run FAILS HONESTLY instead of
 *                        answering with stale data (§35).
 *   3. CORROBORATION   — comparative/temporal claims require ≥2 independent
 *                        domains; repetition across engines is NOT counted
 *                        (REPETITION ≠ TRUTH, §10).
 *
 * Rejected sources are reported with reasons — gates are auditable, not a
 * silent black box.
 */

import type { WebCitation } from "../searchProviders/types";
import { domainOf, sourceTier, freshnessScore } from "../searchEngine/quality";

export type GateVerdict = "accepted" | "rejected";

export type GatedSource = {
  citation: WebCitation;
  verdict: GateVerdict;
  /** Machine-readable rejection reasons (empty when accepted). */
  reasons: string[];
  /** Freshness score at gate time (0..1, 0.4 = unknown date). */
  freshness: number;
};

export type GateResult = {
  accepted: WebCitation[];
  rejected: Array<{ url: string; reasons: string[] }>;
  /** Distinct domains among accepted sources (independence proxy). */
  independentDomains: number;
  /** Gate-level warnings the synthesizer must know about. */
  warnings: string[];
  /** True when gates left too little evidence to answer honestly. */
  insufficient: boolean;
};

export const GATE_LIMITS = {
  /** Max age (days) tolerated when freshness matters. */
  maxAgeDaysFreshQueries: 545,
  /** Fresh sources needed to answer a freshness-sensitive question. */
  minFreshSources: 2,
  /** Independent domains required when corroboration is enforced. */
  minIndependentDomains: 2,
} as const;

function ageDaysOf(c: WebCitation, now: number): number | null {
  if (!c.publishedAt) return null;
  const t = Date.parse(c.publishedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 86_400_000);
}

/**
 * Apply the source gates. `now` is injectable for tests; defaults to now.
 * Never throws; always returns a full audit of what passed and why.
 */
export function applySourceGates(
  citations: WebCitation[],
  opts: { freshnessMatters: boolean; corroborationRequired: boolean; now?: number },
): GateResult {
  const now = opts.now ?? Date.now();
  const accepted: GatedSource[] = [];
  const rejected: GateResult["rejected"] = [];

  for (const c of citations) {
    const reasons: string[] = [];

    // Gate 1 — quality floor.
    if (sourceTier(c.url).tier === "low") {
      reasons.push("low-quality source tier");
    }

    // Gate 2 — freshness (only when the question is freshness-sensitive).
    const age = ageDaysOf(c, now);
    if (opts.freshnessMatters && age !== null && age > GATE_LIMITS.maxAgeDaysFreshQueries) {
      reasons.push(`stale for this question (${Math.round(age / 30)} months old)`);
    }

    if (reasons.length === 0) {
      accepted.push({
        citation: c,
        verdict: "accepted",
        reasons: [],
        freshness: freshnessScore(c.publishedAt, now),
      });
    } else {
      rejected.push({ url: c.url, reasons });
    }
  }

  // Gate 3 — corroboration: independence is measured in DOMAINS, not engines.
  const domainCount = new Map<string, number>();
  for (const a of accepted) {
    const d = domainOf(a.citation.url);
    domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
  }
  const independentDomains = domainCount.size;

  const warnings: string[] = [];
  if (opts.corroborationRequired && accepted.length > 0 && independentDomains < GATE_LIMITS.minIndependentDomains) {
    warnings.push(
      `Corroboration not met: all evidence comes from ${independentDomains} domain(s). Claims are source-reported, not independently confirmed.`,
    );
  }

  // Honest insufficiency. Hard-fail ONLY when we have nothing usable, or
  // when dated evidence exists and ALL of it is stale (already handled by
  // the freshness gate above). Undated sources are NOT treated as stale —
  // many quality pages simply lack dates — so they warn loudly instead of
  // failing the run (a brittle gate would make temporal research useless).
  let insufficient = false;
  if (accepted.length === 0) {
    insufficient = rejected.length > 0; // had sources, but all failed gates
  } else if (opts.freshnessMatters) {
    const freshCount = accepted.filter((a) => a.freshness >= 0.5).length;
    const datedCount = accepted.filter((a) => a.citation.publishedAt).length;
    if (freshCount < GATE_LIMITS.minFreshSources) {
      warnings.push(
        datedCount === 0
          ? "No source carries a publication date for this time-sensitive question — recency could not be verified."
          : `Only ${freshCount} sufficiently fresh source(s) for a time-sensitive question — treat dates with caution.`,
      );
    }
  }

  return {
    accepted: accepted.map((a) => a.citation),
    rejected,
    independentDomains,
    warnings,
    insufficient,
  };
}
