import axios from "axios";
import {
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./types";

/**
 * Wikipedia Current Events — a genuinely LIVE, dated, keyless news source.
 *
 * Why this provider exists: the general-web floor (SearXNG public instances,
 * DuckDuckGo HTML) was measured on 2026-09-26 and does not return usable JSON
 * or is bot-gated, so "what happened today" had no working source. Wikipedia's
 * `Portal:Current events/<date>` page is maintained continuously, is keyed by
 * date (so every item is genuinely from today or yesterday), and each bullet
 * links to the original newswire. It is the most reliable current-events feed
 * available without an API key.
 *
 * It is NOT a general web search engine and is never used as one: it only
 * answers questions about events, and it is only consulted for a
 * freshness-sensitive query.
 */

const API = "https://en.wikipedia.org/w/api.php";
const PORTAL_PREFIX = "Portal:Current events/";
const UA = "OmiUniversalAI/1.0 (https://ominnovations.example; contact: omi@ominnovations.example)";

/** Wikipedia page title for a date, e.g. 2026 September 26. */
export function portalTitle(d: Date): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${PORTAL_PREFIX}${d.getUTCFullYear()} ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** ISO midnight UTC for a date — the honest publish time for a daily portal. */
export function portalPublishedAt(d: Date): string {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  ).toISOString();
}

export type ParsedEvent = {
  section: string;
  text: string;
  url?: string;
  source?: string;
};

/**
 * Parse the portal wikitext into dated events.
 *
 * Shape of the page: a `'''Section'''` heading line, then `*item` bullets.
 * A bullet may end with a citation like `[https://… (Reuters)]`, which is the
 * original source and the URL we surface, because the Wikipedia page itself is
 * a summary and the user should be sent to the primary report.
 */
