import axios from "axios";
import {
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./types";

/**
 * Live sports scores — TheSportsDB.
 *
 * Why this exists: §6 of the current-information brief requires SPORTS to route
 * to LIVE SPORTS DATA, and explicitly forbids pretending ordinary web search is
 * a real-time database. A news article saying "Arsenal beat Chelsea 2-1" is not a
 * scoreboard. Until this provider existed, Omi refused sports questions — which
 * was honest but left the capability unimplemented.
 *
 * MEASURED 2026-09-26 against the live API (keyless public test key "3"):
 *
 *   eventsday.php?d=2026-09-26&s=Soccer   → HTTP 200 JSON, 3 events with real
 *        scorelines and statuses, e.g. "Ukraine U21 2 - 2 Turkey U21", FT
 *   eventsday.php?d=2026-09-26&s=Cricket  → HTTP 200 JSON, 0 events (nothing on)
 *   searchteams.php?t=Mumbai%20Indians    → HTTP 200 JSON, resolves the team
 *   searchteams.php?t=zzzznotateam        → HTTP 200 JSON, no match
 *
 * Two measured limitations are designed around, not hidden:
 *
 *   1. FREE-TIER CAP. The public key returns at most ~3 events per request, so
 *      "today's scores" is genuinely "a few of today's scores", never the full
 *      slate. The citation says so rather than implying completeness.
 *   2. LOOSE TEAM SEARCH. `searchteams.php?t=Lakers` returns "Roosevelt"
 *      (American Football) — a confidently wrong team. `teamNameMatches`
 *      therefore re-validates every lookup against what the user actually
 *      typed, and a mismatch is reported as "could not resolve" instead of
 *      serving another team's score.
 *
 * Honesty rules baked in:
 *   • A scoreline is emitted only when the feed carries both scores.
 *   • `publishedAt` is the retrieval time, because a live score's "publish
 *     time" IS the moment it was observed (same principle as weather).
 *   • No event found ⇒ throw, so the chat layer shows the honest
 *     "cannot verify" path. This provider never invents a fixture.
 *
 * Set SPORTSDB_API_KEY to a personal TheSportsDB key for a higher tier; the
 * public test key is the free default. $0, no account required.
 */

const API_BASE = "https://www.thesportsdb.com/api/v1/json";
const DEFAULT_KEY = "3";
const TIMEOUT_MS = 9_000;

/** Queried when the user names no sport — the three most-followed codes. */
const DEFAULT_SPORTS = ["Soccer", "Basketball", "Ice Hockey"];

const UPCOMING = new Set(["ns", "not started", "postponed", "pst", "post", "canceled", "cancelled"]);
const FINISHED = new Set(["ft", "ft (pen)", "aot", "aet", "match finished", "final", "completed"]);

// --- Pure helpers (unit-tested; no network) ---------------------------------

/** Map free-text sport words onto TheSportsDB's `strSport` values. */
const SPORT_WORDS: Array<[RegExp, string]> = [
  [/\b(cricket|ipl|t20|odi|test match|wicket|innings|batting)\b/i, "Cricket"],
  [/\b(soccer|football|premier league|la liga|serie a|bundesliga|champions league|epl|goal)\b/i, "Soccer"],
  [/\b(basketball|nba|wnba|euroleague)\b/i, "Basketball"],
  [/\b(ice hockey|hockey|nhl|nhl|stanley cup)\b/i, "Ice Hockey"],
  [/\b(baseball|mlb)\b/i, "Baseball"],
  [/\b(american football|nfl|ncaa football)\b/i, "American Football"],
  [/\b(rugby)\b/i, "Rugby"],
  [/\b(tennis|wimbledon|open final|atp|wta)\b/i, "Tennis"],
  [/\b(formula 1|f1|grand prix)\b/i, "Racing"],
  [/\b(golf|pga|ryder cup)\b/i, "Golf"],
  [/\b(mma|ufc|boxing|fight)\b/i, "Fighting"],
];

/** Pure: which sport is the user asking about? null when unspecified. */
export function detectSport(query: string): string | null {
  const q = query ?? "";
  for (const [re, sport] of SPORT_WORDS) if (re.test(q)) return sport;
  return null;
}

const SPORT_NOISE =
  /\b(score|scores|scoreline|scorelines|final|finals|result|results|standings|table|fixture|fixtures|match|matches|game|games|who|what|when|where|is|are|the|a|an|of|in|on|at|vs|v|and|or|did|do|does|they|he|she|it|my|our|today|tonight|now|right now|rightnow|current|currently|live|latest|recent|updated|breaking|as of|please|tell|me|show|give|get|any|anyones|news|update|updates|this|last|night|week|day|hour|just|still|yet|so|far|goin|going|happen|happening|status|table)\b/gi;

/** Pure: a plausible team name typed by the user, or null. */
export function detectTeam(query: string): string | null {
  const q = (query ?? "").trim();
  if (!q) return null;
  if (/\b(weather|news|exchange|rate|stock|price|bitcoin|crypto)\b/i.test(q)) return null;
  // Drop the question scaffolding and the score vocabulary, then keep what is
  // left only if it is short enough to plausibly be a team.
  const cleaned = q
    .replace(/[?.,!]+/g, " ")
    .replace(/\bwhat'?s\b|\bwhere'?s\b|\bwho'?s\b|\bhow'?s\b|\bwhich\b|\bthere\b|\bgoing\b/gi, " ")
    .replace(SPORT_NOISE, " ")
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]'(s|re|ve|ll|d|t)\b/gi, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  const candidate = words.join(" ").trim();
  if (candidate.length < 3) return null;
  if (/^\d+$/.test(candidate)) return null;
  // A generic sport word is not a team. "Live sports score" reduces to
  // "sports" after the noise strip, and searching the feed for a team called
  // "sports" produced a confusing hard failure instead of today's fixtures.
  const GENERIC_SPORT_WORDS = new Set([
    "sports", "sport", "game", "games", "match", "matches", "team", "teams",
    "club", "clubs", "league", "leagues", "cup", "final", "finals", "season",
    "tournament", "tournaments", "competition", "fixtures", "scores", "score",
    "results", "standings", "table", "today", "live", "now", "current",
    "latest", "news", "update", "updates", "football", "soccer", "cricket",
    "basketball", "hockey", "baseball", "rugby", "tennis", "golf", "nba",
    "nfl", "nhl", "ipl", "f1", "premier league", "champions league",
  ]);
  if (GENERIC_SPORT_WORDS.has(candidate.toLowerCase())) return null;
  // Reject when EVERY word is generic — "soccer premier" is not a club.
  if (words.every((w) => GENERIC_SPORT_WORDS.has(w.toLowerCase()))) return null;
  return candidate;
}

