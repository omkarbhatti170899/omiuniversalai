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

export type Vertical = "news" | "sports" | "weather" | "markets" | "general";

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
  /** Engine-level time filter, when the provider supports one. */
  timeRange: "hour" | "day" | "week" | "month" | undefined;
  /** A result older than this is not acceptable evidence for this question. */
  maxAgeDays: number;
  /** Human label used in the "what Omi is doing" status. */
  label: string;
  /** Providers that genuinely serve this vertical. */
  preferredProviders: string[];
};

// --- Natural-language current detection ------------------------------------
//
// Keyword-only detection misses the phrasing people actually use, so these
// patterns are deliberately about MEANING, not a word list.

const NEWS_RE =
  /\b(news|headlines?|breaking|what'?s happening|what is happening|what happened|developments?|announcements?|announced|press release|update[ds]?|latest)\b/i;

const SPORTS_RE =
  /\b(score|scores|scoreline|fixture|fixtures|match|matches|fixture|game|tournament|league|ipl|football|soccer|cricket|nba|nfl|f1|formula ?1|tennis|olympic)\b/i;

const WEATHER_RE =
  /\b(weather|forecast|temperature|raining|rain|rainfall|snow|snowfall|humidity|wind speed|wind|storm|cyclone|hot|how (?:hot|cold)|will it (?:rain|snow)|air quality)\b/i;

const MARKETS_RE =
  /\b(stock|stocks|share price|share prices|market cap|sensex|nifty|nasdaq|dow jones|sp ?500|exchange rate|exchange rates|forex|crypto|bitcoin|btc|ethereum|etf|gold price|oil price|brent|commodit|bullion|conversion rate)\b/i;

/** A named currency, e.g. "USD", "INR" — used to spot "USD to INR". */
const CURRENCY_CODE_RE =
  /\b(usd|eur|gbp|inr|jpy|aud|cad|chf|cny|sgd|aed|sar|hkd|nzd|zar|brl|mxn|rub|krw|try|idr|php|myr|thb|ils|pkr|bdt|lkr|kes|ghs|isk|uah)\b/i;

/** "as of today", "right now", "at the moment", "these days", "so far today". */
const NOW_RE =
  /\b(right now|at the moment|at this moment|as of (?:today|now)|so far today|this (?:minute|hour)|as of \d|just now|currently|these days|this (?:evening|morning|afternoon)|today'?s)\b/i;

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
  const q = query ?? "";
  if (WEATHER_RE.test(q)) return "weather";
  if (MARKETS_RE.test(q)) return "markets";
  // "USD to INR", "1 GBP in EUR" — a currency pair IS a market question, even
  // without the word "rate".
  // "gi" — the source pattern is case-insensitive, and `new RegExp(re, flags)`
  // REPLACES the original flags rather than adding to them, so the "i" must be
  // repeated here or "USD" in caps would never match.
  const codes = [...new Set(q.toLowerCase().match(new RegExp(CURRENCY_CODE_RE, "gi")) ?? [])];
  if (codes.length >= 2) return "markets";
  if (SPORTS_RE.test(q)) return "sports";
  if (NEWS_RE.test(q)) return "news";
  return "general";
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
  if (intent === "current" || intent === "news") return true;
  if (NOW_RE.test(q)) return true;
  if (LAST_N_RE.test(q)) return true;
  if (RECENT_RE.test(q)) return true;
  // "What is happening…", "what happened…" — current with no time word.
  if (/\bwhat(?:'s| is| was)?\s+(?:happen(?:ing|ed)?|going on|new)\b/i.test(q)) {
    return true;
  }
  return false;
}

/** Time filter implied by the user's own wording. */
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
  if (intent === "news") return "week";
  if (intent === "current") return "month";
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
  const vertical = detectVertical(query);
  const fresh = requiresFreshness(query, intent);
  const timeRange = timeRangeFor(query, intent);

  if (!fresh) {
    return {
      vertical,
      requiresFreshness: false,
      timeRange: intent === "news" ? "week" : undefined,
      maxAgeDays: 3650,
      label: "Web search",
      preferredProviders: ["wikipedia", "wikidata"],
    };
  }

  // A short window asked for explicitly ("last hour") is a hard 1-day ceiling;
  // everything else accepts up to a week of news coverage.
  const hardWindow = /\b(?:last|past)\s+(?:\d+\s+)?(minute|hour)/i.test(query ?? "");
  const maxAgeDays = hardWindow ? 1 : vertical === "markets" ? 7 : 14;

  const preferred: Record<Vertical, string[]> = {
    news: ["wikipedia-current-events", "gdelt", "hackernews", "searxng"],
    // Sports has no keyless live score feed. Omi will not dress a news
    // article up as a scoreline, so only genuinely-dated news sources run and
    // the answer says plainly that no live score feed is configured.
    sports: ["gdelt", "wikipedia-current-events", "searxng"],
    weather: ["openmeteo"],
    // Real rate data, with a news backstop for "why did the rupee move".
    markets: ["market-rates", "gdelt", "searxng"],
    general: ["wikipedia-current-events", "gdelt", "wikipedia", "searxng"],
  };

  return {
    vertical,
    requiresFreshness: true,
    timeRange,
    maxAgeDays,
    label: VERTICAL_LABEL[vertical],
    preferredProviders: preferred[vertical],
  };
}

const VERTICAL_LABEL: Record<Vertical, string> = {
  news: "Live news search",
  sports: "Live sports search",
  weather: "Live weather data",
  markets: "Live market data",
  general: "Live web search",
};

// --- Timestamps -------------------------------------------------------------

/** Age of a result in days, or null when it carries no usable date. */
export function ageInDays(publishedAt: string | undefined, now = Date.now()): number | null {
  if (!publishedAt) return null;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 86_400_000);
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
          ? " Omi has no live score feed configured, so it will not invent a scoreline. Retry, or add a sports provider in Settings."
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
    return new Set(codes ?? []).size >= 2 ? null : "currency-pair";
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
    `• This is ${policy.label.toLowerCase()}, not a real-time ${policy.vertical} database: if the question needs a live score, rate or forecast that is not in the results, say you could not verify it.`
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
