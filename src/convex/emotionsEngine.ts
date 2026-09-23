/**
 * Human Emotions AI — the ONE emotion layer for the whole product.
 *
 * Why this module exists (and why it is pure): the feature used to live
 * entirely inside `emotionsAi.ts`, reachable only from the Emotions screen's
 * manual text box. Nothing in chat ever touched it, so "Human Emotions AI"
 * never actually influenced a conversation — the capability existed but the
 * pipeline did not. Centralising the reading here lets BOTH surfaces share
 * identical logic:
 *
 *   • the manual analyzer (explicit, saved on the user's request), and
 *   • chat (automatic tone adaptation, ephemeral by default)
 *
 * It has **zero imports** on purpose: no Convex runtime, no provider SDK, no
 * fetch. That keeps it importable from the V8 and Node function runtimes
 * alike, and lets Bun unit-test the exact code production runs.
 *
 * HONESTY CONTRACT (§35 of the master plan). Everything here is an INFERENCE
 * drawn from the words a person typed or said. Omi cannot perceive anyone's
 * inner state, and the prompt + tone block below say so explicitly — the model
 * is instructed never to assert how the user feels, only to hedge and to adapt
 * its own wording. That rule is enforced in one place so it cannot drift.
 */

export type EmotionSource = "ai" | "heuristic";

/** One emotion read-out. Same shape for the AI and heuristic paths. */
export type EmotionRead = {
  /** Primary inferred emotion, e.g. "frustrated", "excited", "neutral". */
  emotion: string;
  /** 0..1 — how confident the reading is. Never presented as certainty. */
  confidence: number;
  /** 0..100 — venting vs actionable complaint. */
  rantScore: number;
  rantInterpretation: string;
  sentiment: "positive" | "neutral" | "negative";
  /** -1..1 */
  sentimentScore: number;
  urgency: "low" | "medium" | "high";
  /** 0..100 */
  urgencyScore: number;
  /** Comma-separated signals actually found in the text. */
  signalFields: string;
  /** One concrete next action for the reader. */
  advice: string;
  /** One warm, plain-language note about the feeling behind the message. */
  omiNote: string;
  /** Whether the read came from a model or the local lexicon/heuristic path. */
  source: EmotionSource;
};

/**
 * Canonical emotion families. Individual words map into a family so the tone
 * guidance stays correct even when a provider answers with a free-form label
 * ("livid", "thrilled", "bummed") that is not one of our keys.
 */
export const EMOTION_FAMILIES = [
  "anger",
  "frustration",
  "sadness",
  "anxiety",
  "confusion",
  "excitement",
  "gratitude",
  "relief",
  "neutral",
] as const;
export type EmotionFamily = (typeof EMOTION_FAMILIES)[number];

/** Word/phrase sets used by the offline heuristic path. */
export const EMOTION_LEXICONS: Record<Exclude<EmotionFamily, "neutral">, string[]> = {
  anger: [
    "angry", "furious", "outraged", "hate", "unacceptable", "useless",
    "pathetic", "worst", "disgusted", "ridiculous",
  ],
  frustration: [
    "frustrated", "annoying", "again", "still not fixed", "keeps happening",
    "fed up", "third time", "tired of", "sick of", "why is this",
  ],
  sadness: [
    "sad", "disappointed", "upset", "unfortunate", "let down", "heartbroken",
    "gutted", "devastated", "miserable", "lonely",
  ],
  anxiety: [
    "worried", "anxious", "nervous", "scared", "afraid", "stressed", "panic",
    "overwhelmed", "uneasy", "concerned",
  ],
  confusion: [
    "confused", "unclear", "don't understand", "do not understand",
    "i'm lost", "i am lost", "feeling lost", "what does", "how do i",
    "makes no sense", "not sure what", "which one",
  ],
  excitement: [
    "excited", "can't wait", "love this", "amazing", "awesome", "fantastic",
    "brilliant", "thrilled", "incredible", "so good", "yay", "woohoo",
  ],
  gratitude: ["thank you", "thanks", "grateful", "appreciate", "means a lot"],
  // Deliberately no bare "fixed": "I need this fixed" is a request, not
  // relief — a false positive here made an urgent transactional message read
  // as a happy one (caught by tests/emotionAware.test.ts).
  relief: [
    "finally", "resolved", "working now", "all good now", "sorted out",
    "back to normal", "no longer an issue", "it's fixed", "its fixed",
    "is fixed now",
  ],
};

