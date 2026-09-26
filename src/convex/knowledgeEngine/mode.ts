/**
 * Omi Knowledge Intelligence — retrieval mode routing (pure).
 *
 * §10 and §11 of the completion spec. Two enterprise modes sit alongside the
 * default behaviour:
 *
 *   only     — 🔒 APPROVED KNOWLEDGE ONLY: answer from approved internal
 *              knowledge or not at all. No web search, ever. If there is no
 *              sufficient approved evidence, say exactly that and offer the
 *              escalation path — never guess, never reach for the web.
 *   research — 🔎 KNOWLEDGE + RESEARCH: internal knowledge first, then fill
 *              the gaps with Andromeda, keeping the two clearly labelled.
 *
 * The decision is a pure function of (mode, intent, whether approved knowledge
 * answered) so it is unit-tested rather than an `if` ladder buried in the
 * 800-line chat turn.
 */

export const KNOWLEDGE_MODES = ["off", "prefer", "only", "research"] as const;
export type KnowledgeMode = (typeof KNOWLEDGE_MODES)[number];

export const DEFAULT_KNOWLEDGE_MODE: KnowledgeMode = "prefer";

export function parseKnowledgeMode(raw: string | undefined): KnowledgeMode {
  return (KNOWLEDGE_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as KnowledgeMode)
    : DEFAULT_KNOWLEDGE_MODE;
}

export type KnowledgeUse = {
  /** Consult approved knowledge for this turn. */
  consultKnowledge: boolean;
  /** Run web/Andromeda search for this turn. */
  allowExternalSearch: boolean;
  /** Only approved knowledge may ground the answer (web suppressed). */
  knowledgeOnly: boolean;
  /** Internal knowledge answered AND external research is permitted too. */
  blendWithResearch: boolean;
};

export function routeKnowledge(args: {
  mode: KnowledgeMode;
  /** Approval-grounded knowledge actually answered this turn. */
  knowledgeAnswered: boolean;
  /** The classifier said this turn wants fresh/web information. */
  intentNeedsSearch: boolean;
}): KnowledgeUse {
  const { mode, knowledgeAnswered, intentNeedsSearch } = args;

  if (mode === "only") {
    return {
      consultKnowledge: true,
      allowExternalSearch: false,
      knowledgeOnly: true,
      blendWithResearch: false,
    };
  }

  if (mode === "off") {
    return {
      consultKnowledge: false,
      allowExternalSearch: intentNeedsSearch,
      knowledgeOnly: false,
      blendWithResearch: false,
    };
  }

  if (mode === "research") {
    // Internal first, then external to fill the gaps — always both labelled.
    return {
      consultKnowledge: true,
      allowExternalSearch: true,
      knowledgeOnly: false,
      blendWithResearch: true,
    };
  }

  // "prefer" (default): internal knowledge answers; the web only runs when
  // knowledge did NOT answer and the question actually wants the web.
  return {
    consultKnowledge: true,
    allowExternalSearch: !knowledgeAnswered && intentNeedsSearch,
    knowledgeOnly: false,
    blendWithResearch: false,
  };
}

/**
 * The honest refusal used by knowledge-only mode when approved evidence is
 * insufficient: state the gap, name what is missing, and offer the next step.
 * Never a guess (§10).
 */
export function knowledgeOnlyRefusal(question: string): string {
  return [
    "I couldn't find sufficient information in the approved knowledge base to answer this.",
    "",
    "The query is logged as a knowledge gap so an owner can add approved guidance.",
    "",
    "What you can do next:",
    "• Open Knowledge AI → Gaps to see and triage the logged question.",
    "• Ask a knowledge owner to author and approve an article, then re-ask.",
    "• Or switch off APPROVED KNOWLEDGE ONLY in Settings to allow external research.",
    "",
    `Question: ${question.slice(0, 200)}`,
  ].join("\n");
}
