import { type SearchProvider } from "./types";
import { createSearxProvider, searxngHealth, searxngHealthCached } from "./searxng";
import { createMwmblProvider } from "./mwmbl";
import { createDuckDuckGoInstantProvider } from "./duckduckgoInstant";
import { createLangSearchProvider } from "./langsearch";
import { createWikipediaProvider } from "./wikipedia";
import { createWikidataProvider } from "./wikidata";
import { createArxivProvider } from "./arxiv";
import { createOpenAlexProvider } from "./openalex";
import { createOpenLibraryProvider } from "./openlibrary";
import { createHackerNewsProvider } from "./hackernews";
import { createOpenverseProvider } from "./openverse";
import { createCommonCrawlProvider } from "./commoncrawl";
import { createGitHubProvider } from "./github";
import { createGdeltProvider } from "./gdelt";
import { createOpenMeteoProvider } from "./openmeteo";
import { createWikipediaCurrentEventsProvider } from "./wikipediaCurrentEvents";
import { createMarketRatesProvider } from "./markets";
import { createSportsProvider } from "./sports";

export type {
  WebCitation,
  SearchOptions,
  SearchProvider,
  SearchProviderResult,
} from "./types";
export { MissingKeyError } from "./types";
export { fetchPageText, type ExtractedPage } from "./pageFetcher";

export type ProviderInfo = {
  id: string;
  label: string;
  configured: boolean;
  hint: string;
};

export type ProviderStatus = {
  id: string;
  label: string;
  /** Ready to serve right now (configured). */
  ready: boolean;
  /** Always-on vs optional. */
  enabled: boolean;
  /** Cost transparency: all registered providers are free per-search. */
  cost: string;
  /** Requires an env key to be useful? */
  requiresKey: boolean;
  hint: string;
};

