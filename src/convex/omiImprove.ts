/**
 * Phase 11 — Controlled self-improvement: proposal derivation.
 *
 * The observation side (omiHealth) records what actually happens — tool
 * success rates, latencies, verification verdicts, provider availability.
 * This PURE module turns that record into concrete PROPOSALS. It never
 * changes anything: master plan §11 requires PROPOSE → TEST → VERIFY →
 * APPROVE → DEPLOY, and the APPROVE step is always human. Nothing here
 * mutates prompts, routing, or code.
 */

export type HealthSnapshot = {
  toolMetrics: Array<{ tool: string; total: number; successRate: number; avgMs: number }>;
  verification: {
    checked: number;
    pass: number;
    warnings: number;
    failed: number;
    passRate: number;
  };
  ai: {
    activeProvider: string | null;
    providers: Array<{ id: string; label: string; configured: boolean; cost: string; hint: string }>;
  };
};

export type ImprovementProposal = {
  /** Stable id so the same problem always proposes the same thing. */
  id: string;
  severity: "info" | "watch" | "action";
  area: "tools" | "verification" | "providers";
  title: string;
  detail: string;
  /** The concrete human decision this proposal asks for. */
  ask: string;
};

const TOOL_SUCCESS_WARN = 80;
const TOOL_SUCCESS_ACT = 50;
const TOOL_MIN_RUNS = 5;
const VERIFICATION_MIN_CHECKED = 5;

/**
 * Derive improvement proposals from a health snapshot. Deterministic:
 * the same snapshot always yields the same proposals (stable ids), so a
 * human reviewer can track an issue across sessions.
 */
export function deriveProposals(snap: HealthSnapshot): ImprovementProposal[] {
  const out: ImprovementProposal[] = [];

  // --- Tools ------------------------------------------------------------------
  for (const t of snap.toolMetrics) {
    if (t.total < TOOL_MIN_RUNS) continue; // not enough evidence yet — no noise
    if (t.successRate < TOOL_SUCCESS_ACT) {
      out.push({
        id: `tool-critical:${t.tool}`,
        severity: "action",
        area: "tools",
        title: `${t.tool} is failing most of the time`,
        detail: `${t.total} runs, ${t.successRate}% success, ${t.avgMs}ms average. Below 50% the tool is more noise than help.`,
        ask: `Review the ${t.tool} provider chain and decide: fix, replace, or disable it for agents.`,
      });
    } else if (t.successRate < TOOL_SUCCESS_WARN) {
      out.push({
        id: `tool-watch:${t.tool}`,
        severity: "watch",
        area: "tools",
        title: `${t.tool} success rate is slipping`,
        detail: `${t.total} runs, ${t.successRate}% success — usable but degrading.`,
        ask: `Watch the next ${t.tool} runs; investigate if it drops below ${TOOL_SUCCESS_ACT}%.`,
      });
    }
  }

  // --- Verification quality ------------------------------------------------------
  const v = snap.verification;
  if (v.checked >= VERIFICATION_MIN_CHECKED) {
    if (v.failed > 0) {
      out.push({
        id: "verification:failures",
        severity: "action",
        area: "verification",
        title: "Verification is catching real failures",
        detail: `${v.failed} of ${v.checked} verified tasks failed the independent check (pass rate ${v.passRate}%).`,
        ask: "Review those tasks' verdict notes and confirm the corrective retries landed.",
      });
    } else if (v.warnings > v.checked / 2) {
      out.push({
        id: "verification:warnings-majority",
        severity: "watch",
        area: "verification",
        title: "Most verified results carry warnings",
        detail: `${v.warnings} of ${v.checked} tasks passed only with warnings — often thin evidence or over-claims.`,
        ask: "Consider tightening the research agent's evidence requirements in its next prompt revision (human-approved change).",
      });
    }
  }

  // --- Providers -------------------------------------------------------------------
  const configured = snap.ai.providers.filter((p) => p.configured);
  if (configured.length === 0) {
    out.push({
      id: "providers:none",
      severity: "action",
      area: "providers",
      title: "No AI provider is configured",
      detail: "Chat, agents and synthesis degrade to extractive mode without one.",
      ask: "Add a free GROQ_API_KEY (or an optional DEEPSEEK_API_KEY / OPENAI_API_KEY) in the API Keys tab.",
    });
  } else if (configured.length === 1 && snap.ai.activeProvider === "vly") {
    out.push({
      id: "providers:single",
      severity: "info",
      area: "providers",
      title: "Single-provider dependency",
      detail: "Only the workspace gateway is active — one outage removes all AI features.",
      ask: "Add a free GROQ_API_KEY for an independent second provider (zero cost, §13 cheapest-suitable routing).",
    });
  } else if (configured.length >= 3) {
    out.push({
      id: "providers:healthy",
      severity: "info",
      area: "providers",
      title: "Provider redundancy is healthy",
      detail: `${configured.length} providers configured — fallback coverage is strong.`,
      ask: "Nothing to do. This is the target state.",
    });
  }

  // Quiet is a result: if nothing fired, say so explicitly rather than faking.
  if (out.length === 0) {
    out.push({
      id: "none",
      severity: "info",
      area: "tools",
      title: "No improvement proposals — system is stable",
      detail: "No tool below threshold, verification passing, provider redundancy present (or not enough data yet).",
      ask: "Nothing to approve. Keep using Omi normally.",
    });
  }

  return out;
}
