/**
 * Current-information contract ("current/live information is broken").
 *
 * Root cause this module exists to close: Omi's decision engine already
 * classified a query as `current` or `news`, but the chat turn threw that
 * decision away when it called the search layer — so the freshness signal
 * never reached an engine, the cache was never bypassed, and "what's the latest
 * news" could be answered from a stale cached result or from model memory.
 *
 * Everything here is pure and unit-tested. The rules:
 *
 *   1. A current-information request is ROUTED BY VERTICAL. Weather goes to
 *      weather data, markets to market/news sources, news to a news index.
 *      Ordinary web search is never presented as a real-time database.
 *   2. Freshness is a POLICY, not a hint: a current request bypasses the cache
 *      and carries a `timeRange` down to every engine that supports one.
 *   3. TIMESTAMPS SURVIVE. A result without a publish date is not silently
 *      presented as fresh — it is labelled undated.
 *   4. On failure, Omi says it could not verify. It never falls back to model
 *      memory for a current question without saying so explicitly.
 */

export type { Vertical, LiveDataKind, CurrentIntent } from "./intent";

import {
  classifyCurrentIntent,
  classifyVertical,
  type Vertical,
  type LiveDataKind,
  type FreshnessTier,
} from "./intent";

export type FreshnessSource = {
  title: string;
  url: string;
  publishedAt?: string;
  snippet?: string;
  domain?: string;
};

export type FreshnessPolicy = {
  vertical: Vertical;
  /** The question cannot be answered honestly from model memory. */
  requiresFreshness: boolean;
  /** Which live datum is being asked for, when the question names one. */
  liveData: LiveDataKind | null;
  /**
   * HOW fresh the evidence must be: "now" (the user said today/now), "recent"
   * (latest/recent), "live-feed" (a structured feed that refreshes in
   * minutes), or "none". This drives the window, the ranking weight and the
   * escalation trigger — it is the fix for "latest" being answered from a
   * 3-day-old article.
   */
  freshnessTier: FreshnessTier;
  /**
   * If the NEWEST acceptable source is older than this many hours, retrieval
   * escalates to a second, tighter pass instead of settling for a stale set.
   */
  preferFreshHours: number;
  /**
   * Years the question is scoped to, ascending. A result about a DIFFERENT
   * year is a wrong answer, not an old one — this drives event/year matching
   * so a 2018 Games article cannot be presented as the 2026 tally.
   */
  years: number[];
  /** A named event the question is scoped to, or null. */
  event: string | null;
  /** Engine-level time filter, when the provider supports one. */
  timeRange: "hour" | "day" | "week" | "month" | undefined;
  /** A result older than this is not acceptable evidence for this question. */
  maxAgeDays: number;
  /** Human label used in the "what Omi is doing" status. */
  label: string;
  /** Providers that genuinely serve this vertical. */
  preferredProviders: string[];
  /**
   * When true, the vertical filter is a HARD constraint: if none of the
   * preferred providers answer, Omi fails honestly rather than quietly
   * falling back to the full fan-out. This is what stops a news article from
   * being served as a scoreline or a forecast.
   */
  strict: boolean;
};

/**
 * Pure: is this a request for LIVE conditions rather than a general question
 * about meteorology?
 *
 * "what's the weather" / "will it rain tomorrow" can never be answered from
 * model memory, so they must reach the weather feed. "what causes rain" is a
 * science question and must NOT — routing it to a forecast API would be as
 * wrong as answering a forecast from a book catalogue. The causal/explanatory
 * guard is what separates them.
 */
export function isLiveWeatherRequest(query: string): boolean {
  const q = query ?? "";
  if (!/\b(weather|forecast|temperature|rain|raining|snow|snowing|humidity|wind|storm|cyclone|hot|cold|warm|chilly)\b/i.test(q)) {
    return false;
  }
  if (/\b(cause[sd]?|why (?:do|does|is|are)|how (?:do|does|is|are)|what (?:causes|makes)|explain|learn about|history of|types? of|meaning of|difference between)\b/i.test(q)) {
    return false;
  }
  return /\b(what'?s|what is|whats|how (?:hot|cold|warm)|how much|will it|is it|do i need|am i|check|forecast|today|tonight|tomorrow|now|current)\b/i.test(
    q,
  );
}

