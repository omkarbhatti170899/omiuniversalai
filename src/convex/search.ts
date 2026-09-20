"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { vly } from "../lib/vly-integrations";
import { friendlyAiError } from "./aiErrors";
import { getConfiguredProviders } from "./searchProviders";
import type { WebCitation } from "./searchProviders";

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

    // 1) Live web search — try each configured engine in priority order
    //    (Tavily -> Exa -> keyless). The first engine that returns
    //    citations wins; a failing engine never breaks the search.
    const providers = getConfiguredProviders();
    if (providers.length === 0) {
      throw new Error(
        "Omi Search could not start: no search engine is available. Add TAVILY_API_KEY or EXA_API_KEY in the project's API Keys tab.",
      );
    }

    let citations: WebCitation[] | null = null;
    let usedEngine = "";
    const failures: string[] = [];

    for (const provider of providers) {
      try {
        const result = await provider.search(trimmed, 6);
        if (result.citations.length > 0) {
          citations = result.citations;
          usedEngine = provider.label;
          break;
        }
        failures.push(`${provider.label}: no results`);
      } catch (err) {
        failures.push(
          `${provider.label}: ${err instanceof Error ? err.message : "failed"}`,
        );
      }
    }

    if (!citations) {
      throw new Error(
        `All search engines failed for this query. ${failures
          .join(" | ")
          .slice(0, 280)}`,
      );
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
      // Graceful degradation: the engines found real sources, so save them
      // with a plain-language note instead of failing the whole search.
      const fallbackAnswer =
        "I found live sources for your question, but my AI summary is temporarily " +
        "unavailable (the AI gateway key is being rejected). Here are the top " +
        "sources I found — the summary will work again once the AI connection is restored:\n\n" +
        citations
          .map(
            (c, i) =>
              `[${i + 1}] ${c.title}${c.snippet ? ` — ${c.snippet.slice(0, 180)}` : ""}`,
          )
          .join("\n");

      const searchId = await ctx.runMutation(
        internal.searchHistory.saveSearch,
        {
          userId,
          query: trimmed,
          answer: fallbackAnswer.slice(0, 3000),
          citations,
        },
      );
      return { searchId };
    }

    const answer = (
      completion.data.choices?.[0]?.message?.content ?? ""
    ).trim();
    if (!answer) {
      throw new Error("Omi returned an empty answer. Try again.");
    }

    // 3) Persist to history — engine label travels with the answer as provenance
    const searchId = await ctx.runMutation(internal.searchHistory.saveSearch, {
      userId,
      query: trimmed,
      answer: usedEngine
        ? `${answer}\n\n— via ${usedEngine}`
        : answer,
      citations,
    });

    return { searchId };
  },
});