export function parseCurrentEvents(wikitext: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  let section = "General";
  for (const rawLine of wikitext.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("<!--")) continue;

    const heading = /^'{3}([^']+?)'{3}\s*$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (!line.startsWith("*")) continue;

    // Strip wiki links to their display text, then pull out the citation.
    let text = line.replace(/^\*+\s*/, "");
    text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
    text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

    const cite = /\[(https?:\/\/[^\s\]]+)\s*\(([^)]+)\)\]/.exec(text);
    let url: string | undefined;
    let source: string | undefined;
    if (cite) {
      url = cite[1];
      source = cite[2];
      text = text.replace(cite[0], "").replace(/[\s,;.]+$/, "");
    }
    // Drop templates and leftover markup.
    text = text
      .replace(/\{\{[^}]*\}\}/g, "")
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
      .replace(/'''?/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 20) continue;
    out.push({ section, text, url, source });
    if (out.length >= 300) break;
  }
  return out;
}

/** Words that carry no signal when matching an event to a question. */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "has", "was", "were",
  "are", "after", "over", "into", "his", "her", "its", "their", "about",
  "latest", "news", "today", "current", "happening", "happened", "update",
  "tell", "give", "what", "whats", "please", "india", "world",
]);

function terms(q: string): string[] {
  return (q ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/**
 * Pure: rank events against the question.
 *
 * The front-page fallback is deliberately CONSERVATIVE. Returning "the first
 * few items on today's page" for any unmatched query is how a weather or
 * currency question ends up answered with unrelated news — the exact
 * "pretend a web page is a real-time database" failure. The fallback is
 * therefore allowed only for genuinely open-ended questions about events.
 */
export function rankEvents(
  events: ParsedEvent[],
  query: string,
  limit: number,
): ParsedEvent[] {
  const q = terms(query);
  const scored = events.map((e) => {
    const hay = `${e.section} ${e.text}`.toLowerCase();
    let score = 0;
    for (const t of q) if (hay.includes(t)) score += 1;
    return { e, score };
  });
  const matches = scored.filter((s) => s.score > 0);
  if (matches.length > 0) {
    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.e);
  }
  // No term matched. A NEWS-phrased question may be answered with the day's
  // front page — "latest announcements" is a request for news, and today's
  // page IS the answer. A question in a vertical that needs real data
  // (weather, a currency rate, a score) must return nothing, so the caller
  // reports that it could not verify rather than surfacing unrelated news.
  if (canUseEventsFrontPage(query)) {
    return events.slice(0, limit);
  }
  return [];
}

/**
 * True when the day's current-events front page is an acceptable answer.
 *
 * Safe for news. NOT safe for weather, currency or scores: a news page is not
 * a thermometer, a rate feed, or a scoreline, and answering those questions
 * with it is the "ordinary web search pretending to be real-time data" failure
 * this contract exists to prevent.
 */
export function canUseEventsFrontPage(query: string): boolean {
  const q = (query ?? "").toLowerCase().trim();
  if (q.length === 0) return false;
  if (NEEDS_REAL_DATA_RE.test(q)) return false;
  return NEWS_PHRASED_RE.test(q);
}

/** Verticals that must never be answered from a news page. */
const NEEDS_REAL_DATA_RE =
  /\b(weather|forecast|temperature|rain|snow|humidity|wind|storm|cyclone|air quality|uv index)\b|\b(score|scoreline|fixture|match result|standing|league table|who won)\b|\b(usd|eur|gbp|inr|jpy|aud|cad|chf|cny|sgd|aed|sar)\b|\b(rate|exchange rate|forex|fx)\b|\b(stock|share price|bitcoin|btc|ethereum|eth|crypto|market cap|gold price|oil price)\b/i;

/** Questions that genuinely ask for news/events coverage. */
const NEWS_PHRASED_RE =
  /\b(news|headlines?|breaking|announcements?|announced|press release|updates?|developments?|what(?:'s| is| are)?\s+(?:happen(?:ing|ed)?|going on|new)|current events|today'?s news)\b/i;

/**
 * True only for questions that genuinely ask "what happened", with no specific
 * subject. "What happened in the world today?" qualifies; "Live sports
 * score", "Current USD/INR rate" and "Today's weather" do not.
 */
export function isOpenEndedEventsQuestion(query: string): boolean {
  return canUseEventsFrontPage(query);
}

let cached: { date: string; events: ParsedEvent[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60_000;

async function fetchPortal(date: Date): Promise<{ events: ParsedEvent[]; publishedAt: string } | null> {
  const title = portalTitle(date);
  const res = await axios.get(API, {
    params: {
      action: "parse",
      page: title,
      prop: "wikitext",
      format: "json",
      formatversion: "2",
    },
    headers: { "User-Agent": UA },
    timeout: 12_000,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const wikitext = res.data?.parse?.wikitext;
  if (typeof wikitext !== "string" || wikitext.length === 0) return null;
  const events = parseCurrentEvents(wikitext);
  if (events.length === 0) return null;
  return { events, publishedAt: portalPublishedAt(date) };
}

/** Today's events, with yesterday as a fallback for the early-UTC window. */
export async function currentEvents(now = new Date()): Promise<{
  events: ParsedEvent[];
  publishedAt: string;
  date: string;
}> {
  const todayKey = portalTitle(now);
  if (cached && cached.date === todayKey && now.getTime() - cached.fetchedAt < CACHE_TTL_MS) {
    return { events: cached.events, publishedAt: portalPublishedAt(now), date: todayKey };
  }
  let result = await fetchPortal(now);
  if (!result) {
    // Early UTC: today's page is not written yet. Yesterday is still "current"
    // for a human and is honestly labelled with ITS date.
    const yesterday = new Date(now.getTime() - 86_400_000);
    result = await fetchPortal(yesterday);
  }
  if (!result) {
    throw new Error("Wikipedia Current Events returned no parseable page");
  }
  cached = { date: todayKey, events: result.events, fetchedAt: now.getTime() };
  return { events: result.events, publishedAt: result.publishedAt, date: todayKey };
}

export function createWikipediaCurrentEventsProvider(): SearchProvider {
  return {
    id: "wikipedia-current-events",
    label: "Wikipedia Current Events (today's news, dated)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      // Only for freshness-sensitive queries. Never a general web fallback.
      if (!opts?.timeRange) return { citations: [] };

      const { events, publishedAt } = await currentEvents();
      // Ask for more than the caller needs: cross-source dedupe and the
      // domain-diversity cap discard some, and 2 results is not an answer.
      const picked = rankEvents(events, query, Math.min(Math.max(numResults * 2, 6), 20));

      const citations: WebCitation[] = picked.map((e) => ({
        title: `${e.section}: ${e.text.slice(0, 180)}`,
        // The primary report, not the portal summary, is what the user opens.
        url: e.url ?? "https://en.wikipedia.org/wiki/Portal:Current_events",
        snippet: e.text.slice(0, 600),
        // The portal is dated, so the item is genuinely current.
        publishedAt,
        providers: ["Wikipedia Current Events"],
      }));
      return { citations: citations.slice(0, Math.max(numResults, 2)) };
    },
  };
}
