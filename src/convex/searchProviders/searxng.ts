import axios from "axios";
import {
  MissingKeyError,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./types";

/**
 * SearXNG — self-hosted metasearch engine. PRIMARY search source for Omi.
 * Zero per-search cost: results come from your own instance (or a
 * community instance you point Omi at), never a metered API.
 *
 * Configure with a single env var:
 *   SEARXNG_BASE_URL = https://your-searxng-instance.example.com
 *
 * Self-host in one command (JSON format must be enabled in settings.yml):
 *   docker run -d -p 8080:8080 searxng/searxng
 *   settings.yml → search.formats: [html, json]
 *
 * When SEARXNG_BASE_URL is not set, Omi falls back to well-known public
 * SearXNG instances that expose the JSON API, so the feature still works
 * at zero cost before your own instance is up.
 */

const SEARX_ENDPOINT = "/search";

/**
 * Public instances that have historically served JSON. The router tries
 * each in order and moves on at the first failure — instances rate-limit
 * aggressively, so this list is a floor, not a dependency.
 */
const PUBLIC_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://baresearch.org",
  "https://search.hbubli.cc",
];

/** One SearXNG attempt, fully parameterized. */
type SearxParams = {
  base: string;
  query: string;
  numResults: number;
  opts: SearchOptions;
};

type SearxResultItem = {
  title?: string;
  url?: string;
  content?: string;
  img_src?: string;
  publishedDate?: string;
};

function buildParams({
  query,
  numResults,
  opts,
}: Omit<SearxParams, "base">): Record<string, string> {
  const params: Record<string, string> = {
    q: query,
    format: "json",
    // SearXNG pages are small (engine fan-out happens server-side); ask for
    // more than requested so dedupe/ranking still yields enough.
    results_on_page: String(Math.min(Math.max(numResults * 2, 10), 30)),
  };
  if (opts.category && opts.category !== "general") {
    params.category_general = "on";
    params[`category_${opts.category}`] = "on";
  }
  if (opts.language) params.language = opts.language;
  if (opts.timeRange) params.time_range = opts.timeRange;
  if (opts.safeSearch !== undefined) params.safesearch = String(opts.safeSearch);
  if (opts.page && opts.page > 1) params.pageno = String(opts.page);
  return params;
}

/**
 * Search suggestions (autocomplete). SearXNG exposes /autocompleter
 * returning a JSON array of strings. Best-effort: empty on any failure.
 */
export async function searxSuggestions(query: string): Promise<string[]> {
  const configuredBase = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "");
  const bases = configuredBase ? [configuredBase] : PUBLIC_INSTANCES;
  for (const base of bases.slice(0, configuredBase ? 1 : 2)) {
    try {
      const res = await axios.get(base + "/autocompleter", {
        params: { q: query.slice(0, 100), format: "json" },
        timeout: 4_000,
        headers: { Accept: "application/json" },
        validateStatus: (s) => s >= 200 && s < 300,
      });
      const data = res.data;
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.[1])
          ? data[1]
          : [];
      return list
        .filter((s): s is string => typeof s === "string")
        .slice(0, 8);
    } catch {
      // try next base
    }
  }
  return [];
}

async function fetchInstance(
  base: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<WebCitation[]> {
  const res = await axios.get(base + SEARX_ENDPOINT, {
    params,
    timeout: timeoutMs,
    headers: {
      Accept: "application/json",
      // Some fronting proxies gate on UA; a browser-like UA maximizes the
      // chance the JSON API answers instead of a bot challenge.
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OmiSearch/1.0",
    },
    // Community front-ends sometimes serve self-signed certs; never fail
    // the whole search over TLS validation we cannot act on.
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const json = res.data as { results?: SearxResultItem[] };
  const items = Array.isArray(json?.results) ? json.results : [];

  return items
    .filter((r) => typeof r.url === "string" && r.url.startsWith("http"))
    .map((r) => ({
      title: (r.title ?? r.url ?? "Untitled").slice(0, 300),
      url: r.url as string,
      snippet: r.content ? String(r.content).slice(0, 600) : undefined,
      imageUrl: r.img_src && typeof r.img_src === "string" ? r.img_src : undefined,
      publishedAt:
        r.publishedDate && typeof r.publishedDate === "string"
          ? r.publishedDate
          : undefined,
    }));
}

export function createSearxProvider(): SearchProvider {
  const configuredBase = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "");

  return {
    id: "searxng",
    label: "SearXNG",
    missingKeyHint: configuredBase
      ? ""
      : "Set SEARXNG_BASE_URL to your self-hosted SearXNG instance (docker run -d -p 8080:8080 searxng/searxng, JSON format enabled). Until then Omi tries public SearXNG instances at zero cost.",
    isConfigured: () => true, // always available: own instance or public floor

    async search(
      query,
      numResults,
      opts = {},
    ): Promise<SearchProviderResult> {
      const params = buildParams({ query, numResults, opts });
      const bases = configuredBase
        ? [configuredBase]
        : PUBLIC_INSTANCES;
      const perTryTimeout = configuredBase ? 15000 : 9000;
      const maxTries = configuredBase ? 2 : bases.length;

      let lastError: unknown = null;
      let attempts = 0;

      for (const base of bases) {
        if (attempts >= maxTries) break;
        attempts += 1;

        // Retry policy: 2 quick attempts per instance (transient 5xx /
        // timeouts are common on shared instances), then move on.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const citations = await fetchInstance(base, params, perTryTimeout);
            if (citations.length > 0) {
              return { citations };
            }
            // Empty result set is a valid answer — but only trust it from
            // the configured (non-gated) instance. Public instances may be
            // serving a challenge that still returned 200 with no results.
            if (configuredBase) {
              return { citations: [] };
            }
            lastError = new Error(`${base} returned no results`);
          } catch (err) {
            lastError = err;
          }
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 400));
          }
        }
      }

      if (!configuredBase) {
        throw new MissingKeyError("searxng");
      }
      throw new Error(
        `SearXNG (${configuredBase}) failed: ${
          lastError instanceof Error ? lastError.message : "unknown error"
        }`,
      );
    },
  };
}
