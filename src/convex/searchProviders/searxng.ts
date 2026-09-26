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
/**
 * Public instances that have historically served JSON. The router tries
 * each in order and moves on at the first failure — instances rate-limit
 * aggressively, so this list is a floor, not a dependency.
 *
 * MEASURED 2026-09-26: every one of these returns HTTP 200 with an HTML body
 * when `format=json` is requested, because SearXNG ships with the JSON format
 * disabled by default. The provider therefore cannot rely on the public
 * floor and must treat "reachable but not JSON" as a hard failure, not as
 * "no results". See `probeInstance` below and `SEARXNG_FLOOR_HEALTHY`.
 */
const PUBLIC_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://baresearch.org",
  "https://search.hbubli.cc",
];

/**
 * Set SEARXNG_BASE_URL to your own instance — that is the only configuration
 * in which this provider is expected to work:
 *   docker run -d -p 8080:8080 searxng/searxng
 *   settings.yml → search.formats: [html, json]
 * Without it, Omi probes the public floor once and reports the result
 * honestly instead of claiming to be ready.
 */
const SEARXNG_FLOOR_HEALTHY = false;

/** Cached reachability verdict, so the status page never probes on a render. */
type ProbeResult = { healthy: boolean; checkedAt: number; detail: string };
let lastProbe: ProbeResult | null = null;
const PROBE_TTL_MS = 5 * 60_000;

/**
 * One SearXNG attempt, fully parameterized.
 */
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

/**
 * Actually check whether a base URL serves the JSON API.
 *
 * This exists because the previous version reported SearXNG as "ready"
 * unconditionally (`isConfigured: () => true`) while every call returned
 * HTML — so the status page, the Settings UI and the self-test all reported
 * a working search engine that could never return a result. Reachability is
 * now measured, cached for five minutes, and surfaced honestly.
 */
export async function probeInstance(
  base: string,
  timeoutMs = 8000,
): Promise<{ healthy: boolean; detail: string }> {
  try {
    const res = await axios.get(base + SEARX_ENDPOINT, {
      params: { q: "omi health probe", format: "json" },
      timeout: timeoutMs,
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OmiSearch/1.0",
      },
      // 200 is not success: a JSON-disabled instance answers 200 + HTML.
      validateStatus: () => true,
    });
    const contentType = String(res.headers?.["content-type"] ?? "");
    const body = res.data;
    if (typeof body === "object" && body !== null && Array.isArray(body.results)) {
      return {
        healthy: true,
        detail: `JSON API reachable (${(body.results as unknown[]).length} probe results, ${contentType || "unknown content-type"})`,
      };
    }
    if (contentType.includes("json")) {
      return { healthy: false, detail: `JSON API returned ${contentType} without a results array` };
    }
    return {
      healthy: false,
      detail:
        `Endpoint answered ${res.status} with ${contentType || "an unknown content-type"} instead of JSON — ` +
        `this instance has search.formats JSON disabled. Enable it in settings.yml, or set SEARXNG_BASE_URL to an instance that has.`,
    };
  } catch (err) {
    return {
      healthy: false,
      detail: `unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/** Cached, honest reachability verdict for the status surface. */
export async function searxngHealth(): Promise<ProbeResult> {
  if (lastProbe && Date.now() - lastProbe.checkedAt < PROBE_TTL_MS) return lastProbe;
  const configuredBase = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "");
  const targets = configuredBase ? [configuredBase] : PUBLIC_INSTANCES;
  const findings: string[] = [];
  let healthy = false;
  for (const base of targets) {
    const r = await probeInstance(base);
    findings.push(`${base}: ${r.healthy ? "OK" : r.detail}`);
    if (r.healthy) {
      healthy = true;
      break;
    }
  }
  lastProbe = {
    healthy,
    checkedAt: Date.now(),
    detail: findings.join(" | "),
  };
  return lastProbe;
}

/** Synchronous, never-blocking health for the reactive status query. */
export function searxngHealthCached(): ProbeResult | null {
  return lastProbe;
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
  const items = Array.isArray(json?.results) ? json.results : null;

  // A 200 with no `results` array is NOT an empty result set — it is almost
  // always an HTML body from an instance with the JSON format disabled. The
  // old code treated it as "no results", moved on, and after every instance
  // failed threw a misleading "missing key" error, so a configuration problem
  // looked like a quota problem.
  if (items === null) {
    const contentType = String(res.headers?.["content-type"] ?? "");
    if (!contentType.includes("json")) {
      throw new Error(
        `${base} answered ${res.status} with ${contentType || "non-JSON"} — its JSON API is disabled ` +
          `(settings.yml → search.formats must include "json"). Set SEARXNG_BASE_URL to an instance that has it.`,
      );
    }
    throw new Error(`${base} returned JSON without a results array`);
  }

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
      : "Set SEARXNG_BASE_URL to your own SearXNG instance with the JSON format enabled (settings.yml → search.formats: [html, json]). The public instances were measured on 2026-09-26 and all return HTML instead of JSON, so Omi does not count them as a working general-web source.",
    /**
     * HONEST readiness. The previous value was `() => true`, which made the
     * status page, the Settings UI and the self-test all report a working
     * general-web engine that could never return a single result. Readiness
     * now means "either you configured your own instance, or a probe has
     * confirmed a public instance actually serves JSON".
     */
    isConfigured: () =>
      configuredBase !== undefined || SEARXNG_FLOOR_HEALTHY || (lastProbe?.healthy ?? false),

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