/**
 * Registered Andromeda sources (master plan §5), in priority order.
 *
 * All keyless, all $0 per query, all free/open APIs:
 *   SearXNG      — self-hosted metasearch floor (SEARXNG_BASE_URL optional;
 *                  public instances used until configured)
 *   Wikipedia    — encyclopedic entities and stable facts
 *   Wikidata     — CC0 structured knowledge graph (Freebase successor)
 *   arXiv        — scientific/technical papers (spec §5 knowledge/research)
 *   OpenAlex     — 250M+ scholarly works across all disciplines
 *   Open Library — open book catalog (Internet Archive)
 *   Hacker News  — practitioner/tech signal (keyless Algolia API)
 *   Openverse    — openly-licensed images (image-category specialist)
 *   Common Crawl — open web index metadata (AWS open data; provenance/diversity)
 *   GitHub       — public repository search, tech queries only (keyless 10/min)
 *   GDELT        — global news index (scope-gated to news-phrased queries)
 *   Wikipedia Current Events — today's dated news, keyless, the reliable
 *                  current-events floor when the general-web floor is unavailable
 *   Open-Meteo   — weather/structured open data (scope-gated, CC-BY attribution)
 *   Market rates — live FX (scope-gated, not financial advice)
 *   Sports DB    — live scorelines (scope-gated to the sports vertical)
 *   Mwmbl        — free, AGPL, non-profit, OWN index, official keyless API
 *   DDG Instant  — official keyless API, encyclopedic entities
 *   LangSearch   — TEMPORARY evaluation adapter, OFF by default. Gated on
 *                  ENABLE_LANGSEARCH=true AND LANGSEARCH_API_KEY. It is a
 *                  RESELLER (its pricing page publishes upstream Tavily/Exa/
 *                  Brave rates), not an independent index, and its free tier
 *                  is bounded by a daily token allowance. Added to be
 *                  BENCHMARKED, never to be a sole dependency.
 *
 * TWO PROVIDERS THAT DELIBERATELY RETURN NO DATES: Mwmbl and DuckDuckGo
 * Instant Answers. Both were measured live on 2026-09-27 and neither includes
 * a publication or update timestamp anywhere in its payload. They are therefore
 * registered for general/knowledge breadth but are ABSENT from every freshness
 * tier's `preferredProviders`. An undated source is not evidence of recency,
 * and letting one into a "latest news" turn is precisely the bug class the
 * freshness engine exists to prevent.
 *
 * DuckDuckGo note: this is the OFFICIAL API (api.duckduckgo.com), keyless and
 * documented, so it is permitted. It is NOT a web search engine — measured,
 * it returns an encyclopedic abstract for entity questions and *nothing at all*
 * for real search queries. The earlier consumer-SERP scrape of
 * html.duckduckgo.com with a spoofed User-Agent was removed as non-compliant.
 *
 * GENERAL-WEB STRATEGY (2026-09-27, revised) — deliberately free/open.
 * A paid general-web API (Brave $5/1000, Mojeek ~$5/1000) is NOT acceptable
 * as a dependency of the core search path, so none is registered. The honest
 * position is that general-web coverage is currently thin, and that is the
 * accepted cost until Andromeda has its own index. See
 * docs/ANDROMEDA_PROVIDER_CAPABILITY_MATRIX.md for the full evidence.
 *
 * Evaluated and rejected on licence/compliance grounds, recorded so the
 * reasoning survives:
 *   ⛔ DuckDuckGo — no official API; scraping a consumer SERP with a spoofed
 *      User-Agent, and measured to return zero results. Removed.
 *   ⛔ Qwant     — no official API; requires a reverse-engineered DataDome
 *      anti-bot cookie. Bot-protection bypass. Never.
 *   ⛔ Baidu     — no general web-search API at all.
 *   ⛔ OpenSERP  — free and self-hostable, but it scrapes Google, Bing, Yandex,
 *      Baidu, DuckDuckGo and Ecosia. Self-hosting does not make that compliant;
 *      it puts us in direct breach of six engines instead of one.
 *   ⛔ Marginalia — free tier is CC-BY-NC-SA 4.0 (**NonCommercial**). Omi is a
 *      commercial product, so the free tier is not usable regardless of price.
 *   🟡 Mwmbl    — free, independent, AGPL. But it supports no time range,
 *      language or region, which is structurally incompatible with a
 *      freshness-first engine. Kept as a SearXNG engine, not a direct adapter.
 *
 * So: general web is served by self-hosted SearXNG restricted to compliant
 * engines, and the freshness-critical verticals are carried by the specialized
 * open-data providers above, which do that job better than general web search
 * would anyway. Long-term, the fix for general-web depth is our own crawler
 * and index (Phase 6), not another free proxy.
 *
 * REMOVED — DuckDuckGo (2026-09-27, compliance). The previous general-web
 * fallback POSTed to `https://html.duckduckgo.com/html/` with a spoofed
 * browser User-Agent. DuckDuckGo publishes no search API, so that is scraping
 * a consumer results page while defeating bot protection — forbidden by the
 * project's own rule ("do NOT scrape consumer search-result pages unless
 * explicitly permitted"). It was ALSO dead weight: measured twice on
 * 2026-09-26, it answers HTTP 202 with an "anomaly"/"challenge" body and zero
 * result links, so it could never return a result. Removing it cost no
 * functionality and removed the only place we broke that rule. Mojeek
 * replaces it as the general-web floor.
 *
 * MEASURED 2026-09-26 against the live endpoints: the general-web floor is NOT
 * reliable. All four public SearXNG instances answer HTTP 200 with an HTML body
 * (their JSON format is disabled by default). SearXNG readiness is therefore
 * reported from a real reachability probe rather than a hardcoded `true`, and
 * current-information questions route to sources that genuinely carry dates.
 * See searxng.ts. Set SEARXNG_BASE_URL to fix the general-web floor.
 *
 * This is the §3 rule in code: a provider that exists in the registry is not
 * evidence that it works. Readiness is measured, cached, and reported.
 *
 * Every source runs in parallel under Promise.allSettled in the orchestrator
 * (universalSearch.ts) with its own timeout and error isolation — a slow or
 * failed source never blocks Andromeda. No metered API (Exa, Tavily, Brave,
 * OpenAI) is registered, so the search layer stays 100% free per-search.
 * To add another free/open source, implement SearchProvider in a new file
 * and register it here — no other call site changes.
 */
