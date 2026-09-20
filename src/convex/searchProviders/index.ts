import { type SearchProvider } from "./types";
import { createSearxProvider } from "./searxng";
import { createWikipediaProvider } from "./wikipedia";
import { createKeylessProvider } from "./keyless";

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
 * Registered search sources, in priority order.
 *
 * PRIMARY: SearXNG (self-hosted metasearch — zero per-search cost).
 *   Point it at your own instance with SEARXNG_BASE_URL; until then it
 *   tries public SearXNG instances automatically.
 * FALLBACKS: Wikipedia and DuckDuckGo (both keyless, zero cost) keep
 *   Omi Search alive if SearXNG is unreachable.
 *
 * No metered APIs (Exa, Tavily, Brave, OpenAI) are registered — the
 * search layer is 100% free per-search. To add another free/open source
 * later, implement SearchProvider in a new file and add it here.
 */
const REGISTRY: SearchProvider[] = [
  createSearxProvider(),
  createWikipediaProvider(),
  createKeylessProvider(),
];

export function getConfiguredProviders(): SearchProvider[] {
  return REGISTRY.filter((p) => p.isConfigured());
}

export function getActiveProvider(): SearchProvider | null {
  return getConfiguredProviders()[0] ?? null;
}

/**
 * Full status incl. cost transparency (master spec §32):
 * every registered provider is $0 per query; paid providers are simply
 * not registered at all, so none can be silently enabled.
 */
export function getProviderStatus(): ProviderStatus[] {
  return REGISTRY.map((p) => ({
    id: p.id,
    label: p.label,
    ready: p.isConfigured(),
    enabled: true,
    cost: "$0 per query",
    requiresKey: p.id === "searxng" && !process.env.SEARXNG_BASE_URL,
    hint: p.missingKeyHint,
  }));
}
