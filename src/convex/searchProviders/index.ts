import { type SearchProvider } from "./types";
import { createSearxProvider, searxngHealth, searxngHealthCached } from "./searxng";
import { createMojeekProvider } from "./mojeek";
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
 *   Mojeek       — independent crawler + own index, official API, explicit
 *                  "AI Usage" right. The first FEDERATED general-web engine:
 *                  it is not a Google wrapper, so it adds genuine ecosystem
 *                  independence. Needs a MOJEEK_API_KEY; reports not-ready
 *                  until one is supplied.
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
  createMojeekProvider(),
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
    cost:
      p.id === "openverse"
        ? "$0 (anonymous, upstream rate-limited)"
        : "$0 per query",
    requiresKey: p.id === "searxng" && !process.env.SEARXNG_BASE_URL,
    hint: p.missingKeyHint,
  }));
}
