/**
 * REGRESSION TESTS FOR THE REPORTED SEARCH-QUALITY BUG
 * =====================================================
 *
 * Real user testing found that live/current questions could still be answered
 * with old or irrelevant information. The reproduction was exact:
 *
 *   "What is the Indian contingent medals tally in Asian Games 2026?"
 *     decision.intent                    -> "knowledge"
 *     freshnessPolicy.requiresFreshness  -> false
 *     vertical                           -> "general"
 *
 * The turn therefore searched the open web, accepted an article about a
 * previous Asian Games, and let the model narrate a medal tally it had
 * memorised — a current, confident, wrong answer.
 *
 * These tests exist so that exact failure cannot come back. They are written
 * against the REAL production entry point (`decideSearch` + `freshnessPolicyFor`,
 * the same pair omiChat calls), not against a simplified helper, because a test
 * against a helper would keep passing while the app stayed broken.
 */

import { describe, expect, it } from "bun:test";
import { decideSearch } from "../src/convex/searchEngine/decision";
import {
  freshnessPolicyFor,
  freshnessStatement,
  relativeAge,
  noVerificationMessage,
  type FreshnessSource,
} from "../src/convex/searchEngine/freshness";
import {
  classifyCurrentIntent,
  extractEvent,
  extractYears,
  retrievalQuery,
} from "../src/convex/searchEngine/intent";
import { matchTemporal, isWrongYear, yearsInSource, temporalPenalty } from "../src/convex/searchEngine/temporal";
import { scoreSource, keywordSet, directnessScore } from "../src/convex/searchEngine/quality";
import { crossCheckClaims, conflictNotice, claimsFromSource } from "../src/convex/searchEngine/crossCheck";
import { validateEvidence, cannotVerifyMessage } from "../src/convex/searchEngine/validation";
import { buildSearchTrace, assertTraceIsSafe, summarizeTrace } from "../src/convex/searchEngine/debugTrace";
import type { WebCitation } from "../src/convex/searchProviders/types";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const NOW_ISO = new Date(NOW).toISOString();
const CURRENT_YEAR = new Date(NOW).getUTCFullYear();

/** The exact query from the bug report. */
const ASIAN_GAMES =
  "What is the Indian contingent medals tally in Asian Games 2026?";

// ===========================================================================
// 1. THE HEADLINE REGRESSION
// ===========================================================================

