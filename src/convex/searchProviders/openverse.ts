import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const OPENVERSE_ENDPOINT = "https://api.openverse.org/v1/images/";

const UA =
  "AndromedaSearch/1.0 (Ominnovations Intelligence; keyless, zero-cost meta-search)";

/**
 * Openverse image engine (Andromeda MEDIA source, spec §5). Openly
 * licensed images from Flickr, Wikimedia and 700M+ works — keyless.
 * Anonymous access is rate-limited (honest cost note in the status
 * panel), so this provider only fires for image-category searches;
 * failures are isolated by the orchestrator like every other source.
 */
export function createOpenverseProvider(): SearchProvider {
  return {
    id: "openverse",
    label: "Openverse (images)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      // Image-category specialist — stay quiet on every other category.
      if (opts?.category !== "images") return { citations: [] };

      const res = await axios.get(OPENVERSE_ENDPOINT, {
        params: {
          q: query,
          page_size: Math.min(numResults, 6),
        },
        headers: { "User-Agent": UA },
        timeout: 12000,
      });

      const results: Array<{
        title?: string | null;
        url?: string | null;
        thumbnail?: string | null;
        foreign_landing_url?: string | null;
        creator?: string | null;
        license?: string | null;
      }> = res.data?.results ?? [];

      const citations = results
        .filter((r) => r.title && (r.foreign_landing_url || r.url))
        .slice(0, numResults)
        .map((r) => ({
          title: r.title!.slice(0, 300),
          url: (r.foreign_landing_url || r.url) as string,
          snippet: [r.creator, r.license ? `License: ${r.license}` : null]
            .filter(Boolean)
            .join(" · ") || undefined,
          imageUrl: r.thumbnail ?? undefined,
        }));

      if (citations.length === 0) throw new MissingKeyError("openverse");
      return { citations };
    },
  };
}
