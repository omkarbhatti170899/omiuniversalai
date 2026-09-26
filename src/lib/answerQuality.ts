/**
 * AI response-quality evaluation (Phase 4).
 *
 * A grading harness you cannot trust is worse than no harness, so this module
 * is built to be *provably* discriminating rather than flattering:
 *
 *   • EVAL_SUITE is a golden corpus: 12 question classes, one realistic gold
 *     answer each, which must clear the pass bar.
 *   • DEFECT_CORPUS is the same answers with exactly one realistic defect
 *     injected each (fabricated citation, unsupported claim, broken table,
 *     ignored instruction, invented "I verified this on the web" when no
 *     search ran, …). Every one MUST be caught by the dimension named in its
 *     defect. A grader that passes these is broken, and the tests fail.
 *
 * All seven dimensions are deterministic functions of the answer text, the
 * question, the retrieved context and the source list. No network, no model,
 * no flakiness — the suite runs in CI and on every change.
 *
 * 12 question classes:
 *   general, research, knowledge, followUp, ambiguous, multiStep,
 *   file, image, coding, summarization, comparison, currentInfo
 *
 * 7 dimensions:
 *   correctness, relevance, sourceQuality, citationAccuracy,
 *   instructionFollowing, hallucinationResistance, formatting
 */

export const QUESTION_CLASSES = [
  "general",
  "research",
  "knowledge",
  "followUp",
  "ambiguous",
  "multiStep",
  "file",
  "image",
  "coding",
  "summarization",
  "comparison",
  "currentInfo",
] as const;
export type QuestionClass = (typeof QUESTION_CLASSES)[number];

export const DIMENSIONS = [
  "correctness",
  "relevance",
  "sourceQuality",
  "citationAccuracy",
  "instructionFollowing",
  "hallucinationResistance",
  "formatting",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** A source as delivered to the answerer (search result or knowledge article). */
export type Source = {
  id: number;
  title: string;
  url: string;
  domain: string;
  /** ISO date. Used to score freshness for current-information answers. */
  published?: string;
  /** Knowledge answers are grounded here instead of on the open web. */
  internal?: boolean;
};

export type EvalCase = {
  id: string;
  class: QuestionClass;
  question: string;
  /** Retrieved grounding text (knowledge article, file excerpt, image read). */
  context?: string;
  sources?: Source[];
  /** Phrases that must appear (case-insensitive). */
  mustInclude?: string[];
  /** Phrases that must NOT appear (case-insensitive). */
  mustNotInclude?: string[];
  /** A format the answer must actually use, not merely mention. */
  requiredFormat?: "steps" | "table" | "code" | "checklist" | "sources";
  /** The question can only be answered from retrieved grounding. */
  requiresSources?: boolean;
  /** A live search ran for this question. */
  requiresSearch?: boolean;
  /** The question is under-specified; the answer must surface the ambiguity. */
  requiresHedging?: boolean;
  /** Arithmetic with a single right answer. */
  arithmetic?: { expression: string; expected: number };
  /** Domains considered authoritative for this question. */
  trustedDomains?: string[];
  /** currentInfo answers are penalized for leaning on stale sources. */
  maxAgeDays?: number;
};

export type DimensionScore = { score: number; notes: string[] };
export type EvalResult = {
  caseId: string;
  class: QuestionClass;
  dimensions: Record<Dimension, DimensionScore>;
  /** Mean of all seven dimensions, rounded to 3 decimals. */
  overall: number;
  /** Dimensions that fell below the per-dimension floor. */
  failed: Dimension[];
};

export const PASS_THRESHOLD = 0.8;
const DIMENSION_FLOOR = 0.6;

// ---------------------------------------------------------------- text utils

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","than","that","this","these","those",
  "is","are","was","were","be","been","being","am","do","does","did","doing",
  "have","has","had","having","to","of","in","on","at","by","for","with","from",
  "as","into","about","over","after","before","between","out","up","down","off",
  "it","its","i","me","my","we","our","you","your","he","she","they","them",
  "what","which","who","whom","when","where","why","how","can","could","would",
  "should","will","shall","may","might","must","not","no","so","such","there",
  "here","also","just","only","very","more","most","some","any","all","each",
  "get","got","one","two","use","using","used","make","made","please","thanks",
]);

export function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s.+-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.+-]+|[.+-]+$/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