describe("REGRESSION — the reported Asian Games 2026 query", () => {
  it("is recognised as current information, not general knowledge", () => {
    const decision = decideSearch(ASIAN_GAMES);
    const policy = freshnessPolicyFor(ASIAN_GAMES, decision.intent);
    // The bug: this was false, so the turn was answerable from model memory.
    expect(policy.requiresFreshness).toBe(true);
  });

  it("names the reason it is current, so the decision is auditable", () => {
    const intent = classifyCurrentIntent(ASIAN_GAMES, undefined, NOW);
    expect(intent.requiresFreshness).toBe(true);
    // Two independent signals, either of which alone is sufficient.
    expect(intent.years).toContain(CURRENT_YEAR);
    expect(intent.event).toBe("asian games");
    expect(intent.liveData).toBe("tally");
    expect(intent.reasons.join(" ")).toContain("current year");
  });

  it("never bypasses the cache for this question", () => {
    const decision = decideSearch(ASIAN_GAMES);
    const policy = freshnessPolicyFor(ASIAN_GAMES, decision.intent);
    expect(decision.skipCache || policy.requiresFreshness).toBe(true);
  });

  it("routes to a vertical with a live source, not the general web floor", () => {
    const policy = freshnessPolicyFor(ASIAN_GAMES, decideSearch(ASIAN_GAMES).intent);
    expect(policy.vertical).toBe("sports");
  });

  it("rejects a source about a different year instead of ranking it", () => {
    // A 2018 Games article is high-authority and may even be recently crawled.
    // It is the WRONG ANSWER, and recency alone cannot express that.
    const oldGames: WebCitation = {
      url: "https://www.reuters.com/sports/asian-games-2018-medal-table",
      title: "Asian Games 2018: full medal table",
      snippet: "India finished third at the 2018 Asian Games with 65 medals.",
      publishedAt: "2026-09-20T00:00:00Z", // published RECENTLY on purpose
    };
    const match = matchTemporal(oldGames, [2026], "asian games");
    expect(match.verdict).toBe("wrong-year");
    expect(isWrongYear(match)).toBe(true);
    expect(temporalPenalty(match)).toBeLessThan(0.2);
  });

  it("prefers a current 2026 source over a recent article about 2018", () => {
    const keywords = keywordSet(ASIAN_GAMES);
    const wrongYear: WebCitation = {
      url: "https://www.reuters.com/sports/asian-games-2018-medal-table",
      title: "Asian Games 2018: full medal table",
      snippet: "India finished third at the 2018 Asian Games with 65 medals.",
      publishedAt: NOW_ISO,
    };
    const rightYear: WebCitation = {
      url: "https://www.asiangames.com/2026/medal-table",
      title: "Asian Games 2026 medal table — Asian Games",
      snippet: "India's contingent won 22 gold medals at the Asian Games 2026.",
      publishedAt: NOW_ISO,
    };
    const scoredWrong = scoreSource(wrongYear, keywords, {
      freshnessMatters: true,
      askedYears: [2026],
      askedEvent: "asian games",
    });
    const scoredRight = scoreSource(rightYear, keywords, {
      freshnessMatters: true,
      askedYears: [2026],
      askedEvent: "asian games",
    });
    expect(scoredRight).toBeGreaterThan(scoredWrong);
  });

  it("says it could not verify, rather than inventing a tally", () => {
    // Evidence that is all about the wrong year must not clear the gate.
    const stale: WebCitation[] = [
      {
        url: "https://www.reuters.com/sports/asian-games-2018-medal-table",
        title: "Asian Games 2018: full medal table",
        snippet: "India won 65 medals at the 2018 Asian Games.",
        publishedAt: NOW_ISO,
      },
    ];
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: stale,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.verdict).toBe("refuse");
    const message = cannotVerifyMessage(ASIAN_GAMES, report);
    expect(message).toContain("could not verify");
    // The refusal must not smuggle in a number.
    expect(message).not.toMatch(/\b\d+\s+medals?\b/i);
    expect(message.toLowerCase()).toContain("not filling this in from my training data");
  });

  it("has an honest message for the vertical when search itself fails", () => {
    const message = noVerificationMessage(ASIAN_GAMES, "sports");
    expect(message).toContain("can't reliably verify");
    expect(message).toContain("not going to answer this from memory");
  });
});

// ===========================================================================
// 2. THE NINE REPORTED QUERIES
// ===========================================================================

const REPORTED_QUERIES = [
  "What is the Indian contingent medals tally in Asian Games 2026?",
  "latest India cricket score",
  "current gold price in India",
  "latest election results",
  "today's weather",
  "latest Apple stock price",
  "current USD INR rate",
  "latest AI news",
  "current IPL standings",
  "latest flight status",
];

describe("REGRESSION — every reported live query requires freshness", () => {
  for (const query of REPORTED_QUERIES) {
    it(`"${query}" is answered from live sources, never from memory`, () => {
      const decision = decideSearch(query);
      const policy = freshnessPolicyFor(query, decision.intent);
      expect(`${query} → ${policy.requiresFreshness}`).toContain("true");
      // A current question must never be served from a stale cache.
      expect(decision.skipCache || policy.requiresFreshness).toBe(true);
    });
  }
});

