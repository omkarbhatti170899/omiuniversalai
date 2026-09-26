/**
 * Answer-shape detection (pure).
 *
 * The presentation rule behind this pass: Omi should not paste every reply as
 * one giant markdown blob. The client inspects the FINISHED TEXT and picks a
 * structure that already exists inside it — steps, knowledge blocks, sources,
 * warnings — and renders those as cards. No backend change, no extra request,
 * and no invention: a card is only rendered when the text actually contains
 * that section.
 *
 * Detection is deliberately conservative — a false positive (rendering prose
 * as a procedure) is worse than falling back to plain markdown. Everything
 * here is deterministic so it is unit-testable and costs nothing at render
 * time (a few regex passes over one string, memoized by the caller).
 */

export type AnswerShape =
  | "knowledge" // grounded knowledge answer (SOURCE/VERSION/EVIDENCE sections)
  | "procedure" // numbered WHAT TO DO steps
  | "checklist" // checkbox items
  | "comparison" // a markdown table
  | "research" // web citations [1] [2] …
  | "warning" // human-review / escalation headline
  | "plain"; // default markdown

/** Knowledge-section keys, in the order the structured card renders them. */
export type KnowledgeSection =
  | "answer"
  | "steps"
  | "required"
  | "checks"
  | "exceptions"
  | "escalate"
  | "source"
  | "version"
  | "evidence";

type SectionKey = KnowledgeSection | "conflict";

const SECTION_MAP: Array<{ label: string; key: SectionKey }> = [
  { label: "DIRECT ANSWER", key: "answer" },
  { label: "WHAT TO DO", key: "steps" },
  { label: "REQUIRED INFORMATION", key: "required" },
  { label: "REQUIRED INFORMATION / DOCUMENTS", key: "required" },
  { label: "IMPORTANT CHECKS", key: "checks" },
  { label: "EXCEPTIONS", key: "exceptions" },
  { label: "EXCEPTIONS / EDGE CASES", key: "exceptions" },
  { label: "WHEN TO ESCALATE", key: "escalate" },
  { label: "SOURCE ARTICLE", key: "source" },
  { label: "VERSION / EFFECTIVE DATE", key: "version" },
  { label: "SUPPORTING EVIDENCE", key: "evidence" },
  { label: "SOURCE", key: "source" },
  { label: "VERSION", key: "version" },
  { label: "EFFECTIVE", key: "version" },
  { label: "EVIDENCE", key: "evidence" },
  { label: "CONFLICT — HUMAN REVIEW REQUIRED", key: "conflict" },
];

export type ParsedKnowledge = {
  kind: "knowledge";
  sections: Partial<Record<SectionKey | "note", string>>;
  order: SectionKey[];
};

/** Section labels rendered by the structured card, in canonical order. */
export const CARD_SECTION_ORDER: Array<{
  key: KnowledgeSection | "conflict" | "note";
  label: string;
}> = [
  { key: "answer", label: "Answer" },
  { key: "steps", label: "What to do" },
  { key: "required", label: "Required information" },
  { key: "checks", label: "Important checks" },
  { key: "exceptions", label: "Exceptions" },
  { key: "escalate", label: "Escalate when" },
  { key: "source", label: "Source" },
  { key: "version", label: "Version" },
  { key: "evidence", label: "Evidence" },
  { key: "conflict", label: "Conflict — human review required" },
  { key: "note", label: "Important" },
];

/**
 * Parse a knowledge/action-plan answer into its labelled sections. A section
 * runs from its label to the next label (or the end). Only exact-ish label
 * matches at a line start count, so prose mentioning "source" is untouched.
 */
export function parseKnowledgeSections(text: string): ParsedKnowledge | null {
  // Longest labels first so "REQUIRED INFORMATION / DOCUMENTS" wins over
  // "REQUIRED INFORMATION" and "SOURCE ARTICLE" over "SOURCE".
  const labels = [...SECTION_MAP].sort((a, b) => b.label.length - a.label.length);
  const marks: Array<{ key: KnowledgeSection | "conflict"; index: number }> = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > 60) continue;
    const match = labels.find((l) => trimmed.toUpperCase().startsWith(l.label));
    if (match) {
      marks.push({ key: match.key, index: text.indexOf(line) });
    }
  }
  // Need at least an answer and one more section to render as a knowledge
  // card — a lone "SOURCE" heading in prose is not a knowledge answer.
  const uniqueKeys = new Set(marks.map((m) => m.key));
  if (!uniqueKeys.has("answer") || uniqueKeys.size < 2) return null;

  marks.sort((a, b) => a.index - b.index);
  const sections: ParsedKnowledge["sections"] = {};
  const order: KnowledgeSection[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + text.slice(marks[i].index).indexOf("\n") + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (body.length === 0) continue;
    if (sections[marks[i].key] === undefined) order.push(marks[i].key as KnowledgeSection);
    sections[marks[i].key] =
      sections[marks[i].key] === undefined
        ? body
        : `${sections[marks[i].key]}\n${body}`;
  }
  return { kind: "knowledge", sections, order };
}

