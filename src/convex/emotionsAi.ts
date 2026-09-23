"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { complete } from "./aiProviders";
import { getAuthUserId } from "@convex-dev/auth/server";
// §45 — single source of truth for product identity, shared by every surface.
import { creatorIdentityBlock } from "./omiIdentity";
import { readEmotionWith, type EmotionRead } from "./emotionsEngine";

/**
 * One emotional read-out of a passage.
 *
 * AI first (a fast classification model through the provider-neutral router),
 * then the local lexicon heuristic. The try/catch is the graceful-fallback
 * contract the feature is required to have: a provider outage, a rate limit,
 * a timeout, a malformed JSON reply or a thrown transport error can all only
 * ever downgrade the reading — never break the caller. Chat calls this on
 * every eligible turn, so "never throws" matters more here than anywhere.
 */
async function inferRead(text: string): Promise<EmotionRead> {
  return readEmotionWith(
    text,
    async (messages) => {
      const result = await complete({
        task: "classification",
        messages,
        temperature: 0.2,
        // gpt-oss models spend reasoning tokens before the JSON — headroom.
        maxTokens: 1000,
      });
      return result.ok ? result.content : null;
    },
    // §45 — the product identity stays in the system prompt of every surface.
    creatorIdentityBlock(),
  );
}

/**
 * Internal, DB-free read for other server code (chat). Returning the read
 * instead of writing it is what lets chat be emotion-aware WITHOUT turning
 * every message into a permanent record of the user's inferred feelings — the
 * privacy rule the product requires (no sensitive emotional data stored unless
 * the user explicitly opts in).
 */
export const inferInternal = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }): Promise<EmotionRead> => inferRead(text),
});

/** Public, explicit analysis from the Emotions screen — the user asked for it, so it is saved. */
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

    const read = await inferRead(trimmed);

    const analysisId = await ctx.runMutation(internal.emotions.saveAnalysis, {
      userId,
      text: trimmed,
      emotion: read.emotion,
      confidence: read.confidence,
      rantScore: read.rantScore,
      rantInterpretation: read.rantInterpretation,
      sentiment: read.sentiment,
      sentimentScore: read.sentimentScore,
      urgency: read.urgency,
      urgencyScore: read.urgencyScore,
      signalFields: read.signalFields,
      advice: read.advice,
      omiNote: read.omiNote,
      source: read.source,
    });

    return { analysisId };
  },
});
