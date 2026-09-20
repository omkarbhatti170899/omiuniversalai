/**
 * Andromeda — Insight layer (Omi-owned additions).
 *
 * PURE module. Two jobs, both honest:
 *
 *   1. CONFIDENCE LABEL — a plain-language answer-confidence chip derived
 *      from the *measured* pipeline state: gate pass-rates, independent
 *      domain count, corroboration, verification verdict. Never invented
 *      certainty: thin evidence says "thin", unverified says "unverified".
 *
 *   2. FOLLOW-UPS — suggested next questions that would genuinely deepen or
 *      challenge the answer (missing angles, opposing views, fresher data),
 *      derived from the query plan kind + evidence gaps. They are questions,
 *      never implied conclusions.
 */

import type { AndromedaQueryPlan } from "./query";
import type { GateResult } from "./gates";

export type ConfidenceLabel = {
  level: "high" | "moderate" | "low" | "unverified";
  reason: string;
};

export function deriveConfidence(
  plan: AndromedaQueryPlan,
  gates: GateResult | null,
  verificationVerdict: string,
  usedAi: boolean,
): ConfidenceLabel {
  if (!usedAi) {
    return {
      level: "unverified",
      reason: "No AI provider was available — this is a source extract, not synthesis.",
    };
  }
  if (verificationVerdict === "unverified") {
    return {
      level: "unverified",
      reason: "The independent checker could not run on this answer.",
    };
  }
  if (verificationVerdict === "failed") {
    return {
      level: "low",
      reason: "The independent check found problems with this answer.",
    };
  }

  const domainCount = gates?.independentDomains ?? 0;
  const acceptance = gates && gates.rejected.length > 0
    ? gates.accepted.length / (gates.accepted.length + gates.rejected.length)
    : 1;
  const corroborated = !plan.corroborationRequired || domainCount >= 2;

  if (
    verificationVerdict === "pass" &&
    corroborated &&
    domainCount >= 3 &&
    acceptance >= 0.7
  ) {
    return {
      level: "high",
      reason: `Evidence spans ${domainCount} independent domains and passed the independent check.`,
    };
  }
  if (corroborated && domainCount >= 2) {
    return {
      level: "moderate",
      reason: `Evidence spans ${domainCount} independent domains; ${verificationVerdict === "pass" ? "check passed" : "check passed with warnings"}.`,
    };
  }
  return {
    level: "low",
    reason:
      gates && gates.accepted.length > 0
        ? `Evidence comes from ${domainCount} domain(s) — thin independence for this question type.`
        : "Very little evidence survived the quality/freshness gates.",
  };
}

/** One suggested follow-up, with why it deepens the answer. */
export type FollowUp = {
  question: string;
  why: string;
};

export function suggestFollowUps(
  plan: AndromedaQueryPlan,
  gates: GateResult | null,
): FollowUp[] {
  const out: FollowUp[] = [];
  const q = plan.cleanedQuery;

  if (plan.kind === "comparative") {
    out.push({
      question: `What are the main criticisms of ${q.replace(/\s+/g, " ").trim()}?`,
      why: "Comparisons reward adversarial evidence — search for the counter-arguments.",
    });
    out.push({
      question: `Which of these options is most cost-effective over 3 years?`,
      why: "Adds a decision dimension the first pass may not have covered.",
    });
  }
  if (plan.kind === "temporal") {
    out.push({
      question: `Has anything changed about ${q} in the last 30 days?`,
      why: "Temporal answers age — re-check the newest coverage before acting.",
    });
  }
  if (plan.kind === "definitional") {
    out.push({
      question: `How is ${q} applied in practice, with real examples?`,
      why: "Definitions flatten nuance — practical cases restore it.",
    });
  }
  if (plan.kind === "exploratory" || plan.kind === "factual") {
    out.push({
      question: `What do critics or skeptics say about ${q}?`,
      why: "Deliberately seeks opposing evidence (confirmation-bias guard).",
    });
  }

  // Evidence-driven follow-ups from measured gate state.
  if (gates) {
    if (gates.independentDomains < 3) {
      out.push({
        question: `Are there primary or official sources on ${q} beyond the ones found?`,
        why: "Independence was thin — hunting higher-tier sources raises confidence.",
      });
    }
    if (gates.rejected.length > 0) {
      out.push({
        question: `Why were ${gates.rejected.length} source(s) excluded from this answer?`,
        why: "Auditability: check the gates' reasoning yourself.",
      });
    }
  }

  // Dedupe by question text, cap at 4.
  const seen = new Set<string>();
  return out
    .filter((f) => (seen.has(f.question) ? false : (seen.add(f.question), true)))
    .slice(0, 4);
}
