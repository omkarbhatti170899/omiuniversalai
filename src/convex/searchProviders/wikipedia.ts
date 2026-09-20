import axios from "axios";
import type {
  SearchProvider,
  SearchProviderResult,
  WebCitation,
} from "./exa";

const WIKI_API_BASES = [
  "https://en.wikipedia.org/w/api.php",
  "https://en.m.wikipedia.org/w/api.php",
];

/**
 * Wikipedia knowledge engine — keyless, encyclopedic coverage with
 * automatic failover across endpoint mirrors. Full-text MediaWiki search
 * plus intro extracts: best for entities (people, science, history,
 * technology, organizations) and stable factual knowledge.
 */
export function createWikipediaProvider(): SearchProvider {
  return {
    id: "wikipedia",
    label: "Wikipedia",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults): Promise<SearchProviderResult> {
      let lastErr: unknown = null;

      for (const base of WIKI_API_BASES) {
        try {
          // 1) Full-text search for the most relevant articles
          const searchRes = await axios.get(base, {
            params: {
              action: "query",
              list: "search",
              srsearch: query,
              srlimit: Math.min(numResults, 6),
              format: "json",
            },
            // Wikimedia requires a descriptive User-Agent for API access.
            headers: {
              "User-Agent":
                "OmiUniversalSearch/1.0 (Ominnovations Intelligence; contact: omi@omininnovations.app)",
            },
            timeout: 12000,
          });

          const hits: Array<{ title?: string }> =
            searchRes.data?.query?.search ?? [];
          const titles = hits
            .map((h) => h.title)
            .filter((t): t is string => typeof t === "string" && t.length > 0)
            .slice(0, numResults);

          if (titles.length === 0) {
            throw new Error("wikipedia: no matching articles");
          }

          // 2) Fetch clean intro extracts for those titles in one call
          const extractRes = await axios.get(base, {
            params: {
              action: "query",
              prop: "extracts",
              exintro: 1,
              explaintext: 1,
              titles: titles.join("|"),
              format: "json",
            },
            headers: {
              "User-Agent":
                "OmiUniversalSearch/1.0 (Ominnovations Intelligence; contact: omi@omininnovations.app)",
            },
            timeout: 12000,
          });

          const pages = extractRes.data?.query?.pages ?? {};
          const extractsByTitle = new Map<string, string>();
          for (const page of Object.values<Record<string, unknown>>(pages)) {
            const title = page.title as string | undefined;
            const extract = page.extract as string | undefined;
            if (title && extract) {
              extractsByTitle.set(title, extract);
            }
          }

          const citations: WebCitation[] = titles.map((title) => ({
            title,
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
              title.replace(/\s+/g, "_"),
            )}`,
            snippet: (extractsByTitle.get(title) ?? "").slice(0, 500),
          }));

          const withSnippets = citations.filter(
            (c) => (c.snippet ?? "").length > 0,
          );
          if (withSnippets.length === 0) {
            throw new Error("wikipedia: extracts unavailable");
          }

          return { citations: withSnippets };
        } catch (err) {
          lastErr = err;
        }
      }

      throw new Error(
        `wikipedia: ${
          lastErr instanceof Error ? lastErr.message : "unreachable"
        }`,
      );
    },
  };
}
