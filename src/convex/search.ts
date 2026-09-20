"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { runUniversalSearch } from "./universalSearch";

export const searchWeb = action({
  args: { query: v.string() },
  handler: async (ctx, { query }): Promise<{ searchId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Sign in to use Omi Search.");
    }

    const trimmed = query.trim().slice(0, 500);
    if (trimmed.length < 2) {
      throw new Error("Type a question or topic to search.");
    }

    // Universal search: multi-engine fan-out, dedupe, domain diversity,
    // AI-synthesized brief with extractive fallback. Never depends on a
    // single engine or the AI gateway to return something useful.
    const result = await runUniversalSearch(trimmed);

    // Persist to history — engine provenance travels with the answer.
    const answer = result.brief
      ? `${result.brief}\n\n— via ${result.engine}`
      : "";

    const searchId = await ctx.runMutation(internal.searchHistory.saveSearch, {
      userId,
      query: trimmed,
      answer,
      citations: result.citations,
    });

    return { searchId };
  },
});
