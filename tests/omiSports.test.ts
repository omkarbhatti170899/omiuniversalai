/**
 * LIVE SPORTS SCORES — the last declared gap in the current-information
 * contract (§6: SPORTS must route to live sports data, and ordinary web
 * search must not be dressed up as a scoreboard).
 *
 * These tests pin the parts a user would notice breaking:
 *   • a scoreline only ever appears when the feed actually carried one
 *   • a generic word like "sports" is never treated as a team name
 *   • a wrong-team lookup is rejected rather than served
 *   • a requested score is routed ONLY to the live score feed (strict)
 *   • a live score is stamped with the observation time, not the kick-off
 */
import { describe, expect, it } from "bun:test";

import {
  composeEventCitation,
  detectSport,
  detectTeam,
  hasScoreline,
  isFinishedStatus,
  isLiveStatus,
  isUpcomingStatus,
  normalizeTeamName,
  rankEvents,
  statusPhrase,
  teamNameMatches,
  type SportsEvent,
} from "../src/convex/searchProviders/sports";
import {
  freshnessPolicyFor,
  isLiveWeatherRequest,
  scoreDemanded,
} from "../src/convex/searchEngine/freshness";

const FT: SportsEvent = {
  idEvent: "2269527",
  strEvent: "Ukraine U21 vs Turkey U21",
  strHomeTeam: "Ukraine U21",
  strAwayTeam: "Turkey U21",
  intHomeScore: "2",
  intAwayScore: "2",
  strStatus: "FT",
  strTimestamp: "2026-09-26T16:00:00",
  strLeague: "UEFA European Under-21 Championship",
  strSport: "Soccer",
  idLeague: "4566",
  idHomeTeam: "140337",
};

const UPCOMING: SportsEvent = {
  idEvent: "2494052",
  strEvent: "Arsenal vs Leeds United",
  strHomeTeam: "Arsenal",
  strAwayTeam: "Leeds United",
  intHomeScore: null,
  intAwayScore: null,
  strStatus: "NS",
  strTimestamp: "2026-10-10T11:30:00",
  strLeague: "English Premier League",
  idLeague: "4328",
  idHomeTeam: "133604",
};

const IN_PLAY: SportsEvent = {
  ...FT,
  idEvent: "live1",
  strStatus: "67",
  intHomeScore: "1",
  intAwayScore: "0",
};

describe("sports — a scoreline is never invented", () => {
  it("emits the score only when the feed carried both goals", () => {
    expect(hasScoreline(FT)).toBe(true);
    expect(hasScoreline(UPCOMING)).toBe(false);
    // A half-populated scoreline is not a scoreline.
    expect(hasScoreline({ ...FT, intAwayScore: null })).toBe(false);
  });

  it("never prints a score for a fixture that has not started", () => {
    const c = composeEventCitation(UPCOMING, { now: Date.parse("2026-09-26T12:00:00Z") });
    expect(c).not.toBeNull();
    expect(c!.title).toContain("Arsenal vs Leeds United");
    expect(c!.title).not.toMatch(/\d+\s*–\s*\d+/);
    expect(c!.snippet).toContain("not started");
  });

  it("prints a real score with its competition and kick-off time", () => {
    const c = composeEventCitation(FT, { now: Date.parse("2026-09-26T12:00:00Z") });
    expect(c!.title).toContain("2 – 2");
    expect(c!.title).toContain("UEFA European Under-21 Championship");
    expect(c!.snippet).toContain("full time");
  });

  it("stamps a live score with the OBSERVATION time, not the kick-off", () => {
    // Kick-off was 16:00; we read it at 17:30. Using the kick-off would make
    // the reading look stale and get it thrown away by the freshness gate.
    const now = Date.parse("2026-09-26T17:30:00Z");
    const c = composeEventCitation(FT, { now });
    expect(c!.publishedAt).toBe(new Date(now).toISOString());
  });

  it("cites a resolvable page and says the feed is a small free selection", () => {
    const c = composeEventCitation(FT, { now: Date.now() });
    expect(c!.url).toMatch(/^https:\/\/www\.thesportsdb\.com\/(team|league)\/\d+/);
    expect(c!.snippet).toContain("not the full schedule");
  });

  it("returns null for an event with no usable name", () => {
    expect(composeEventCitation({})).toBeNull();
    expect(composeEventCitation({ strEvent: "   " })).toBeNull();
  });
});