/** Signals that the request wants action now (drives urgency, not emotion). */
const URGENCY_TERMS = [
  "urgent", "asap", "immediately", "right now", "emergency", "critical",
  "deadline", "today", "tonight", "before end of day", "blocker", "blocked",
];

/** Tone guidance per family: HOW Omi should answer, never WHAT it answers. */
const TONE_GUIDANCE: Record<EmotionFamily, string> = {
  anger:
    "Acknowledge the strength of the reaction once, briefly and without defensiveness, then move straight to the concrete fix or facts. No chirpy tone, no jokes, no long preamble.",
  frustration:
    "Lead with the specific answer, keep it short and concrete, and name a next step rather than restating the problem back to them. Avoid filler and avoid sounding like a script.",
  sadness:
    "Be gentle and direct. Skip cheerfulness and exclamation marks, acknowledge the disappointment plainly, and be useful rather than effusive.",
  anxiety:
    "Reduce uncertainty: give facts, order, and a clear sequence. Say what is known, what is unknown, and what happens next. Avoid vague reassurance.",
  confusion:
    "Slow down and be explicit. Define terms, use short numbered steps, and give one worked example rather than more options. Ask a clarifying question only if it truly blocks the answer.",
  excitement:
    "Match the energy lightly — warm and affirmative, not gushing — then get to the substance and build on the idea.",
  gratitude:
    "Return the warmth in one short line and stay useful; do not over-thank or pad the reply.",
  relief: "Confirm clearly and calmly what is now settled, without re-opening the problem.",
  neutral:
    "Answer normally: clear, direct, well-organised. Do not add emotional framing that is not there.",
};

const NOTE_BY_FAMILY: Record<EmotionFamily, string> = {
  anger: "There's real anger in the wording — being heard matters before anything else.",
  frustration: "This reads like someone who has tried more than once; patience is wearing thin.",
  sadness: "There's quiet disappointment here — gentleness over efficiency.",
  anxiety: "There's worry underneath — certainty and a clear plan will help most.",
  confusion: "They want to understand, not to complain — clarity is the kindness here.",
  excitement: "Genuine enthusiasm — worth acknowledging and building on.",
  gratitude: "Warm appreciation — meet it with warmth.",
  relief: "The tension just released — confirm that it's truly settled.",
  neutral: "No strong emotional markers — a calm, factual reply fits best.",
};

const ADVICE_BY_FAMILY: Record<EmotionFamily, string> = {
  anger: "Acknowledge the anger once, then move to a concrete fix.",
  frustration: "Take ownership of the repeated effort and give one specific next step.",
  sadness: "Be gentle, acknowledge the disappointment, and show what happens next.",
  anxiety: "Reassure with facts, list the exact steps, and remove deadline ambiguity.",
  confusion: "Restate the answer in simpler terms with a short walkthrough.",
  excitement: "Acknowledge the enthusiasm and build on it with substance.",
  gratitude: "Respond warmly and offer continued help.",
  relief: "Confirm the resolution clearly so the relief settles.",
  neutral: "Read the message closely and respond to the specific concern raised.",
};

/**
 * Stem patterns per family, so ANY surface form maps correctly: the lexicon
 * emits "frustration" while a model answers "frustrated" or "annoyed", and
 * both must reach the same tone guidance. A naive `includes(family)` check is
 * not enough — "frustrated" does not contain "frustration".
 */
const FAMILY_STEMS: Record<EmotionFamily, RegExp> = {
  anger: /ang[er]|furious|livid|irate|rage|mad\b|outrag/,
  frustration: /frustrat|annoy|irritat|impatient|exasperat|fed up/,
  sadness: /sad|disappoint|hurt|heartbrok|grief|miserab|bummed|\bdown\b|upset/,
  anxiety: /anxi|worri|nervous|scared|afraid|stress|panic|tense|uneas/,
  confusion: /confus|uncertain|unsure|puzzl|lost|unclear/,
  excitement: /excit|happy|delight|thrill|joy|glad|enthus|energ/,
  gratitude: /grate|thank|appreciat/,
  relief: /reliev|relief|settled|sorted|soothed/,
  neutral: /neutral|calm|flat|even|objective/,
};

