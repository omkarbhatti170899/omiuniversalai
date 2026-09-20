"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { vly } from "../lib/vly-integrations";
import { friendlyAiError } from "./aiErrors";
import { getAuthUserId } from "@convex-dev/auth/server";

const SYSTEM_PROMPT = `You are Omi, the emotion-analysis engine inside Ominnovations Intelligence, an AI workspace for customer-support and operations teams.

You receive a short passage of human speech (a support message, chat, review, note, or spoken snippet) and you analyze the HUMAN EMOTIONS in it.

Respond with ONLY a single minified JSON object (no markdown, no code fences, no commentary) with exactly these keys:
{
  "emotion": string,            // primary human emotion, one word if possible (e.g. frustrated, anxious, delighted, confused, angry, relieved)
  "confidence": number,         // 0..1
  "rantScore": number,          // 0..100, how much this is an unproductive rant vs a clear actionable complaint (0 = clear complaint, 100 = pure venting)
  "rantInterpretation": string, // one short sentence explaining the rantScore
  "sentiment": string,          // "positive" | "neutral" | "negative"
  "sentimentScore": number,     // -1..1
  "urgency": string,            // "low" | "medium" | "high"
  "urgencyScore": number,       // 0..100
  "signalFields": string,       // comma-separated key signals found (e.g. "product defect, deadline pressure, repeated contact")
  "advice": string,             // one concrete next action for the support agent
  "omiNote": string             // one warm, plain-language note from Omi about the human feeling behind the message
}
Keep every string under 200 characters. If the text is too short or has no detectable emotion, still return the JSON with your best judgment (e.g. emotion "neutral").`;

type AiJson = {
  emotion?: unknown;
  confidence?: unknown;
  rantScore?: unknown;
  rantInterpretation?: unknown;
  sentiment?: unknown;
  sentimentScore?: unknown;
  urgency?: unknown;
  urgencyScore?: unknown;
  signalFields?: unknown;
  advice?: unknown;
  omiNote?: unknown;
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function asNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.min(max, Math.max(min, parsed));
    }
  }
  return fallback;
}

/**
 * Keyword-lexicon emotion analysis used when no AI provider is reachable.
 * Produces the exact same JSON shape as the AI path so persistence and UI
 * work unchanged. Confidence is kept modest — heuristics are honest about
 * being approximate.
 */
const EMOTION_LEXICONS: Record<string, string[]> = {
  anger: ["angry", "furious", "outraged", "hate", "unacceptable", "useless", "pathetic", "worst", "disgusted"],
  frustration: ["frustrated", "annoying", "again", "still not fixed", "keeps happening", "fed up", "third time", "tired of", "ridiculous"],
  anxiety: ["worried", "anxious", "nervous", "scared", "afraid", "stressed", "panic", "overwhelmed"],
  confusion: ["confused", "unclear", "don't understand", "do not understand", "lost", "what does", "how do i", "makes no sense"],
  delight: ["love", "amazing", "wonderful", "excellent", "fantastic", "awesome", "perfect", "happy", "brilliant", "impressed"],
  gratitude: ["thank you", "thanks", "grateful", "appreciate"],
  relief: ["finally", "resolved", "working now", "fixed", "sorted", "all good now"],
  sadness: ["sad", "disappointed", "upset", "unfortunate", "let down", "heartbroken"],
};

const ADVICE_BY_EMOTION: Record<string, string> = {
  anger: "Acknowledge the anger directly, apologize once sincerely, and move to a concrete fix.",
  frustration: "Recognize the repeated effort, take ownership, and give a specific next step with a time estimate.",
  anxiety: "Reassure with facts, lay out the exact steps, and remove any deadline ambiguity.",
  confusion: "Slow down, restate the explanation in simpler terms, and offer a short walkthrough.",
  delight: "Thank them warmly and pass the positive feedback to the team — momentum matters.",
  gratitude: "Respond warmly and offer continued help.",
  relief: "Confirm the resolution clearly so their relief settles.",
  sadness: "Be gentle, acknowledge the disappointment, and show what you'll do differently.",
};

const NOTE_BY_EMOTION: Record<string, string> = {
  anger: "There's real anger here — this person needs to feel heard before anything else.",
  frustration: "This person has likely tried more than once; tiredness and irritation are stacking up.",
  anxiety: "There's worry underneath — certainty and a clear plan will help most.",
  confusion: "They want to understand, not to complain — clarity is the kindness here.",
  delight: "Genuine happiness — a moment worth celebrating and reinforcing.",
  gratitude: "Warm appreciation — meet it with warmth.",
  relief: "The tension just released — confirm it's truly settled.",
  sadness: "There's quiet disappointment here — gentleness over efficiency.",
};