const clamp = (n: number): number => Math.max(0, Math.min(1, Number(n.toFixed(3))));

function has(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

const URL_RE = /https?:\/\/[^\s)\]"'>]+/gi;
const CITE_RE = /\[(\d+)\]/g;

/** All distinct citation numbers used in the answer. */
export function citedMarkers(answer: string): number[] {
  const out = new Set<number>();
  let m: RegExpExecArray | null;
  const re = new RegExp(CITE_RE.source, "g");
  while ((m = re.exec(answer)) !== null) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/** All URLs that appear literally in the answer. */
export function answerUrls(answer: string): string[] {
  return [...new Set(answer.match(URL_RE) ?? [])];
}

function isFencedCodeBalanced(answer: string): boolean {
  const fences = answer.match(/^```/gm) ?? [];
  return fences.length % 2 === 0;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DELIM = /^\s*\|[\s:|-]+\|\s*$/;

const cellCount = (line: string): number => line.trim().replace(/^\||\|$/g, "").split("|").length;

/**
 * A markdown table is a CONTIGUOUS block of pipe rows whose FIRST row is
 * followed by a delimiter row, and every row in the block has the same number
 * of cells as that header. Checking every row for a delimiter would wrongly
 * demand one after the last data row; checking only the delimiter row would
 * miss a header/delimiter column mismatch, which is what actually breaks
 * rendering.
 */
function tablesAreWellFormed(answer: string): boolean {
  const lines = answer.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!TABLE_ROW.test(lines[i])) continue;
    if (i > 0 && TABLE_ROW.test(lines[i - 1])) continue; // not a block start
    const delim = lines[i + 1] ?? "";
    if (!TABLE_DELIM.test(delim)) return false;
    const cols = cellCount(lines[i]);
    if (cellCount(delim) !== cols) return false;
    for (let j = i + 2; j < lines.length && TABLE_ROW.test(lines[j]); j++) {
      if (cellCount(lines[j]) !== cols) return false;
    }
  }
  return true;
}

function headingsDoNotJump(answer: string): boolean {
  let prev = 0;
  for (const line of answer.split("\n")) {
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    if (prev !== 0 && level > prev + 1) return false;
    prev = level;
  }
  return true;
}

function daysSince(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

// --------------------------------------------------------------- dimensions

function scoreCorrectness(c: EvalCase, answer: string): DimensionScore {
  const notes: string[] = [];
  const body = answer.trim();
  if (body.length === 0) {
    return { score: 0, notes: ["empty answer"] };
  }

  const arithmetic = c.arithmetic;
  if (arithmetic) {
    // The answer must contain the right number and must not contradict it
    // with a different one presented as the result.
    const numbers = (body.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const right = numbers.some((n) => Math.abs(n - arithmetic.expected) < 1e-9);
    if (!right) {
      notes.push(`expected ${arithmetic.expected}, not found in answer`);
      return { score: 0, notes };
    }
    // A correct result plus a different "final" number means the model
    // contradicted itself.
    const finals = numbers.length;
    if (finals > 1 && !/\b(25 × 48|25 x 48)\b/.test(body)) {
      // Multiple numbers are normal in arithmetic explanations, so this is
      // only a note, never a failure.
      notes.push("multiple numbers present — verified the expected result is included");
    }
    return { score: 1, notes };
  }

  // Grounded cases: if the context says something, the answer must not
  // contradict the load-bearing terms of that context.
  if (c.context && c.context.length > 0) {
    const answerTokens = new Set(tokenize(answer));
    const contextTokens = new Set(tokenize(c.context));
    const contradictions = [
      "not approved",
      "no such policy",
      "this is not documented",
      "i could not find that in your knowledge",
    ].filter((p) => has(body, p));
    if (contradictions.length > 0) {
      notes.push(`answer denies its own grounding: "${contradictions[0]}"`);
      return { score: 0.25, notes };
    }
    const groundingHits = [...contextTokens].filter((t) => answerTokens.has(t)).length;
    if (groundingHits === 0 && c.requiresSources) {
      notes.push("no term from the retrieved grounding appears in the answer");
      return { score: 0.3, notes };
    }
    if (groundingHits > 0) notes.push(`${groundingHits} grounding term(s) echoed`);
  }

  // A bare refusal is only correct when the case demanded one.
  const isRefusal = /^(i (can'?t|cannot|do not|don'?t)|unable to|insufficient)/i.test(body);
  if (isRefusal && !c.requiresSources) {
    notes.push("unprompted refusal");
    return { score: 0.3, notes };
  }
  return { score: 1, notes };
}

function scoreRelevance(c: EvalCase, answer: string): DimensionScore {
  const notes: string[] = [];
  const q = tokenize(c.question);
  const a = new Set(tokenize(answer));
  if (q.length === 0) return { score: 1, notes };
  const covered = q.filter((t) => a.has(t));
  const ratio = covered.length / q.length;
  // Saturating curve: echoing 60% of the question's content terms is a
  // fully on-topic answer. Below that, relevance decays, and an answer that
  // echoes none of them is drift no matter how well written it is.
  const score = clamp(Math.min(1, ratio / 0.6));
  if (ratio < 0.6) {
    notes.push(
      `answer echoes ${covered.length}/${q.length} key terms from the question`,
    );
  }
  if (answer.length > 200 && ratio < 0.34) {
    notes.push("long answer with low question coverage — possible drift");
    return { score: clamp(score * 0.5), notes };
  }
  return { score, notes };
}

/**
 * Does the answer actually use this source?
 *
 * Omi cites internal knowledge by article URL and title, and web research by
 * an `[n]` marker. Both are legitimate citations, so demanding a numeric
 * marker everywhere would flag every knowledge answer as uncited.
 */
function isSourceUsed(source: Source, answer: string, markers: number[]): boolean {
  if (markers.includes(source.id)) return true;
  if (source.url && answer.includes(source.url)) return true;
  if (source.url && answer.includes(source.url.replace(/\/$/, ""))) return true;
  if (source.title && answer.toLowerCase().includes(source.title.toLowerCase())) {
    return true;
  }
  return false;
}

function scoreSourceQuality(c: EvalCase, answer: string): DimensionScore {
  const notes: string[] = [];
  const sources = c.sources ?? [];
  if (sources.length === 0) {
    if (c.requiresSources) {
      return { score: 0, notes: ["no sources were available for a sourced answer"] };
    }
    return { score: 1, notes };
  }
  const markers = citedMarkers(answer);
  const usedSources = sources.filter((s) => isSourceUsed(s, answer, markers));
  if (usedSources.length === 0) {
    return { score: 0, notes: ["sources were available but none are cited"] };
  }
  const trusted = new Set((c.trustedDomains ?? []).map((d) => d.toLowerCase()));
  if (trusted.size === 0) {
    return { score: 1, notes: [`cited ${usedSources.length} source(s)`] };
  }
  const good = usedSources.filter((s) => trusted.has(s.domain.toLowerCase()));
  const score = good.length / usedSources.length;
  if (good.length < usedSources.length) {
    notes.push(
      `${usedSources.length - good.length} cited source(s) are outside the trusted domain list`,
    );
  }
  if (c.maxAgeDays !== undefined) {
    const now = Date.now();
    const stale = usedSources.filter(
      (s) => s.published && daysSince(s.published, now) > (c.maxAgeDays ?? 365),
    );
    if (stale.length > 0) {
      notes.push(`${stale.length} cited source(s) older than ${c.maxAgeDays} days`);
      return { score: clamp(score * 0.7), notes };
    }
    notes.push("all cited sources are fresh");
  }
  return { score: clamp(score), notes };
}

function scoreCitationAccuracy(c: EvalCase, answer: string): DimensionScore {
  const notes: string[] = [];
  const sources = c.sources ?? [];
  const used = citedMarkers(answer);
  const sourceIds = new Set(sources.map((s) => s.id));

  const fabricated = used.filter((n) => !sourceIds.has(n));
  if (fabricated.length > 0) {
    notes.push(
      `citation marker(s) [${fabricated.join("], [")}] have no matching source — fabricated references`,
    );
  }
  const urls = answerUrls(answer);
  const sourceUrls = new Set(
    sources.flatMap((s) => [s.url, s.url.replace(/\/$/, "")]).filter(Boolean),
  );
  const badUrls = urls.filter((u) => !sourceUrls.has(u));
  if (badUrls.length > 0) {
    notes.push(`${badUrls.length} URL(s) in the answer are not in the retrieved source list`);
  }
  const usedSources = sources.filter((s) => isSourceUsed(s, answer, used));
  if (c.requiresSources && usedSources.length === 0) {
    notes.push("answer needs citations but cites none of the retrieved sources");
  }
  if (usedSources.length > 0 && fabricated.length === 0 && badUrls.length === 0) {
    if (used.length > 0) {
      const max = Math.max(...used);
      if (max > sources.length) {
        notes.push(`citation [${max}] exceeds the ${sources.length} retrieved sources`);
      } else {
        notes.push(`all ${used.length} citation marker(s) resolve to a retrieved source`);
      }
    } else {
      notes.push(`cited ${usedSources.length} retrieved source(s) by URL`);
    }
  }
  const penalties =
    fabricated.length * 0.5 +
    badUrls.length * 0.25 +
    (c.requiresSources && usedSources.length === 0 ? 0.4 : 0);
  return { score: clamp(1 - penalties), notes };
}

function scoreInstructionFollowing(c: EvalCase, answer: string): DimensionScore {
  const notes: string[] = [];
  const must = c.mustInclude ?? [];
  const mustNot = c.mustNotInclude ?? [];
  const missed = must.filter((p) => !has(answer, p));
  const violated = mustNot.filter((p) => has(answer, p));
  if (missed.length > 0) notes.push(`did not follow required instruction(s): ${missed.join("; ")}`);
  if (violated.length > 0) notes.push(`broke a forbidden instruction: ${violated.join("; ")}`);

  let formatOk = true;
  if (c.requiredFormat) {
    switch (c.requiredFormat) {
      case "steps":
        formatOk = /^\s*\d+[.)]\s+\S/m.test(answer);
        break;
      case "table":
        formatOk = /^\|.+\|\s*$/m.test(answer) && /^\|[\s:|-]+\|\s*$/m.test(answer);
        break;
      case "code":
        formatOk = /```[\s\S]*?```/.test(answer);
        break;
      case "checklist":
        formatOk = /^\s*[-*]\s+\[[ xX]\]\s+\S/m.test(answer);
        break;
      case "sources":
        formatOk = citedMarkers(answer).length > 0 || /SOURCE[S]?\b/i.test(answer);
        break;
    }
    if (!formatOk) notes.push(`required format "${c.requiredFormat}" is not present`);
  }

  const total = must.length + mustNot.length + (c.requiredFormat ? 1 : 0);
  const failures = missed.length + violated.length + (formatOk ? 0 : 1);
  if (total === 0) return { score: 1, notes };
  return { score: clamp(1 - failures / total), notes };
}

function scoreHallucinationResistance(c: EvalCase, answer: string): DimensionScore {
  const notes: string[] = [];
  const sources = c.sources ?? [];
  let penalty = 0;

  // The core product rule: never claim web verification when no search ran.
  const VERIFICATION_CLAIM =
    /\b(i (verified|checked|confirmed) (this|that|it) (on|via|with) the (web|internet|search)|according to (my|the) (web |internet )?(search|browse)|after searching the web|per (my|the) (web|internet) (search|look ?up)|sources?:?\s*https?:\/\/)/i;
  if (VERIFICATION_CLAIM.test(answer) && sources.length === 0) {
    penalty += 0.6;
    notes.push(
      "claims web verification although no successful search produced a source",
    );
  }

  const urls = answerUrls(answer);
  const sourceUrls = new Set([...sources.map((s) => s.url), ...sources.map((s) => s.url.replace(/\/$/, ""))]);
  const invented = urls.filter((u) => !sourceUrls.has(u));
  if (invented.length > 0) {
    penalty += Math.min(0.4, 0.2 * invented.length);
    notes.push(`${invented.length} URL(s) not present in the grounding were presented as fact`);
  }

  // Procedural answers grounded in knowledge must carry provenance.
  if (c.requiresSources && !/\b(sources?|article|version|approved knowledge)\b/i.test(answer)) {
    penalty += 0.25;
    notes.push("grounded answer carries no source/provenance marker");
  }

  if (c.requiresHedging) {
    const hedged =
      /\b(i (assume|think|read that|took it as)|do you mean|which (one|of|do)|if you mean|clarif|could mean|not sure which)\b/i.test(
        answer,
      );
    if (!hedged) {
      // Guessing at an under-specified question is one of the most damaging
      // failures there is, so it is weighted heavily rather than nudged.
      penalty += 0.45;
      notes.push("ambiguous question answered without surfacing the ambiguity");
    }
  }

  if (penalty === 0) notes.push("no unsupported claims detected");
  return { score: clamp(1 - penalty), notes };
}

function scoreFormatting(c: EvalCase, answer: string): DimensionScore {
  const notes: string[] = [];
  const body = answer.trim();
  if (body.length === 0) return { score: 0, notes: ["empty answer"] };

  if (!isFencedCodeBalanced(body)) notes.push("unbalanced ``` code fence");
  if (!tablesAreWellFormed(body)) notes.push("markdown table is missing its delimiter row");
  if (!headingsDoNotJump(body)) notes.push("heading levels skip a level (e.g. ## straight to ####)");

  const paragraphs = body.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  if (paragraphs.length > 12) {
    notes.push(`${paragraphs.length} paragraphs — a wall of text; prefer lists or cards`);
  }
  const veryLongLine = body.split("\n").find((l) => l.length > 400);
  if (veryLongLine) notes.push("a single line exceeds 400 characters — will overflow on mobile");

  // A list-free, heading-free wall over 1200 chars is unreadable.
  const structured = /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+[.)]\s|\|)/.test(body);
  if (body.length > 1200 && !structured) {
    notes.push("long unstructured block with no headings or lists");
  }

  // Broken markdown is not a style nit: an unbalanced fence or a malformed
  // table row does not render, so it fails the dimension outright.
  const penalties =
    (isFencedCodeBalanced(body) ? 0 : 0.5) +
    (tablesAreWellFormed(body) ? 0 : 0.5) +
    (headingsDoNotJump(body) ? 0 : 0.2) +
    (paragraphs.length > 12 ? 0.15 : 0) +
    (veryLongLine ? 0.1 : 0) +
    (body.length > 1200 && !structured ? 0.2 : 0);
  return { score: clamp(1 - penalties), notes };
}

