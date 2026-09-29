/**
 * Shared contracts for Omi's provider-independent search layer.
 *
 * Any search source — self-hosted SearXNG, Wikipedia, a future free/open
 * engine — implements SearchProvider and returns normalized WebCitations.
 * The rest of the app never knows which engine served a given query.
 */

export type WebCitation = {
  title: string;
  url: string;
  snippet?: string;
  /** Thumbnail/image URL (images and video results). */
  imageUrl?: string;
  /** Publication date when the source provides one (news results). */
  publishedAt?: string;
  /** Provenance (spec §8/§29): which Andromeda sources surfaced this result. */
  providers?: string[];
  /** Andromeda relevance score (0..1), assigned during merge/ranking. */
  relevance?: number;
  /**
   * Per-component ranking breakdown (2026-09-29 quality layer): relevance,
   * freshness, authority, sourceQuality, directness, corroboration, final.
   * Persisted so the benchmark and UI can show WHY a source ranked where it
   * did without recomputing it.
   */
  scoreBreakdown?: import("../searchEngine/quality").ScoreBreakdown;
  /** Author when the source provides one (papers, books, HN). */
  author?: string;
};

/**
 * Optional filters a provider may honor. SearXNG supports all of them;
 * simpler providers safely ignore what they don't support.
 */
export type SearchOptions = {
  /** general | news | images | videos | science | it | files | music */
  category?: string;
  /**
   * The freshness vertical the caller classified the query into
   * ("weather" | "sports" | "markets" | …). Carried so the orchestrator can
   * pick an honest general-web backstop when the vertical's structured feed
   * is down, instead of failing the whole search (measured defect, 2026-09-28).
   */
  verticalName?: string;
  /** e.g. "en", "de", "all" */
  language?: string;
  /**
   * Recency window requested by the user. "hour" was added for explicit
   * "news from the last hour" requests; providers that cannot honour it map it
   * to their nearest supported window and the result is still date-checked by
   * the caller, so a narrower request is never silently widened.
   */
  timeRange?: "hour" | "day" | "week" | "month" | "year";
  /** 0 = off, 1 = moderate, 2 = strict (SearXNG; others ignore). */
  safeSearch?: number;
  /** 1-based result page. */
  page?: number;
};

export type SearchProviderResult = {
  citations: WebCitation[];
};
export type SearchProvider = {
  id: string;
  label: string;
  /** True when the provider is ready to serve searches. */
  isConfigured: () => boolean;
  /** Human-facing setup hint when the provider is not configured. */
  missingKeyHint: string;
  search: (
    query: string,
    numResults: number,
    opts?: SearchOptions,
  ) => Promise<SearchProviderResult>;
};

/**
 * Thrown by a provider that requires configuration which is missing.
 * The orchestrator treats it as "this source unavailable; try next".
 *
 * READ THE CONTRACT BEFORE USING THIS CLASS. "Not configured" means a
 * credential or an instance URL is absent — a SETUP task for an operator. It
 * does not mean "returned nothing", "timed out", or "upstream returned 4xx";
 * those are availability conditions with completely different fixes.
 */
export class MissingKeyError extends Error {
  constructor(providerId: string) {
    super(`Search provider "${providerId}" is not configured.`);
    this.name = "MissingKeyError";
  }
}

/**
 * Thrown by a provider that IS configured and WAS called, but could not serve
 * the request — an upstream failure, not a missing credential.
 *
 * MEASURED DEFECT this replaces (search-quality benchmark, 2026-09-28): EIGHT
 * providers threw `MissingKeyError` for conditions that have nothing to do with
 * configuration. Because the message is composed as
 * `Search provider "<id>" is not configured.`, a user (and the benchmark) saw:
 *
 *   Search provider "openmeteo: Request failed with status code 429" is not configured.
 *   Search provider "hackernews" is not configured.        // keyless, and empty
 *   Search provider "arxiv" is not configured.             // keyless, and empty
 *
 * Every one of those sends an operator looking for a credential that does not
 * exist, while the real causes were upstream rate limiting, an upstream 5xx,
 * and an ordinary empty result set. A wrong diagnosis is worse than no
 * diagnosis: it costs the debugging time AND hides the true failure.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
