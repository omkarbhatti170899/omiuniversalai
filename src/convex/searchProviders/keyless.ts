import axios from "axios";
import {
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./types";

const DUCK_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * Keyless last-resort engine for general web search.
 *
 * MEASURED 2026-09-26 from a real request to this exact endpoint, twice:
 *
 *   POST https://html.duckduckgo.com/html/  q=latest+news
 *   → HTTP 202, ~14 KB HTML body containing "anomaly" and "challenge",
 *     zero `result__a` anchors.
 *
 * DuckDuckGo answers automated requests with a bot challenge (HTTP 202) rather
 * than results. The previous version of this provider reported itself as
 * "configured" unconditionally and threw `MissingKeyError` when the challenge
 * page produced no anchors — so the status page advertised a working
 * general-web engine that could never return a single result, and a
 * configuration/network problem was reported to the user as a missing API
 * key. Readiness is now measured, cached and reported honestly, exactly as
 * SearXNG's is.
 */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OmiSearch/1.0";

/** DuckDuckGo serves challenges as 202, so 200 is not the only thing to check. */
const DDG_CHALLENGE_MARKERS = /anomaly|challenge|captcha|unusual traffic/i;

type HealthResult = { healthy: boolean; checkedAt: number; detail: string };
let lastHealth: HealthResult | null = null;
const HEALTH_TTL_MS = 10 * 60_000;

/**
 * Ask DuckDuckGo for something nobody would be blocked from seeing, then judge
 * the response by its SHAPE: real results contain `result__a` anchors. An HTTP
 * 200 that carries a challenge page is a failure, not an empty result set.
 */
export async function duckduckgoHealth(
  timeoutMs = 12_000,
): Promise<{ healthy: boolean; detail: string }> {
  try {
    const res = await axios.post(
      DUCK_ENDPOINT,
      new URLSearchParams({ q: "omi health probe" }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          Accept: "text/html",
        },
        timeout: timeoutMs,
        // 202 is the challenge status — we must be able to see the body.
        validateStatus: () => true,
      },
    );
    const html = String(res.data ?? "");
    const anchors = (html.match(/class="result__a"/g) ?? []).length;
    if (res.status === 202 || DDG_CHALLENGE_MARKERS.test(html)) {
      return {
        healthy: false,
        detail:
          `bot challenge (HTTP ${res.status}${anchors > 0 ? `, ${anchors} result anchors present` : ", no results"}) — ` +
          `DuckDuckGo blocks server-side automated search from datacenter IPs`,
      };
    }
    if (res.status >= 300) {
      return { healthy: false, detail: `HTTP ${res.status} from ${DUCK_ENDPOINT}` };
    }
    if (anchors === 0) {
      return {
        healthy: false,
        detail: `HTTP ${res.status} but no result anchors in the body — not a usable results page`,
      };
    }
    return { healthy: true, detail: `reachable (HTTP ${res.status}, ${anchors} probe results)` };
  } catch (err) {
    return {
      healthy: false,
      detail: `unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/** Cached, honest reachability verdict — never probes on a reactive render. */
export async function duckduckgoHealthCached(): Promise<HealthResult> {
  if (lastHealth && Date.now() - lastHealth.checkedAt < HEALTH_TTL_MS) return lastHealth;
  const r = await duckduckgoHealth();
  lastHealth = { ...r, checkedAt: Date.now() };
  return lastHealth;
}

/** Synchronous view for the reactive status query. */
export function duckduckgoHealthSync(): HealthResult | null {
  return lastHealth;
}

function parseResults(html: string, numResults: number): WebCitation[] {
  const results: WebCitation[] = [];

  const linkRe =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(sm[1].replace(/<[^>]+>/g, "").trim());
  }

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && results.length < numResults) {
    let url = lm[1];
    // DDG wraps URLs in a redirect (uddg param) — unwrap it.
    const match = url.match(/uddg=([^&]+)/);
    if (match) url = decodeURIComponent(match[1]);
    if (!url.startsWith("http")) continue;

    const title = lm[2].replace(/<[^>]+>/g, "").trim();
    results.push({
      title: (title || url).slice(0, 300),
      url,
      snippet: snippets[i] ? snippets[i].slice(0, 600) : undefined,
    });
    i += 1;
  }
  return results;
}

export function createKeylessProvider(): SearchProvider {
  return {
    id: "duckduckgo",
    label: "DuckDuckGo (keyless)",
    missingKeyHint:
      "DuckDuckGo returns a bot challenge (HTTP 202) to server-side searches from datacenter IPs, so it is not counted as a working general-web source. Point SEARXNG_BASE_URL at your own SearXNG instance for reliable keyless web search.",
    /**
     * HONEST readiness. Readiness means "a probe confirmed this endpoint
     * actually serves results", not "it has no key to be missing". A keyless
     * provider can be unconfigured in exactly the same way a metered one is.
     */
    isConfigured: () => lastHealth?.healthy ?? false,

    async search(query: string, numResults: number): Promise<SearchProviderResult> {
      const res = await axios.post(
        DUCK_ENDPOINT,
        new URLSearchParams({ q: query }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": UA,
            Accept: "text/html",
          },
          timeout: 20000,
          validateStatus: () => true,
        },
      );

      const html = String(res.data ?? "");

      // A challenge page is a BLOCK, not an empty result set, and not a
      // missing API key. Saying "missing key" here sent users looking for a
      // setting that does not exist.
      if (res.status === 202 || DDG_CHALLENGE_MARKERS.test(html)) {
        throw new Error(
          `DuckDuckGo returned a bot challenge (HTTP ${res.status}) instead of results — ` +
            `it blocks server-side automated search. Set SEARXNG_BASE_URL to a SearXNG instance with the JSON API enabled.`,
        );
      }

      const results = parseResults(html, numResults);
      if (results.length === 0) {
        throw new Error(
          `DuckDuckGo answered HTTP ${res.status} with no result links — the results page format changed or the request was silently blocked.`,
        );
      }
      return { citations: results };
    },
  };
}
