/**
 * Omi Knowledge Intelligence — grounded-answer construction (pure).
 *
 * The product principle (§21): SEARCH → RETRIEVE → VERIFY → ANSWER → CITE.
 * NOT: ASK AI → GUESS → ANSWER. This module never invents an answer: if the
 * approved evidence is below the confidence floor it says so plainly, and the
 * caller escalates (web research or human review) instead.
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

/** Below this BM25 score the answer is not supported well enough to give. */
export const GROUNDING_MIN_SCORE = 1.5;

const STOP = new Set([
  "how", "do", "i", "the", "a", "an", "to", "for", "of", "in", "on", "is",
  "what", "whats", "what's", "please", "can", "you", "me", "my", "we", "our",
  "and", "or", "it", "this", "that", "with", "are", "be", "should", "does",
]);

/**
 * A stable key grouping phrasings of the same gap: lowercase, punctuation
 * stripped, stopwords removed, first significant tokens kept. "How do I handle
 * procedure X?" and "procedure X handling" collapse to the same key.
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
    a.escalateWhen.length > 0
      ? `ESCALATE WHEN\n${a.escalateWhen.join("\n")}`
      : null,
  ];
  return parts.filter(Boolean).join("\n\n");
}