const CITE_RE = /\[\d+\]/;
const STEPS_RE = /^\s*\d+[.)]\s+\S/m;
const CHECKBOX_RE = /^\s*[-*]\s+\[[ xX]\]\s+\S/m;
const TABLE_RE = /^\|.+\|\s*$/m;
const REVIEW_RE = /\b(HUMAN REVIEW REQUIRED|ESCALATE WHEN)\b/;

/** Detect which structured renderer fits the finished text. */
export function detectAnswerShape(text: string): AnswerShape {
  if (text.length === 0) return "plain";
  if (parseKnowledgeSections(text) !== null) return "knowledge";
  if (CHECKBOX_RE.test(text)) return "checklist";
  if (STEPS_RE.test(text) && /\n\s*\d+[.)]\s+\S/.test(text)) return "procedure";
  if (TABLE_RE.test(text)) return "comparison";
  if (CITE_RE.test(text) && /\[(1|2)\]/.test(text)) return "research";
  if (REVIEW_RE.test(text)) return "warning";
  return "plain";
}

/**
 * Extract web citation markers with their surrounding text for source chips.
 * Returns one entry per DISTINCT citation number, with the label Omi emitted
 * (from the [n] Title / URL / EXCERPT search block when it was echoed) or a
 * generic label otherwise.
 */
export type Citation = { n: number; hint: string };

export function extractCitations(text: string): Citation[] {
  const seen = new Map<number, string>();
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    // The label hint is the text after the marker, up to the next marker,
    // a newline or a URL — enough for a readable chip, nothing more.
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 120);
    const nextMarker = rest.search(/\[\d+\]/);
    const segment = (nextMarker === -1 ? rest : rest.slice(0, nextMarker))
      .split(/https?:\/\//)[0]
      .split("\n")[0]
      .replace(/^[\s,.;:—-]+/, "")
      .trim();
    if (!seen.has(n) && segment.length > 0) {
      seen.set(n, segment.slice(0, 60));
    }
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, hint]) => ({ n, hint }));
}

/** True when the text carries Omi's "INTERNAL KNOWLEDGE" provenance label. */
export function isInternalKnowledge(text: string): boolean {
  return /APPROVED KNOWLEDGE|INTERNAL KNOWLEDGE/i.test(text);
}

/** Steps of a procedure answer ("1. Do x" lines), verbatim, no invention. */
export function extractSteps(text: string): string[] {
  return text
    .split("\n")
    .map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((s): s is string => Boolean(s && s.length > 1))
    .slice(0, 20);
}

/** Checkbox items of a checklist answer, with their checked state. */
export function extractChecklist(text: string): Array<{ text: string; done: boolean }> {
  const out: Array<{ text: string; done: boolean }> = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (m) out.push({ text: m[2].trim(), done: m[1].toLowerCase() === "x" });
    if (out.length >= 30) break;
  }
  return out;
}

/** The progressive status a streaming turn reports (schema: message.reasoning). */
export const PROGRESS_STAGES = [
  "UNDERSTANDING",
  "SEARCHING",
  "ANALYZING",
  "VERIFYING",
  "PREPARING ANSWER",
] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

/**
 * Map a streaming message's interim content/reasoning to a visible stage.
 * This is a presentation heuristic over the status text Omi already patches
 * into the live message ("Omi is searching the web…", "Reading N sources…",
 * "Omi is checking approved knowledge…") — never chain-of-thought.
 */
export function stageForStatus(status?: string): ProgressStage {
  const s = (status ?? "").toLowerCase();
  if (/check(ing)? approved knowledge/.test(s)) return "VERIFYING";
  if (/read(ing)?|analyz/.test(s)) return "ANALYZING";
  if (/search|sources/.test(s)) return "SEARCHING";
  if (/thinking|understand/.test(s)) return "UNDERSTANDING";
  return "PREPARING ANSWER";
}