/** Map any free-form label (from a model or the lexicon) onto a family. */
export function emotionFamily(emotion: string): EmotionFamily {
  const key = emotion.trim().toLowerCase();
  if (key.length === 0) return "neutral";

  // Exact family name first (the heuristic path passes these directly).
  if ((EMOTION_FAMILIES as readonly string[]).includes(key)) {
    return key as EmotionFamily;
  }

  // Any lexicon word the label mentions is a strong signal (e.g. "very frustrated").
  for (const [family, words] of Object.entries(EMOTION_LEXICONS)) {
    if (words.some((w) => key.includes(w))) return family as EmotionFamily;
  }

  for (const family of EMOTION_FAMILIES) {
    if (FAMILY_STEMS[family].test(key)) return family;
  }

  return "neutral";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Accept only a finite number (a numeric string is tolerated — models emit both). */
function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toText(value: unknown, fallback: string, max = 200): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, max);
}

function toSentiment(value: unknown, score: number): EmotionRead["sentiment"] {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw.startsWith("pos")) return "positive";
  if (raw.startsWith("neg")) return "negative";
  if (raw.startsWith("neu")) return "neutral";
  return score > 0.15 ? "positive" : score < -0.15 ? "negative" : "neutral";
}

function toUrgency(value: unknown, score: number): EmotionRead["urgency"] {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw.startsWith("high")) return "high";
  if (raw.startsWith("med")) return "medium";
  if (raw.startsWith("low")) return "low";
  return score >= 60 ? "high" : score >= 25 ? "medium" : "low";
}

/**
 * Turn whatever the model produced into a valid read-out.
 *
 * Kept strict on purpose: a provider that returns `confidence: 12` or omits
 * `sentiment` must not be able to hand the chat pipeline a nonsensical number
 * or an empty string. Anything unusable falls back to a sane default, and the
 * callers below never have to re-validate.
 */
export function normalizeEmotionRead(
  raw: unknown,
  source: EmotionSource,
): EmotionRead {
  const r = (raw ?? {}) as Record<string, unknown>;
  const emotion = toText(r.emotion, "neutral", 40);
  const family = emotionFamily(emotion);

  const sentimentScore = clamp(toNumber(r.sentimentScore, 0), -1, 1);
  const urgencyScore = clamp(toNumber(r.urgencyScore, 20), 0, 100);
  const rantScore = clamp(toNumber(r.rantScore, 0), 0, 100);

  return {
    emotion,
    confidence: clamp(toNumber(r.confidence, 0.6), 0, 1),
    rantScore,
    rantInterpretation: toText(
      r.rantInterpretation,
      rantScore >= 50
        ? "Mostly emotional release rather than an actionable request."
        : "Intensity is present, but the request is still actionable.",
    ),
    sentiment: toSentiment(r.sentiment, sentimentScore),
    sentimentScore: Number(sentimentScore.toFixed(2)),
    urgency: toUrgency(r.urgency, urgencyScore),
    urgencyScore: Number(urgencyScore.toFixed(1)),
    signalFields: toText(r.signalFields, "no strong emotional markers", 300),
    advice: toText(r.advice, ADVICE_BY_FAMILY[family]),
    omiNote: toText(r.omiNote, NOTE_BY_FAMILY[family]),
    source,
  };
}

/**
 * Zero-cost local read-out. Used when no AI provider is reachable (and as the
 * baseline the AI path must beat). Confidence is deliberately modest: a word
 * list is an approximation and is presented as one.
 */