/**
 * Pure: is the user actually asking for a SCORE/result (not a news story about
 * a match)? "Live sports score" and "what's the Arsenal result" want the
 * scoreboard. "Latest news on the World Cup final" wants reporting, and news
 * sources are a legitimate answer for that.
 */
/**
 * MEASURED DEFECT (search-quality benchmark, 2026-09-28):
 * "history of the World Cup final" was routed to the live scoreboard and
 * hard-failed, because "final" is a score word and nothing cancelled it for
 * explicitly historical framing. A question that names itself as history can
 * never be answered by a live feed — the scoreboard has no 1930 rows.
 */
const HISTORICAL_FRAMING_RE =
  /\b(history|historical|past|origin|origins|retrospective|all[- ]time|greatest)\b/i;

export function scoreDemanded(query: string): boolean {
  return (
    /\b(score|scores|scoreline|scorelines|result|results|final|standings|table|fixture|fixtures|who won|how many goals)\b/i.test(
      query ?? "",
    ) && !HISTORICAL_FRAMING_RE.test(query ?? "")
  );
}

// --- Natural-language current detection ------------------------------------
//
// Vertical vocabulary and IMPLICIT-freshness detection now live in ./intent
// (the query-intent classifier). They are not duplicated here: two lists that
// can drift apart is how "medal tally" ended up classified as history while
// "latest AI news" was classified as current. ./intent is the single source.