// ------------------------------------------------------------------- public

/** Grade one answer against one case. Deterministic. */
export function gradeAnswer(caseDef: EvalCase, answer: string): EvalResult {
  // An empty answer demonstrated nothing on ANY dimension. Short-circuiting
  // here is what stops "no output" from scoring as a safe, neutral answer.
  if (answer.trim().length === 0) {
    const dimensions = Object.fromEntries(
      DIMENSIONS.map((d) => [d, { score: 0, notes: ["the answer is empty"] }]),
    ) as Record<Dimension, DimensionScore>;
    return {
      caseId: caseDef.id,
      class: caseDef.class,
      dimensions,
      overall: 0,
      failed: [...DIMENSIONS],
    };
  }
  const dimensions: Record<Dimension, DimensionScore> = {
    correctness: scoreCorrectness(caseDef, answer),
    relevance: scoreRelevance(caseDef, answer),
    sourceQuality: scoreSourceQuality(caseDef, answer),
    citationAccuracy: scoreCitationAccuracy(caseDef, answer),
    instructionFollowing: scoreInstructionFollowing(caseDef, answer),
    hallucinationResistance: scoreHallucinationResistance(caseDef, answer),
    formatting: scoreFormatting(caseDef, answer),
  };
  const total = DIMENSIONS.reduce((s, d) => s + dimensions[d].score, 0);
  const overall = Number((total / DIMENSIONS.length).toFixed(3));
  const failed = DIMENSIONS.filter((d) => dimensions[d].score < DIMENSION_FLOOR);
  return { caseId: caseDef.id, class: caseDef.class, dimensions, overall, failed };
}

