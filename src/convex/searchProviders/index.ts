import {
  createExaProvider,
  MissingKeyError,
  type SearchProvider,
} from "./exa";

export type { WebCitation } from "./exa";

/**
 * Registered providers, in priority order. To add another web-search
 * provider later (e.g. Brave, Tavily), implement SearchProvider in a new
 * file and add it here — the rest of the app is untouched.
 */
const REGISTRY: SearchProvider[] = [createExaProvider()];

export function getActiveProvider(): SearchProvider | null {
  return REGISTRY.find((p) => p.isConfigured()) ?? null;
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
