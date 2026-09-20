import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const OPENLIBRARY_ENDPOINT = "https://openlibrary.org/search.json";

const UA =
  "AndromedaSearch/1.0 (Ominnovations Intelligence; keyless, zero-cost meta-search)";

/**
 * Open Library engine (Andromeda source, spec §5). Free, keyless book
 * search from the Internet Archive's open catalog. Useful for books,
 * authors, editions, and reference material.
 */
export function createOpenLibraryProvider(): SearchProvider {
  return {
    id: "openlibrary",
    label: "Open Library",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      if (opts?.category === "news" || opts?.category === "images") {
        return { citations: [] };
      }

      const res = await axios.get(OPENLIBRARY_ENDPOINT, {
        params: {
          q: query,
          limit: Math.min(numResults, 6),
          fields: "key,title,author_name,first_publish_year,subject",
        },
        headers: { "User-Agent": UA },
        timeout: 12000,
      });

      const docs: Array<{
        key?: string;
        title?: string;
        author_name?: string[];
        first_publish_year?: number;
        subject?: string[];
      }> = res.data?.docs ?? [];

      const citations = docs
        .filter((d) => d.title && d.key)
        .slice(0, numResults)
        .map((d) => {
          const meta = [
            d.author_name?.slice(0, 3).join(", "),
            d.first_publish_year ? String(d.first_publish_year) : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const subjects = (d.subject ?? []).slice(0, 6).join(", ");
          return {
            title: `${d.title}${d.first_publish_year ? ` (${d.first_publish_year})` : ""}`.slice(0, 300),
            url: `https://openlibrary.org${d.key}`,
            snippet: [meta, subjects].filter(Boolean).join(" — ") || undefined,
          };
        });

      if (citations.length === 0) throw new MissingKeyError("openlibrary");
      return { citations };
    },
  };
}