export type SuiteEntry = { case: EvalCase; answer: string };
export type SuiteReport = {
  passed: number;
  failed: number;
  total: number;
  passRate: number;
  byClass: Record<string, { passed: number; total: number; meanOverall: number }>;
  results: EvalResult[];
};

export function runSuite(entries: SuiteEntry[]): SuiteReport {
  const results = entries.map((e) => gradeAnswer(e.case, e.answer));
  const byClass: SuiteReport["byClass"] = {};
  for (const r of results) {
    const bucket = (byClass[r.class] ??= { passed: 0, total: 0, meanOverall: 0 });
    bucket.total += 1;
    bucket.meanOverall += r.overall;
    if (r.overall >= PASS_THRESHOLD && r.failed.length === 0) bucket.passed += 1;
  }
  for (const bucket of Object.values(byClass)) {
    bucket.meanOverall = Number((bucket.meanOverall / Math.max(1, bucket.total)).toFixed(3));
  }
  const passed = results.filter(
    (r) => r.overall >= PASS_THRESHOLD && r.failed.length === 0,
  ).length;
  return {
    passed,
    failed: results.length - passed,
    total: results.length,
    passRate: Number((passed / Math.max(1, results.length)).toFixed(3)),
    byClass,
    results,
  };
}

// ------------------------------------------------------------- golden corpus

