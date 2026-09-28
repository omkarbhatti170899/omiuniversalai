/**
 * Source quality engine (spec §12/§13): URL normalization, domain
 * authority tiers, freshness scoring, completeness, relevance, and
 * syndicated-content dedupe. Preference order:
 *   official/government → academic → reference → reputable news → general → low
 */

import type { WebCitation } from "../searchProviders/types";
import { matchTemporal, temporalPenalty } from "./temporal";

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

/**
 * 0..1 — how fresh the source is, at HOUR resolution.
 *
 * The previous version bucketed "<=1 day = 1.0, <=7 days = 0.9", which made a
 * 3-day-old article indistinguishable from yesterday's. Measured consequence:
 * a user asked for the LATEST Asian Games medal tally and Omi answered from a
 * source 3 days old, at full confidence, because a week-old page and a
 * day-old page scored identically. A day-scale curve cannot express "today".
 *
 * The curve is now smooth and log-shaped, so an extra day of age always
 * costs something, and the first 24 hours are the most valuable.
 */
export function freshnessScore(publishedAt: string | undefined, now = Date.now()): number {
  if (!publishedAt) return 0.4;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 0.4;
  const ageHours = Math.max(0, (now - t) / 3_600_000);
  // <1h 1.0 · 6h .95 · 1d .88 · 3d .72 · 7d .55 · 30d .3 · 1y .08
  if (ageHours <= 1) return 1;
  if (ageHours <= 6) return 0.95;
  if (ageHours <= 24) return 0.88;
  if (ageHours <= 72) return 0.72;
  if (ageHours <= 168) return 0.55;
  if (ageHours <= 720) return 0.3;
  if (ageHours <= 8760) return 0.12;
  return 0.05;
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
 * Words that say WHEN or WHAT KIND — never WHAT ABOUT.
 *
 * MEASURED DEFECT (freshness benchmark, 2026-09-28): the topic floor was
 * dropping the FRESHEST dated source on every generic news question. For
 * "latest world news" the topic set was {latest, news, world}, and a Wikipedia
 * Current Events wire item dated 8.6 h earlier — genuinely today's world news —
 * shared none of those three words, so it was discarded while 3-day-old
 * articles were kept. Same class of failure for "latest science news" and
 * "today's technology news".
 *
 * This is the same rule already applied to years: "2026" is a scoping
 * constraint, not a topic, because it appears on holiday packages and tender
 * notices. "Latest" and "news" are equally non-topical — they describe when the
 * user wants information and what form it should take, and no wire headline
 * ever contains the word "latest". Requiring a match on them drops exactly the
 * evidence the freshness gate exists to find.
 *
 * The subject words are untouched: "medals", "tally", "asian", "games",
 * "india", "kubernetes". So the floor still catches the case it was written
 * for (a Maldives holiday package under a medal-tally question), and it still
 * turns itself OFF when a question has no subject words left — a question we
 * cannot characterise is not evidence that a source is off-topic.
 */
const ASPECT_WORDS = new Set([
  "latest", "newest", "news", "today", "tonight", "tomorrow", "yesterday",
  "current", "currently", "now", "recent", "recently", "update", "updates",
  "breaking", "live", "headline", "headlines", "information", "happening",
  "world", "worldwide", "global", "international", "top",
]);

/**
 * Possessives and plurals of an aspect word are still aspect words.
 * `keywordSet` keeps the apostrophe (it allows `'` inside a token), so
 * "today's" never equals "today" and would survive as a fake topic word.
 */
export function isAspectWord(word: string): boolean {
  return ASPECT_WORDS.has(word.replace(/['\u2019]s?$/, ""));
}

/**
 * The TOPIC words of a question — its keywords minus bare numbers and minus
 * the words that only describe when/what-kind of information is wanted.
 */
export function topicKeywords(query: string): string[] {
  return keywordSet(query).filter((w) => !/^\d+$/.test(w) && !isAspectWord(w));
}

/** Exported for tests: the aspect vocabulary above, as a set. */
export function aspectWords(): ReadonlySet<string> {
  return ASPECT_WORDS;
}

/**
 * Off-topic test: shares NO topic word with the question.
 *
 * Deliberately the weakest possible floor — one shared topic word is enough to
 * survive. A stricter threshold was rejected: paraphrase and inflection
 * ("medal" vs "medals", "tally" vs "medal count") are common in real headlines,
 * and a floor tuned on one query would silently drop legitimate evidence on the
 * next one. Zero overlap is unambiguous in a way that partial overlap is not.
 *
 * Returns false when the question has no topic words, because a question we
 * cannot characterise is not evidence that a source is off-topic.
 */
export function isOffTopic(c: WebCitation, topic: string[]): boolean {
  if (topic.length === 0) return false;
  const hay = `${c.title ?? ""} ${c.snippet ?? ""}`.toLowerCase();
  return !topic.some((k) => hay.includes(k));
}

/**
 * Directness: does the source actually ANSWER, or merely mention the topic?
 *
 * A page that discusses the Asian Games at length without giving a medal count
 * is not evidence for a medal question. Directness rewards sources whose own
 * text carries the asked entity together with a concrete value (a number, a
 * date, a scoreline) — that is the difference between a real answer and a
 * summary page.
 */
export function directnessScore(c: WebCitation, keywords: string[]): number {
  const hay = `${c.title ?? ""} ${c.snippet ?? ""}`.toLowerCase();
  if (!hay) return 0;
  const entityHits = keywords.filter((k) => hay.includes(k)).length;
  if (entityHits === 0) return 0;
  // A concrete value in the body text is the strongest signal of a direct
  // answer; a value in the title alone is weaker but still meaningful.
  const hasNumber = /\b\d+(?:[.,]\d+)?\b/.test(hay);
  const titleHasNumber = /\b\d+(?:[.,]\d+)?\b/.test((c.title ?? "").toLowerCase());
  const coverage = entityHits / Math.max(1, keywords.length);
  const valueBonus = hasNumber ? (titleHasNumber ? 0.35 : 0.2) : 0;
  return Math.min(1, coverage * 0.7 + valueBonus);
}

/**
 * True when a source shares at least one SUBJECT word with the question.
 *
 * Same vocabulary as `isOffTopic` (aspect words and bare numbers removed), so
 * ranking and gating can never disagree about what "about the question" means.
 * `true` when the question has no subject words left, because a question we
 * cannot characterise is not evidence that a source is off-topic.
 */
export function sharesTopic(c: WebCitation, keywords: string[]): boolean {
  const topic = keywords.filter((w) => !/^\d+$/.test(w) && !isAspectWord(w));
  if (topic.length === 0) return true;
  const hay = `${c.title ?? ""} ${c.snippet ?? ""}`.toLowerCase();
  return topic.some((k) => hay.includes(k));
}

/**
 * Blended source score (0..1): relevance and authority dominate; freshness
 * (weighted up when the request is freshness-sensitive), directness and
 * completeness contribute per spec §12.
 *
 * MEASURED CHANGE (2026-09-28) — FRESHNESS IS CREDITED ONLY FOR A SOURCE THAT
 * IS ABOUT THE QUESTION.
 *
 * Freshness is evidence of CURRENCY, never of SUBJECT. The previous weights
 * gave a `now`-tier question freshness 0.40 against relevance 0.28, so a page
 * published an hour ago about the wrong subject collected more than a relevant
 * article did — and the "newest timestamp wins" behaviour that produces is
 * exactly what a user reads as "it answered with something unrelated". An
 * off-topic source now earns NO freshness credit at all, which is also
 * CONSISTENT with the topical floor that drops it a moment later: ranking and
 * gating agree.
 *
 * The rest of the budget is nudged toward AUTHORITY (0.18 → 0.22) and away
 * from raw recency (0.40 → 0.34 for `now`), so a brand-new low-quality page
 * cannot outrank a reliable source merely by being new. Recency still outranks
 * relevance for "today" — answering with yesterday's number is wrong, not
 * merely less good — so the freshness guarantee is preserved.
 *
 * For a year- or event-scoped question the whole score is then multiplied by
 * `temporalPenalty`, which drives a confidently-wrong-year source to the
 * floor. Recency alone cannot do this: a page published last week about the
 * 2018 Games is fresh by timestamp and useless by content.
 */
export function scoreSource(
  c: WebCitation,
  keywords: string[],
  opts: {
    freshnessMatters?: boolean;
    askedYears?: number[];
    askedEvent?: string | null;
    /**
     * "now" | "recent" | "live-feed" | "none". How aggressively recency
     * outranks everything else. For "now" (the user said today/now) freshness
     * is worth 0.34 — still more than relevance — because answering with
     * yesterday's number is wrong, not merely less good.
     */
    freshnessTier?: string;
  } = {},
): number {
  const rel = relevanceScore(c, keywords);
  const tier = sourceTier(c.url).weight;
  const fresh = freshnessScore(c.publishedAt);
  const comp = completenessScore(c);
  const ft = opts.freshnessTier;
  // Freshness weight by demand. Without this, a 3-day-old authoritative page
  // and a 2-hour-old one ranked identically.
  const freshW = !opts.freshnessMatters ? 0.06 : ft === "now" ? 0.34 : ft === "live-feed" ? 0.28 : 0.22;
  // Relevance is de-weighted as freshness demand rises, but no longer below
  // the authority tier's contribution.
  const relW = ft === "now" ? 0.32 : 0.5;
  const authorityW = 0.22;
  const rest = Math.max(0, 1 - relW - authorityW - freshW - 0.12 - 0.08);
  const direct = 0.08 * directnessScore(c, keywords);
  // Off-topic ⇒ zero freshness credit. On-topic is judged with the same
  // vocabulary the topical floor uses, so the two can never disagree.
  const freshnessCredit = sharesTopic(c, keywords) ? fresh : 0;
  const base =
    relW * rel + authorityW * tier + freshW * freshnessCredit + 0.12 * comp + direct + rest;

  // Temporal matching is only meaningful when the question is actually scoped
  // to a year or an event. Applying it unconditionally would penalise every
  // source for a timeless question.
  if ((opts.askedYears?.length ?? 0) > 0 || opts.askedEvent) {
    const match = matchTemporal(c, opts.askedYears ?? [], opts.askedEvent ?? null);
    return base * temporalPenalty(match);
  }
  return base;
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