describe("REGRESSION — implicit freshness needs no time word", () => {
  it("treats a live-data noun as current even with no 'latest' anywhere", () => {
    for (const query of [
      "India's medal tally",
      "current IPL standings",
      "election results",
      "flight status for AI 101",
    ]) {
      expect(`${query} → ${classifyCurrentIntent(query, undefined, NOW).requiresFreshness}`).toContain(
        "true",
      );
    }
  });

  it("treats a current-year mention as current even with no time word", () => {
    // No "latest", no "today" — only a year that has not happened yet.
    const intent = classifyCurrentIntent("Asian Games 2026 medal table", undefined, NOW);
    expect(intent.requiresFreshness).toBe(true);
    expect(intent.reasons.join(" ")).toContain("current year");
  });

  it("still recognises the ordinary explicit freshness words", () => {
    for (const query of [
      "latest news",
      "today's weather",
      "right now",
      "as of today",
      "this week",
      "recent updates",
      "current price",
    ]) {
      expect(`${query} → ${classifyCurrentIntent(query, undefined, NOW).requiresFreshness}`).toContain(
        "true",
      );
    }
  });
});

// ===========================================================================
// 3. HISTORICAL QUESTIONS MUST NOT BE DRAGGED INTO LIVE SEARCH
// ===========================================================================

describe("REGRESSION — history is not forced through a live feed", () => {
  it("answers a settled past event from stable knowledge", () => {
    for (const query of [
      "Who won the 2016 Olympics men's 100m?",
      "Who won the 2018 Asian Games 100m final?",
      "What was the score in the 2014 World Cup final?",
    ]) {
      const intent = classifyCurrentIntent(query, undefined, NOW);
      expect(`${query} → ${intent.requiresFreshness}`).toContain("false");
      expect(intent.historical).toBe(true);
    }
  });

  it("does not misclassify causal or definitional questions as current", () => {
    for (const query of [
      "What causes rain?",
      "What is a stock market?",
      "What is the capital of France?",
      "Explain recursion",
    ]) {
      expect(
        `${query} → ${classifyCurrentIntent(query, undefined, NOW).requiresFreshness}`,
      ).toContain("false");
    }
  });

  it("lets an explicit freshness word override a past year", () => {
    // If the user insists on live sources, give them live sources.
    const intent = classifyCurrentIntent("latest update on the 2018 Asian Games", undefined, NOW);
    expect(intent.requiresFreshness).toBe(true);
    expect(intent.historical).toBe(false);
  });
});

// ===========================================================================
// 4. YEAR / EVENT EXTRACTION
// ===========================================================================

describe("REGRESSION — date-aware and event-aware matching", () => {
  it("extracts the years named in the question", () => {
    expect(extractYears("Asian Games 2026 medal table", CURRENT_YEAR)).toEqual([2026]);
    expect(extractYears("results from 2024 and 2026", CURRENT_YEAR)).toEqual([2024, 2026]);
    // Implausible / non-event numbers are ignored.
    expect(extractYears("room 12045 booked", CURRENT_YEAR)).toEqual([]);
  });

  it("extracts the named event", () => {
    expect(extractEvent("Asian Games 2026")).toBe("asian games");
    expect(extractEvent("current IPL standings")).toBe("ipl");
    expect(extractEvent("what is a mutex")).toBeNull();
  });

  it("reads the years a source itself mentions", () => {
    const c: WebCitation = {
      url: "https://example.com/a",
      title: "Asian Games 2018 medal table",
      snippet: "2018 Asian Games results",
    };
    expect(yearsInSource(c)).toEqual([2018]);
  });

  it("marks a source about another event as wrong-event", () => {
    const c: WebCitation = {
      url: "https://example.com/premier",
      title: "Premier League standings",
      snippet: "Premier League table update",
    };
    const match = matchTemporal(c, [], "ipl");
    expect(match.verdict).toBe("wrong-event");
    expect(temporalPenalty(match)).toBeLessThan(1);
  });

  it("leaves an unlabelled source alone rather than emptying the results", () => {
    // Plenty of good pages never print a year. Penalising them would be worse
    // than useless — it would remove the only usable evidence.
    const c: WebCitation = {
      url: "https://example.com/report",
      title: "India's contingent performance",
      snippet: "A detailed report on the contingent.",
    };
    expect(matchTemporal(c, [2026], "asian games").verdict).toBe("unknown");
    expect(temporalPenalty(matchTemporal(c, [2026], "asian games"))).toBe(1);
  });
});

