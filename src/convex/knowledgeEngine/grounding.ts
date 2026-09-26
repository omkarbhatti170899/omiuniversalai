/**
 * Omi Knowledge Intelligence — grounded answers + ACTION PLANS (pure).
 *
 * Product principle (§21): SEARCH → RETRIEVE → VERIFY → ANSWER → CITE.
 * NOT: ASK AI → GUESS → ANSWER.
 *
 * And the newer rule: don't just tell the user the answer — show what to do
 * next. Every procedural answer becomes an ACTION PLAN derived STRICTLY from
 * the retrieved authoritative article text. If the article lists no explicit
 * steps, no steps are invented — the plan says so and points at the evidence.
 */

export type KnowledgePassage = {
  articleId: string;
  familyId: string;
  title: string;
  version: number;
  status: string;
  effectiveDate?: number;
  sourceType: "internal" | "external";
  snippet: string;
  content: string;
  score: number;
};

export type GroundedSource = {
  articleId: string;
  title: string;
  version: number;
  status: string;
  effectiveDate?: number;
};

export type GroundedAnswer = {
  answered: boolean;
  /** Provenance label — internal knowledge vs external research vs none. */
  sourceKind: "internal" | "external" | "none";
  answer: string;
  source?: GroundedSource;
  relevantSection?: string;
  evidence: string[];
  exceptions: string[];
  escalateWhen: string[];
  reason?: string;
  score: number;
};

export type TroubleshootingStep = {
  problem: string;
  action: string;
  escalate: boolean;
};

export type ActionPlan = GroundedAnswer & {
  mode: "procedure" | "troubleshooting" | "workflow" | "general";
  /** Numbered steps, extracted verbatim from the approved article only. */
  steps: string[];
  /** False when the article lists no explicit steps (nothing was invented). */
  stepsSupported: boolean;
  requiredInfo: string[];
  checks: string[];
  troubleshooting: TroubleshootingStep[];
  /** Descriptions of conflicting matched procedures (never auto-resolved). */
  conflicts: string[];
  note?: string;
};

/** Below this BM25 score the answer is not supported well enough to give. */
export const GROUNDING_MIN_SCORE = 1.5;
/** Two procedures this close in score are treated as a conflict, not a pick. */
export const CONFLICT_DOMINANCE_RATIO = 1.3;
export const MAX_STEPS = 15;

const STOP = new Set([
  "how", "do", "i", "the", "a", "an", "to", "for", "of", "in", "on", "is",
  "what", "whats", "what's", "please", "can", "you", "me", "my", "we", "our",
  "and", "or", "it", "this", "that", "with", "are", "be", "should", "does",
]);

/**
 * A stable key grouping phrasings of the same gap: lowercase, punctuation
 * stripped, stopwords removed, first significant tokens kept.
 */
export function normalizeQuestionKey(question: string): string {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP.has(t));
  return tokens.slice(0, 8).join(" ") || question.trim().toLowerCase().slice(0, 60);
}

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function lines(content: string): string[] {
  return content
    .split(/\n+|(?<=[.!?])\s+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The lines of a passage that actually address the question, best first. */
export function extractRelevantLines(
  content: string,
  query: string,
  max = 4,
): string[] {
  const qs = terms(query);
  const scored = lines(content).map((line) => {
    const lower = line.toLowerCase();
    const overlap = qs.filter((t) => lower.includes(t)).length;
    return { line, overlap };
  });
  const hit = scored.filter((s) => s.overlap > 0);
  const pool = hit.length > 0 ? hit : scored.slice(0, max);
  return pool
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, max)
    .map((s) => s.line);
}

const EXCEPTION_RE = /\bexcept(?:ion)?s?\b|\bunless\b|\bdoes not apply\b|\bnot applicable\b/i;
const ESCALATE_RE =
  /\bescalat|\bhuman review\b|\brefer to\b|\bsupervisor\b|\bmanager approval\b|\bseek approval\b|\bhand[- ]?off\b/i;

export function extractExceptions(content: string): string[] {
  return lines(content).filter((l) => EXCEPTION_RE.test(l)).slice(0, 4);
}

export function extractEscalations(content: string): string[] {
  return lines(content).filter((l) => ESCALATE_RE.test(l)).slice(0, 4);
}

// --- Action-plan extraction (STRICTLY from the article) ---------------------

/**
 * Ordered steps that the article itself enumerates. Recognises `1.`, `1)`,
 * `Step N`, and `-`/`*`/`•` list items. Returns [] when the article lists no
 * steps — the caller must NOT fabricate any.
 */
export function extractSteps(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const numbered = /^(?:step\s*)?(\d{1,2})[.)]\s+(.+)$/i.exec(line);
    if (numbered) {
      out.push(numbered[2].trim());
      continue;
    }
    const bulleted = /^[-*•]\s+(.+)$/.exec(line);
    if (bulleted && bulleted[1].trim().length > 0) {
      out.push(bulleted[1].trim());
    }
  }
  return out.filter((s) => s.length > 2).slice(0, MAX_STEPS);
}

