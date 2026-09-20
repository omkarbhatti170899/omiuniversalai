"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { vly } from "../lib/vly-integrations";
import {
  getActiveProvider,
  MissingKeyError,
  type WebCitation,
} from "./searchProviders";

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

    // 1) Live web search via the provider layer
    let citations: WebCitation[];
    try {
      const provider = getActiveProvider();
      if (!provider) {
        throw new MissingKeyError("none");
      }
      const result = await provider.search(trimmed, 6);
      citations = result.citations;
    } catch (err) {
      if (err instanceof MissingKeyError) {
        // Graceful, actionable message — no raw server error.
        throw new Error(
          "Omi Search needs a web-search API key to reach the live web. Add EXA_API_KEY in the project's API Keys tab, then try again.",
        );
      }
      throw err;
    }

    if (citations.length === 0) {
      throw new Error("No results found for that query. Try rephrasing it.");
    }

    // 2) Omi synthesizes a cited answer from the live results
    const sourcesBlock = citations
      .map(
        (c, i) =>
          `[${i + 1}] ${c.title}\nURL: ${c.url}\nEXCERPT: ${c.snippet ?? ""}`,
      )
      .join("\n\n");

    const completion = await vly.ai.completion({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Omi, the Universal AI inside Ominnovations Intelligence. You just received live web search results. Write a clear, direct answer to the user's question grounded ONLY in the provided excerpts. Cite sources inline using [1], [2] etc. matching the numbered sources. Keep it under 250 words. No preamble, no markdown headings.",
        },
        {
          role: "user",
          content: `Question: ${trimmed}\n\nSources:\n${sourcesBlock}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 500,
    });

    if (!completion.success || !completion.data) {
      throw new Error(
        completion.error ?? "Omi could not synthesize an answer. Try again.",
      );
    }

    const answer = (
      completion.data.choices?.[0]?.message?.content ?? ""
    ).trim();
    if (!answer) {
      throw new Error("Omi returned an empty answer. Try again.");
    }

    // 3) Persist to history
    const searchId = await ctx.runMutation(internal.searchHistory.saveSearch, {
      userId,
      query: trimmed,
      answer,
      citations,
    });

    return { searchId };
  },
});