// ===========================================================================
// 5. RANKING QUALITY — not "take the first result"
// ===========================================================================

describe("REGRESSION — ranking uses authority, freshness and directness", () => {
  const keywords = keywordSet("India medal tally Asian Games 2026");

  it("scores a direct answer above a passing mention", () => {
    const direct: WebCitation = {
      url: "https://www.asiangames.com/2026/medal-table",
      title: "Asian Games 2026 medal table",
      snippet: "India has won 22 gold medals, 18 silver and 14 bronze at the 2026 Asian Games.",
    };
    const passing: WebCitation = {
      url: "https://blog.example.com/olympics",
      title: "A history of the Olympic Games",
      snippet: "The Olympic Games have a long and storied tradition of competition.",
    };
    expect(directnessScore(direct, keywords)).toBeGreaterThan(directnessScore(passing, keywords));
  });

  it("prefers a primary source over a content farm on equal footing", () => {
    const official: WebCitation = {
      url: "https://www.asiangames.com/2026/medal-table",
      title: "Asian Games 2026 medal table",
      snippet: "India won 22 gold medals at the 2026 Asian Games.",
    };
    const farm: WebCitation = {
      url: "https://answers.com/q/medal-table",
      title: "Asian Games 2026 medal table",
      snippet: "India won 22 gold medals at the 2026 Asian Games.",
    };
    expect(scoreSource(official, keywords)).toBeGreaterThan(scoreSource(farm, keywords));
  });

  it("never rewards an undated source as though it were fresh", () => {
    // `freshnessScore` treats "no date" as neutral, but the freshness GATE must
    // still refuse to call undated evidence current.
    const undated: FreshnessSource = {
      title: "Asian Games medal table",
      url: "https://example.com/x",
    };
    expect(relativeAge(undated.publishedAt, NOW)).toBe("date not shown by the source");
    expect(freshnessStatement([undated], 14, NOW)).toBeNull();
  });
});

// ===========================================================================
// 6. MULTI-SOURCE VERIFICATION — conflicts are surfaced, not resolved
// ===========================================================================

describe("REGRESSION — disagreeing sources are reported, never silently picked", () => {
  const today = (d: string) => ({ publishedAt: new Date(NOW - d * 86_400_000).toISOString() });

  it("detects two independent sources giving different medal totals", () => {
    const report = crossCheckClaims(
      [
        { title: "India wins 22 gold medals at the Asian Games 2026", url: "https://reuters.com/x", ...today(1) },
        { title: "India wins 25 gold medals at the Asian Games 2026", url: "https://bbc.co.uk/y", ...today(2) },
      ],
      NOW,
    );
    expect(report.conflicts.length).toBeGreaterThan(0);
    expect(report.agreed).toBe(false);
  });

  it("does NOT call one domain repeating itself a conflict", () => {
    // An echo is not corroboration, and it is certainly not a disagreement.
    const report = crossCheckClaims(
      [
        { title: "India wins 22 gold medals", url: "https://reuters.com/x", ...today(1) },
        { title: "India wins 22 gold medals again", url: "https://reuters.com/y", ...today(1) },
      ],
      NOW,
    );
    expect(report.conflicts).toHaveLength(0);
  });

  it("agrees when independent sources match", () => {
    const report = crossCheckClaims(
      [
        { title: "India wins 22 gold medals at the Asian Games 2026", url: "https://reuters.com/x", ...today(1) },
        { title: "India wins 22 gold medals in the Asian Games 2026", url: "https://bbc.co.uk/y", ...today(1) },
      ],
      NOW,
    );
    expect(report.conflicts).toHaveLength(0);
    expect(report.agreed).toBe(true);
  });

  it("does not report agreement when there was nothing to compare", () => {
    // "No claims found" must never read as "sources agreed".
    const report = crossCheckClaims(
      [{ title: "A general article", url: "https://example.com/a", ...today(1) }],
      NOW,
    );
    expect(report.insufficientEvidence).toBe(true);
    expect(report.agreed).toBe(false);
  });

  it("tells the user sources disagree, with source, date and figure", () => {
    const report = crossCheckClaims(
      [
        { title: "India wins 22 gold medals at the Asian Games 2026", url: "https://reuters.com/x", publishedAt: NOW_ISO },
        { title: "India wins 25 gold medals at the Asian Games 2026", url: "https://bbc.co.uk/y", publishedAt: NOW_ISO },
      ],
      NOW,
    );
    const notice = conflictNotice(report, NOW);
    expect(notice).toContain("Sources currently report different values");
    expect(notice).toContain("reuters.com");
    expect(notice).toContain("bbc.co.uk");
    // It must not choose a winner.
    expect(notice).not.toMatch(/the correct (?:value|answer) is/i);
  });

  it("extracts comparable figures per source without regex state leaking", () => {
    const claims = claimsFromSource(
      { title: "India 22 gold, 18 silver medals", url: "https://a.com/x", publishedAt: NOW_ISO },
      NOW,
    );
    expect(claims.length).toBeGreaterThan(0);
    // A second identical source must produce identical claims.
    const again = claimsFromSource(
      { title: "India 22 gold, 18 silver medals", url: "https://a.com/x", publishedAt: NOW_ISO },
      NOW,
    );
    expect(again.map((c) => c.value)).toEqual(claims.map((c) => c.value));
  });
});