const REGISTRY: SearchProvider[] = [
  createSearxProvider(),
  createWikipediaCurrentEventsProvider(),
  createWikipediaProvider(),
  createWikidataProvider(),
  createArxivProvider(),
  createOpenAlexProvider(),
  createOpenLibraryProvider(),
  createHackerNewsProvider(),
  createOpenverseProvider(),
  createCommonCrawlProvider(),
  createGitHubProvider(),
  createGdeltProvider(),
  createOpenMeteoProvider(),
  createMarketRatesProvider(),
  createSportsProvider(),
  createMwmblProvider(),
  createDuckDuckGoInstantProvider(),
  // Feature-gated and off by default; never a replacement for anything.
  createLangSearchProvider(),
];

export function getConfiguredProviders(): SearchProvider[] {
  return REGISTRY.filter((p) => p.isConfigured());
}

export function getActiveProvider(): SearchProvider | null {
  return getConfiguredProviders()[0] ?? null;
}

/**
 * Full status incl. cost transparency (master spec §31/§32):
 * every registered Andromeda source is a free/open keyless API — $0 per
 * query, no account, no quota purchase. Paid providers are simply not
 * registered at all, so none can be silently enabled. Openverse's honest
 * note: anonymous access is rate-limited by the upstream API (still free).
 */
/**
 * Measure the general-web provider (the one that was previously reporting
 * itself ready without ever being reachable) and warm its cache. Cheap: one
 * request, cached, and callers (the /status and /selftest surfaces) are rare.
 * Never throws.
 */
export async function warmGeneralWebHealth(): Promise<void> {
  await Promise.allSettled([searxngHealth()]);
}

export function getProviderStatus(): ProviderStatus[] {
  return REGISTRY.map((p) => ({
    id: p.id,
    label: p.label,
    // SearXNG readiness is MEASURED, never inferred: a configured base URL is
    // not evidence that the instance serves JSON (the user's requested
    // searx.tiekoetter.com answers 403). The probe cache is warmed before this
    // snapshot is built (see /status → warmGeneralWebHealth).
    ready: p.id === "searxng" ? (searxngHealthCached()?.healthy ?? false) : p.isConfigured(),
    enabled: true,
    cost: PROVIDER_COST[idOf(p)] ?? "$0 per query",
    // MEASURED GAP FIXED: this used to be hardcoded to SearXNG, so a
    // key-gated provider reported requiresKey:false in the status surface —
    // telling an operator a provider needed no credentials when it plainly
    // does. It is now derived per provider.
    requiresKey: KEYED_PROVIDER_IDS.has(idOf(p)),
    hint: p.missingKeyHint,
  }));
}

function idOf(p: SearchProvider): string {
  return p.id;
}

/**
 * Per-provider cost statements. Kept honest rather than uniformly "$0":
 * a status page that says "free" for a provider with a daily token
 * allowance and published paid tiers is not being truthful, even if today's
 * usage happens to cost nothing.
 */
const PROVIDER_COST: Record<string, string> = {
  openverse: "$0 (anonymous, upstream rate-limited)",
  langsearch:
    "$0 on the free plan — but bounded by a daily token allowance, and it " +
    "resells Tavily/Exa/Brave (paid tiers exist). Temporary evaluation only.",
  searxng: "$0 (self-hosted)",
  mwmbl: "$0 (keyless, open source)",
  "duckduckgo-instant": "$0 (keyless, official API)",
};

/** Providers that cannot serve without a credential of some kind. */
const KEYED_PROVIDER_IDS = new Set(["searxng", "langsearch"]);
