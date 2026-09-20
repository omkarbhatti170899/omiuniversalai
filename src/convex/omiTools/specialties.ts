/**
 * OMI Agent Specialties (master plan Phase 6 "Create specialized agents" +
 * task-oriented prompting: a hierarchy of prompts that prioritize planning,
 * verification and safety per domain).
 *
 * This module is PURE (no Convex, no fetch) so it is unit-testable and
 * importable by both the backend runtime and the UI. Agents of every
 * specialty still use the SAME OMI tool registry — a specialty only
 * restricts which registry tools it may execute, it never adds new ones.
 *
 * Permission model:
 *   • known specialty → its explicit allowlist (least privilege)
 *   • unknown/free-text specialty → "general" (full safe set), so legacy
 *     agents keep working unchanged (backward compatibility)
 *   • enforcement lives in the executor (omiTools/executor.ts), not only in
 *     prompts — prompt restriction alone is never treated as security.
 */

import { TOOL_IDS, type ToolId } from "./registry";

export interface SpecialtyProfile {
  /** Canonical lowercase id (also what the allowlist is keyed on). */
  id: string;
  label: string;
  /** One-line description shown in the UI. */
  description: string;
  /** Domain planning discipline — appended to the planner system prompt. */
  planning: string;
  /** Domain execution discipline — prepended to each step's system prompt. */
  execution: string;
  /** Tools this specialty may execute. "all" = every registry tool. */
  tools: readonly ToolId[] | "all";
}

export const GENERAL_SPECIALTY: SpecialtyProfile = {
  id: "general",
  label: "General",
  description: "A balanced generalist with access to every Omi tool.",
  planning:
    "Plan steps that are concrete and verifiable. Whenever the answer depends on facts you cannot verify yourself, plan a step that retrieves them with a tool instead of assuming.",
  execution:
    "Ground every claim: use tools to verify facts you are unsure of, and say plainly what remains unverified.",
  tools: "all",
};

export const SPECIALTIES: SpecialtyProfile[] = [
  {
    id: "research",
    label: "Research",
    description:
      "Gathers evidence from the live web and the user's documents before concluding.",
    planning:
      "Plan steps that gather evidence before concluding: identify what is known vs unknown, retrieve current facts with web search, open primary sources with read_page, and check the user's own documents first — they are the highest-trust source. Never plan a step that asserts a fact you have not retrieved.",
    execution:
      "Cite where each finding came from (which source or document). Separate what the sources say from your interpretation. If sources conflict, say so instead of picking one silently.",
    tools: ["web_search", "read_page", "knowledge_search", "memory_list", "andromeda_research"],
  },
  {
    id: "analysis",
    label: "Analysis",
    description:
      "Quantifies, compares and produces decision-ready summaries grounded in the user's data.",
    planning:
      "Plan steps that quantify and compare: define the metrics that matter, ground every claim in the user's documents before generalizing, and reserve the final step for a decision-ready summary with explicit trade-offs.",
    execution:
      "State numbers and assumptions explicitly. Distinguish observation from interpretation, and note what the data cannot support.",
    tools: ["web_search", "knowledge_search", "memory_list", "calculate", "andromeda_research"],
  },
  {
    id: "operations",
    label: "Operations",
    description:
      "Turns messy operational problems into sequenced, owned, check-pointed plans.",
    planning:
      "Plan steps that are concrete and sequenced: each with an owner, an order, and a checkpoint for verifying completion. When the user confirms a durable procedure, capture it with memory_save so it persists.",
    execution:
      "Be specific: names, order, deadlines, fallbacks. Flag blockers and dependencies explicitly rather than glossing over them.",
    tools: ["web_search", "read_page", "knowledge_search", "memory_save", "memory_list"],
  },
  {
    id: "coding",
    label: "Coding",
    description:
      "Restates requirements, checks real API docs, and ends with how to test the result.",
    planning:
      "Plan steps that build and verify: restate the requirement precisely, identify the interfaces and data shapes involved, look up current API or library documentation when unsure rather than guessing, and reserve a final step for how the result can be tested.",
    execution:
      "Prefer exact, runnable specifics over vague guidance. When API behavior matters, verify against documentation instead of memory, and note the version or source you relied on.",
    tools: ["web_search", "read_page", "knowledge_search", "memory_list", "andromeda_research"],
  },
  {
    id: "document",
    label: "Document",
    description:
      "Extracts and organizes what is actually in the user's documents — no filling gaps from memory.",
    planning:
      "Plan steps that extract and organize what is in the user's documents: summarize section by section, keep short quotes for key claims, and flag contradictions or gaps instead of filling them in from your own knowledge.",
    execution:
      "Only report what the documents contain. Mark anything unclear as a gap — never silently substitute outside knowledge for a missing passage.",
    tools: ["knowledge_search", "memory_list"],
  },
  {
    id: "data",
    label: "Data",
    description:
      "Structures datasets, checks quality honestly, and states the limits of the numbers.",
    planning:
      "Plan steps that structure the data: identify the schema and units, check for missing or malformed values, compute comparisons honestly, and reserve a final step for stating the limitations of the data.",
    execution:
      "Show the computation path briefly so it can be checked. Distinguish measured values from estimates, and never round in a way that hides uncertainty.",
    tools: ["web_search", "knowledge_search", "memory_list", "calculate"],
  },
];

/** Resolve any stored specialty string (may be legacy free text) to a profile. */
export function specialtyProfile(
  specialty: string | undefined | null,
): SpecialtyProfile {
  const s = (specialty ?? "").trim().toLowerCase();
  return SPECIALTIES.find((p) => p.id === s) ?? GENERAL_SPECIALTY;
}

/** May an agent of this specialty execute this registry tool? */
export function toolAllowedForSpecialty(
  tool: ToolId,
  specialty: string | undefined | null,
): boolean {
  const profile = specialtyProfile(specialty);
  return profile.tools === "all" || profile.tools.includes(tool);
}

/** The full allowlist for a specialty (resolved — never "all"). */
export function allowedToolIds(
  specialty: string | undefined | null,
): ToolId[] {
  const profile = specialtyProfile(specialty);
  return profile.tools === "all" ? [...TOOL_IDS] : [...profile.tools];
}
