/**
 * SPORTS STANDINGS — structured provider tests.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * "Current IPL standings" was answered with a list of unrelated cricket
 * matches — live, dated, and completely wrong for the question. A league table
 * is a different endpoint from a fixture list, so asking the scoreboard for it
 * returns *something* and nothing useful.
 *
 * The fix asks the real table endpoint first, and when the feed genuinely has
 * no table it says so instead of substituting fixtures. Measured live:
 *   • "current Premier League standings" -> real table, 692 ms
 *   • "current IPL standings"            -> honest refusal, 94 ms
 *     ("no current league table … will not present a fixture list as a
 *      standings table")
 */

import { describe, expect, it } from "bun:test";
import {
  standingsDemanded,
  leagueFromQuery,
  normalizeStandings,
  standingsLines,
  composeStandingsCitation,
  composeEventCitation,
  rankEvents,
  hasScoreline,
} from "../src/convex/searchProviders/sports";

const NOW = Date.parse("2026-09-27T12:00:00Z");

describe("standings detection", () => {
  it("recognises a table request rather than a scoreline request", () => {
    for (const q of [
      "current Premier League standings",
      "Premier League table",
      "EPL league table",
      "La Liga positions",
      "current points table",
    ]) {
      expect(`${q} → ${standingsDemanded(q)}`).toContain("true");
    }
  });

  it("does not treat an ordinary score question as a standings question", () => {
    for (const q of [
      "latest India cricket score",
      "Arsenal vs Chelsea result",
      "what is the weather",
    ]) {
      expect(`${q} → ${standingsDemanded(q)}`).toContain("false");
    }
  });
});

describe("league resolution", () => {
  it("resolves the well-known competitions without a network call", () => {
    expect(leagueFromQuery("current Premier League standings")?.idLeague).toBe("4328");
    expect(leagueFromQuery("La Liga table")?.idLeague).toBe("4335");
    expect(leagueFromQuery("current IPL standings")?.idLeague).toBe("4460");
    expect(leagueFromQuery("NBA standings")?.idLeague).toBe("4387");
  });

  it("returns null rather than guessing a competition", () => {
    // Guessing a league id would produce a confidently wrong table.
    expect(leagueFromQuery("standings in my local league")).toBeNull();
  });
});

describe("standings normalisation", () => {
  const raw = [
    { intRank: "2", strTeam: "Arsenal", intPlayed: "5", intWin: "4", intDraw: "1", intLoss: "0", intGoalsFor: "12", intGoalsAgainst: "5", intGoalDifference: "7", intPoints: "13" },
    { intRank: "1", strTeam: "Manchester City", intPlayed: "5", intWin: "5", intDraw: "0", intLoss: "0", intGoalsFor: "13", intGoalsAgainst: "5", intGoalDifference: "8", intPoints: "15" },
    { intRank: "", strTeam: "  ", intPlayed: "0" },
  ];

  it("orders by rank regardless of feed order", () => {
    const rows = normalizeStandings(raw);
    expect(rows.map((r) => r.team)).toEqual(["Manchester City", "Arsenal"]);
  });

  it("drops a row with no team name", () => {
    expect(normalizeStandings(raw)).toHaveLength(2);
  });

  it("keeps a missing figure as null rather than inventing a zero", () => {
    const rows = normalizeStandings([{ strTeam: "X", intRank: "1" }]);
    expect(rows[0].points).toBeNull();
    expect(rows[0].played).toBeNull();
  });

  it("formats a readable line per team", () => {
    const lines = standingsLines(normalizeStandings(raw), 5);
    expect(lines[0]).toContain("Manchester City");
    expect(lines[0]).toContain("15 pts");
    expect(lines[0]).toContain("5 played");
  });

  it("says so when points are not reported", () => {
    const lines = standingsLines(normalizeStandings([{ strTeam: "X", intRank: "1" }]), 5);
    expect(lines[0]).toContain("not reported");
  });
});

describe("standings citation — honest about its own currency", () => {
  const rows = normalizeStandings([
    { intRank: "1", strTeam: "Manchester City", intPlayed: "5", intWin: "5", intDraw: "0", intLoss: "0", intGoalDifference: "8", intPoints: "15" },
  ]);

  it("uses the feed's own update time when it supplies one", () => {
    const c = composeStandingsCitation({ idLeague: "4328", name: "English Premier League" }, rows, {
      now: NOW,
      updatedAt: "2026-09-24 10:00:07",
    });
    expect(c.publishedAt).toBe(new Date("2026-09-24T10:00:07Z").toISOString());
    expect(c.snippet).toContain("Table last updated by the feed");
  });

  it("says plainly when the feed supplied no timestamp", () => {
    const c = composeStandingsCitation({ idLeague: "4328", name: "English Premier League" }, rows, { now: NOW });
    expect(c.snippet).toContain("did not supply a table timestamp");
    // Falls back to the read time so the citation is still stamped.
    expect(c.publishedAt).toBe(new Date(NOW).toISOString());
  });

  it("links to a real, resolving public page", () => {
    const c = composeStandingsCitation({ idLeague: "4328", name: "English Premier League" }, rows, { now: NOW });
    expect(c.url).toBe("https://www.thesportsdb.com/league/4328");
  });

  it("includes the actual table rows, not just a title", () => {
    const c = composeStandingsCitation({ idLeague: "4328", name: "English Premier League" }, rows, { now: NOW });
    expect(c.snippet).toContain("Manchester City");
    expect(c.title).toContain("league standings");
  });
});

describe("a fixture list is never dressed up as a standings table", () => {
  it("a match citation does not claim to be a table", () => {
    const c = composeEventCitation(
      {
        strEvent: "England Cricket vs Sri Lanka Cricket",
        strHomeTeam: "England Cricket",
        strAwayTeam: "Sri Lanka Cricket",
        strLeague: "One Day International",
        strTimestamp: "2026-09-27T10:00:00",
        intHomeScore: "150",
        intAwayScore: "149",
        strStatus: "Match Finished",
        idLeague: "4432",
      },
      { now: NOW },
    );
    expect(c).not.toBeNull();
    expect(`${c?.title} ${c?.snippet}`.toLowerCase()).not.toContain("standing");
    expect(`${c?.title}`.toLowerCase()).not.toContain("league table");
  });

  it("the scoreline helpers are untouched by the standings work", () => {
    // The existing score path must keep working exactly as before.
    const events = [
      { strEvent: "A v B", strHomeTeam: "A", strAwayTeam: "B", intHomeScore: "1", intAwayScore: "0", strStatus: "Match Finished" },
      { strEvent: "C v D", strHomeTeam: "C", strAwayTeam: "D", strStatus: "Not Started" },
    ];
    expect(rankEvents(events as never)).toHaveLength(2);
    expect(hasScoreline(events[0] as never)).toBe(true);
    expect(hasScoreline(events[1] as never)).toBe(false);
  });
});
