import axios from "axios";

export type WebCitation = {
  title: string;
  url: string;
  snippet?: string;
};

/** Any web-search provider must return normalized citations. */
export type SearchProvider = {
  id: string;
  label: string;
  /** Return true if the provider's API key is configured. */
  isConfigured: () => boolean;
  /** Human-facing hint for the operator when the key is missing. */
  missingKeyHint: string;
  search: (query: string, numResults: number) => Promise<SearchProviderResult>;
};

export type SearchProviderResult = {
  citations: WebCitation[];
};

const EXA_ENDPOINT = "https://api.exa.ai/search";

/**
 * Exa (exa.ai) — semantic web search built for AI answer engines.
 * Expected env var: EXA_API_KEY (set via the project's API Keys tab).
 */
export function createExaProvider(): SearchProvider {
  return {
    id: "exa",
    label: "Exa",
    missingKeyHint:
      "Add EXA_API_KEY in the project's API Keys tab to enable live web search.",
    isConfigured: () => Boolean(process.env.EXA_API_KEY),

    async search(query, numResults): Promise<SearchProviderResult> {
      const apiKey = process.env.EXA_API_KEY;
      if (!apiKey) {
        throw new MissingKeyError("exa");
      }

      try {
        const res = await axios.post(
          EXA_ENDPOINT,
          {
            query,
            numResults,
            type: "auto",
            contents: { text: { maxCharacters: 1000 } },
          },
          {
            headers: {
              "x-api-key": apiKey,
              "Content-Type": "application/json",
            },
            timeout: 20000,
          },
        );

        const results: Array<{
          title?: string;
          url?: string;
          text?: string;
          highlight?: string | string[];
        }> = res.data?.results ?? [];

        const citations: WebCitation[] = results
          .filter((r) => r.url)
          .map((r) => ({
            title: (r.title ?? r.url ?? "Untitled").slice(0, 200),
            url: r.url as string,
            snippet: (r.highlight ?? r.text ?? "").toString().slice(0, 400),
          }));

        return { citations };
      } catch (err) {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          if (status === 401 || status === 403) {
            throw new Error(
              "Search provider rejected the API key (401/403). Double-check EXA_API_KEY.",
            );
          }
          if (status === 429) {
            throw new Error(
              "Search provider rate limit hit (429). Try again in a moment.",
            );
        }
          throw new Error(`Search provider error (${status ?? "network"}).`);
        }
        throw err;
      }
    },
  };
}

/** Error type used so the orchestrator can distinguish missing-key from other failures. */
export class MissingKeyError extends Error {
  providerId: string;
  constructor(providerId: string) {
    super(`missing_key:${providerId}`);
    this.name = "MissingKeyError";
    this.providerId = providerId;
  }
}
