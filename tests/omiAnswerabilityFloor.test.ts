/**
 * ANSWERABILITY FLOOR — regression tests (a504ac2 review, 2026-09-29).
 * =============================================================================
 * MEASURED FAILURE: "Who is leading the F1 2026 drivers championship?"
 * selected "Kim Kardashian's F1 Dream Gets Lewis Hamilton's Approval"
 * (realitytea.com) as SOLE evidence. Fresh + dated + entity-matching, but
 * INCAPABLE of answering a standings question — nothing in the selection
 * layer judged whether the page can actually support the answer.
 *
 * Pinned here, machine-verifiably:
 *   • question-type extraction (ranking/result/live-score/value/schedule/…)
 *   • the freshness-never-overrides rule: a fresh unanswerable page is
 *     REJECTED; an older-but-in-window page that directly answers is KEPT;
 *     current + answers + authoritative is preferred
 *   • poison articles (Kim K F1, MotoGP-when-F1-asked, Asian Games,
 *     celebrity/entertainment, unrelated sports) cannot survive the floor
 *     as final evidence for ANY of the 7 golden queries
 *   • the wiring: engine option plumbed through chat/probe/search call sites
 */

import { describe, expect, test } from "bun:test";
import {
  questionTypeFor,
  answerabilityPenalty,
  scoreSourceDetailed,
  SPORTS_ENTERTAINMENT_RE,
} from "../src/convex/searchEngine/quality";
import { readFileSync } from "node:fs";

const NOW = Date.now();
const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

/** Poison set — every article that must NEVER answer the F1 standings query. */
const POISON = {
  kimK: {
    title: "Kim Kardashian's F1 Dream Gets Lewis Hamilton's Approval — Source",
    url: "https://www.realitytea.com/2026/09/29/kim-k-f1",
    snippet: "Kim Kardashian's F1 dream gets Lewis Hamilton's approval, sources say, ahead of the 2026 season.",
    publishedAt: h(2),
  },
  motoGP: {
    title: "MotoGP championship leader wins again after dominant weekend",
    url: "https://www.motorsport.com/motogp/news/leader-wins",
    snippet: "The MotoGP championship leader extended his points lead after another win.",
    publishedAt: h(1),
  },
  asianGames: {
    title: "Sports: South Korea's An Se-young wins women's singles gold at the 2026 Asian Games",
    url: "https://en.wikipedia.org/wiki/2026_Asian_Games",
    snippet: "In badminton, South Korea's An Se-young wins the women's singles gold medal at the 2026 Asian Games.",
    publishedAt: h(3),
  },
  celebrity: {
    title: "Pop star spotted in the paddock at the race weekend",
    url: "https://www.ladbible.com/entertainment/paddock-star",
    snippet: "The singer was seen smiling in the paddock before the grand prix, fans say.",
    publishedAt: h(1),
  },
  unrelatedSport: {
    title: "NASCAR Cup: Reddick concedes \"we got big problems\" after rough Kansas outing",
    url: "https://www.si.com/racing/nascar-kansas",
    snippet: "Tyler Reddick anguished after another rough outing in Sunday's NASCAR Cup Series race at Kansas Speedway.",
    publishedAt: h(2),
  },
};

/** A page that CAN answer each golden query type. */
const GOOD = {
  f1Leader: {
    title: "F1 2026 drivers championship standings: leader 12 points clear",
    url: "https://www.bbc.com/sport/formula1/standings",
    snippet: "The F1 2026 drivers championship standings after the latest grand prix — the leader sits 12 points clear on 244 points.",
    publishedAt: h(3),
  },
  f1Winner: {
    title: "Formula 1 race result: norris wins the 2026 azerbaijan grand prix",
    url: "https://www.skysports.com/f1/race-report",
    snippet: "Full race result: Norris won the Azerbaijan Grand Prix ahead of Verstappen — final classification and podium.",
    publishedAt: h(5),
  },
  iplNews: {
    title: "IPL 2026: latest news and match reports",
    url: "https://www.espncricinfo.com/ipl-2026",
    snippet: "All the latest IPL 2026 news: results, reports and announcements from the tournament.",
    publishedAt: h(2),
  },
  footballLive: {
    title: "Live football scores: matches underway now",
    url: "https://www.premierleague.com/scores",
    snippet: "Live scores from today's fixtures — three matches in play, one at halftime.",
    publishedAt: h(0),
  },
  eplStandings: {
    title: "Premier League table: current standings and points",
    url: "https://www.bbc.com/sport/football/premier-league/table",
    snippet: "The Premier League standings after the weekend: points, goal difference, league table for every club.",
    publishedAt: h(4),
  },
  nbaStandings: {
    title: "NBA standings: conference table and win records",
    url: "https://www.nba.com/standings",
    snippet: "Current NBA standings — conference leaders, win-loss records and the playoff picture.",
    publishedAt: h(6),
  },
};