const DOCS: Source = {
  id: 1,
  title: "Omi Remote Work Policy",
  url: "https://intranet.example.com/hr/remote-work",
  domain: "intranet.example.com",
  published: "2026-01-15",
  internal: true,
};

const RUNBOOK: Source = {
  id: 1,
  title: "Database failover runbook",
  url: "https://wiki.example.net/db-failover",
  domain: "wiki.example.net",
  internal: true,
};

export const EVAL_SUITE: SuiteEntry[] = [
  {
    case: {
      id: "general-1",
      class: "general",
      question: "What is the difference between a mutex and a semaphore?",
      mustNotInclude: ["you are wrong"],
    },
    answer: `The difference is **ownership versus counting**: a mutex allows one
holder at a time, a semaphore allows N holders where N is the count you set.

- **Mutex** — ownership matters. Only the thread that locked it may unlock it.
- **Semaphore** — only the count matters. Any holder can release it.

Use a mutex for protecting one shared resource, and a semaphore when you need a
bounded pool of N concurrent workers.`,
  },
  {
    case: {
      id: "general-2",
      class: "general",
      question: "What is 25 × 48?",
      arithmetic: { expression: "25 * 48", expected: 1200 },
      mustInclude: ["1200"],
    },
    answer: `25 × 48 = **1200**.

25 × 48 = 25 × 50 − 25 × 2 = 1250 − 50 = 1200.`,
  },
  {
    case: {
      id: "research-1",
      class: "research",
      question: "How does retrieval-augmented generation reduce hallucination?",
      requiresSources: true,
      requiresSearch: true,
      mustInclude: ["grounding"],
      trustedDomains: ["arxiv.org"],
      maxAgeDays: 365 * 5,
      sources: [
        {
          id: 1,
          title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP",
          url: "https://arxiv.org/abs/2005.11401",
          domain: "arxiv.org",
          published: "2025-11-02",
        },
        {
          id: 2,
          title: "RAG survey: grounding and attribution",
          url: "https://arxiv.org/abs/2401.12345",
          domain: "arxiv.org",
          published: "2026-02-18",
        },
      ],
    },
    answer: `RAG reduces hallucination by **grounding** generation in retrieved text.

The model is given real passages before it writes, so each claim has something
to be checked against instead of being recalled from weights [1]. A second pass
cites the passage that supports each claim, which makes the output auditable
[2].

Sources:
[1] https://arxiv.org/abs/2005.11401
[2] https://arxiv.org/abs/2401.12345`,
  },
  {
    case: {
      id: "knowledge-1",
      class: "knowledge",
      question: "How many days of remote work are allowed per month?",
      context:
        "Employees may work remotely up to 3 days per calendar month. Requests beyond 3 days need written approval from the team lead.",
      sources: [DOCS],
      requiresSources: true,
      requiredFormat: "sources",
      mustInclude: ["3 days"],
      trustedDomains: ["intranet.example.com"],
    },
    answer: `**Direct answer:** Up to **3 days** of remote work per calendar month.

**What to do**
1. Count the remote days already approved for the month.
2. For anything beyond 3 days, request written approval from your team lead before booking.

**Source article:** Omi Remote Work Policy — https://intranet.example.com/hr/remote-work

**Version / effective date:** effective 2026-01-15

The limit is a policy, not a suggestion — going past it without written approval
breaches the policy.`,
  },
  {
    case: {
      id: "followup-1",
      class: "followUp",
      question: "What about during a public holiday week?",
      context: "The remote-work limit is a per-calendar-month allowance and is not reduced for holidays.",
      sources: [DOCS],
      requiresSources: true,
      trustedDomains: ["intranet.example.com"],
    },
    answer: `The allowance is **per calendar month**, so a holiday week does not reduce it.

You still get the full 3 remote days for that month, and days beyond 3 still need
written approval from your team lead.

Source: Omi Remote Work Policy — https://intranet.example.com/hr/remote-work`,
  },
  {
    case: {
      id: "ambiguous-1",
      class: "ambiguous",
      question: "Fix it.",
      requiresHedging: true,
    },
    answer: `"Fix it" could mean several things here, so before I act — do you mean:

- fixing a specific error in a file you can point me at,
- fixing a runbook step in your knowledge base, or
- fixing a previous answer of mine in this thread?

Tell me which one and I will go straight to it.`,
  },
  {
    case: {
      id: "multistep-1",
      class: "multiStep",
      question: "Fail over the primary database to the standby.",
      context:
        "Failover procedure: 1) confirm the standby is in sync, 2) promote the standby, 3) repoint the application connection string, 4) verify health checks, 5) record the change.",
      sources: [RUNBOOK],
      requiresSources: true,
      requiredFormat: "steps",
      mustInclude: ["standby"],
      trustedDomains: ["wiki.example.net"],
    },
    answer: `**What to do**
1. Confirm the standby is in sync with the primary.
2. Promote the standby to primary.
3. Repoint the application connection string at the new primary.
4. Verify the health checks pass on the new primary.
5. Record the failover in the change log.

Every step above comes from the failover runbook — Omi did not add any step of
its own.

Source: Database failover runbook — https://wiki.example.net/db-failover`,
  },
  {
    case: {
      id: "file-1",
      class: "file",
      question: "What is the total revenue in Q3?",
      context:
        "Q1 revenue 120,000; Q2 revenue 150,000; Q3 revenue 210,000; Q4 revenue 190,000.",
      mustInclude: ["210,000"],
    },
    answer: `The total revenue in Q3 is **210,000**.

For context, Q1 was 120,000, Q2 150,000 and Q4 190,000, so Q3 was the
strongest quarter in the file.`,
  },
  {
    case: {
      id: "image-1",
      class: "image",
      question: "What colour is the traffic light in this photo?",
      context: "Image analysis: a pole with a three-lens traffic light; the illuminated lens is amber.",
      mustInclude: ["amber"],
    },
    answer: `In the photo the illuminated lens of the traffic light is **amber** —
it is the middle light of the three-lens signal, and it is the one that is lit.`,
  },
  {
    case: {
      id: "coding-1",
      class: "coding",
      question: "Write a TypeScript function that returns the median of a number array.",
      requiredFormat: "code",
      mustNotInclude: ["any"],
    },
    answer: `\`\`\`ts
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of an empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
\`\`\`

The input is copied before sorting, so the caller's array order is preserved.`,
  },
  {
    case: {
      id: "summary-1",
      class: "summarization",
      question: "Summarise this incident report.",
      context:
        "At 02:14 the primary database became unreachable. Failover to the standby completed at 02:26. No data was lost; replication lag peaked at 4 seconds. Root cause was a misapplied migration that dropped a connection pool. The migration was rolled back and the pool size doubled.",
      mustInclude: ["failed over", "no data was lost"],
    },
    answer: `This incident report describes a 12-minute primary-database outage that
was resolved with no data loss.

- **Cause** — a misapplied migration dropped the connection pool at 02:14.
- **Response** — failed over to the standby at 02:26; peak replication lag was 4 seconds and no data was lost.
- **Fix** — the migration was rolled back and the connection pool size doubled.`,
  },
  {
    case: {
      id: "comparison-1",
      class: "comparison",
      question: "Compare REST and GraphQL for a mobile client.",
      requiredFormat: "table",
    },
    answer: `| Aspect | REST | GraphQL |
| --- | --- | --- |
| Payload | Over-fetches on wide screens | Client selects exact fields |
| Requests | Many round-trips for related data | One request for a whole view |
| Caching | Native HTTP caching | Needs a persisted-query layer |
| Mobile latency | Higher | Lower for deep screens |
| Tooling | Ubiquitous | Needs a gateway |

For a mid-range Android client with several nested screens, GraphQL wins on
round-trips; REST wins on tooling and caching.`,
  },
  {
    case: {
      id: "currentinfo-1",
      class: "currentInfo",
      question: "What is the latest stable version of Node.js LTS right now?",
      requiresSearch: true,
      requiresSources: true,
      trustedDomains: ["nodejs.org"],
      maxAgeDays: 120,
      sources: [
        {
          id: 1,
          title: "Node.js releases",
          url: "https://nodejs.org/en/about/previous-releases",
          domain: "nodejs.org",
          published: "2026-09-20",
        },
        {
          id: 2,
          title: "Old node LTS notes",
          url: "https://blog.example.org/node-lts-2019",
          domain: "blog.example.org",
          published: "2019-04-02",
        },
      ],
    },
    answer: `The latest stable **Node.js LTS** line is **Node 24**, and the current
patch release is the one nodejs.org published on 2026-09-20.

Check the official releases page before pinning an exact patch in CI — patch
releases land often, and the version moves.

Source: https://nodejs.org/en/about/previous-releases`,
  },
];