/** "as of today", "right now", "at the moment", "these days", "so far today". */
// The bare words "live", "current" and "now" are in the current-information
// keyword list but were NOT matched here — freshness only worked because the
// intent classifier happened to label those queries "current". A caller that
// asks without an intent (any future call site, or a regression) would have
// silently answered "live score" from model memory. Defence in depth: this
// predicate now stands on its own.
const NOW_RE =
  /\b(right now|at the moment|at this moment|as of (?:today|now)|so far today|this (?:minute|hour)|as of \d|just now|currently|these days|this (?:evening|morning|afternoon)|today'?s|live|breaking|current|now)\b/i;

/**
 * A relative window, as in "the last 3 hours" or — very commonly — the
 * unnumbered "the last hour" / "past week".
 */
const LAST_N_RE =
  /\b(?:last|past|previous)\s+(\d{1,3})?\s*(minute|min|hour|hr|day|week)s?\b/i;

/** Explicit relative-date phrasing, which implies freshness even without a keyword. */
const RECENT_RE =
  /\b(this week|this month|recent(?:ly)?|past few days|as of|updated|update)\b/i;

/**
 * Which kind of current information is being asked for. Order matters: a
 * "weather" question that also says "today" is weather, not news.
 */
export function detectVertical(query: string): Vertical {
  return classifyVertical(query);
}

/**
 * True when the question is asking for information that changes with time, and
 * therefore may NOT be answered primarily from model memory.
 *
 * This is intentionally broader than a keyword list: "what is happening in
 * India?" has no time word at all, but is unmistakably a current question.
 */
export function requiresFreshness(query: string, intent?: string): boolean {
  const q = query ?? "";
  // The classifier owns the decision. It understands IMPLICIT freshness — a
  // live-data noun ("medal tally", "election result", "flight status") or a
  // year at/after the current one — which is what the old keyword list missed
  // and what let "Asian Games 2026" be answered from model memory.
  if (classifyCurrentIntent(q, intent).requiresFreshness) return true;
  // Defence in depth: the two live-feed rules below stand on their own, so a
  // future caller that skips the classifier still cannot answer a forecast or
  // a conversion from memory.
  if (isLiveWeatherRequest(q)) return true;
  if (demandIsInherentlyLive(q)) return true;
  // Explicit relative-date phrasing implies freshness even without a keyword.
  if (NOW_RE.test(q) || LAST_N_RE.test(q) || RECENT_RE.test(q)) return true;
  // "What is happening…", "what happened…" — current with no time word.
  if (/\bwhat(?:'s| is| was)?\s+(?:happen(?:ing|ed)?|going on|new)\b/i.test(q)) {
    return true;
  }
  return false;
}

/**
 * True when the query asks for a value that only a live data feed can supply,
 * independent of any time word. Deliberately narrow: a question that merely
 * MENTIONS a domain ("what caused the 2008 crash", "explain offside") is not
 * a live-data request and must not be routed to a scoreboard or a ticker.
 */
function demandIsInherentlyLive(query: string): boolean {
  const q = query ?? "";
  const vertical = detectVertical(q);
  if (vertical === "sports" && scoreDemanded(q)) return true;
  if (vertical === "weather" && isLiveWeatherRequest(q)) return true;
  if (vertical !== "markets") return false;
  return marketValueDemanded(q);
}

/**
 * Pure: does the wording ask for the NUMBER itself, rather than discussing the
 * market? Markets is the broadest vertical — "what is a stock market?" is a
 * definition question — so a live read is only claimed when the user is asking
 * for a value or a conversion.
 */
export function marketValueDemanded(query: string): boolean {
  const q = query ?? "";
  return (
    /\b(rate|rate s|price|prices|trading|quote|worth|cost|conversion|convert|exchange|market cap)\b/i.test(q) ||
    // "1 usd to inr", "100 eur in gbp" — a pair plus a numeral is a conversion.
    /\b\d+(?:\.\d+)?\s*(usd|inr|eur|gbp|jpy|aud|cad|chf|sgd|aed)\b/i.test(q) ||
    /\b(usd|inr|eur|gbp|jpy|aud|cad|chf|sgd|aed)\s*(to|in|into|against)\s*(usd|inr|eur|gbp|jpy|aud|cad|chf|sgd|aed)\b/i.test(q)
  );
}

/**
 * Age in hours of the NEWEST dated source, or null when nothing is dated.
 *
 * `null` means NO dated evidence survived the freshness filter — the worst
 * case, not a neutral one. `shouldEscalateForFreshness` treats it as
 * "escalate" for exactly that reason.
 */
/**
 * How far into the FUTURE a publication date may be before we stop believing
 * it. Small negative ages are ordinary clock skew between a publisher and us;
 * anything beyond this is a broken page, not a scoop.
 */
export const MAX_FUTURE_SKEW_HOURS = 12;

/**
 * Age in HOURS, or null when the date is missing or implausible.
 *
 * MEASURED DEFECT (search-quality benchmark, 2026-09-28): a bookseller's
 * product listing stamped `2026-09-28T14:00:00Z` — five hours IN THE FUTURE —
 * was ranked as the freshest possible evidence for "today's top stories", at
 * age 0. A future timestamp is not a fresh scoop; it is a broken or
 * pre-scheduled page, and no real report can be dated tomorrow. It is now
 * treated exactly like a missing date. Tiny negative ages are still clamped to
 * 0, because publisher/consumer clock skew is normal and harmless.
 *
 * Shared by `minAgeHours` and `ageInDays` so the two can never disagree — they
 * did: `minAgeHours` skipped every negative age while `ageInDays` clamped to 0,
 * so a future-dated source counted as "no dated evidence" for escalation and
 * "maximally fresh" for ranking, at the same time.
 */
export function plausibleAgeHours(
  publishedAt: string | null | undefined,
  now: number,
): number | null {
  if (!publishedAt) return null;
  const at = Date.parse(publishedAt);
  if (!Number.isFinite(at)) return null;
  const hours = (now - at) / 3_600_000;
  if (hours < -MAX_FUTURE_SKEW_HOURS) return null;
  return Math.max(0, hours);
}

export function minAgeHours(
  sources: Array<{ publishedAt?: string | null }>,
  now: number,
): number | null {
  let best: number | null = null;
  for (const s of sources) {
    const hours = plausibleAgeHours(s.publishedAt, now);
    if (hours === null) continue;
    if (best === null || hours < best) best = hours;
  }
  return best;
}

/**
 * THE ESCALATION TRIGGER: "is my best evidence recent enough for what was
 * actually asked?" If not, retrieval runs a second, tighter pass instead of
 * settling.
 *
 * Measured defect this fixes: the trigger was guarded as
 * `newestHours !== null && newestHours > preferFreshHours`, but
 * `minAgeHours([])` returns `null`. So when the first pass returned results
 * that were ALL too old to be evidence, escalation could not fire — the
 * engine refused on the first pass and never looked again. That is
 * backwards: "nothing recent enough" is precisely the case that most needs a
 * second, tighter pass. On the deployed build this left three /currentinfo
 * scenarios at "5 raw result(s) but none recent enough".
 *
 * `preferFreshHours <= 0` means the policy does not demand freshness, so no
 * escalation is ever warranted.
 */
export function shouldEscalateForFreshness(
  freshSources: Array<{ publishedAt?: string | null }>,
  preferFreshHours: number,
  now: number,
): boolean {
  if (preferFreshHours <= 0) return false;
  const newestHours = minAgeHours(freshSources, now);
  return newestHours === null || newestHours > preferFreshHours;
}

/**
 * The freshness window, derived from the user's own demand.
 *
 * THE BUG THIS REPLACES: a single flat `maxAgeDays` of 14 (or 7 for markets)
 * was applied to every current question. Measured consequence — a user asked
 * for India's LATEST Asian Games medal tally and Omi answered from a source
 * THREE DAYS OLD, at full confidence, because three days is comfortably
 * inside fourteen. A window that cannot express "today" will eventually serve
 * last week and call it current.
 *
 * `preferFreshHours` is the escalation trigger: if the NEWEST acceptable
 * source is older than this, retrieval runs a second, tighter pass rather
 * than settling for the best of a stale set.
 */
export function freshnessWindowFor(
  tier: FreshnessTier,
  vertical: Vertical,
): { maxAgeDays: number; preferFreshHours: number } {
  switch (tier) {
    case "now":
      // "Today" really means today. 2 days is the outer bound because some
      // verticals publish a round-up once a day.
      return { maxAgeDays: 2, preferFreshHours: 30 };
    case "live-feed":
      // Weather and rates carry the provider's own read time.
      return { maxAgeDays: vertical === "markets" ? 3 : 1, preferFreshHours: 6 };
    case "recent":
      // "Latest" still means days, not weeks. Measured: a 3-6-day-old page
      // set was being accepted for a "latest medal tally" question, so the
      // escalation trigger is pulled in to 48h and the ceiling to 5 days.
      return { maxAgeDays: 5, preferFreshHours: 48 };
    default:
      return { maxAgeDays: 14, preferFreshHours: 168 };
  }
}

/**
 * Wording that means "right now", as opposed to "recently".
 *
 * The distinction matters because the ENGINE filter is coarse: SearXNG's own
 * granularity stops at `day`. Measured 2026-09-27 on the configured instance,
 * passing `time_range` took the date yield from 21% to 100% — because the
 * filter makes the metasearch restrict itself to engines that can honour dates
 * (yandex) instead of mixing in ones that cannot (seznam, mwmbl). So asking
 * for `day` is not a cosmetic tightening; it is what switches on dated
 * retrieval at all.
 *
 * Deliberately NOT included: "recent", "this week", "2026", "current" — those
 * are handled by the freshness TIER, and forcing a day filter on them would
 * throw away genuinely current-but-not-today material.
 */
const STRONG_NOW_RE =
  /(?<![\p{L}\p{N}])(today|tonight|right\s+now|as\s+of\s+now|just\s+now|breaking|just\s+announced|this\s+morning|this\s+afternoon|this\s+evening|in\s+the\s+last\s+few\s+hours)(?![\p{L}\p{N}])/iu;

/** A year that is clearly in the past must never get a one-day filter. */
const HISTORICAL_YEAR_RE = /(?<![\d])((?:19|20)\d{2})(?![\d])/;

export function timeRangeFor(query: string, intent?: string): FreshnessPolicy["timeRange"] {
  const explicit = LAST_N_RE.exec(query ?? "");
  if (explicit) {
    // The number is optional ("the last hour" ≡ one hour), so an absent group
    // must mean 1 rather than NaN.
    const n = explicit[1] === undefined ? 1 : Number(explicit[1]);
    const unit = explicit[2];
    if (unit.startsWith("min")) return "hour";
    if (unit.startsWith("hour") || unit === "hr") return n <= 1 ? "hour" : "day";
    if (unit.startsWith("day")) return n <= 1 ? "day" : "week";
    return "week";
  }
  // "today"/"breaking"/"right now" ask for the current day specifically.
  // Guarded against historical framing so "the 2018 Asian Games medal tally
  // today" is not answered with a one-day filter that cannot possibly hold
  // the answer.
  if (STRONG_NOW_RE.test(query ?? "")) {
    const years = (query ?? "").match(HISTORICAL_YEAR_RE);
    const onlyPastYears =
      years !== null && years.every((y) => Number(y) < new Date().getUTCFullYear());
    if (!onlyPastYears) return "day";
  }
  if (intent === "news") return "week";
  // A generic "current" previously widened the engine-level filter to a
  // MONTH, which is the opposite of what the user asked for. Default to a
  // week; the freshness TIER tightens it further when the wording demands
  // "today".
  if (intent === "current") return "week";
  return undefined;
}

/**
 * The policy for one turn. `intent` is the decision engine's classification;
 * when it already said "current"/"news" that is trusted, and the natural
 * language patterns catch everything the classifier missed.
 */
export function freshnessPolicyFor(
  query: string,
  intent?: string,
): FreshnessPolicy {
  const classified = classifyCurrentIntent(query, intent);
  const vertical = classified.vertical;
  const fresh = requiresFreshness(query, intent);
  const timeRange = timeRangeFor(query, intent);

  if (!fresh) {
    return {
      vertical,
      requiresFreshness: false,
      liveData: classified.liveData,
      freshnessTier: "none",
      preferFreshHours: 0,
      years: classified.years,
      event: classified.event,
      timeRange: intent === "news" ? "week" : undefined,
      maxAgeDays: 3650,
      label: "Web search",
      preferredProviders: ["wikipedia", "wikidata"],
      // Not a current-information question, so there is nothing to fail hard on.
      strict: false,
    };
  }

  // A short window asked for explicitly ("last hour") is a hard 1-day ceiling;
  // otherwise the window comes from the freshness TIER, not a flat constant.
  const hardWindow = /\b(?:last|past)\s+(?:\d+\s+)?(minute|hour)/i.test(query ?? "");
  const window = freshnessWindowFor(classified.freshnessTier, vertical);
  const maxAgeDays = hardWindow ? 1 : window.maxAgeDays;

  const scoreAsked = vertical === "sports" ? scoreDemanded(query) : false;
  // A straight rate/price read has exactly one honest source. "Why did the
  // rupee move?" is a different question and keeps its news backstop.
  const valueAsked = vertical === "markets" && marketValueDemanded(query);

  const preferred: Record<Vertical, string[]> = {
    // `langsearch` is in every general-web backstop list, and it is FIRST in
    // the dated ones, because the benchmark measured the thing that matters
    // here: LangSearch returns a publication date on 100% of its results while
    // SearXNG dates 5% of the ~63 it returns. A freshness-gated question needs
    // DATED evidence, so the provider that dates everything belongs ahead of
    // the one that returns volume. SearXNG is kept — breadth is still breadth,
    // and the circuit breaker needs a second general-web engine to fall back
    // to when LangSearch's daily token allowance runs out.
    news: ["langsearch", "wikipedia-current-events", "gdelt", "hackernews", "searxng"],
    // A scoreline must come from a scoreboard, never from a news article
    // saying "Arsenal beat Chelsea 2-1". When a score is actually being asked
    // for, ONLY the live score feed may answer; when the user merely wants
    // reporting about a match, news is a legitimate answer.
    //
    // The live scoreboard is deliberately EXCLUDED when no score is asked
    // for. Measured live: a question about the "Asian Games 2026 medal tally"
    // was answered with Japanese B1 League basketball scorelines, because
    // the scoreboard returns *something* for any query that looks sporting.
    // Those results are genuinely fresh, which is precisely why they were
    // dangerous — a medal tally is not a fixture list.
    sports: scoreAsked
      ? ["sports-scores"]
      : ["langsearch", "gdelt", "wikipedia-current-events", "searxng"],
    weather: ["openmeteo"],
    // Real rate data, with a news backstop for "why did the rupee move".
    markets: ["market-rates", "langsearch", "gdelt", "searxng"],
    // No dedicated structured feed is wired for these two yet, so news plus
    // the general-web floor is the honest best available — and `strict` stays
    // FALSE so a single index outage degrades to a real answer instead of a
    // bare failure.
    election: ["langsearch", "gdelt", "wikipedia-current-events", "searxng"],
    travel: ["langsearch", "searxng", "gdelt"],
    general: ["langsearch", "wikipedia-current-events", "gdelt", "wikipedia", "searxng"],
  };

  return {
    vertical,
    requiresFreshness: true,
    liveData: classified.liveData,
    freshnessTier: classified.freshnessTier,
    preferFreshHours: window.preferFreshHours,
    years: classified.years,
    event: classified.event,
    timeRange,
    maxAgeDays,
    label: VERTICAL_LABEL[vertical],
    preferredProviders: preferred[vertical],
    // Weather, an explicitly-requested score, and a straight rate/price read
    // each have exactly one honest source type. If it is down, the correct
    // behaviour is to say so rather than substituting an unrelated engine.
    strict: vertical === "weather" || scoreAsked || valueAsked,
  };
}

const VERTICAL_LABEL: Record<Vertical, string> = {
  news: "Live news search",
  sports: "Live sports search",
  weather: "Live weather data",
  markets: "Live market data",
  election: "Live election search",
  travel: "Live travel search",
  general: "Live web search",
};

// --- Timestamps -------------------------------------------------------------

/**
 * Age of a result in days, or null when it carries no USABLE date.
 *
 * "Usable" means parseable and not implausibly future — see
 * `plausibleAgeHours`, which this delegates to so ranking, gating and the
 * prompt can never disagree about whether a date exists.
 */
export function ageInDays(publishedAt: string | undefined, now = Date.now()): number | null {
  const hours = plausibleAgeHours(publishedAt, now);
  return hours === null ? null : hours / 24;
}

/** True when a result is recent enough to be evidence for a current question. */
export function isFreshEnough(
  source: FreshnessSource,
  maxAgeDays: number,
  now = Date.now(),
): boolean {
  const age = ageInDays(source.publishedAt, now);
  // An undated result is NOT fresh. Treating "unknown date" as "recent" is
  // exactly how stale content gets presented as today's news.
  if (age === null) return false;
  return age <= maxAgeDays;
}

export type FreshnessSplit = { fresh: FreshnessSource[]; undated: FreshnessSource[]; stale: FreshnessSource[] };

/** Split results into fresh, undated and too-old, preserving order. */
export function splitByFreshness(
  sources: FreshnessSource[],
  maxAgeDays: number,
  now = Date.now(),
): FreshnessSplit {
  const fresh: FreshnessSource[] = [];
  const undated: FreshnessSource[] = [];
  const stale: FreshnessSource[] = [];
  for (const s of sources) {
    const age = ageInDays(s.publishedAt, now);
    if (age === null) undated.push(s);
    else if (age <= maxAgeDays) fresh.push(s);
    else stale.push(s);
  }
  return { fresh, undated, stale };
}

/** "3 hours ago", "2 days ago", "today" — compact and honest. */
export function relativeAge(publishedAt: string | undefined, now = Date.now()): string {
  const age = ageInDays(publishedAt, now);
  if (age === null) return "date not shown by the source";
  const hours = age * 24;
  if (hours < 1) return "just now";
  if (hours < 2) return "about an hour ago";
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  if (age < 2) return "yesterday";
  if (age < 30) return `${Math.round(age)} days ago`;
  if (age < 365) return `${Math.round(age / 30)} months ago`;
  return "over a year ago";
}

/**
 * The freshness sentence the answer must lead with, e.g.
 * "Based on 3 reports published in the last 24 hours…".
 * Returns null when there is nothing fresh to say.
 */
export function freshnessStatement(
  sources: FreshnessSource[],
  maxAgeDays: number,
  now = Date.now(),
): string | null {
  const { fresh, undated } = splitByFreshness(sources, maxAgeDays, now);
  if (fresh.length === 0) return null;
  const n = fresh.length;
  const plural = n === 1 ? "report" : "reports";
  const newest = fresh.reduce(
    (best, s) => (ageInDays(s.publishedAt, now) ?? Infinity) < (ageInDays(best.publishedAt, now) ?? Infinity) ? s : best,
    fresh[0],
  );
  const window =
    maxAgeDays <= 1
      ? "in the last 24 hours"
      : fresh.every((s) => (ageInDays(s.publishedAt, now) ?? 99) < 1)
        ? "today"
        : `in the last ${maxAgeDays} days`;
  const base = `Based on ${n} ${plural} published ${window} (newest: ${relativeAge(newest.publishedAt, now)})`;
  if (undated.length > 0) {
    return `${base}. ${undated.length} further result(s) did not show a publish date and are not counted as current.`;
  }
  return `${base}.`;
}

/**
 * The exact wording Omi must use when a current question could not be
 * verified. It states the limitation and gives the user an action, and it
 * never implies the model knows the current answer.
 */
export function noVerificationMessage(query: string, vertical: Vertical): string {
  const head =
    `Live search is currently unavailable, so I can't reliably verify the latest information about "${query.trim()}". ` +
    `I'm not going to answer this from memory, because my training data is not a live ${vertical} feed and could be months out of date.`;
  // The next step must be specific to what actually went wrong, or it is not
  // an action at all.
  const next =
    vertical === "weather"
      ? " Tell me which city or location you mean (for example \"weather in Mumbai\") and Omi will pull the live conditions."
      : vertical === "markets"
        ? " Omi can quote live currency rates if you name the pair (for example \"USD to INR\"). It will not guess an equity, crypto or commodity price."
        : vertical === "sports"
          ? " Omi could not reach a live score feed just now, so it will not invent a scoreline. Name the team or competition (for example \"Mumbai Indians score\" or \"Premier League scores today\") and press Retry Search."
          : " Press Retry Search to try again, or switch a search provider in Settings.";
  return head + next;
}

/**
 * A required input the question did not supply. Weather needs a place; an
 * exchange rate needs a currency pair. Returning this lets Omi ask one precise
 * clarifying question instead of reporting a generic "all engines failed" —
 * which is both unhelpful and technically false.
 */
export function missingInputFor(query: string, vertical: Vertical): string | null {
  const q = query ?? "";
  if (vertical === "weather") {
    // A weather question with no place name cannot be resolved to coordinates.
    const hasPlace =
      /\b(in|at|for)\s+[A-Z]/.test(q) ||
      /\b(mumbai|delhi|bengaluru|bangalore|chennai|kolkata|hyderabad|pune|ahmedabad|jaipur|london|new york|paris|tokyo|beijing|sydney|toronto|dubai|singapore|berlin|amsterdam|lagos|nairobi|karachi|dhaka|colombo|kathmandu)\b/i.test(q);
    return hasPlace ? null : "location";
  }
  if (vertical === "markets") {
    const codes = q.toUpperCase().match(/\b(?:USD|EUR|GBP|INR|JPY|AUD|CAD|CHF|CNY|SGD|AED|SAR|HKD|NZD|ZAR|BRL|MXN|RUB|KRW|TRY|IDR|PHP|MYR|THB|ILS|PKR|BDT|LKR|KES|GHS|ISK|UAH)\b/g);
    if (new Set(codes ?? []).size >= 2) return null;

    // MEASURED DEFECT: the old rule asked "Which currency pair do you mean?"
    // for ANY markets query without two codes, so "what is the current market
    // cap of Apple?", "current gold price in Tokyo?" and "Nifty 50 today" were
    // all answered with a nonsense question about currency pairs. Blocking a
    // perfectly answerable question is worse than attempting it: the live
    // stress run showed these returning 0 results purely because Omi asked
    // instead of searching.
    //
    // A currency pair is only genuinely missing when the question is actually
    // about converting between two currencies.
    const FX_RE =
      /\b(exchange rate|fx rate|forex|currency|convert|conversion|how much is|worth|in (?:usd|eur|gbp|inr|jpy)|rate of)\b/i;
    // A named non-FX asset makes it a market question, not an FX question.
    const NON_FX_ASSET_RE =
      /\b(market cap|share price|stock price|share|stock|equit|index|nifty|sensex|dow|s&p|nasdaq|gold|silver|platinum|oil|crude|bitcoin|btc|ethereum|crypto|coin|bitcoin|bond|yield|commodit|ticker|ipo)\b/i;
    if (NON_FX_ASSET_RE.test(q)) return null;
    return FX_RE.test(q) ? "currency-pair" : null;
  }
  return null;
}

/** The clarifying question for a missing input, or null when none is missing. */
export function clarifyForMissingInput(query: string, vertical: Vertical): string | null {
  const missing = missingInputFor(query, vertical);
  if (missing === "location") {
    return (
      `Which location do you mean? I can pull live conditions for any city — ` +
      `try "what's the weather in Mumbai". I won't guess a location and give you the wrong forecast.`
    );
  }
  if (missing === "currency-pair") {
    return (
      `Which currency pair do you mean? Omi can quote live rates for any pair — ` +
      `try "USD to INR" or "1 GBP in EUR". I won't guess a rate.`
    );
  }
  return null;
}

/**
 * Instruction block injected with the search results so the model is told, in
 * one place, what the freshness rules are for THIS turn.
 */
export function freshnessInstruction(policy: FreshnessPolicy): string {
  if (!policy.requiresFreshness) {
    return "LIVE WEB RESULTS (cite them inline as [1], [2] … where used):";
  }
  return (
    `${policy.label.toUpperCase()} — live results only.\n` +
    `These results were retrieved live for this question. RULES:\n` +
    `• Ground EVERY factual claim in a result, and cite it inline as [1], [2] …\n` +
    `• Lead your answer with a freshness line, e.g. "Based on reports published today, …"\n` +
    `• Use ONLY the dates shown below. Never estimate or invent a date.\n` +
    `• If the results do not actually answer the question, say so — do NOT fill the gap from your own training data.\n` +
    `• This is ${policy.label.toLowerCase()}, not a real-time ${policy.vertical} database: if the question needs a live score, rate or forecast that is not in the results, say you could not verify it.` +
    (policy.vertical === "sports"
      ? `\n• For a scoreboard question, name each match and print its scoreline (e.g. "Portland Thorns 0–0 Houston Dash, 5' in play"). Never summarise the collection without the scores.`
      : "")
  );
}

/** Formatting helper: one line per source with its date, for the prompt. */
export function formatSourceLine(source: FreshnessSource, index: number, now = Date.now()): string {
  const domain = source.domain ?? hostOf(source.url);
  // One wording for "unknown age", shared with `relativeAge`, so the prompt
  // and the freshness sentence can never disagree.
  const when = relativeAge(source.publishedAt, now);
  return `[${index}] ${source.title} — ${domain} — published: ${when}\nURL: ${source.url}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown source";
  }
}
