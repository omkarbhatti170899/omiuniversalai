import axios from "axios";
import {
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

/**
 * Mwmbl — free, open, independent. No key, no billing, no scraping.
 * =========================================================================
 *
 * Mwmbl is a non-profit, AGPL-3.0 search engine with its OWN index, crawled by
 * volunteers. Its API is official and keyless: SearXNG ships a Mwmbl engine
 * that declares `use_official_api: true` / `require_api_key: false` against
 * `https://api.mwmbl.org/api/v1`, and it returns JSON. Verified live
 * 2026-09-27.
 *
 * The honest limit, MEASURED on the live API: **Mwmbl returns no dates.**
 * The response objects carry only `url`, `title` (a list of bold/word runs),
 * `extract` (same shape) and `source`. There is no publication or update
 * timestamp anywhere in the payload.
 *
 * That single fact decides where it may be used. A freshness-gated question —
 * "latest", "today", "current" — cannot be answered from evidence that carries
 * no date, and pretending otherwise is exactly the bug class Andromeda's
 * freshness engine exists to prevent. So Mwmbl is registered for GENERAL and
 * KNOWLEDGE questions and is deliberately absent from every freshness tier's
 * `preferredProviders`. It contributes breadth and independence, never
 * recency. An undated source is not evidence of freshness.
 *
 * Other measured limits, recorded so they are not rediscovered later:
 *   • no paging (SearXNG sets `paging = False`); you get one shallow page
 *   • no region, no language, no safe-search, no time range
 *   • the index is small and volunteer-crawled; its own README says the core
 *     design "has yet to be tested on any large scale"
 */

const MWMBL_ENDPOINT = "https://api.mwmbl.org/api/v1/search/";

const UA =
  "AndromedaSearch/1.0 (Ominnovations Intelligence; free/open federated provider)";

const MWMBL_TIMEOUT_MS = 12_000;

/** A "run" is a word fragment plus whether the indexer bolded it. */
type Run = { value?: string; is_bold?: boolean };

type MwmblResult = {
  url?: string;
  title?: Run[];
  extract?: Run[];
  source?: string;
};

function runsToText(runs: Run[] | undefined): string {
  if (!Array.isArray(runs)) return "";
  return runs.map((r) => r?.value ?? "").join("");
}

export function createMwmblProvider(): SearchProvider {
  return {
    id: "mwmbl",
    label: "Mwmbl (free, open, independent index)",
    // No key exists, so there is nothing to be missing. The hint documents the
    // real limitation instead, which is the more useful thing to surface.
    missingKeyHint:
      "Always available — Mwmbl needs no key. Note: it returns NO publication " +
      "dates, so it is excluded from freshness-gated ('latest'/'today') queries.",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      // Mwmbl is a text web index. Asking it for images or video wastes the
      // call and returns nothing.
      if (opts?.category === "images" || opts?.category === "videos") {
        return { citations: [] };
      }
      // `timeRange` is ignored on purpose: Mwmbl does not implement it, and
      // silently accepting a recency request we cannot honour would return
      // undated results that look like they satisfied the request.

      const res = await axios.get<MwmblResult[]>(MWMBL_ENDPOINT, {
        params: { s: query },
        headers: { "User-Agent": UA },
        timeout: MWMBL_TIMEOUT_MS,
      });

      const rows = Array.isArray(res.data) ? res.data : [];
      const citations = rows
        .filter((r) => r?.url)
        .slice(0, numResults)
        .map((r) => ({
          title: runsToText(r.title) || String(r.url),
          url: String(r.url),
          snippet: runsToText(r.extract) || undefined,
          // Deliberately NO publishedAt. Inventing or guessing one would be
          // worse than admitting the source is undated.
          publishedAt: undefined,
          providers: ["mwmbl"],
        }));

      return { citations };
    },
  };
}

/** Exposed for the registry test and the health module. */
export const MWMBL_RETURNS_TIMESTAMPS = false;