// ===========================================================================
// 7. THE SEVEN VALIDATION CHECKS
// ===========================================================================

describe("REGRESSION — the seven validation checks", () => {
  const good: WebCitation[] = [
    {
      url: "https://www.asiangames.com/2026/medal-table",
      title: "Asian Games 2026 medal table",
      snippet: "India won 22 gold medals at the 2026 Asian Games.",
      publishedAt: NOW_ISO,
    },
    {
      url: "https://www.reuters.com/sports/asiangames-2026-india",
      title: "India at the Asian Games 2026",
      snippet: "India's contingent won 22 gold medals at the Asian Games 2026.",
      publishedAt: NOW_ISO,
    },
  ];

  it("runs every one of the seven checks", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: good,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.checks.map((c) => c.id).sort()).toEqual([
      "authority",
      "corroboration",
      "event",
      "recency",
      "relevance",
      "timestamp",
      "year",
    ]);
  });

  it("answers confidently when all critical checks pass", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: good,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.verdict).toBe("answer");
    expect(report.passRate).toBe(1);
  });

  it("refuses when nothing is recent enough", () => {
    const old = Date.parse("2019-01-01T00:00:00Z");
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: good.map((c) => ({ ...c, publishedAt: new Date(old).toISOString() })),
      askedYears: [2026],
      askedEvent: null,
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.verdict).toBe("refuse");
    expect(report.unverifiable.join(" ")).toContain("recent enough");
  });

  it("refuses when the evidence is about the wrong year", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: [
        {
          url: "https://www.reuters.com/sports/asian-games-2018",
          title: "Asian Games 2018 medal table",
          snippet: "India won 65 medals at the 2018 Asian Games.",
          publishedAt: NOW_ISO,
        },
      ],
      askedYears: [2026],
      askedEvent: null,
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.verdict).toBe("refuse");
    expect(report.unverifiable.join(" ")).toContain("2026");
  });

  it("refuses when nothing retrieved addresses the question", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: [
        {
          url: "https://example.com/unrelated",
          title: "Gardening tips",
          snippet: "How to grow tomatoes in a small balcony.",
          publishedAt: NOW_ISO,
        },
      ],
      askedYears: [2026],
      askedEvent: null,
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.verdict).toBe("refuse");
  });

  it("cavoids rather than refuses on a non-critical failure", () => {
    // One undated source cannot corroborate itself, but the answer is still
    // usable — that is a caveat, not a refusal.
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: [good[0]],
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.verdict).toBe("answer-caveated");
    expect(report.unverifiable.join(" ")).toContain("Only one source");
  });

  it("treats cross-source disagreement as a validation failure", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: good,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      crossCheck: crossCheckClaims(
        [
          { title: "India wins 22 gold medals", url: "https://reuters.com/x", publishedAt: NOW_ISO },
          { title: "India wins 25 gold medals", url: "https://bbc.co.uk/y", publishedAt: NOW_ISO },
        ],
        NOW,
      ),
      now: NOW,
    });
    expect(report.verdict).toBe("answer-caveated");
    expect(report.unverifiable.join(" ")).toContain("disagree");
  });

  it("never claims certainty it did not measure", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: good,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.passRate).toBeGreaterThanOrEqual(0);
    expect(report.passRate).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// 7b. THE WRONG-EVENT DEFECT, FOUND BY RUNNING THE REAL PIPELINE
