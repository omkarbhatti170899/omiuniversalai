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
  /** e.g. "en", "de", "all" */
  language?: string;
  timeRange?: "day" | "week" | "month" | "year";
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
 */
export class MissingKeyError extends Error {
  constructor(providerId: string) {
    super(`Search provider "${providerId}" is not configured.`);
    this.name = "MissingKeyError";
  }
}
