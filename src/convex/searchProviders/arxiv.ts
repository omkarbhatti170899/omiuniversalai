import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";

const UA =
  "AndromedaSearch/1.0 (Ominnovations Intelligence; keyless, zero-cost meta-search)";

/**
 * arXiv research engine (Andromeda source, spec §5 "KNOWLEDGE / RESEARCH").
 * Keyless, zero cost, no registration. Best for scientific/technical
 * queries. Skipped for news/images categories where papers are noise.
 */
export function createArxivProvider(): SearchProvider {
  return {
    id: "arxiv",
    label: "arXiv",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      if (opts?.category === "news" || opts?.category === "images") {
        return { citations: [] };
      }

      const res = await axios.get(ARXIV_ENDPOINT, {
        params: {
          search_query: `all:${query}`,
          start: 0,
          max_results: Math.min(numResults, 6),
          sortBy: "relevance",
        },
        headers: { "User-Agent": UA },
        timeout: 12000,
      });

      const xml = String(res.data ?? "");
      const entries = xml.split("<entry>").slice(1);
      const citations = [];

      for (const entry of entries) {
        const title = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const idUrl = (entry.match(/<id>([\s\S]*?)<\/id>/)?.[1] ?? "").trim();
        const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const published = (entry.match(/<published>([\s\S]*?)<\/published>/)?.[1] ?? "").trim();
        const author = Array.from(entry.matchAll(/<name>([\s\S]*?)<\/name>/g))
          .map((m) => m[1].trim())
          .slice(0, 3)
          .join(", ");

        if (!title || !idUrl.startsWith("http")) continue;
        citations.push({
          title: title.slice(0, 300),
          url: idUrl,
          snippet: summary.slice(0, 600) || undefined,
          publishedAt: published || undefined,
          ...(author ? { author } : {}),
        });
        if (citations.length >= numResults) break;
      }

      if (citations.length === 0) throw new MissingKeyError("arxiv");
      return { citations };
    },
  };
}
