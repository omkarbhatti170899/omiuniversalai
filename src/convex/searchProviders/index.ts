import { type SearchProvider } from "./types";
import { createSearxProvider, searxngHealth } from "./searxng";
import { createKeylessProvider, duckduckgoHealthCached } from "./keyless";
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
 *   DuckDuckGo   — keyless last-resort web floor
 *
 * MEASURED 2026-09-26 against the live endpoints: the general-web floor is NOT
 * reliable. All four public SearXNG instances answer HTTP 200 with an HTML body
 * (their JSON format is disabled by default), and DuckDuckGo's keyless endpoint
 * answers HTTP 202 with an "anomaly"/"challenge" body and zero results — twice,
 * reproducibly. Both are therefore reported as `ready: false` from a real
 * reachability probe rather than a hardcoded `true`, and current-information
 * questions route to sources that genuinely carry dates. See searxng.ts and
 * keyless.ts. Set SEARXNG_BASE_URL to fix the general-web floor.
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
  createKeylessProvider(),
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
 * Measure the two general-web providers (the ones that were previously
 * reporting themselves ready without ever being reachable) and warm their
 * caches. Cheap: each is one request, both are cached for 5-10 minutes, and
 * callers (the /status and /selftest surfaces) are rare. Never throws.
 */
export async function warmGeneralWebHealth(): Promise<void> {
  await Promise.allSettled([searxngHealth(), duckduckgoHealthCached()]);
}

export function getProviderStatus(): ProviderStatus[] {
  return REGISTRY.map((p) => ({
    id: p.id,
    label: p.label,
    ready: p.isConfigured(),
    enabled: true,
    cost:
      p.id === "openverse"
        ? "$0 (anonymous, upstream rate-limited)"
        : "$0 per query",
    requiresKey: p.id === "searxng" && !process.env.SEARXNG_BASE_URL,
    hint: p.missingKeyHint,
  }));
}