const CLUB_SUFFIX =
  /\b(fc|cf|afc|sc|ac|as|ss|sv|us|ud|cd|rc|vfl|vfb|bsc|tsg|1\.\s*fc|united|city|town|rovers|wanderers|county|club)\b/g;

/** Pure: normalize a club name for comparison. */
export function normalizeTeamName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(CLUB_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure: does the feed's team actually match what the user asked for?
 *
 * Guards the measured `t=Lakers -> "Roosevelt"` failure. Equal names always
 * match; a strict prefix/substring match is allowed only when the shorter name
 * is long enough to be specific, so "Arsenal" matches "Arsenal FC" but
 * "Lakers" cannot match "Roosevelt".
 */
export function teamNameMatches(asked: string, returned: string): boolean {
  const a = normalizeTeamName(asked);
  const b = normalizeTeamName(returned);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  return long.startsWith(short) || short.startsWith(long) || long.includes(` ${short}`);
}

/** Pure: a fixture that has not started. */
export function isUpcomingStatus(status: string | null | undefined): boolean {
  return UPCOMING.has((status ?? "").trim().toLowerCase());
}

/** Pure: a fixture that is over. */
export function isFinishedStatus(status: string | null | undefined): boolean {
  return FINISHED.has((status ?? "").trim().toLowerCase());
}

/** Pure: in play. Anything that is neither upcoming nor finished but has a state. */
export function isLiveStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").trim();
  if (!s) return false;
  return !isUpcomingStatus(s) && !isFinishedStatus(s);
}

export type SportsEvent = {
  idEvent?: string;
  strEvent?: string;
  strHomeTeam?: string;
  strAwayTeam?: string;
  intHomeScore?: string | number | null;
  intAwayScore?: string | number | null;
  strStatus?: string | null;
  strTimestamp?: string | null;
  strTime?: string | null;
  strLeague?: string | null;
  strSport?: string | null;
  idLeague?: string | null;
  idHomeTeam?: string | null;
  idAwayTeam?: string | null;
  /** Live-scoreboard-only: the in-play clock (e.g. "45'") or period label. */
  strProgress?: string | null;
};