describe("sports — status is reported, never embellished", () => {
  it("separates upcoming, in-play and finished", () => {
    expect(isUpcomingStatus("NS")).toBe(true);
    expect(isUpcomingStatus("ns")).toBe(true);
    expect(isFinishedStatus("FT")).toBe(true);
    expect(isLiveStatus("67")).toBe(true);
    expect(isLiveStatus("HT")).toBe(true);
    // Mutually exclusive.
    expect(isLiveStatus("NS")).toBe(false);
    expect(isLiveStatus("FT")).toBe(false);
    expect(isLiveStatus(null)).toBe(false);
  });

  it("phrases a status from what the feed actually said", () => {
    expect(statusPhrase(FT)).toBe("full time");
    expect(statusPhrase(UPCOMING)).toBe("not started");
    expect(statusPhrase(IN_PLAY)).toContain("in play");
    // A status we do not recognise with no score is "scheduled", never "live".
    expect(statusPhrase({ strStatus: "ZZ" })).toBe("scheduled");
  });

  it("ranks in-play first, then results, then upcoming", () => {
    const order = rankEvents([UPCOMING, FT, IN_PLAY]).map((e) => e.strEvent);
    expect(order[0]).toBe(IN_PLAY.strEvent);
    expect(order[1]).toBe(FT.strEvent);
    expect(order[2]).toBe(UPCOMING.strEvent);
  });
});

describe("sports — a generic word is not a team", () => {
  it("does not look up a team for a bare sports question", () => {
    // This was a real bug: "Live sports score" reduced to the team "sports"
    // and then hard-failed instead of returning today's fixtures.
    expect(detectTeam("Live sports score")).toBeNull();
    expect(detectTeam("latest sports news")).toBeNull();
    expect(detectTeam("premier league standings")).toBeNull();
    expect(detectTeam("what is the score")).toBeNull();
  });

  it("does extract a real team name", () => {
    expect(detectTeam("Mumbai Indians score")).toBe("Mumbai Indians");
    expect(detectTeam("what's the Arsenal score")).toBe("Arsenal");
    expect(detectTeam("Manchester United result today")).toBe("Manchester United");
  });

  it("refuses non-sports and empty candidates", () => {
    expect(detectTeam("")).toBeNull();
    expect(detectTeam("12")).toBeNull();
    expect(detectTeam("weather in Mumbai")).toBeNull();
  });
});

describe("sports — a wrong-team lookup is rejected, not served", () => {
  it("accepts the team the user actually asked for", () => {
    expect(teamNameMatches("Arsenal", "Arsenal")).toBe(true);
    expect(teamNameMatches("Manchester United", "Manchester United")).toBe(true);
    expect(teamNameMatches("Mumbai Indians", "Mumbai Indians")).toBe(true);
  });

  it("rejects the measured Lakers -> Roosevelt mis-resolution", () => {
    // Measured: searchteams.php?t=Lakers returns "Roosevelt" (American
    // Football). Serving that score would be a confidently wrong answer.
    expect(teamNameMatches("Lakers", "Roosevelt")).toBe(false);
  });

  it("ignores club suffixes but not real differences", () => {
    expect(teamNameMatches("Chelsea", "Chelsea FC")).toBe(true);
    expect(teamNameMatches("Arsenal", "Arsenal Women")).toBe(true);
    expect(teamNameMatches("Chelsea", "Manchester City")).toBe(false);
    // "Inter" genuinely is the short name of Internazionale, so accepting the
    // abbreviation is correct — the guard rejects MISMATCHES, not short forms.
    expect(teamNameMatches("Inter", "Internazionale")).toBe(true);
    expect(teamNameMatches("Real Madrid", "Real Betis")).toBe(false);
  });

  it("rejects empty and over-short comparisons", () => {
    expect(teamNameMatches("", "Arsenal")).toBe(false);
    expect(teamNameMatches("Arsenal", "")).toBe(false);
    expect(teamNameMatches("FC", "Barcelona")).toBe(false);
  });

  it("normalizes accents and punctuation", () => {
    expect(normalizeTeamName("Atlético Madrid")).toBe("atletico madrid");
    expect(normalizeTeamName("M.S. Dhoni")).toBe("ms dhoni");
  });
});