const REQUIRED_RE =
  /\b(must provide|must include|required (?:information|document|documents|details|field)|need(?:ed)? to (?:provide|attach|supply)|provide the following|attach(?:ed)?|upload(?:ed)?|documents? required)\b/i;
const CHECK_RE = /\b(check|verify|ensure|confirm|validate|double[- ]check|review)\b/i;
const IF_THEN_RE = /^if\b.*\b(then|,|→)\b/i;
const PROBLEM_RE = /\b(error|fails?|failed|not working|broken|issue|problem|unable|cannot|can't|won't|rejected|declined)\b/i;

export function extractRequiredInfo(content: string): string[] {
  return lines(content).filter((l) => REQUIRED_RE.test(l)).slice(0, 6);
}

export function extractChecks(content: string): string[] {
  return lines(content).filter((l) => CHECK_RE.test(l)).slice(0, 6);
}

/** Trouble-shooting pairs derived from "If <problem>, <action>" lines. */
export function extractTroubleshooting(content: string): TroubleshootingStep[] {
  const out: TroubleshootingStep[] = [];
  for (const line of lines(content)) {
    if (!IF_THEN_RE.test(line) && !PROBLEM_RE.test(line)) continue;
    const m = /^if\b([\s\S]*?)(?:,|\bthen\b|→)\s*(.+)$/i.exec(line);
    const problem = m ? m[1].trim() : line;
    const action = m ? m[2].trim() : "";
    if (problem.length === 0) continue;
    out.push({ problem, action, escalate: ESCALATE_RE.test(line) });
    if (out.length >= 5) break;
  }
  return out;
}

export function detectMode(
  question: string,
  content: string,
  steps: string[],
): ActionPlan["mode"] {
  const q = question.toLowerCase();
  const c = content.toLowerCase();
  if (
    /\b(error|not working|fails?|failed|broken|troubleshoot|problem|issue|can'?t|cannot|won'?t|rejected|declined)\b/.test(q) ||
    PROBLEM_RE.test(c)
  ) {
    return "troubleshooting";
  }
  if (/\b(workflow|end[- ]to[- ]end|decision point|sign[- ]?off)\b/.test(q + " " + c)) {
    return "workflow";
  }
  if (steps.length > 0) return "procedure";
  return "general";
}

/**
 * Conflicting approved procedures: two strong matches from DIFFERENT families
 * whose scores are close. Omi never silently picks one — it reports both.
 */
export function detectConflicts(
  passages: KnowledgePassage[],
  minScore = GROUNDING_MIN_SCORE,
  ratio = CONFLICT_DOMINANCE_RATIO,
): string[] {
  const strong = passages.filter((p) => p.score >= minScore);
  if (strong.length < 2) return [];
  const [a, b] = strong;
  if (a.familyId === b.familyId) return [];
  if (b.score < a.score / ratio) return [];
  return [
    `Two approved procedures match this question closely: "${a.title}" (v${a.version}) and "${b.title}" (v${b.version}).`,
  ];
}