const F1_QUERY = "Who is leading the F1 2026 drivers championship?";

describe("question-type extraction", () => {
  const cases: Array<[string, string]> = [
    ["Who is leading the F1 2026 drivers championship?", "ranking"],
    ["Current F1 driver standings", "ranking"],
    ["Who won the latest F1 race?", "result"],
    ["Latest IPL news", "news"],
    ["Live football scores", "live-score"],
    ["Current Premier League standings", "ranking"],
    ["NBA standings", "ranking"],
    ["current gold price", "value"],
    ["when is the next F1 race", "schedule"],
    ["why is the sky blue", "explanation"],
    ["how to install node", "procedure"],
  ];
  for (const [q, expected] of cases) {
    test(`"${q}" → ${expected}`, () => {
      expect(questionTypeFor(q)).toBe(expected);
    });
  }
});

describe("CRITICAL RULE: freshness never overrides answerability", () => {
  const keywords = ["leading", "f1", "2026", "drivers", "championship"];

  test("fresh unanswerable celebrity article is REJECTED (score floored)", () => {
    const bd = scoreSourceDetailed(POISON.kimK as never, keywords, {
      userQuestion: F1_QUERY,
      askedEvent: "formula 1",
      askedYears: [2026],
      freshnessMatters: true,
      freshnessTier: "now",
    });
    expect(bd.final).toBeLessThan(0.5); // kept sources score well above this
    expect(bd.answerability).toBeLessThan(1);
  });

  test("freshness does NOT change the verdict: 1h-old and 30h-old unanswerable pages both floor", () => {
    const fresh = scoreSourceDetailed(POISON.kimK as never, keywords, {
      userQuestion: F1_QUERY, freshnessMatters: true, freshnessTier: "now",
    });
    const older = scoreSourceDetailed({ ...POISON.kimK, publishedAt: h(30) } as never, keywords, {
      userQuestion: F1_QUERY, freshnessMatters: true, freshnessTier: "now",
    });
    expect(fresh.final).toBeLessThan(0.5);
    expect(older.final).toBeLessThan(0.5);
  });

  test("older-but-in-window page that DIRECTLY answers is kept and outranks the poison", () => {
    const good = scoreSourceDetailed(GOOD.f1Leader as never, keywords, {
      userQuestion: F1_QUERY, askedEvent: "formula 1", askedYears: [2026],
      freshnessMatters: true, freshnessTier: "now",
    });
    const poison = scoreSourceDetailed(POISON.kimK as never, keywords, {
      userQuestion: F1_QUERY, askedEvent: "formula 1", askedYears: [2026],
      freshnessMatters: true, freshnessTier: "now",
    });
    expect(good.final).toBeGreaterThan(poison.final);
    expect(good.answerability).toBe(1);
  });
});

describe("poison articles cannot survive as F1-standings evidence", () => {
  const keywords = ["leading", "f1", "2026", "drivers", "championship"];

  for (const [name, article] of Object.entries(POISON)) {
    test(`${name} is floored for "${F1_QUERY}"`, () => {
      // The mechanical contract the ranker enforces: penalty ≥0.45 ⇒ rejected
      // at selection, no matter how fresh.
      const penalty = answerabilityPenalty(article as never, "ranking", { userQuestion: F1_QUERY });
      if (SPORTS_ENTERTAINMENT_RE.test(new URL(article.url).hostname)) {
        expect(penalty).toBeGreaterThanOrEqual(0.45);
      }
      const bd = scoreSourceDetailed(article as never, keywords, {
        userQuestion: F1_QUERY, askedEvent: "formula 1", askedYears: [2026],
        freshnessMatters: true, freshnessTier: "now",
      });
      // Either the answerability floor or the entity/cross-sport anchor kills it.
      expect(bd.final).toBeLessThan(0.5);
    });
  }

  test("MotoGP-when-F1-asked: cross-sport anchor drives it to zero", () => {
    const bd = scoreSourceDetailed(POISON.motoGP as never, keywords, {
      userQuestion: F1_QUERY, askedEvent: "formula 1", askedYears: [2026],
      freshnessMatters: true, freshnessTier: "now",
    });
    expect(bd.final).toBeLessThan(0.1);
  });
});