function scoreOf(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pure: does this event carry an actual scoreline? */
export function hasScoreline(e: SportsEvent): boolean {
  return scoreOf(e.intHomeScore) !== null && scoreOf(e.intAwayScore) !== null;
}

/** Pure: a human status phrase, never invented beyond what the feed says. */
export function statusPhrase(e: SportsEvent): string {
  const raw = (e.strStatus ?? "").trim();
  if (hasScoreline(e)) {
    if (isFinishedStatus(raw)) return raw === "FT" ? "full time" : "finished";
    if (isUpcomingStatus(raw)) return "not started";
    return raw ? `in play (${raw})` : "in play";
  }
  if (isUpcomingStatus(raw)) return "not started";
  return "scheduled";
}

/**
 * Pure: build the citation. A scoreline appears ONLY when the feed has both
 * scores, so Omi can never show a half-empty or invented score.
 */
export type SportsDisclosure =
  /** A broad "today's scores" sweep — the free tier shows only a few events. */
  | "today-selection"
  /** The named team's own next fixture, which has not been played. */
  | "next-fixture"
  /** The named team's own match today, so the sample caveat does not apply. */
  | "named-team"
  /**
   * The live scoreboard (`livescore.php`): matches in play RIGHT NOW. Only
   * used when the feed actually reports in-play matches, so the caveat is
   * about scopeness (live only, not full-time results), not about staleness.
   */
  | "live-in-play";

const DISCLOSURE_TEXT: Record<SportsDisclosure, string> = {
  "today-selection":
    "Free-tier feed: this is a small selection of today's fixtures, not the full schedule.",
  "next-fixture":
    "This is the team's NEXT fixture, not a played match — it has no score yet. " +
    "Omi is showing the schedule because the feed reports no live or completed match for this team today.",
  "live-in-play":
    "Live scoreboard: these matches are in play right now, as reported by the feed. " +
    "Completed results from earlier today are not included.",
  "named-team": "",
};

export function composeEventCitation(
  e: SportsEvent,
  opts: { now?: number; freeTier?: boolean; disclosure?: SportsDisclosure } = {},
): WebCitation | null {
  const disclosure = opts.disclosure ?? "today-selection";
  const now = opts.now ?? Date.now();
  const home = (e.strHomeTeam ?? "").trim();
  const away = (e.strAwayTeam ?? "").trim();
  const name = (e.strEvent ?? `${home} v ${away}`).replace(/\s+/g, " ").trim();
  // A blank/"v"-only composed name is not a real fixture.
  if (!name || name === "v" || name.length < 3) return null;

  const hs = scoreOf(e.intHomeScore);
  const as = scoreOf(e.intAwayScore);
  const score = hs !== null && as !== null ? `${hs} – ${as}` : null;
  const when = (e.strTimestamp ?? "").trim();
  const league = (e.strLeague ?? "").trim();

  const titleParts = [name];
  if (score) titleParts.push(score);
  const progress = (e.strProgress ?? "").trim();
  const context = [
    league,
    progress && isLiveStatus(e.strStatus) ? progress : "",
    when ? when.replace("T", " ") : (e.strTime ?? "").trim(),
  ]
    .filter(Boolean)
    .join(" · ");
  if (context) titleParts.push(`(${context})`);

  const snippetParts: string[] = [
    `${name} — ${statusPhrase(e)}${score ? `, ${score}` : ""}.`,
  ];
  if (league) snippetParts.push(`Competition: ${league}.`);
  if (progress && isLiveStatus(e.strStatus)) snippetParts.push(`In play: ${progress}.`);
  if (when) snippetParts.push(`Scheduled/kicked off ${when.replace("T", " ")} (as given by the feed).`);
  if (disclosure === "next-fixture" && !score) {
    snippetParts[0] = `${name} has not been played yet — no score exists for it.`;
  }
  if (opts.freeTier !== false && DISCLOSURE_TEXT[disclosure]) {
    snippetParts.push(DISCLOSURE_TEXT[disclosure]);
  }
  snippetParts.push("Live score data from TheSportsDB. Figures as reported by the feed.");

  // Prefer a stable, verified public page. /match/{id} 404s (measured), while
  // /team/{id} and /league/{id} both resolve.
  const url =
    (e.idHomeTeam && `https://www.thesportsdb.com/team/${e.idHomeTeam}`) ||
    (e.idLeague && `https://www.thesportsdb.com/league/${e.idLeague}`) ||
    "https://www.thesportsdb.com/";

  return {
    title: titleParts.join(" "),
    url,
    snippet: snippetParts.join(" "),
    // A live score's freshness is the moment it was read. The observation time
    // IS the publish time; stamping the kick-off time would make a 3-hour-old
    // in-play game look stale and get it discarded.
    publishedAt: new Date(now).toISOString(),
    author: (e.strSport ?? "").trim() || undefined,
  };
}

/** Pure: rank live first, then results, then upcoming, then most recent. */
export function rankEvents(events: SportsEvent[]): SportsEvent[] {
  return [...events]
    .map((e, i) => ({ e, i }))
    .sort((x, y) => {
      const tier = (e: SportsEvent) =>
        isLiveStatus(e.strStatus) ? 0 : hasScoreline(e) ? 1 : 2;
      const d = tier(x.e) - tier(y.e);
      if (d !== 0) return d;
      const ts = (e: SportsEvent) => Date.parse(e.strTimestamp ?? "") || 0;
      const dts = ts(y.e) - ts(x.e);
      if (dts !== 0) return dts;
      return x.i - y.i;
    })
    .map((x) => x.e);
}

// --- Provider ---------------------------------------------------------------

function key(): string {
  return (process.env.SPORTSDB_API_KEY ?? "").trim() || DEFAULT_KEY;
}

async function getJson<T>(endpoint: string, params: Record<string, string>): Promise<T | null> {
  try {
    const res = await axios.get(`${API_BASE}/${key()}/${endpoint}`, {
      params,
      timeout: TIMEOUT_MS,
      headers: { Accept: "application/json" },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return (res.data ?? null) as T | null;
  } catch {
    return null;
  }
}

function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

type EventsPayload = { events?: SportsEvent[] | null };
type TeamsPayload = {
  teams?: Array<{ idTeam?: string; strTeam?: string; strSport?: string | null }> | null;
};

/**
 * The public demo key is rate limited and returns an EMPTY `events` array
 * rather than an error once you trip it. Measured: the same request that
 * returned 3 fixtures a minute earlier returned 0 from the Convex egress IP
 * after a few probe runs. Two defences:
 *
 *   1. a short cache, so a burst of questions costs one upstream call
 *   2. sequential fetches with one retry, because three simultaneous requests
 *      are the fastest way to trip a per-minute limit
 */
const SPORTS_CACHE_TTL_MS = 90_000;
const todayCache = new Map<string, { at: number; events: SportsEvent[] }>();

async function fetchEventsDay(sport: string | null, now: number): Promise<SportsEvent[]> {
  const params: Record<string, string> = { d: todayUtc(now) };
  if (sport) params.s = sport;
  const data = await getJson<EventsPayload>("eventsday.php", params);
  const events = data?.events;
  return Array.isArray(events) ? events : [];
}

async function eventsForToday(sport: string | null, now: number): Promise<SportsEvent[]> {
  const date = todayUtc(now);
  const cacheKey = `${date}|${sport ?? "*"}`;
  const hit = todayCache.get(cacheKey);
  if (hit && now - hit.at < SPORTS_CACHE_TTL_MS) return hit.events;

  let events = await fetchEventsDay(sport, now);
  // An empty result is the rate limiter's signature. One patient retry, not
  // three parallel requests.
  if (events.length === 0) {
    await new Promise((r) => setTimeout(r, 350));
    events = await fetchEventsDay(sport, now);
  }
  // Only a NON-empty result is worth caching; caching an empty one would
  // suppress the feed for 90 seconds after a transient block.
  if (events.length > 0) todayCache.set(cacheKey, { at: now, events });
  return events;
}

/** Sequential, not parallel: parallel fan-out trips the demo-key rate limit. */
async function eventsForSports(sports: string[], now: number): Promise<SportsEvent[]> {
  const all: SportsEvent[] = [];
  for (const sport of sports) {
    if (all.length > 0) await new Promise((r) => setTimeout(r, 120));
    all.push(...(await eventsForToday(sport, now)));
  }
  return all;
}

/**
 * `livescore.php` — the feed's dedicated in-play scoreboard.
 *
 * MEASURED 2026-09-27 with the free key: `livescore.php?s=Soccer` returned 43
 * in-play matches with real `intHomeScore`/`intAwayScore`/`strStatus`/`strProgress`
 * and no key required. Unlike `eventsday.php` (which lists the day's fixtures,
 * many of them not yet started), this returns ONLY matches in play, so a
 * "live score" question gets an actual scoreline instead of a schedule.
 *
 * A 30 s cache: the board is genuinely live, so a fresh reading every half
 * minute is right, and it keeps a burst of questions to one upstream call.
 */
const LIVE_CACHE_TTL_MS = 30_000;
const liveCache = new Map<string, { at: number; events: SportsEvent[] }>();

type LivePayload = { livescore?: SportsEvent[] | null };

async function fetchLiveScores(sport: string, now: number): Promise<SportsEvent[]> {
  const hit = liveCache.get(sport);
  if (hit && now - hit.at < LIVE_CACHE_TTL_MS) return hit.events;
  const data = await getJson<LivePayload>("livescore.php", { s: sport });
  const raw = data?.livescore;
  // Only keep rows with a real scoreline; the scoreboard is worthless otherwise.
  const events = (Array.isArray(raw) ? raw : []).filter(hasScoreline);
  liveCache.set(sport, { at: now, events });
  return events;
}

/** In-play matches across sports, sequential to respect the free-tier limit. */
async function liveScoresForSports(sports: string[], now: number): Promise<SportsEvent[]> {
  const all: SportsEvent[] = [];
  for (const sport of sports) {
    if (all.length > 0) await new Promise((r) => setTimeout(r, 120));
    all.push(...(await fetchLiveScores(sport, now)));
  }
  return all;
}

export function createSportsProvider(): SearchProvider {
  return {
    id: "sports-scores",
    label: "Live sports scores (TheSportsDB)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query: string, numResults: number): Promise<SearchProviderResult> {
      const now = Date.now();
      const sport = detectSport(query);
      const team = detectTeam(query);
      const limit = Math.max(1, Math.min(numResults, 6));

      const build = (events: SportsEvent[], disclosure: SportsDisclosure): WebCitation[] =>
        rankEvents(events)
          .map((e) => composeEventCitation(e, { now, disclosure }))
          .filter((c): c is WebCitation => c !== null)
          .slice(0, limit);

      // --- A named team: resolve it, then re-validate the resolution. --------
      if (team) {
        const found = await getJson<TeamsPayload>("searchteams.php", { t: team });
        const candidates = (found?.teams ?? []).filter(
          (t) => typeof t.strTeam === "string" && teamNameMatches(team, t.strTeam as string),
        );
        if (candidates.length > 0) {
          const id = candidates[0].idTeam;
          const teamSport = sport ?? (candidates[0].strSport ?? null);
          // The live scoreboard first: if the team is playing RIGHT NOW, this
          // is where the current scoreline is, and it is more current than the
          // day's fixture list.
          if (teamSport) {
            const live = (await fetchLiveScores(teamSport, now)).filter((e) =>
              [e.strHomeTeam, e.strAwayTeam].some(
                (n) => typeof n === "string" && teamNameMatches(team, n as string),
              ),
            );
            if (live.length > 0) return { citations: build(live, "named-team") };
          }
          const today = await eventsForToday(teamSport, now);
          const mine = today.filter((e) =>
            [e.strHomeTeam, e.strAwayTeam].some(
              (n) => typeof n === "string" && teamNameMatches(team, n as string),
            ),
          );
          if (mine.length > 0) {
            return { citations: build(mine, "named-team") };
          }
          // No match today: report the next fixture honestly, marked as
          // upcoming, so "what is the score" does not return a stale result.
          if (id) {
            const next = await getJson<EventsPayload>("eventsnext.php", { id });
            const nextEvents = Array.isArray(next?.events) ? next.events : [];
            if (nextEvents.length > 0) {
              return { citations: build(nextEvents, "next-fixture") };
            }
          }
        }
        // A team was named but the feed could not confirm it right now.
        if (sport) {
          const fallback = build(await eventsForToday(sport, now), "today-selection");
          if (fallback.length > 0) return { citations: fallback };
        }
        throw new Error(
          `TheSportsDB has no current fixture for "${team}" right now — Omi will not invent a scoreline.`,
        );
      }

      // --- No team named: the live scoreboard first, then today's fixtures.
      const sports = sport ? [sport] : DEFAULT_SPORTS;
      const live = await liveScoresForSports(sports, now);
      if (live.length > 0) {
        return { citations: build(live, "live-in-play") };
      }
      const all = await eventsForSports(sports, now);
      const citations = build(all, "today-selection");
      if (citations.length === 0) {
        throw new Error(
          sport
            ? `TheSportsDB reports no live or scheduled ${sport} matches for ${todayUtc(now)}.`
            : `TheSportsDB reports no live or scheduled matches for ${todayUtc(now)} in ${sports.join(", ")}.`,
        );
      }
      return { citations };
    },
  };
}
