/**
 * Omi Knowledge Intelligence — knowledge artifacts (pure).
 *
 * §5 of the completion spec: a knowledge answer should be convertible into a
 * Procedure / Checklist / SOP / Training guide / Report WITHOUT losing source
 * attribution. Every artifact is rendered from the SAME grounded ActionPlan —
 * the same steps, the same version, the same evidence — so the document can
 * never drift from the approved article it cites.
 *
 * This is the "send to Canvas" payload: deterministic markdown a workspace can
 * display, copy or download.
 */

import { formatActionPlan, labelSourceKind, type ActionPlan } from "./grounding";

export const ARTIFACT_KINDS = [
  "procedure",
  "checklist",
  "sop",
  "training",
  "report",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(v: string): v is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(v);
}

const TITLES: Record<ArtifactKind, string> = {
  procedure: "Procedure",
  checklist: "Checklist",
  sop: "Standard Operating Procedure",
  training: "Training Guide",
  report: "Knowledge Report",
};

/** The attribution footer every artifact carries — never omitted. */
export function attributionBlock(plan: ActionPlan): string {
  if (!plan.source) {
    return [
      "SOURCE",
      "No approved source — this answer is not grounded in the knowledge base.",
    ].join("\n");
  }
  const lines = [
    "SOURCE ATTRIBUTION",
    `Source type: ${labelSourceKind(plan.sourceKind)}`,
    `Article: ${plan.source.title}`,
    `Version: v${plan.source.version}`,
  ];
  if (plan.source.effectiveDate) {
    lines.push(`Effective: ${new Date(plan.source.effectiveDate).toISOString().slice(0, 10)}`);
  }
  if (plan.relevantSection) lines.push(`Section: ${plan.relevantSection}`);
  if (plan.evidence.length > 0) {
    lines.push(`Evidence:\n${plan.evidence.map((e) => `  - ${e}`).join("\n")}`);
  }
  return lines.join("\n");
}

/**
 * Render a plan as the requested artifact. An ungrounded plan renders an
 * honest "no approved source" document rather than an empty shell that looks
 * authoritative.
 */
export function buildArtifact(plan: ActionPlan, kind: ArtifactKind): string {
  const heading = `# ${TITLES[kind]}${plan.source ? `: ${plan.source.title}` : ""}`;
  if (!plan.answered || !plan.source) {
    return [
      heading,
      "",
      plan.answer,
      "",
      "This question is logged as a knowledge gap so an owner can add approved",
      "guidance. Omi does not invent procedural steps.",
      "",
      attributionBlock(plan),
    ].join("\n");
  }

  const parts: string[] = [heading, ""];

  if (kind === "checklist") {
    parts.push("## Checklist");
    parts.push(plan.steps.length > 0
      ? plan.steps.map((s) => `- [ ] ${s}`).join("\n")
      : "- [ ] No explicit steps are listed in the approved article. Ask a knowledge owner to add them.");
    if (plan.requiredInfo.length > 0) {
      parts.push("");
      parts.push("## Required information / documents");
      parts.push(plan.requiredInfo.map((r) => `- [ ] ${r}`).join("\n"));
    }
  } else if (kind === "report") {
    parts.push("## Direct answer");
    parts.push(plan.answer);
    parts.push("");
    parts.push("## Findings");
    parts.push(formatActionPlan(plan));
    if (plan.conflicts.length > 0) {
      parts.push("");
      parts.push("## Conflicting knowledge");
      parts.push(plan.conflicts.map((c) => `- ${c}`).join("\n"));
    }
  } else {
    // procedure / sop / training share the action structure, but a training
    // guide leads with the narrative and a SOP leads with the steps.
    if (kind === "training") {
      parts.push("## Overview");
      parts.push(plan.answer);
      parts.push("");
    }
    parts.push(formatActionPlan(plan));
  }

  parts.push("");
  parts.push(attributionBlock(plan));
  return parts.join("\n");
}