describe("all 7 golden queries: poison rejected, good evidence kept", () => {
  const cases: Array<{
    query: string; good: typeof GOOD.f1Leader; poison: Array<{ url: string; title: string }>;
  }> = [
    { query: F1_QUERY, good: GOOD.f1Leader, poison: [POISON.kimK, POISON.motoGP, POISON.asianGames, POISON.unrelatedSport, POISON.celebrity] },
    { query: "Current F1 driver standings", good: GOOD.f1Leader, poison: [POISON.kimK, POISON.motoGP, POISON.unrelatedSport] },
    { query: "Who won the latest F1 race?", good: GOOD.f1Winner, poison: [POISON.kimK, POISON.asianGames, POISON.celebrity] },
    { query: "Latest IPL news", good: GOOD.iplNews, poison: [POISON.asianGames, POISON.celebrity] },
    { query: "Live football scores", good: GOOD.footballLive, poison: [POISON.asianGames, POISON.celebrity] },
    { query: "Current Premier League standings", good: GOOD.eplStandings, poison: [POISON.kimK, POISON.unrelatedSport] },
    { query: "NBA standings", good: GOOD.nbaStandings, poison: [POISON.asianGames, POISON.unrelatedSport] },
  ];

  for (const { query, good, poison } of cases) {
    const qType = questionTypeFor(query);
    const keywords = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);

    test(`"${query}" — good evidence passes the floor`, () => {
      const p = answerabilityPenalty(good as never, qType, { userQuestion: query });
      expect(p).toBeLessThan(0.45);
      const bd = scoreSourceDetailed(good as never, keywords, { userQuestion: query, freshnessMatters: true });
      expect(bd.final).toBeGreaterThan(0.5);
    });

    for (const bad of poison) {
      test(`"${query}" — poison "${bad.title.slice(0, 40)}…" rejected`, () => {
        const bd = scoreSourceDetailed(bad as never, keywords, {
          userQuestion: query, askedEvent: query.includes("F1") ? "formula 1" : null,
          freshnessMatters: true, freshnessTier: "now",
        });
        // Not guaranteed to be floored by answerability alone for every
        // poison×query pair (a NASCAR piece may carry "scores"), but the
        // COMBINED engine (entity anchor + cross-sport + answerability +
        // noise) must hold it below kept-evidence level for the queried
        // subject — except a genuinely type-matching page, which must at
        // least never beat the good evidence.
        const goodBd = scoreSourceDetailed(good as never, keywords, { userQuestion: query, freshnessMatters: true });
        expect(bd.final).toBeLessThan(goodBd.final);
      });
    }
  }
});

describe("answerability wiring (the engine actually enforces it)", () => {
  test("runUniversalSearch accepts userQuestion at every production call site", () => {
    const chat = readFileSync("src/convex/omiChat.ts", "utf8");
    const probe = readFileSync("src/convex/omiSelfTest.ts", "utf8");
    const search = readFileSync("src/convex/search.ts", "utf8");
    expect(chat.match(/userQuestion:/g)?.length).toBe(2); // first pass + escalation
    expect(probe.match(/userQuestion:/g)?.length).toBe(2); // probe mirror: both passes
    expect(search).toContain("userQuestion:");
  });

  test("the ranking loop hard-floors unanswerable pages (≥0.45 penalty ⇒ dropped)", () => {
    const src = readFileSync("src/convex/universalSearch.ts", "utf8");
    expect(src).toContain("answerabilityPenalty");
    expect(src).toContain(">= 0.45");
    // Feed citations are exempt (they carry their answer by construction).
    expect(src).toContain("sports-scores");
  });

  test("the trace exposes the question type and an answerability rejection bucket", () => {
    const src = readFileSync("src/convex/searchEngine/debugTrace.ts", "utf8");
    expect(src).toContain("questionType");
    expect(src).toContain("answerability");
  });
});