/** Detect a markdown heading nearest to the evidence line (best effort). */
export function nearestHeading(content: string, evidenceLine: string): string | undefined {
  const idx = content.indexOf(evidenceLine);
  if (idx < 0) return undefined;
  const before = content.slice(0, idx).split("\n");
  for (let i = before.length - 1; i >= 0; i--) {
    const m = /^#{1,6}\s+(.+)$/.exec(before[i].trim());
    if (m) return m[1].trim();
  }
  return undefined;
}

/** Human label for a source kind, used to keep internal vs external explicit. */
export function labelSourceKind(kind: GroundedAnswer["sourceKind"]): string {
  switch (kind) {
    case "internal":
      return "INTERNAL KNOWLEDGE";
    case "external":
      return "EXTERNAL RESEARCH";
    default:
      return "NO SOURCE";
  }
}

/**
 * Build the structured grounded answer. Deterministic — no model call — so it
 * can never hallucinate, and the citation is always the exact article that
 * supplied the evidence.
 */
export function buildGroundedAnswer(
  question: string,
  passages: KnowledgePassage[],
  opts: { minScore?: number } = {},
): GroundedAnswer {
  const minScore = opts.minScore ?? GROUNDING_MIN_SCORE;
  const top = passages[0];
  if (!top || top.score < minScore) {
    return {
      answered: false,
      sourceKind: "none",
      answer:
        "The approved knowledge base does not contain sufficient information to answer this confidently. This question has been logged as a knowledge gap for review.",
      evidence: [],
      exceptions: [],
      escalateWhen: [],
      reason: top ? "the best match scored below the evidence floor" : "no matching approved knowledge",
      score: top?.score ?? 0,
    };
  }

  const evidence = extractRelevantLines(top.content, question, 4);
  const source: GroundedSource = {
    articleId: top.articleId,
    title: top.title,
    version: top.version,
    status: top.status,
    effectiveDate: top.effectiveDate,
  };

  return {
    answered: true,
    sourceKind: top.sourceType,
    answer: evidence[0] ?? top.snippet,
    source,
    relevantSection: evidence[0] ? nearestHeading(top.content, evidence[0]) : undefined,
    evidence,
    exceptions: extractExceptions(top.content),
    escalateWhen: extractEscalations(top.content),
    score: top.score,
  };
}

/**
 * Build the ACTION PLAN. Steps/checks/required-info/troubleshooting come ONLY
 * from the authoritative article's own text; when the article lists nothing,
 * the plan states that explicitly instead of inventing steps.
 */
export function buildActionPlan(
  question: string,
  passages: KnowledgePassage[],
  opts: { minScore?: number } = {},
): ActionPlan {
  const base = buildGroundedAnswer(question, passages, opts);
  const conflicts = detectConflicts(passages, opts.minScore ?? GROUNDING_MIN_SCORE);

  if (!base.answered) {
    return {
      ...base,
      mode: "general",
      steps: [],
      stepsSupported: false,
      requiredInfo: [],
      checks: [],
      troubleshooting: [],
      conflicts,
      note: undefined,
    };
  }

  const top = passages[0];
  const steps = extractSteps(top.content);
  const mode = detectMode(question, top.content, steps);
  const troubleshooting = mode === "troubleshooting" ? extractTroubleshooting(top.content) : [];
  const requiredInfo = extractRequiredInfo(top.content);
  const checks = extractChecks(top.content);

  const notes: string[] = [];
  if (steps.length === 0) {
    notes.push(
      "The approved article does not list explicit steps, so none were invented — see the evidence below.",
    );
  }
  if (conflicts.length > 0) {
    notes.push("More than one approved procedure may apply — human review is requested rather than a silent choice.");
  }

  return {
    ...base,
    mode,
    steps,
    stepsSupported: steps.length > 0,
    requiredInfo,
    checks,
    troubleshooting,
    conflicts,
    note: notes.length > 0 ? notes.join(" ") : undefined,
  };
}