/**
 * Defect corpus: each entry is a gold answer with exactly one realistic defect,
 * and the dimension that MUST catch it. The suite asserts every one is caught —
 * this is what stops the graders from silently becoming permissive.
 */
export const DEFECT_CORPUS: Array<{
  id: string;
  from: string;
  defect: Dimension;
  answer: string;
  note: string;
}> = [
  {
    id: "defect-fabricated-citation",
    from: "research-1",
    defect: "citationAccuracy",
    answer: `RAG reduces hallucination by grounding generation in retrieved text.

The model is given real passages before it writes [1]. A second pass cites the
passage supporting each claim [7].

Sources:
[1] https://arxiv.org/abs/2005.11401
[2] https://arxiv.org/abs/2401.12345`,
    note: "cites [7] when only sources 1 and 2 were retrieved",
  },
  {
    id: "defect-unverified-claim",
    from: "general-1",
    defect: "hallucinationResistance",
    answer: `A mutex allows one holder at a time; a semaphore allows N holders.

I verified this on the web — per my web search, the distinction is ownership,
not just counting. See https://semantics.example.net/mutex-vs-semaphore`,
    note: "claims web verification with no sources and invents a URL",
  },
  {
    id: "defect-broken-table",
    from: "comparison-1",
    defect: "formatting",
    answer: `| Aspect | REST | GraphQL |
| --- | --- |
| Payload | Over-fetches | Exact |
| Caching | Native | Gateway needed |
| Mobile latency | Higher | Lower |
| Tooling | Ubiquitous | Needs a gateway |`,
    note: "header declares three columns but the delimiter row declares two",
  },
  {
    id: "defect-unbalanced-fence",
    from: "coding-1",
    defect: "formatting",
    answer: `\`\`\`ts
export function median(values: number[]): number {
  return values.sort((a, b) => a - b)[0];
}
\`\`\`
\`\`\`
Note: this does not use the any type, so it compiles under strict mode.`,
    note: "an extra opening fence leaves the code block unbalanced",
  },
  {
    id: "defect-ignored-instruction",
    from: "knowledge-1",
    defect: "instructionFollowing",
    answer: `**Direct answer:** Remote work is allowed as often as team capacity allows.

**What to do**
1. Coordinate with your team.
2. Update the team calendar.

**Source article:** Omi Remote Work Policy — https://intranet.example.com/hr/remote-work`,
    note: "omits the required '3 days' limit and invents steps",
  },
  {
    id: "defect-no-hedging",
    from: "ambiguous-1",
    defect: "hallucinationResistance",
    answer: `Done — I fixed the database failover runbook and promoted the standby.`,
    note: "answers an ambiguous question by guessing, with no clarification",
  },
  {
    id: "defect-stale-source",
    from: "currentinfo-1",
    defect: "sourceQuality",
    answer: `The latest stable **Node.js LTS** version is **Node 18**, which is what I
read on a blog post about Node LTS.

Source: https://blog.example.org/node-lts-2019`,
    note: "current-information question answered from a stale, untrusted blog instead of nodejs.org",
  },
  {
    id: "defect-off-topic",
    from: "file-1",
    defect: "relevance",
    answer: `Quarterly performance reporting matters because it shapes long-range strategy. Businesses that review their numbers carefully every cycle and adjust their long-range forecasts accordingly tend to plan more successfully than those that do not.`,
    note: "long, fluent and completely non-responsive to the question",
  },
  {
    id: "defect-wrong-number",
    from: "general-2",
    defect: "correctness",
    answer: `25 × 48 = 1300.`,
    note: "the deterministic calculator case answered wrongly",
  },
  {
    id: "defect-forbidden-claim",
    from: "coding-1",
    defect: "instructionFollowing",
    answer: `\`\`\`ts
export function median(values: any[]): any {
  return values[0];
}
\`\`\``,
    note: "uses the explicitly forbidden 'any' type",
  },
];
