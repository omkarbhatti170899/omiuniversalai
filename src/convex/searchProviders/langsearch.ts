import axios from "axios";
import {
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./types";

/**
 * LangSearch — TEMPORARY adapter, feature-gated, never a sole provider.
 * =========================================================================
 *
 * WHAT THIS IS
 *   LangSearch (langsearch.com) is a web-search API aimed at AI agents and
 *   RAG pipelines. Verified against its own documentation, 2026-09-27:
 *
 *   ✅ Official documented API — POST https://api.langsearch.com/v1/web-search
 *   ✅ Returns `datePublished` per result, plus a `freshness` filter accepting
 *      oneDay / oneWeek / oneMonth / oneYear, a single UTC date, or an
 *      inclusive UTC range. That date filtering is the reason it is worth
 *      evaluating at all: Mwmbl and DuckDuckGo Instant both return 0% dated
 *      results (measured), and SearXNG's community instance flaps.
 *   ✅ Returns real source URLs and optional full page text, so citations are
 *      grounded in the actual document rather than a snippet.
 *   ✅ Free plan exists: $0/month, input and output tokens both $0 per million,
 *      bounded by RPS (5 for new accounts), TPM and a daily token allowance
 *      that resets at 00:00 UTC.
 *   ✅ Their own docs tell integrators not to expose the key in a browser
 *      bundle — which matches this project's rule exactly.
 *
 * WHAT IT IS NOT — read before trusting the "free" label
 *   LangSearch is a RESELLER, not an index owner. Its pricing page publishes
 *   the upstream rates it resells (Tavily basic search at $8/1k, plus its own
 *   "advanced" credit multipliers, and references to Exa and Brave), and paid
 *   monthly plans exist ($30 / 4,000 credits upward). So the free tier is a
 *   promotional allowance on a commercial aggregator, not an independent
 *   open index.
 *
 *   That distinction matters for two reasons:
 *     1. It is NOT the same compliance problem as scraping a consumer SERP —
 *        reselling a licensed upstream API is legitimate. The earlier
 *        DuckDuckGo scraper was removed precisely because it had no licence.
 *     2. It IS a paid API in the supply chain, which is what the product
 *        decision was to avoid. The free tier is real today and is genuinely
 *        $0, but it is bounded by a DAILY TOKEN allowance, and full-text
 *        extraction spends output tokens. A free tier that resets at 00:00 UTC
 *        is a bounded trial, not a foundation. Treat this as a benchmark
 *        candidate, not a permanent core dependency.
 *
 * GATING — deliberately conservative, per the brief
 *   Requires BOTH `ENABLE_LANGSEARCH=true` AND `LANGSEARCH_API_KEY`. Without
 *   both it reports not-configured and is skipped, so it can never be enabled
 *   by accident, by a stray key, or by a deploy that happens to have the
 *   secret present. It is added to the registry alongside SearXNG and the
 *   open-data providers; it does NOT replace any of them.
 *
 * KEY HANDLING
 *   The key is read from the server-side environment only. This file is a
 *   Convex server module and is never bundled to the browser; there is no
 *   client-facing path that can surface the value. No key is ever placed in a
 *   citation, a log line, or the provider-health snapshot.
 */

const LANGSEARCH_ENDPOINT = "https://api.langsearch.com/v1/web-search";

const UA = "AndromedaSearch/1.0 (Ominnovations Intelligence; temporary federated provider)";

const LANGSEARCH_TIMEOUT_MS = 20_000;

/** Their documented cap is 50; we ask for far less to protect the token budget. */
const MAX_COUNT = 10;

function apiKey(): string | undefined {
  const k = process.env.LANGSEARCH_API_KEY?.trim();
  return k && k.length > 0 ? k : undefined;
}

/**
 * Feature flag. Default OFF. A provider this new, this reseller-shaped, and
 * this quota-bounded must be switched on deliberately, not inherited.
 */
export function isLangSearchEnabled(): boolean {
  return process.env.ENABLE_LANGSEARCH === "true";
}

export function isLangSearchConfigured(): boolean {
  return isLangSearchEnabled() && apiKey() !== undefined;
}

/**
 * Map our recency vocabulary onto LangSearch's `freshness` values.
 * They also accept a single UTC date and an inclusive range, which is what
 * the escalation pass uses when it wants "as of this specific day".
 */
export function toLangSearchFreshness(
  timeRange: "hour" | "day" | "week" | "month" | "year" | undefined,
): string {
  switch (timeRange) {
    case "hour":
      return "oneDay";
    case "day":
      return "oneDay";
    case "week":
      return "oneWeek";
    case "month":
      return "oneMonth";
    case "year":
      return "oneYear";
    default:
      return "noLimit";
  }
}

/**
 * Normalise `datePublished` to an ISO timestamp.
 * Docs say the field may be missing, and that date filtering "uses source
 * metadata, not a guarantee that a page was crawled during that window" —
 * so this is treated as evidence of publication, never of recency of crawl.
 */
export function normalizeDatePublished(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

type LangSearchResponse = {
  data?: {
    webPages?: {
      value?: Array<{
        name?: string;
        url?: string;
        snippet?: string;
        text?: string;
        datePublished?: string;
      }>;
    };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  code?: string;
  message?: string;
};

export function createLangSearchProvider(): SearchProvider {
  return buildProvider(() => isLangSearchConfigured());
}

/**
 * EVALUATION-ONLY factory. Bypasses the feature flag so the internal
 * benchmark can measure whether LangSearch deserves to be enabled.
 *
 * This exists because a benchmark that refuses to measure a candidate until
 * the candidate is enabled can never answer the question "should it be
 * enabled?". The production gate in `createLangSearchProvider` is untouched
 * and stays closed.
 *
 * NOT REGISTERED ANYWHERE. Nothing in the product's provider registry or
 * fan-out may import this; only the internal benchmark action may.
 */
export function createLangSearchEvaluationProvider(): SearchProvider {
  return buildProvider(() => apiKey() !== undefined);
}

function buildProvider(ready: () => boolean): SearchProvider {
  return {
    id: "langsearch",
    label: "LangSearch (temporary, feature-gated)",
    missingKeyHint:
      "Set ENABLE_LANGSEARCH=true and LANGSEARCH_API_KEY to enable. Temporary " +
      "evaluation adapter — it supplements SearXNG and the open-data providers " +
      "and must never be the only search source. See " +
      "docs/PROVIDER_BENCHMARK_RESULTS.md.",
    isConfigured: () => ready(),

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      if (!ready()) {
        throw new Error(
          "langsearch: disabled (needs ENABLE_LANGSEARCH=true and LANGSEARCH_API_KEY)",
        );
      }
      const key = apiKey()!;

      if (opts?.category === "images" || opts?.category === "videos") {
        return { citations: [] };
      }

      const count = Math.max(1, Math.min(MAX_COUNT, numResults));

      const res = await axios.post<LangSearchResponse>(LANGSEARCH_ENDPOINT, {
        query,
        count,
        freshness: toLangSearchFreshness(opts?.timeRange),
        // Full page text is what makes a citation checkable, but it spends
        // output tokens against a DAILY allowance. Bounded, and only when the
        // caller actually wants snippets large enough to matter.
        contents: { text: { maxCharacters: 3000 } },
      }, {
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": UA,
        },
        timeout: LANGSEARCH_TIMEOUT_MS,
      });

      const rows = res.data?.data?.webPages?.value ?? [];
      const citations: WebCitation[] = rows
        .filter((r) => r?.url)
        .map((r) => ({
          title: r.name ?? String(r.url),
          url: String(r.url),
          // Prefer the fuller body; fall back to the snippet. Truncated to keep
          // prompt size sane — the full text stays retrievable at the URL.
          snippet: (r.text ?? r.snippet ?? "").slice(0, 2000) || undefined,
          publishedAt: normalizeDatePublished(r.datePublished),
          providers: ["langsearch"],
        }));

      return { citations };
    },
  };
}