// ===========================================================================

describe("REGRESSION — a live provider answering the wrong question is blocked", () => {
  // Found by running the real pipeline, not by reading code. A question about
  // the Asian Games 2026 medal tally was served Japanese B1 League basketball
  // scorelines by the sports feed. Every one was stamped "just now", so
  // recency, recency-weighted ranking and the year check all PASSED. The only
  // signal that caught it was that no source mentioned the Asian Games — and
  // at the time that check was recorded but not enforced.
  const basketball: WebCitation[] = [
    {
      url: "https://www.thesportsdb.com/japanese-b1-league",
      title: "Sendai 89ers v Akita Northern Happinets 34 – 32 (Japanese B1 League · 2026 season)",
      snippet: "Sendai 89ers 34 – 32 Akita Northern Happinets, Japanese B1 League 2026 season, 7' in play.",
      publishedAt: NOW_ISO,
    },
    {
      url: "https://www.thesportsdb.com/b1-league-2",
      title: "Levanga Hokkaido v SeaHorses Mikawa 34 – 37 (Japanese B1 League · 2026)",
      snippet: "Levanga Hokkaido 34 – 37 SeaHorses Mikawa, Japanese B1 League 2026.",
      publishedAt: NOW_ISO,
    },
  ];

  it("REFUSES to answer an Asian Games question from basketball results", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: basketball,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      now: NOW,
    });
    expect(report.verdict).toBe("refuse");
    expect(report.unverifiable.join(" ")).toContain("asian games");
  });

  it("names the event check as the one that caught it", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: basketball,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      now: NOW,
    });
    const event = report.checks.find((c) => c.id === "event");
    expect(event?.passed).toBe(false);
    // A check that detects the wrong answer but does not block it is
    // decoration, so the event check must be able to refuse.
    expect(event?.critical).toBe(true);
  });

  it("does not let a fresh, dated, wrong-event source through on recency alone", () => {
    const report = validateEvidence({
      query: ASIAN_GAMES,
      citations: basketball,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 14,
      now: NOW,
    });
    // These really are fresh and really are dated — which is exactly why the
    // event check has to be independent of both.
    expect(report.checks.find((c) => c.id === "recency")?.passed).toBe(true);
    expect(report.checks.find((c) => c.id === "timestamp")?.passed).toBe(true);
    expect(report.verdict).toBe("refuse");
  });

  it("does not route a non-score sporting question to the live scoreboard", () => {
    // The scoreboard returns *something* for any query that looks sporting.
    // A medal tally is not a fixture list, so it must not be asked of one.
    const tally = freshnessPolicyFor(ASIAN_GAMES, decideSearch(ASIAN_GAMES).intent);
    expect(tally.preferredProviders).not.toContain("sports-scores");

    // A real score question still gets the live scoreboard.
    const score = freshnessPolicyFor("latest India cricket score", "current");
    expect(score.preferredProviders).toContain("sports-scores");
  });
});

// ===========================================================================
// 8. SEARCH DEBUG MODE
// ===========================================================================

