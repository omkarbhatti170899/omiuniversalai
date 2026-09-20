"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import axios from "axios";
import { vly } from "../lib/vly-integrations";

const EXA_BASE = "https://api.exa.ai";

type Citation = {
  title: string;
  url: string;
  snippet?: string;
};

type ExaResult = {
  title?: string;
  url?: string;
  text?: string;
  highlight?: string | string[];
};

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

    const exaKey = process.env.EXA_API_KEY;
    if (!exaKey) {
      throw new Error(
        "Omi Search needs the EXA_API_KEY. Add it in the project's API Keys tab and try again.",
      );
    }

    // 1) Live web search via Exa (semantic, with page text for grounding)
    let citations: Citation[] = [];
    try {
      const exaRes = await axios.post(
        `${EXA_BASE}/search`,
        {
          query: trimmed,
          numResults: 6,
          type: "auto",
          contents: { text: { maxCharacters: 1000 } },
        },
        {
          headers: {
            "x-api-key": exaKey,
            "Content-Type": "application/json",
          },
          timeout: 20000,
        },
      );

      const results: ExaResult[] = exaRes.data?.results ?? [];
      citations = results
        .filter((r) => r.url)
        .map((r) => ({
          title: (r.title ?? r.url ?? "Untitled").slice(0, 200),
          url: r.url as string,
          snippet: (r.highlight ?? r.text ?? "")
            .slice(0, 400)
            .toString(),
        }));
    } catch (err) {
      const msg =
        axios.isAxiosError(err) && err.response
          ? `Exa search failed (${err.response.status}).`
          : "Exa search failed. Check EXA_API_KEY and try again.";
      throw new Error(msg);
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
            "You are Omi, the AI inside Ominnovations Intelligence. You just received live web search results. Write a clear, direct answer to the user's question grounded ONLY in the provided excerpts. Cite sources inline using [1], [2] etc. matching the numbered sources. Keep it under 250 words. No preamble, no markdown headings.",
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