describe("sports — routing", () => {
  it("detects the sport the user asked about", () => {
    expect(detectSport("cricket score")).toBe("Cricket");
    expect(detectSport("NBA game tonight")).toBe("Basketball");
    expect(detectSport("premier league result")).toBe("Soccer");
    expect(detectSport("IPL")).toBe("Cricket");
    expect(detectSport("what is the weather")).toBeNull();
  });

  it("knows when a score — not a story — is being asked for", () => {
    expect(scoreDemanded("Live sports score")).toBe(true);
    // "who won the match" wants the result, so it belongs on the scoreboard
    // too — reporting would answer a different question.
    expect(scoreDemanded("who won the match")).toBe(true);
    expect(scoreDemanded("latest news about the World Cup")).toBe(false);
    expect(scoreDemanded("tell me about the team")).toBe(false);
  });

  it("detects freshness on its own, without an intent hint", () => {
    // These are in the current-information keyword list. They used to pass
    // only because the intent classifier said "current", so any caller that
    // omitted the hint would have answered them from model memory.
    for (const q of [
      "live sports score",
      "current USD/INR rate",
      "what is the score right now",
      "breaking update please",
    ]) {
      const p = freshnessPolicyFor(q);
      expect(p.requiresFreshness).toBe(true);
    }
  });

  it("routes a requested score ONLY to the live score feed", () => {
    const p = freshnessPolicyFor("Live sports score");
    expect(p.vertical).toBe("sports");
    expect(p.preferredProviders).toEqual(["sports-scores"]);
    // Strict: if the scoreboard is down, Omi must refuse rather than let a
    // news article answer "what is the score".
    expect(p.strict).toBe(true);
  });

  it("allows news as an answer when the user wants reporting, not a score", () => {
    const p = freshnessPolicyFor("latest news about the cricket world cup");
    expect(p.vertical).toBe("sports");
    expect(p.preferredProviders.length).toBeGreaterThan(1);
    expect(p.strict).toBe(false);
  });

  it("keeps weather strict — a forecast never comes from a news index", () => {
    // A bare "what's the weather" carries no time word but still cannot come
    // from model memory, so it must route to the live weather feed.
    expect(freshnessPolicyFor("what's the weather in Mumbai").strict).toBe(true);
    expect(freshnessPolicyFor("what's the weather in Mumbai").requiresFreshness).toBe(true);
  });

  it("does not route a science question about weather into the forecast feed", () => {
    for (const q of ["what causes rain", "why does it snow", "how does a hurricane form"]) {
      expect(isLiveWeatherRequest(q)).toBe(false);
    }
    expect(isLiveWeatherRequest("will it rain in Mumbai tomorrow")).toBe(true);
    expect(isLiveWeatherRequest("how hot is it right now")).toBe(true);
  });
});

// --- Regression: a live-DATA demand with no time word must still be live -----
//
// Found by the deployed probe: "arsenal score" contains no freshness word, so
// requiresFreshness() said false, the sports vertical lost its strict routing,
// the general fan-out ran, and the answer came back as two paragraphs about
// ammunition-scoring software and the Vendi Score — papers from arXiv/OpenAlex.
// Naming a time word is not what makes a question current; asking for a live
// value is.
describe("live-data demand implies freshness without a time word", () => {
  const cases: Array<[string, string]> = [
    ["arsenal score", "sports"],
    ["arsenal vs chelsea result", "sports"],
    ["mumbai indians score", "sports"],
    ["1 usd to inr", "markets"],
    ["usd inr rate", "markets"],
    ["bitcoin price", "markets"],
  ];
  for (const [query, vertical] of cases) {
    it(`"${query}" routes to ${vertical} and is never answered from memory`, () => {
      const policy = freshnessPolicyFor(query, "knowledge");
      expect(policy.vertical).toBe(vertical);
      expect(policy.requiresFreshness).toBe(true);
      // Strict routing is what stops an unrelated engine from answering.
      expect(policy.strict).toBe(true);
      if (vertical === "sports") expect(policy.preferredProviders).toEqual(["sports-scores"]);
      if (vertical === "markets") expect(policy.preferredProviders[0]).toBe("market-rates");
    });
  }

  // The narrowness guard: mentioning a domain is not asking for a live value.
  it.each([
    "what causes rain",
    "explain the offside rule",
    "what is a stock market",
    "history of the Cricket World Cup",
  ])('"%s" is not forced onto a live feed', (query) => {
    expect(freshnessPolicyFor(query, "knowledge").requiresFreshness).toBe(false);
  });
});

// --- A next fixture must never be dressed up as a played match --------------
describe("next-fixture disclosure", () => {
  const next = {
    strEvent: "Arsenal vs Leeds United",
    strHomeTeam: "Arsenal",
    strAwayTeam: "Leeds United",
    intHomeScore: null,
    intAwayScore: null,
    strStatus: "NS",
    strTimestamp: "2026-10-10T11:30:00",
    strLeague: "English Premier League",
  };
  const played = { ...next, strEvent: "Ukraine U21 vs Turkey U21", intHomeScore: "2", intAwayScore: "2", strStatus: "FT" };

  it("says plainly that an unplayed fixture has no score", () => {
    const c = composeEventCitation(next, { now: 1_700_000_000_000, disclosure: "next-fixture" });
    expect(c!.snippet).toContain("has not been played yet");
    expect(c!.snippet).toContain("NEXT fixture");
    // The old bug: an unplayed fixture was captioned as "today's selection".
    expect(c!.snippet).not.toContain("small selection of today's fixtures");
  });

  it("does not attach the sample caveat to the user's own team's match", () => {
    const c = composeEventCitation(played, { now: 1_700_000_000_000, disclosure: "named-team" });
    expect(c!.title).toContain("2 – 2");
    expect(c!.snippet).not.toContain("small selection");
  });

  it("keeps the sample caveat for a broad today's-sweep", () => {
    const c = composeEventCitation(played, { now: 1_700_000_000_000, disclosure: "today-selection" });
    expect(c!.snippet).toContain("small selection of today's fixtures");
  });
});
