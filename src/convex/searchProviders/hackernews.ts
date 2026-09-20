import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const HN_ENDPOINT = "https://hn.algolia.com/api/v1/search";

const UA =
  "AndromedaSearch/1.0 (Ominnovations Intelligence; keyless, zero-cost meta-search)";

/**
 * Hacker News engine (Andromeda source, spec §5) via the keyless Algolia
 * HN API. Strong for tech/industry discussions and practitioner signal.
 * Falls back to the HN item page when a story has no external URL.
 */
export function createHackerNewsProvider(): SearchProvider {
  return {
    id: "hackernews",
    label: "Hacker News",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      if (opts?.category === "news" || opts?.category === "images") {
        return { citations: [] };
      }

      const res = await axios.get(HN_ENDPOINT, {
        params: {
          query,
          hitsPerPage: Math.min(numResults, 6),
          tags: "story",
        },
        headers: { "User-Agent": UA },
        timeout: 12000,
      });

      const hits: Array<{
        title?: string | null;
        url?: string | null;
        objectID?: string;
        points?: number | null;
        num_comments?: number | null;
        created_at?: string | null;
        story_text?: string | null;
      }> = res.data?.hits ?? [];

      const citations = hits
        .filter((h) => h.title && h.objectID)
        .slice(0, numResults)
        .map((h) => {
          const meta = [
            h.points ? `${h.points} points` : null,
            h.num_comments ? `${h.num_comments} comments` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return {
            title: h.title!.slice(0, 300),
            url:
              h.url && h.url.startsWith("http")
                ? h.url
                : `https://news.ycombinator.com/item?id=${h.objectID}`,
            snippet:
              (h.story_text ?? "").replace(/<[^>]+>/g, " ").trim().slice(0, 400) ||
              meta ||
              undefined,
            publishedAt: h.created_at ?? undefined,
          };
        });

      if (citations.length === 0) throw new MissingKeyError("hackernews");
      return { citations };
    },
  };
}