/** Render a grounded answer as the human-facing block (§3 format). */
export function formatGroundedAnswer(a: GroundedAnswer): string {
  if (!a.answered || !a.source) return a.answer;
  const parts = [
    `ANSWER\n${a.answer}`,
    `SOURCE\n${a.source.title}`,
    `VERSION\n${a.source.version}`,
    a.source.effectiveDate
      ? `EFFECTIVE\n${new Date(a.source.effectiveDate).toISOString().slice(0, 10)}`
      : null,
    a.relevantSection ? `RELEVANT SECTION\n${a.relevantSection}` : null,
    a.evidence.length > 1 ? `EVIDENCE\n${a.evidence.slice(1).join("\n")}` : null,
    a.exceptions.length > 0 ? `EXCEPTIONS\n${a.exceptions.join("\n")}` : null,
    a.escalateWhen.length > 0 ? `ESCALATE WHEN\n${a.escalateWhen.join("\n")}` : null,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Render an ACTION PLAN in the 9-part structure Omi shows the user. */
export function formatActionPlan(p: ActionPlan): string {
  if (!p.answered || !p.source) return p.answer;

  const parts: Array<string | null> = [`DIRECT ANSWER\n${p.answer}`];

  if (p.mode === "troubleshooting" && p.troubleshooting.length > 0) {
    parts.push(
      `WHAT TO DO\n${p.troubleshooting
        .map(
          (t, i) =>
            `${i + 1}. PROBLEM: ${t.problem}\n   CHECK: ${t.action || "see the article"}${
              t.escalate ? "\n   ESCALATE: yes — this condition requires human review" : ""
            }`,
        )
        .join("\n")}`,
    );
  } else if (p.stepsSupported) {
    parts.push(`WHAT TO DO\n${p.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  } else {
    parts.push(
      `WHAT TO DO\nNo explicit steps are listed in the approved article, so Omi will not invent any. Use the evidence below, or ask a knowledge owner to add step-by-step instructions.`,
    );
  }

  if (p.requiredInfo.length > 0) {
    parts.push(`REQUIRED INFORMATION / DOCUMENTS\n${p.requiredInfo.map((r) => `• ${r}`).join("\n")}`);
  }
  if (p.checks.length > 0) {
    parts.push(`IMPORTANT CHECKS\n${p.checks.map((c) => `• ${c}`).join("\n")}`);
  }
  if (p.exceptions.length > 0) {
    parts.push(`EXCEPTIONS / EDGE CASES\n${p.exceptions.map((e) => `• ${e}`).join("\n")}`);
  }
  if (p.escalateWhen.length > 0) {
    parts.push(`WHEN TO ESCALATE\n${p.escalateWhen.map((e) => `• ${e}`).join("\n")}`);
  } else {
    parts.push(`WHEN TO ESCALATE\n• If anything is unclear or the situation is not covered above — request human review.`);
  }
  parts.push(`SOURCE ARTICLE\n${p.source.title}`);
  parts.push(
    `VERSION / EFFECTIVE DATE\nv${p.source.version}${
      p.source.effectiveDate
        ? ` · effective ${new Date(p.source.effectiveDate).toISOString().slice(0, 10)}`
        : ""
    }`,
  );
  if (p.evidence.length > 0) {
    parts.push(`SUPPORTING EVIDENCE\n${p.evidence.map((e) => `• ${e}`).join("\n")}`);
  }
  if (p.conflicts.length > 0) {
    parts.push(`CONFLICT — HUMAN REVIEW REQUIRED\n${p.conflicts.map((c) => `• ${c}`).join("\n")}`);
  }
  if (p.note) parts.push(`IMPORTANT\n${p.note}`);

  return parts.filter(Boolean).join("\n\n");
}
