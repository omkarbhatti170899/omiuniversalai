import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./exa";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/**
 * Tavily (tavily.com) — AI-first search engine purpose-built for LLM agents.
 * "advanced" depth pulls richer, cleaner source extracts than keyword search.
 * Expected env var: TAVILY_API_KEY (set via the project's API Keys tab).
 */
export function createTavilyProvider(): SearchProvider {
  return {
    id: "tavily",
    label: "Tavily",
    missingKeyHint:
      "Optional: add TAVILY_API_KEY for Tavily's advanced AI search depth (free tier at tavily.com).",
    isConfigured: () => Boolean(process.env.TAVILY_API_KEY),

    async search(query, numResults): Promise<SearchProviderResult> {
      const apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) {
        throw new MissingKeyError("tavily");
      }

      try {
        const res = await axios.post(
          TAVILY_ENDPOINT,
          {
            query,
            max_results: numResults,
            search_depth: "advanced",
            include_answer: false,
            include_raw_content: false,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            timeout: 25000,
          },
        );

        const results: Array<{
          title?: string;
          url?: string;
          content?: string;
        }> = res.data?.results ?? [];

        const citations: WebCitation[] = results
          .filter((r) => r.url)
          .map((r) => ({
            title: (r.title ?? r.url ?? "Untitled").slice(0, 200),
            url: r.url as string,
            snippet: (r.content ?? "").slice(0, 400),
          }));

        return { citations };
      } catch (err) {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          if (status === 401 || status === 403) {
            throw new Error(
              "Tavily rejected the API key (401/403). Double-check TAVILY_API_KEY.",
            );
          }
          if (status === 429) {
            throw new Error(
              "Tavily rate limit hit (429). Omi will retry on another engine.",
            );
          }
          throw new Error(`Tavily error (${status ?? "network"}).`);
        }
        throw err;
      }
    },
  };
}
