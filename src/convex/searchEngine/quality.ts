/**
 * Source quality engine (spec §12/§13): URL normalization, domain
 * authority tiers, freshness scoring, completeness, relevance, and
 * syndicated-content dedupe. Preference order:
 *   official/government → academic → reference → reputable news → general → low
 */

import type { WebCitation } from "../searchProviders/types";

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()];
    for (const k of params) {
      if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
    }
    u.hash = "";
    return (
      u.origin +
      u.pathname.replace(/\/+$/, "") +
      (u.searchParams.toString() ? `?${u.searchParams.toString()}` : "")
    );
  } catch {
    return url;
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}

export type SourceTier =
  | "official"
  | "academic"
  | "reference"
  | "news"
  | "general"
  | "low";

const ACADEMIC_RE =
  /(\.edu|\.ac\.[a-z]{2})(:|$)|arxiv\.org|openalex\.org|nature\.com|science\.org|ieeexplore\.ieee\.org|springer\.com|sciencedirect\.com|ncbi\.nlm\.nih\.gov|jstor\.org|pubsonline\.acs\.org|semanticscholar\.org/;
const REFERENCE_RE =
  /(^|\.)wikipedia\.org$|openlibrary\.org$|britannica\.com$|developer\.mozilla\.org$|w3\.org$|stanford\.encyclopedia/;
const NEWS_RE =
  /(^|\.)reuters\.com$|(^|\.)apnews\.com$|(^|\.)bbc\.(com|co\.uk)$|nytimes\.com$|theguardian\.com$|bloomberg\.com$|ft\.com$|economist\.com$|npr\.org$|aljazeera\.com$|cnn\.com$|wsj\.com$|cnbc\.com$|dw\.com$|lemonde\.fr$|spiegel\.de$/;
const LOW_RE =
  /pinterest\.[a-z.]+$|quora\.com$|answers\.com$|ehow\.com$|ask\.com$|slideshare\.net$|scribd\.com$|coursehero\.com$/;
const OFFICIAL_HINT_RE = /^(docs?|developer|developers|api|support)\./;

export function sourceTier(url: string): { tier: SourceTier; weight: number } {
  const d = domainOf(url);
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    path = "";
  }
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(d) || d.endsWith(".europa.eu") || d === "who.int" || d.endsWith(".who.int") || d === "un.org") {
    return { tier: "official", weight: 1.0 };
  }
  if (ACADEMIC_RE.test(d)) return { tier: "academic", weight: 0.95 };
  if (OFFICIAL_HINT_RE.test(d) || /\/docs?(\/|$)/.test(path) || REFERENCE_RE.test(d)) {
    return { tier: "reference", weight: 0.9 };
  }
  if (NEWS_RE.test(d)) return { tier: "news", weight: 0.85 };
  if (LOW_RE.test(d)) return { tier: "low", weight: 0.4 };
  return { tier: "general", weight: 0.6 };
}

/** 0..1 — how fresh the source is; unknown dates score neutral 0.4. */
export function freshnessScore(publishedAt: string | undefined, now = Date.now()): number {
  if (!publishedAt) return 0.4;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 0.4;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  if (ageDays <= 1) return 1;
  if (ageDays <= 7) return 0.9;
  if (ageDays <= 30) return 0.75;
  if (ageDays <= 180) return 0.55;
  if (ageDays <= 365) return 0.4;
  return 0.25;
}

/** 0..1 — how much usable content the citation carries. */
export function completenessScore(c: WebCitation): number {
  const len = c.snippet?.length ?? 0;
  let s = len >= 500 ? 1 : len >= 220 ? 0.8 : len >= 80 ? 0.55 : 0.3;
  if (c.imageUrl) s = Math.min(1, s + 0.05);
  return s;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "how", "in", "is", "it", "its", "of", "on", "or", "that", "the", "to", "was",
  "what", "when", "where", "which", "who", "why", "will", "with", "do", "does",
  "did", "can", "could", "should", "would", "me", "my", "your", "you", "i",
]);

export function keywordSet(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export function relevanceScore(c: WebCitation, keywords: string[]): number {
  const hay = `${c.title} ${c.snippet ?? ""}`.toLowerCase();
  if (keywords.length === 0) return 0.5;
  let hits = 0;
  for (const k of keywords) if (hay.includes(k)) hits += 1;
  return hits / keywords.length;
}

/**
 * Blended source score (0..1): relevance dominates; authority, freshness
 * (weighted up when the request is freshness-sensitive), and completeness
 * contribute per spec §12.
 */
export function scoreSource(
  c: WebCitation,
  keywords: string[],
  opts: { freshnessMatters?: boolean } = {},
): number {
  const rel = relevanceScore(c, keywords);
  const tier = sourceTier(c.url).weight;
  const fresh = freshnessScore(c.publishedAt);
  const comp = completenessScore(c);
  const freshW = opts.freshnessMatters ? 0.18 : 0.06;
  const rest = 1 - 0.5 - 0.18 - freshW - 0.12;
  return 0.5 * rel + 0.18 * tier + freshW * fresh + 0.12 * comp + rest;
}

function titleKey(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/);
  return words.slice(0, 10).join(" ");
}

/**
 * Syndication dedupe (spec: source diversity). Items must arrive
 * best-first. Same story republished across sites (very similar titles)
 * is collapsed to the best-ranked copy.
 */
export function dedupeSyndication<T extends { c: WebCitation; score: number }>(
  items: T[],
): T[] {
  const seenTitles = new Map<string, string>(); // titleKey -> domain kept
  const out: T[] = [];
  for (const item of items) {
    const key = titleKey(item.c.title);
    const words = key.split(" ").filter(Boolean).length;
    const prevDomain = words >= 6 ? seenTitles.get(key) : undefined;
    if (prevDomain && prevDomain !== domainOf(item.c.url)) continue;
    if (!seenTitles.has(key)) seenTitles.set(key, domainOf(item.c.url));
    out.push(item);
  }
  return out;
}