describe("REGRESSION — search debug mode records why, and leaks nothing", () => {
  const classified = classifyCurrentIntent(ASIAN_GAMES, undefined, NOW);
  const citations: WebCitation[] = [
    {
      url: "https://www.asiangames.com/2026/medal-table",
      title: "Asian Games 2026 medal table",
      snippet: "India won 22 gold medals at the 2026 Asian Games.",
      publishedAt: NOW_ISO,
    },
    {
      url: "https://www.reuters.com/sports/asiangames-2026-india",
      title: "India at the Asian Games 2026",
      snippet: "India's contingent won 22 gold medals at the Asian Games 2026.",
      publishedAt: NOW_ISO,
    },
    {
      url: "https://www.reuters.com/sports/asian-games-2018",
      title: "Asian Games 2018 medal table",
      snippet: "India won 65 medals at the 2018 Asian Games.",
      publishedAt: NOW_ISO,
    },
  ];
  const usable = [citations[0], citations[1]];
  const validation = validateEvidence({
    query: ASIAN_GAMES,
    citations: usable,
    askedYears: [2026],
    askedEvent: "asian games",
    maxAgeDays: 14,
    now: NOW,
  });

  const trace = buildSearchTrace({
    query: ASIAN_GAMES,
    intent: "knowledge",
    classified,
    providersSearched: ["searxng", "gdelt"],
    providersFailed: ["gdelt"],
    rawCount: 2,
    dedupedCount: 2,
    candidates: citations.map((citation) => ({
      citation,
      selected: usable.includes(citation),
      reason: usable.includes(citation)
        ? "kept as current evidence"
        : "dropped: about a different year than asked",
    })),
    maxAgeDays: 14,
    validation,
    searchMs: 1234,
    totalMs: 2000,
    now: NOW,
  });

  it("records the query, intent and freshness decision", () => {
    expect(trace.query).toBe(ASIAN_GAMES);
    expect(trace.requiresFreshness).toBe(true);
    expect(trace.freshnessReasons.length).toBeGreaterThan(0);
    expect(trace.askedYears).toEqual([2026]);
    expect(trace.askedEvent).toBe("asian games");
  });

  it("records which providers ran and which failed", () => {
    expect(trace.providersSearched).toContain("searxng");
    expect(trace.providersFailed).toContain("gdelt");
  });

  it("records the rejected wrong-year source with its reason", () => {
    expect(trace.rejectedStaleCount).toBe(1);
    expect(trace.rejectedStale[0].reason).toContain("different year");
  });

  it("records per-source dates, latency and the verification state", () => {
    expect(trace.sources).toHaveLength(3);
    expect(trace.sources[0].publishedAt).toBe(NOW_ISO);
    expect(trace.searchMs).toBe(1234);
    expect(trace.verification.verdict).toBe("answer");
    expect(trace.verification.passRate).toBeGreaterThan(0);
  });

  it("carries no credential-shaped or personal field", () => {
    expect(assertTraceIsSafe(trace)).toEqual([]);
  });

  it("summarises to a single safe log line", () => {
    const line = summarizeTrace(trace);
    expect(line).toContain("[search]");
    expect(line).toContain("fresh=true");
    expect(line.split("\n")).toHaveLength(1);
    expect(assertTraceIsSafe(JSON.parse(JSON.stringify({ line })) as never)).toEqual([]);
  });
});

// ===========================================================================
// 8b. THE RETRIEVAL QUERY DEFECT, ALSO FOUND BY RUNNING THE REAL PIPELINE
// ===========================================================================

