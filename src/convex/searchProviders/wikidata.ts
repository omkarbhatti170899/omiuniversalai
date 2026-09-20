import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const WB_SEARCH_URL = "https://www.wikidata.org/w/api.php";
const UA = "OmiSearch/1.0 (https://ominnovations.example; contact: omi@ominnovations.example)";

/**
 * Wikidata knowledge engine (Google/Alphabet ecosystem via the Wikimedia
 * Foundation — the open successor to Google's Freebase knowledge graph).
 *
 * Keyless, CC0-licensed structured knowledge: entities with labels,
 * descriptions, and aliases in every language. Best for disambiguation
 * ("what exactly is X?"), identifiers, and cross-language facts.
 * Zero cost, no API key, no account.
 */
export function createWikidataProvider(): SearchProvider {
  return {
    id: "wikidata",
    label: "Wikidata (CC0 knowledge graph)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults): Promise<SearchProviderResult> {
      try {
        const res = await axios.get(WB_SEARCH_URL, {
          params: {
            action: "wbsearchentities",
            search: query,
            language: "en",
            uselang: "en",
            limit: Math.min(numResults, 10),
            format: "json",
            origin: "*",
          },
          headers: { "User-Agent": UA },
          timeout: 15000,
        });

        const hits: Array<{
          id?: string;
          label?: string;
          description?: string;
          alias?: string;
          concepturi?: string;
        }> = res.data?.search ?? [];

        const citations = hits
          .filter((h) => h.id && (h.label || h.description))
          .slice(0, numResults)
          .map((h) => ({
            title: h.label ?? (h.id as string),
            url: h.concepturi ?? `https://www.wikidata.org/wiki/${h.id}`,
            snippet: [h.description, h.alias ? `Also known as: ${h.alias}` : null]
              .filter((x): x is string => Boolean(x))
              .join(" — ")
              .slice(0, 500),
          }));

        if (citations.length > 0) return { citations };
        return { citations: [] };
      } catch (err) {
        throw new MissingKeyError(
          `wikidata: ${err instanceof Error ? err.message : "unavailable"}`,
        );
      }
    },
  };
}
