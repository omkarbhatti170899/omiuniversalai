import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const OPENALEX_ENDPOINT = "https://api.openalex.org/works";

const UA =
  "AndromedaSearch/1.0 (Ominnovations Intelligence; keyless, zero-cost meta-search)";
// Polite-pool contact so OpenAlex routes us into the faster shared pool
// (still keyless, still zero cost).
const MAILTO = "omi@ominnovations.example";

/** Rebuild the abstract text from OpenAlex's inverted index format. */
function abstractFromInvertedIndex(
  inv: Record<string, number[]> | null | undefined,
): string {
  if (!inv) return "";
  const words: Array<{ pos: number; word: string }> = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions) words.push({ pos, word });
  }
  words.sort((a, b) => a.pos - b.pos);
  return words.map((w) => w.word).join(" ");
}

/**
 * OpenAlex scholarly engine (Andromeda source, spec §5). Open index of
 * 250M+ research works — keyless, zero cost. Complements arXiv with
 * journal-published papers across all disciplines.
 */
export function createOpenAlexProvider(): SearchProvider {
  return {
    id: "openalex",
    label: "OpenAlex",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      if (opts?.category === "news" || opts?.category === "images") {
        return { citations: [] };
      }

      const res = await axios.get(OPENALEX_ENDPOINT, {
        params: {
          search: query,
          per_page: Math.min(numResults, 6),
          mailto: MAILTO,
        },
        headers: { "User-Agent": UA },
        timeout: 12000,
      });

      const works: Array<{
        title?: string;
        doi?: string | null;
        id?: string;
        publication_year?: number | null;
        abstract_inverted_index?: Record<string, number[]> | null;
        cited_by_count?: number | null;
      }> = res.data?.results ?? [];

      const citations = works
        .filter((w) => w.title)
        .slice(0, numResults)
        .map((w) => {
          const url = w.doi
            ? `https://doi.org/${String(w.doi).replace(/^https?:\/\/doi\.org\//, "")}`
            : (w.id ?? "");
          const abstract = abstractFromInvertedIndex(w.abstract_inverted_index);
          const meta = [
            w.publication_year ? String(w.publication_year) : null,
            w.cited_by_count ? `${w.cited_by_count} citations` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return {
            title: w.title!.slice(0, 300),
            url,
            snippet:
              [meta, abstract.slice(0, 550)].filter(Boolean).join("\n") ||
              undefined,
            publishedAt: w.publication_year
              ? `${w.publication_year}-01-01`
              : undefined,
          };
        })
        .filter((c) => c.url.startsWith("http"));

      if (citations.length === 0) throw new MissingKeyError("openalex");
      return { citations };
    },
  };
}
