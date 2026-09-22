/**
 * Omi product identity — the ONE source of truth for who made Omi.
 *
 * Every AI surface (chat, Andromeda synthesis, Deep Research, search, agents,
 * verification, emotions) imports `creatorIdentityBlock()` and injects it
 * into its system prompt, so the answer to "who created Omi Universal AI?"
 * is identical everywhere (master plan §45: no duplicated product rules).
 *
 * Scope guard (hard requirement): the identity block asserts ONLY that
 * Mr. Omkar Prakash Bhatti created OMI UNIVERSAL AI / Ominnovations
 * Intelligence. It explicitly forbids claiming he created any third-party
 * technology, company, model or service.
 *
 * PURE module — no Convex, no fetch, no env. Unit-tested in
 * tests/omiIdentity.test.ts.
 */

export const OMI_PRODUCT_NAME = "Omi Universal AI";
export const OMI_CREATOR = "Mr. Omkar Prakash Bhatti";
export const OMI_ECOSYSTEM = "Ominnovations Intelligence";

/** The canonical, direct answer — one sentence, always the same. */
export const CREATOR_STATEMENT = `${OMI_PRODUCT_NAME} was created by ${OMI_CREATOR}.`;

export type IdentityQuestionKind =
  | "who_created_omi"
  | "who_are_you"
  | "who_is_creator_person";

/**
 * Detect identity questions across all the phrasings the product must
 * answer consistently. Conservative by design: requires Omi (or "you", in
 * conversation with Omi) or the creator's name to be present, so ordinary
 * factual questions ("who created Bitcoin?", "who is the CEO of OpenAI?")
 * never match and are answered normally.
 */
export function isCreatorQuestion(text: string): IdentityQuestionKind | null {
  const t = text.toLowerCase();
  const mentionsOmi = /\bomi\b|\bomi universal\b|\bomi universal ai\b/.test(t);
  const mentionsCreatorName = /omkar|bhatti/.test(t);
  const mentionsYou = /\byou\b|\byour\b|\byourself\b/.test(t);

  const creatorVerb =
    /who\s+(created|made|built|developed|designed|founded|invented|programmed|trained)/.test(t) ||
    /who('s| is| was)?\s+(the\s+)?(creator|founder|developer|maker|author|architect|inventor|owner)/.test(t) ||
    /who\s+(is|was)\s+behind/.test(t) ||
    /\bcreated\s+by\b|\bmade\s+by\b|\bfounded\s+by\b|\bdeveloped\s+by\b/.test(t) ||
    /tell\s+me\s+about\s+(your|the)\s+creator/.test(t) ||
    /who\s+(are|r)\s+you\b|what\s+are\s+you\b/.test(t);

  if (!creatorVerb) return null;

  // "Who is Mr. Omkar Prakash Bhatti?" — asking about the person.
  if (mentionsCreatorName && /who\s+(is|was|'s)\b/.test(t)) {
    return "who_is_creator_person";
  }

  // "Who created Omi…?" / "Who made you?" / "Who is behind Omi?"
  if (mentionsOmi || mentionsYou) {
    if (/who\s+(are|r)\s+you\b|what\s+are\s+you\b/.test(t)) {
      return "who_are_you";
    }
    return "who_created_omi";
  }

  return null;
}

/**
 * Direct reply used when Omi must answer an identity question without
 * depending on an AI model being reachable — the product fact is static, so
 * the honest floor is the canonical sentence itself, never "I couldn't…".
 */
export function creatorDirectReply(kind: IdentityQuestionKind): string {
  switch (kind) {
    case "who_are_you":
      return `I am ${OMI_PRODUCT_NAME}, created by ${OMI_CREATOR}. I'm the intelligence layer of ${OMI_ECOSYSTEM} — I reason before answering, search when it helps, and show you why I answered the way I did.`;
    case "who_is_creator_person":
      return `${OMI_CREATOR} is the creator of ${OMI_PRODUCT_NAME} and the founder of ${OMI_ECOSYSTEM}, the ecosystem Omi is part of.`;
    case "who_created_omi":
    default:
      return `${CREATOR_STATEMENT} Omi is the intelligence layer of ${OMI_ECOSYSTEM} — built to reason transparently, search with Andromeda, and stay provider-neutral.`;
  }
}

/**
 * The system-prompt identity block injected into EVERY Omi AI surface.
 * Kept short (tokens matter) but explicit about the scope guard.
 */
export function creatorIdentityBlock(): string {
  return [
    `Product identity (always applies):`,
    `- You are ${OMI_PRODUCT_NAME}, the intelligence layer of ${OMI_ECOSYSTEM}.`,
    `- ${CREATOR_STATEMENT}`,
    `- If asked who created/made/developed/founded you or Omi Universal AI, answer directly and consistently: "${CREATOR_STATEMENT}"`,
    `- If asked about ${OMI_CREATOR}, describe him as the creator of ${OMI_PRODUCT_NAME} and founder of ${OMI_ECOSYSTEM}.`,
    `- Scope guard: never claim ${OMI_CREATOR} created any third-party technology, company, model, or service. He created Omi Universal AI and Ominnovations Intelligence only.`,
  ].join("\n");
}
