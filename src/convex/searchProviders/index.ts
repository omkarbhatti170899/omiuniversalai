import {
  createExaProvider,
  MissingKeyError,
  type SearchProvider,
} from "./exa";
import { createTavilyProvider } from "./tavily";
import { createWikipediaProvider } from "./wikipedia";
import { createKeylessProvider } from "./keyless";

export type { WebCitation } from "./exa";

/**
 * Registered providers, in priority order. The orchestrator (search.ts)
 * tries each configured provider in this order and uses the first that
 * succeeds — so a rate-limited or failing engine never breaks Omi Search.
 *
 * To add another provider later (e.g. Brave), implement SearchProvider in
 * a new file and add it here — the rest of the app is untouched.
 * The keyless provider is always last as a never-dead fallback.
 */
const REGISTRY: SearchProvider[] = [
  createTavilyProvider(),
  createExaProvider(),
  createWikipediaProvider(),
  createKeylessProvider(),
];

export function getConfiguredProviders(): SearchProvider[] {
  return REGISTRY.filter((p) => p.isConfigured());
}

export function getActiveProvider(): SearchProvider | null {
  return getConfiguredProviders()[0] ?? null;
}

export function getProviderStatus() {
  return {
    providers: REGISTRY.map((p) => ({
      id: p.id,
      label: p.label,
      configured: p.isConfigured(),
      hint: p.missingKeyHint,
    })),
    activeId: getActiveProvider()?.id ?? null,
  };
}

export { MissingKeyError };