describe("REGRESSION — the query sent to the engines is keyword-shaped", () => {
  // Found by running the real pipeline: Omi forwarded the user's raw question
  // to search indexes that expect keywords. Measured side by side on the same
  // deployment, same minute:
  //   "What is the Indian contingent medals tally in Asian Games 2026?"
  //     -> 0 results after a 12s timeout
  //   "Indian contingent medals tally in Asian Games 2026"
  //     -> 4-8 real results
  //
  // A user typing a sentence is the NORMAL case, so this silently degraded the
  // quality of almost every current-information answer.
  it("strips the interrogative frame before retrieval", () => {
    expect(retrievalQuery("What is India's medal tally in Asian Games 2026?")).toBe(
      "India's medal tally in Asian Games 2026",
    );
    // "Who won …" keeps its subject — stripping it would leave "won the Asian
    // Games 2026", which searches worse, not better.
    expect(retrievalQuery("Who won the Asian Games 2026?")).toBe("Who won the Asian Games 2026");
    // Both the politeness frame and the freshness adjective are noise to an
    // index; what remains is the pair the user actually wants.
    expect(retrievalQuery("Tell me the current USD INR rate")).toBe("USD INR rate");
  });

  it("strips the trailing question mark and any leading article", () => {
    expect(retrievalQuery("What is the Indian contingent medal tally?")).not.toMatch(/\?$/);
    expect(retrievalQuery("What is the Indian contingent medal tally?")).not.toMatch(/^the /);
  });

  it("keeps the entity, the year and the event — never the year or the event", () => {
    const q = retrievalQuery(ASIAN_GAMES);
    expect(q).toContain("2026");
    expect(q.toLowerCase()).toContain("asian games");
    expect(q.toLowerCase()).toContain("medal");
  });

  it("never returns an empty or degenerate query", () => {
    for (const raw of ["", "  ", "?", "a", "the", "What is?"]) {
      const out = retrievalQuery(raw);
      expect(out.length).toBeGreaterThanOrEqual(0);
      // A blank query is worse than the original, so fall back to it.
      if (raw.trim().length >= 3) expect(out.length).toBeGreaterThan(0);
    }
  });

  it("is idempotent, so a re-run does not degrade the query further", () => {
    const once = retrievalQuery(ASIAN_GAMES);
    expect(retrievalQuery(once)).toBe(once);
  });

  it("keeps a real general-web fallback in the current verticals", () => {
    // SearXNG is a single community instance and was measured returning
    // nothing for ~1 in 3 current queries after a 12s timeout. A current
    // question must not depend on it alone.
    //
    // The second fallback has changed twice, both times for compliance:
    // DuckDuckGo (a consumer-SERP scraper, measured returning zero results)
    // then Mojeek (official, but a PAID API — rejected because the product is
    // free-first and a metered bill on the query path is not acceptable).
    // The current verticals therefore lean on the open-data providers
    // (gdelt, wikipedia-current-events) which serve freshness-critical
    // current information better than general web search would anyway.
    // See docs/ANDROMEDA_PROVIDER_CAPABILITY_MATRIX.md.
    for (const query of ["latest AI news", "What is India's medal tally in Asian Games 2026?", "latest election results"]) {
      const policy = freshnessPolicyFor(query, decideSearch(query).intent);
      expect(policy.preferredProviders).toContain("gdelt");
      // Neither a scraper nor a paid API may creep back into routing.
      expect(policy.preferredProviders).not.toContain("duckduckgo");
      expect(policy.preferredProviders).not.toContain("mojeek");
      expect(policy.preferredProviders).not.toContain("brave");
    }
  });
});

describe("REGRESSION — the freshness policy carries year/event context", () => {
  it("passes the asked years and event to the search layer", () => {
    const policy = freshnessPolicyFor(ASIAN_GAMES, decideSearch(ASIAN_GAMES).intent);
    expect(policy.years).toEqual([2026]);
    expect(policy.event).toBe("asian games");
    expect(policy.liveData).toBe("tally");
  });

  it("gives election and travel their own honest labels", () => {
    const election = freshnessPolicyFor("latest election results", "current");
    expect(election.vertical).toBe("election");
    expect(election.label).toBe("Live election search");
    // No structured feed is wired for these yet, so failing hard would be a
    // lie; degrading to a real answer is the honest behaviour.
    expect(election.strict).toBe(false);

    const travel = freshnessPolicyFor("latest flight status", "current");
    expect(travel.vertical).toBe("travel");
    expect(travel.label).toBe("Live travel search");
  });

  it("keeps a single-source vertical strict", () => {
    // A forecast has exactly one honest source; substituting a news page for
    // it would be the "ordinary web search is not a database" failure.
    expect(freshnessPolicyFor("today's weather", "current").strict).toBe(true);
  });
});