export function heuristicEmotionRead(text: string): EmotionRead {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  let bestFamily: EmotionFamily = "neutral";
  let bestHits = 0;
  const matched: string[] = [];

  for (const [family, lexicon] of Object.entries(EMOTION_LEXICONS)) {
    const hits = lexicon.filter((w) => lower.includes(w));
    if (hits.length > 0) matched.push(...hits);
    if (hits.length > bestHits) {
      bestHits = hits.length;
      bestFamily = family as EmotionFamily;
    }
  }

  const exclamations = (text.match(/!/g) ?? []).length;
  const capsWords = words.filter(
    (w) => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w),
  ).length;
  const urgentHits = URGENCY_TERMS.filter((w) => lower.includes(w)).length;

  const rantScore = clamp(
    exclamations * 12 + capsWords * 10 + (bestFamily === "frustration" ? 35 : 0),
    0,
    100,
  );
  const urgencyScore = clamp(
    urgentHits * 30 + (exclamations > 1 ? 15 : 0) + (/\bbroken\b|not working|\bdown\b/.test(lower) ? 20 : 0),
    0,
    100,
  );

  const positiveHits = [
    ...EMOTION_LEXICONS.excitement,
    ...EMOTION_LEXICONS.gratitude,
    ...EMOTION_LEXICONS.relief,
  ].filter((w) => lower.includes(w)).length;
  const negativeHits = [
    ...EMOTION_LEXICONS.anger,
    ...EMOTION_LEXICONS.frustration,
    ...EMOTION_LEXICONS.sadness,
    ...EMOTION_LEXICONS.anxiety,
  ].filter((w) => lower.includes(w)).length;
  const sentimentScore = clamp((positiveHits - negativeHits) * 0.35, -1, 1);

  if (exclamations >= 2) matched.push("high exclamation density");
  if (capsWords > 0) matched.push("emphatic capitals");
  if (urgentHits > 0) matched.push("time pressure");

  return normalizeEmotionRead(
    {
      emotion: bestFamily,
      // Honest about being approximate — never above 0.75 from a word list.
      confidence: Math.min(0.75, 0.45 + bestHits * 0.08),
      rantScore,
      sentimentScore,
      sentiment:
        sentimentScore > 0.15 ? "positive" : sentimentScore < -0.15 ? "negative" : "neutral",
      urgencyScore,
      signalFields: [...new Set(matched)].slice(0, 4).join(", ") || "no strong emotional markers",
    },
    "heuristic",
  );
}

/** Prompt for the AI classification pass. Shared so every surface asks the same question. */
export const EMOTION_SYSTEM_PROMPT = `You analyze the HUMAN EMOTIONAL SIGNALS in a short passage of human writing or speech (a chat message, support note, review, or voice transcript).

You are inferring from wording, punctuation and phrasing ONLY. You cannot perceive anyone's internal state, and nothing you output is a diagnosis, a mental-health assessment, or a statement of fact about the person. Report signals, not certainties.

Respond with ONLY a single minified JSON object (no markdown fences, no commentary) with exactly these keys:
{
  "emotion": string,            // primary emotional signal, one word if possible (e.g. frustrated, sad, angry, excited, confused, anxious, relieved, neutral)
  "confidence": number,         // 0..1 — your confidence in THIS READING of the wording, never certainty about the person
  "rantScore": number,          // 0..100, unproductive venting vs a clear actionable request (0 = clearly actionable, 100 = pure venting)
  "rantInterpretation": string, // one short sentence explaining the rantScore
  "sentiment": string,          // "positive" | "neutral" | "negative"
  "sentimentScore": number,     // -1..1
  "urgency": string,            // "low" | "medium" | "high"
  "urgencyScore": number,       // 0..100
  "signalFields": string,       // comma-separated signals actually present in the text (e.g. "repeated contact, deadline pressure, emphatic capitals")
  "advice": string,             // one concrete next action for whoever replies
  "omiNote": string             // one short, warm, plain-language note about the feeling the wording suggests
}
Keep every string under 200 characters. If the text is short, factual or carries no clear emotional signal, return the JSON with "neutral" — do not invent a feeling that is not in the words.`;

/**
 * The tone block injected into chat when auto emotion-awareness is on.
 *
 * Three rules are non-negotiable and live here (not duplicated at call sites):
 *   1. it adapts TONE only — the user's actual request is answered in full;
 *   2. it must never be presented as knowledge of the person's inner state;
 *   3. it is droppable — if the read is wrong, Omi follows the user, not the
 *      label.
 */
