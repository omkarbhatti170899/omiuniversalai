import axios from "axios";
import {
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

/**
 * DuckDuckGo Instant Answers — OFFICIAL, keyless, permitted.
 * =========================================================================
 *
 * This is the answer to "is there a legitimate DuckDuckGo integration?" and
 * the answer is genuinely YES — but not in the way anyone expects.
 *
 * WHAT THIS IS
 *   DuckDuckGo publishes a documented, keyless, free JSON API at
 *   `api.duckduckgo.com`. It requires no key, no account, and no scraping. It
 *   is explicitly offered for integration, so using it is permitted. (The
 *   project previously scraped `html.duckduckgo.com/html/` with a spoofed
 *   User-Agent instead — that was a consumer-results-page scrape with no
 *   permission, and it has been removed. See the removal note in
 *   searchProviders/index.ts.)
 *
 * WHAT IT IS NOT — and this is the part that matters
 *   It is **not a web search engine.** It serves "Instant Answers":
 *   encyclopedia-style entities — definitions, abstracts, disambiguation,
 *   related topics — keyed off DuckDuckGo's knowledge graph.
 *
 *   MEASURED 2026-09-27, live:
 *     q="climate change"  → an Abstract sourced from Wikipedia + RelatedTopics
 *     q="best crm software" → Abstract empty, RelatedTopics 0, Results 0
 *
 *   So for a real search question it returns NOTHING. Wiring it in as a
 *   "general web" provider would be a category error that looks like a
 *   working provider in every status surface while silently returning nothing.
 *
 * WHERE IT IS HONESTLY USEFUL
 *   Short, entity-shaped questions — "who is Ada Lovelace", "what is
 *   photosynthesis", "capital of Peru" — where a citable encyclopedic source
 *   is a better answer than a pile of web results. It is a SUPPLEMENT to
 *   Wikipedia, not a replacement for a web index.
 *
 * It returns NO publication dates, so like Mwmbl it is excluded from the
 * freshness tiers: an undated abstract is not evidence of recency.
 */

const DDG_IA_ENDPOINT = "https://api.duckduckgo.com/";

const UA = "AndromedaSearch/1.0 (Ominnovations Intelligence; DuckDuckGo Instant Answers)";

const DDG_TIMEOUT_MS = 10_000;

type DdgRelated = {
  FirstURL?: string;
  Text?: string;
  Result?: string;
  Topics?: DdgRelated[];
};

type DdgResponse = {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  Definition?: string;
  DefinitionURL?: string;
  DefinitionSource?: string;
  Answer?: string;
  RelatedTopics?: DdgRelated[];
  Results?: Array<{ FirstURL?: string; Result?: string }>;
};

/** Strip the HTML anchors DuckDuckGo embeds in `Result`/`Text`. */
function stripHtml(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function collectTopics(
  topics: DdgRelated[] | undefined,
  out: Array<{ url: string; title: string }>,
  depth = 0,
): void {
  if (!Array.isArray(topics) || depth > 2) return;
  for (const t of topics) {
    if (t?.FirstURL && t?.Text) {
      out.push({ url: t.FirstURL, title: stripHtml(t.Text) });
    }
    if (Array.isArray(t?.Topics)) collectTopics(t.Topics, out, depth + 1);
  }
}

/**
 * Strip DuckDuckGo's internal redirect links to the real destination.
 * These are `duckduckgo.com/l/?uddg=<urlencoded>`; keeping them would make
 * every citation point at DDG rather than at the source.
 */
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith("duckduckgo.com")) {
      const target = u.searchParams.get("uddg");
      if (target) return target;
    }
    return raw;
  } catch {
    return raw;
  }
}

export function createDuckDuckGoInstantProvider(): SearchProvider {
  return {
    id: "duckduckgo-instant",
    label: "DuckDuckGo Instant Answers (official, keyless)",
    // No key exists. The hint states the real limitation — this is an entity
    // lookup, not web search — so nobody wires it in expecting a web index.
    missingKeyHint:
      "Always available — the official API is keyless. Note: Instant Answers " +
      "returns encyclopedic entities, NOT web results, and carries no dates.",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      if (opts?.category === "images" || opts?.category === "videos") {
        return { citations: [] };
      }

      const res = await axios.get<DdgResponse>(DDG_IA_ENDPOINT, {
        params: { q: query, format: "json", no_html: 1, skip_disambig: 0 },
        headers: { "User-Agent": UA },
        timeout: DDG_TIMEOUT_MS,
      });

      const d = res.data ?? {};
      const citations: Array<{
        title: string;
        url: string;
        snippet?: string;
        providers: string[];
      }> = [];

      const heading = d.Heading?.trim() || query;

      // 1) The abstract is the highest-quality item: a sourced encyclopedic
      //    paragraph, exactly the shape of evidence a factual answer wants.
      if (d.AbstractText && d.AbstractURL) {
        citations.push({
          title: `${heading} — ${d.AbstractSource ?? "DuckDuckGo"}`,
          url: cleanUrl(d.AbstractURL),
          snippet: stripHtml(d.AbstractText),
          providers: ["duckduckgo-instant"],
        });
      }

      // 2) A direct answer (calculations, conversions, definitions) is even
      //    more precise than an abstract when present.
      if (d.Answer) {
        citations.push({
          title: `${heading} (direct answer)`,
          url: cleanUrl(d.AbstractURL ?? `https://duckduckgo.com/?q=${encodeURIComponent(query)}`),
          snippet: stripHtml(d.Answer),
          providers: ["duckduckgo-instant"],
        });
      }

      // 3) The definition field, when the abstract is absent.
      if (d.Definition && d.DefinitionURL) {
        citations.push({
          title: `${heading} — definition`,
          url: cleanUrl(d.DefinitionURL),
          snippet: stripHtml(d.Definition),
          providers: ["duckduckgo-instant"],
        });
      }

      // 4) Related topics, as weaker supporting evidence.
      const related: Array<{ url: string; title: string }> = [];
      collectTopics(d.RelatedTopics, related);
      for (const t of related) {
        if (citations.length >= numResults) break;
        citations.push({
          title: t.title,
          url: cleanUrl(t.url),
          providers: ["duckduckgo-instant"],
        });
      }

      // NOTE: no `publishedAt` on any of these. Measured: Instant Answers carry
      // no date. This provider is excluded from the freshness tiers.
      return { citations: citations.slice(0, numResults) };
    },
  };
}

export const DUCK_DUCK_GO_INSTANT_RETURNS_TIMESTAMPS = false;
