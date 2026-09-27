/**
 * REGRESSION — PROVIDER POLICY: free/open only, and no scraping.
 * =========================================================================
 *
 * This is now a POLICY test, not a snapshot test. It exists to stop two
 * specific regressions from ever coming back:
 *
 *   1. A PAID general-web API becoming a dependency of the core search path.
 *      Brave (~$5/1000) and Mojeek (~$5/1000) were both evaluated and
 *      deliberately NOT adopted — the product is free-first, and a metered
 *      bill on the query path is not an acceptable foundation.
 *
 *   2. A SCRAPER being added as a "free" provider. That is the failure that
 *      actually happened twice:
 *        • DuckDuckGo — no official API; we scraped the no-JS consumer
 *          endpoint with a spoofed browser User-Agent. Measured to return
 *          zero results anyway. Removed.
 *        • OpenSERP — free and self-hostable, but it scrapes Google, Bing,
 *          Yandex, Baidu, DuckDuckGo and Ecosia. Self-hosting does not make
 *          that compliant; it puts us in direct breach of six engines
 *          instead of one.
 *
 * And one licensing trap, which is the subtler of the three:
 *        • Marginalia — free, but the free tier is CC-BY-NC-SA 4.0, i.e.
 *          NON-COMMERCIAL. Omi is a commercial product, so "free" does not
 *          mean "usable". Price was never the blocker; the licence was.
 *
 * Full evidence: docs/ANDROMEDA_PROVIDER_CAPABILITY_MATRIX.md
 */

import { describe, expect, it } from "bun:test";
import { getProviderStatus } from "../src/convex/searchProviders";
import { freshnessPolicyFor } from "../src/convex/searchEngine/freshness";
import { decideSearch } from "../src/convex/searchEngine/decision";

const ALL_PROVIDER_IDS = getProviderStatus().map((p) => p.id);

/** Providers that must never appear: paid, or licence/compliance-blocked. */
const FORBIDDEN = {
  paid: ["brave", "mojeek", "kagi", "exa", "tavily", "serpapi", "serper"],
  scrapers: ["duckduckgo", "openserp", "qwant", "baidu-scrape"],
  nonCommercialLicence: ["marginalia"],
} as const;

describe("provider policy — the core search path is free/open", () => {
  for (const id of FORBIDDEN.paid) {
    it(`does NOT register the paid provider "${id}"`, () => {
      expect(ALL_PROVIDER_IDS).not.toContain(id);
    });
  }

  for (const id of FORBIDDEN.scrapers) {
    it(`does NOT register the scraper "${id}"`, () => {
      expect(ALL_PROVIDER_IDS).not.toContain(id);
    });
  }

  for (const id of FORBIDDEN.nonCommercialLicence) {
    it(`does NOT register the non-commercial-only provider "${id}"`, () => {
      expect(ALL_PROVIDER_IDS).not.toContain(id);
    });
  }

  it("no registered provider reports a paid cost", () => {
    // Every registered source must be free/open. A metered provider that
    // slipped into the registry would show up here as a cost note.
    for (const p of getProviderStatus()) {
      expect(p.cost).toMatch(/\$0/);
    }
  });

  it("no provider is configured via a commercial API key", () => {
    // Guard against reintroducing a metered key path.
    for (const p of getProviderStatus()) {
      const hint = p.hint ?? "";
      expect(hint).not.toMatch(/BRAVE_API_KEY|MOJEEK_API_KEY|SERP|TAVILY|EXA_API/i);
    }
  });
});

describe("provider policy — nothing routes to a removed provider", () => {
  const QUERIES = [
    "latest AI news",
    "What is India's medal tally in Asian Games 2026?",
    "latest election results",
    "current USD INR rate",
    "what is the weather in Mumbai",
    "live sports score",
    "latest flight status",
    "Tell me a joke",
  ];

  const REMOVED = [
    "duckduckgo",
    "mojeek",
    "brave",
    "marginalia",
    "openserp",
    "qwant",
  ];

  for (const id of REMOVED) {
    it(`"${id}" appears in no vertical's routing`, () => {
      for (const q of QUERIES) {
        const policy = freshnessPolicyFor(q, decideSearch(q).intent);
        expect(policy.preferredProviders).not.toContain(id);
      }
    });
  }
});

describe("provider policy — the surviving general-web floor is compliant", () => {
  it("serves general web through SearXNG, which is self-hostable and curated", () => {
    const policy = freshnessPolicyFor(
      "latest AI news",
      decideSearch("latest AI news").intent,
    );
    // SearXNG is the aggregation layer, not a scraper in itself — its
    // compliance comes from the curated engine list in
    // docs/SEARXNG_SELF_HOST_PLAN.md, which disables google/bing/ddg/startpage.
    expect(policy.preferredProviders).toContain("searxng");
  });

  it("the freshness-critical verticals are carried by open data providers", () => {
    // These do current information better than general web search would, and
    // they are free/open — which is why the free-only policy is survivable.
    const news = freshnessPolicyFor("latest AI news", decideSearch("latest AI news").intent);
    expect(news.preferredProviders).toContain("gdelt");
    expect(news.preferredProviders).toContain("wikipedia-current-events");
  });
});