export function emotionAwarenessBlock(read: EmotionRead): string {
  const family = emotionFamily(read.emotion);
  const weak = read.confidence < 0.5;

  return [
    "EMOTION-AWARE TONE SIGNAL — an INFERENCE from the user's wording this turn, NOT knowledge of how they feel.",
    `Read as: ${read.emotion} (confidence ${read.confidence.toFixed(2)}, from ${read.source === "ai" ? "a classification model" : "a local word/punctuation heuristic"})`,
    `Sentiment: ${read.sentiment} (${read.sentimentScore.toFixed(2)}) · urgency: ${read.urgency} (${read.urgencyScore.toFixed(0)}/100) · venting vs actionable: ${read.rantScore.toFixed(0)}/100`,
    `Signals found in the text: ${read.signalFields}`,
    `How to adapt your tone: ${TONE_GUIDANCE[family]}`,
    weak
      ? "The signal is WEAK. Do not lean on it: answer normally and do not add emotional framing beyond one word if it clearly helps."
      : "Keep the adaptation to tone and pacing only.",
    [
      "Rules for using this signal:",
      "(1) Answer the user's ACTUAL request in full and first. This signal may never change WHAT you answer, prioritise a different question, or be offered instead of the answer they asked for.",
      "(2) Never state how the user feels as fact. If you acknowledge tone at all, hedge it (\"this sounds frustrating\", \"if I'm reading this right\") and keep it to one short clause.",
      "(3) If the read is wrong, drop it immediately and follow the user's own words.",
    ].join(" "),
  ].join("\n");
}

/**
 * Turns too short or purely transactional to be worth an analysis call.
 * Keeps automatic emotion-awareness off the "hi", "thanks", "ok" turns so the
 * feature costs nothing where there is nothing to read.
 */
const TRIVIAL = new Set([
  "hi", "hey", "hello", "yo", "ok", "okay", "k", "thanks", "thank you", "ty",
  "yes", "no", "yep", "nope", "sure", "cool", "nice", "lol", "bye", "good",
  "great", "done", "continue", "go on",
]);

export const MIN_AUTO_EMOTION_CHARS = 4;

export function shouldAnalyzeEmotion(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.?]+$/, "");
  if (t.length < MIN_AUTO_EMOTION_CHARS) return false;
  return !TRIVIAL.has(t);
}

/**
 * Build the classifier messages. `systemPrefix` lets a caller keep its own
 * standing identity text ahead of the emotion instructions without copying
 * them (the chat/analyzer path passes the product identity block).
 */
export function emotionMessages(
  text: string,
  systemPrefix?: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: systemPrefix
        ? `${systemPrefix}\n\n${EMOTION_SYSTEM_PROMPT}`
        : EMOTION_SYSTEM_PROMPT,
    },
    { role: "user", content: text.trim().slice(0, 2000) },
  ];
}

/**
 * The ONE read path: ask a model through the injected classifier, then fall
 * back to the local heuristic.
 *
 * The classifier is injected (rather than imported) so this module stays free
 * of the provider stack — the Convex action passes `complete`, the live
 * self-test passes its own instrumented call, and both exercise the same
 * prompt, parsing, normalization and fallback. There is no second
 * implementation to drift.
 *
 * `classify` returns the raw model text or `null` when no provider answered;
 * it may also throw, which is treated identically (a provider outage must only
 * ever downgrade the reading).
 */
export async function readEmotionWith(
  text: string,
  classify: (
    messages: Array<{ role: "system" | "user"; content: string }>,
  ) => Promise<string | null>,
  systemPrefix?: string,
): Promise<EmotionRead> {
  const trimmed = text.trim().slice(0, 2000);

  try {
    const raw = await classify(emotionMessages(trimmed, systemPrefix));
    if (raw) {
      const parsed = parseEmotionJson(raw);
      // Only a reply carrying a usable label counts as a model read; an empty
      // or off-shape object must not masquerade as one.
      if (parsed && typeof (parsed as { emotion?: unknown }).emotion === "string") {
        return normalizeEmotionRead(parsed, "ai");
      }
    }
  } catch {
    // Fall through to the local read below.
  }

  return heuristicEmotionRead(trimmed);
}

/** Strip ```json fences and pull the first JSON object out of a model reply. */
export function parseEmotionJson(raw: string): unknown | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