function heuristicAnalysis(text: string): AiJson {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  let bestEmotion = "neutral";
  let bestHits = 0;
  const signals: string[] = [];

  for (const [emotion, lexicon] of Object.entries(EMOTION_LEXICONS)) {
    const hits = lexicon.filter((w) => lower.includes(w)).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestEmotion = emotion;
      signals.push(emotion);
    }
  }

  const exclamations = (text.match(/!/g) ?? []).length;
  const questionMarks = (text.match(/\?/g) ?? []).length;
  const capsWords = words.filter(
    (w) => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w),
  ).length;

  const rantScore = Math.min(
    100,
    exclamations * 12 + capsWords * 10 + (bestEmotion === "frustration" ? 35 : 0),
  );

  const urgentWords = ["urgent", "asap", "immediately", "right now", "emergency", "critical", "deadline", "today"];
  const urgentHits = urgentWords.filter((w) => lower.includes(w)).length;
  const urgencyScore = Math.min(100, urgentHits * 30 + (exclamations > 1 ? 15 : 0) + (/broken|not working|down\b/.test(lower) ? 20 : 0));
  const urgency = urgencyScore >= 60 ? "high" : urgencyScore >= 25 ? "medium" : "low";

  const positiveHits = [...EMOTION_LEXICONS.delight, ...EMOTION_LEXICONS.gratitude, ...EMOTION_LEXICONS.relief]
    .filter((w) => lower.includes(w)).length;
  const negativeHits = [...EMOTION_LEXICONS.anger, ...EMOTION_LEXICONS.frustration, ...EMOTION_LEXICONS.sadness, ...EMOTION_LEXICONS.anxiety]
    .filter((w) => lower.includes(w)).length;
  const sentimentScore = Math.max(-1, Math.min(1, (positiveHits - negativeHits) * 0.35));
  const sentiment = sentimentScore > 0.15 ? "positive" : sentimentScore < -0.15 ? "negative" : "neutral";

  return {
    emotion: bestEmotion,
    confidence: Math.min(0.75, 0.45 + bestHits * 0.08),
    rantScore,
    rantInterpretation:
      rantScore >= 50
        ? "Strong venting signals (punctuation/caps) — mostly emotional release."
        : rantScore >= 20
          ? "Some emotional intensity, but the complaint is still actionable."
          : "Mostly a clear, actionable complaint rather than venting.",
    sentiment,
    sentimentScore: Number(sentimentScore.toFixed(2)),
    urgency,
    urgencyScore,
    signalFields: signals.slice(0, 3).join(", ") || "no strong emotional markers",
    advice:
      ADVICE_BY_EMOTION[bestEmotion] ??
      "Read the message closely and respond to the specific concern raised.",
    omiNote:
      NOTE_BY_EMOTION[bestEmotion] ??
      "No strong emotional markers — a calm, factual reply fits best.",
  };
}

export const analyze = action({
  args: { text: v.string() },
  handler: async (ctx, { text }): Promise<{ analysisId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Sign in to run an emotion analysis.");
    }

    const trimmed = text.trim().slice(0, 2000);
    if (trimmed.length < 2) {
      throw new Error("Give Omi at least a few words to analyze.");
    }

    // AI path first; if every AI provider is unavailable, fall back to an
    // on-device heuristic so the flagship feature never dead-ends.
    let parsed: AiJson | null = null;
    try {
      const result = await vly.ai.completion({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: trimmed },
        ],
        temperature: 0.2,
        maxTokens: 1000, // gpt-oss models spend reasoning tokens before the JSON — leave headroom
      });

      if (result.success && result.data) {
        const raw = result.data.choices?.[0]?.message?.content ?? "";

        // The model sometimes wraps JSON in ```json fences — strip them.
        const jsonText = raw
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "")
          .trim();

        const start = jsonText.indexOf("{");
        const end = jsonText.lastIndexOf("}");
        if (start !== -1 && end !== -1) {
          parsed = JSON.parse(jsonText.slice(start, end + 1)) as AiJson;
        }
      }
    } catch {
      parsed = null;
    }

    if (!parsed) {
      parsed = heuristicAnalysis(trimmed);
    }

    const emotion = asString(parsed.emotion, "neutral");
    const confidence = asNumber(parsed.confidence, 0.7, 0, 1);

    const analysisId = await ctx.runMutation(internal.emotions.saveAnalysis, {
      userId,
      text: trimmed,
      emotion,
      confidence,
      rantScore: asNumber(parsed.rantScore, 0, 0, 100),
      rantInterpretation: asString(parsed.rantInterpretation, ""),
      sentiment: asString(parsed.sentiment, "neutral"),
      sentimentScore: asNumber(parsed.sentimentScore, 0, -1, 1),
      urgency: asString(parsed.urgency, "medium"),
      urgencyScore: asNumber(parsed.urgencyScore, 50, 0, 100),
      signalFields: asString(parsed.signalFields, ""),
      advice: asString(parsed.advice, ""),
      omiNote: asString(parsed.omiNote, ""),
    });

    return { analysisId };
  },
});
