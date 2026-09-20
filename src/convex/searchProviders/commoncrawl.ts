import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const CDX_API = "https://index.commoncrawl.org/CC-MAIN-2026-13-index";
const UA = "OmiSearch/1.0 (https://ominnovations.example; contact: omi@ominnovations.example)";

/**
 * Common Crawl provider (Amazon/AWS-ecosystem open data on S3) — a petabyte
 * open repository of crawled web pages. Master plan §5 lists it for web
 * retrieval.
 *
 * License/legal reality (§32 audit):
 *   • The index metadata API is keyless and free.
 *   • Content lives in public WARC segments (S3 requester-pays historically;
 *     mirrors vary) — we DO NOT fetch or store page content from Common
 *     Crawl; we surface index metadata (URL + title-ish info) and retrieve
 *     pages live via our own SSRF-guarded fetcher. Only what we are legally
 *     permitted to process is retained (§11/§41).
 *
 * This provider is a defensive addition: it participates in parallel
 * retrieval but its role is provenance/diversity, not bulk content.
 */
export function createCommonCrawlProvider(): SearchProvider {
  return {
    id: "commoncrawl",
    label: "Common Crawl (open web index)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults): Promise<SearchProviderResult> {
      try {
        // CDX server API: url + output=json. We treat the query as a broad
        // match filter so it composes with the other engines' results.
        const res = await axios.get(CDX_API, {
          params: {
            url: query.replace(/\s+/g, "+"),
            matchType: "domain",
            output: "json",
            limit: Math.min(numResults, 10),
          },
          headers: { "User-Agent": UA },
          timeout: 15000,
        });

        const lines = String(res.data ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 1 && l.startsWith("{"));
        const citations: SearchProviderResult["citations"] = [];
        const seen = new Set<string>();
        for (const line of lines) {
          try {
            const row = JSON.parse(line) as { url?: string; urlkey?: string };
            const url = row.url;
            if (!url || seen.has(url)) continue;
            seen.add(url);
            citations.push({
              title: url.replace(/^https?:\/\//, "").slice(0, 120),
              url,
              snippet: "Indexed by the Common Crawl open web index (metadata).",
            });
            if (citations.length >= numResults) break;
          } catch {
            // skip malformed line
          }
        }
        return { citations };
      } catch (err) {
        throw new MissingKeyError(
          `commoncrawl: ${err instanceof Error ? err.message : "unavailable"}`,
        );
      }
    },
  };
}
