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

    const result = await vly.ai.completion({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: trimmed },
      ],
      temperature: 0.2,
      maxTokens: 400,
    });

    if (!result.success || !result.data) {
      throw new Error(friendlyAiError(result.error));
    }

    const raw = result.data.choices?.[0]?.message?.content ?? "";

    // The model sometimes wraps JSON in ```json fences — strip them.
    const jsonText = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    let parsed: AiJson;
    try {
      const start = jsonText.indexOf("{");
      const end = jsonText.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("no JSON in response");
      parsed = JSON.parse(jsonText.slice(start, end + 1)) as AiJson;
    } catch {
      throw new Error("Omi's response was malformed. Try again.");
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
