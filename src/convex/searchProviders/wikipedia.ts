import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const WIKI_API_BASES = [
  "https://en.wikipedia.org/w/api.php",
  "https://en.m.wikipedia.org/w/api.php",
];

const UA = "OmiSearch/1.0 (https://ominnovations.example; contact: omi@ominnovations.example)";

/**
 * Wikipedia knowledge engine — keyless, encyclopedic coverage with
 * automatic failover across endpoint mirrors. Best for entities (people,
 * science, history, technology, organizations) and stable facts.
 * Zero cost, no API key.
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
            headers: { "User-Agent": UA },
            timeout: 15000,
          });

          const hits: Array<{ title?: string }> =
            searchRes.data?.query?.search ?? [];
          const titles = hits
            .map((h) => h.title)
            .filter((t): t is string => Boolean(t));
          if (titles.length === 0) {
            return { citations: [] };
          }

          // 2) Fetch intro extracts for those titles in one batch call
          const extractRes = await axios.get(base, {
            params: {
              action: "query",
              prop: "extracts",
              exintro: 1,
              explaintext: 1,
              titles: titles.join("|"),
              format: "json",
            },
            headers: { "User-Agent": UA },
            timeout: 15000,
          });

          const pages: Record<
            string,
            { title?: string; extract?: string }
          > = extractRes.data?.query?.pages ?? {};

          const citations = Object.values(pages)
            .filter((p) => p.extract && p.title)
            .slice(0, numResults)
            .map((p) => ({
              title: p.title as string,
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
                (p.title as string).replace(/ /g, "_"),
              )}`,
              snippet: (p.extract as string).slice(0, 600),
            }));

          if (citations.length > 0) {
            return { citations };
          }
          lastErr = new Error("no extracts returned");
        } catch (err) {
          lastErr = err;
        }
      }

      throw new MissingKeyError(
        `wikipedia: ${lastErr instanceof Error ? lastErr.message : "unavailable"}`,
      );
    },
  };
}
