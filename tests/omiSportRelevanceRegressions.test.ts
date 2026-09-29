/**
 * REGRESSION — THE FIVE MEASURED FAILURES (f190e36 review, 2026-09-29).
 * =============================================================================
 * FAIL 1  "latest IPL news" kept B.Arch admissions, NEET MDS, panferov-art.ru.
 *         Root cause: the year gate accepted any page carrying "2026"; nothing
 *         required the page to be about the IPL at all.
 *         Fix pinned here: the ENTITY ANCHOR — a question that names a
 *         competition scores every source that never mentions it at FINAL 0,
 *         regardless of date, keywords or domain.
 *
 * FAIL 2  "live football scores" lost the real table page because it never
 *         contains the literal word "football". Fix pinned: SPORT-DOMAIN
 *         SEMANTIC relevance — a page that speaks the sport's result
 *         vocabulary (standings/league table/fixtures/goals) is relevant
 *         without any word overlap with the query.
 *
 * FAIL 3  "current Premier League standings" presented a 112-hour-old source
 *         as current. Fix pinned at two layers: the chat-path usable filter
 *         drops every source older than the freshness promise, and the
 *         escalation gate refuses the turn instead of answering stale.
 *
 * FAIL 4/5  Formula 1 / NBA died when TheSportsDB had no data. Fix pinned:
 *         the strict-vertical backstop re-enters the search with the
 *         general-web providers instead of throwing.
 *
 * EXTRA regressions requested: latest cricket news, current IPL standings,
 * latest Champions League results, current NBA scores, latest F1 results.
 *
 * The contract is unchanged: cache bypass, memory protection, year/event
 * matching, future-date protection, provider fallback — pinned elsewhere.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  scoreSourceDetailed,
  usefulnessPenalty,
  detectSportDomain,
  sportRelevance,
  entityInSource,
  keywordSet,
  isOffTopic,
} from "../src/convex/searchEngine/quality";
import { strictVerticalFallbackFor } from "../src/convex/searchEngine/resilience";
import {
  plausibleAgeHours,
  shouldEscalateForFreshness,
} from "../src/convex/searchEngine/freshness";
import type { WebCitation } from "../src/convex/searchProviders/types";

const now = Date.now();
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const cite = (over: Partial<WebCitation>): WebCitation =>
  ({ url: "https://example.example/x", snippet: "", ...over } as WebCitation);

// ---------------------------------------------------------------------------
// FAIL 1 — "latest IPL news": non-IPL pages must score FINAL 0
// ---------------------------------------------------------------------------

describe("FAIL 1: the IPL entity anchor", () => {
  const kw = keywordSet("latest IPL news");

  test("the measured B.Arch admissions page is FINAL 0 for an IPL question", () => {
    const bd = scoreSourceDetailed(
      cite({
        url: "https://colleges.example/barch-admissions-2026",
        title: "B.Arch Admissions 2026: dates, eligibility, counselling",
        snippet: "Application window for B.Arch 2026 admissions opens next week.",
        publishedAt: iso(1),
      }),
      kw,
      { askedEvent: "ipl", freshnessMatters: true, freshnessTier: "now" },
    );
    expect(bd.final).toBe(0);
    expect(bd.relevance).toBe(0);
  });

  test("the measured NEET MDS page is FINAL 0 for an IPL question", () => {
    const bd = scoreSourceDetailed(
      cite({
        url: "https://exams.example/neet-mds-2026",
        title: "NEET MDS 2026 counselling schedule released",
        snippet: "Registration for NEET MDS 2026 begins today.",
        publishedAt: iso(2),
      }),
      kw,
      { askedEvent: "ipl", freshnessMatters: true, freshnessTier: "now" },
    );
    expect(bd.final).toBe(0);
  });

  test("the measured panferov-art.ru page is floored as garbage", () => {
    const c = cite({
      url: "https://panferov-art.ru/some-post",
      title: "Gallery post",
      snippet: "Art gallery update.",
    });
    expect(usefulnessPenalty(c)).toBeGreaterThanOrEqual(0.45);
    // ...and the ranker's noise floor drops penalty>=0.45 before ranking.
    const src = readFileSync("src/convex/universalSearch.ts", "utf8");
    expect(src).toContain("usefulnessPenalty(item.c) >= 0.45) continue;");
  });

  test("a real IPL story on a reputable domain survives with a strong final", () => {
    const bd = scoreSourceDetailed(
      cite({
        url: "https://www.espncricinfo.com/story/ipl-2026-match-report",
        title: "IPL 2026: Gujarat Titans clinch last-over thriller",
        snippet:
          "IPL 2026 match report: Rajasthan Royals fell short as Gujarat Titans defended 24 in the final over.",
        publishedAt: iso(3),
      }),
      kw,
      { askedEvent: "ipl", freshnessMatters: true, freshnessTier: "now" },
    );
    expect(bd.final).toBeGreaterThan(0.5);
  });

  test("the entity anchor also gates CURRENT IPL STANDINGS and LATEST CRICKET NEWS is domain-gated", () => {
    // current IPL standings: same entity anchor
    const kwIpl = keywordSet("current IPL standings");
    const bd = scoreSourceDetailed(
      cite({ url: "https://x.example/baking", title: "Sourdough basics" }),
      kwIpl,
      { askedEvent: "ipl" },
    );
    expect(bd.final).toBe(0);
    // latest cricket news: no named event, but the cricket DOMAIN gate applies
    expect(detectSportDomain("latest cricket news")?.name).toBe("cricket");
  });
});

// ---------------------------------------------------------------------------
// FAIL 2 — "live football scores": semantic, not literal
// ---------------------------------------------------------------------------

describe("FAIL 2: sport-domain semantic relevance", () => {
  const kw = keywordSet("live football scores");

  test("a Premier League TABLE page with zero 'football' words is fully relevant", () => {
    const domain = detectSportDomain("live football scores")!;
    expect(domain.name).toBe("football");
    const table = cite({
      url: "https://www.premierleague.com/table",
      title: "Premier League Table & Standings",
      snippet: "League table: positions, played, goal difference, points, fixtures, results.",
    });
    const rel = sportRelevance(table, domain);
    expect(rel).toBeGreaterThan(0.5);
    const bd = scoreSourceDetailed(table, kw, {
      freshnessMatters: true,
      freshnessTier: "now",
    });
    // Undated ⇒ no freshness credit, yet the semantic match still carries it
    // well clear of zero — literal keyword overlap would have been ~0.
    expect(bd.final).toBeGreaterThan(0.4);
  });

  test("an unrelated recipe page scores below the table page for the same query", () => {
    const domain = detectSportDomain("live football scores")!;
    const recipe = cite({
      url: "https://food.example/paneer-recipe",
      title: "Paneer butter masala recipe",
      snippet: "A rich tomato gravy with soft paneer cubes.",
    });
    expect(sportRelevance(recipe, domain)).toBe(0);
  });

  test("CURRENT NBA SCORES and LATEST F1 RESULTS resolve their own domains", () => {
    expect(detectSportDomain("current NBA scores")?.name).toBe("basketball");
    expect(detectSportDomain("latest F1 results")?.name).toBe("motorsport");
  });

  test("isOffTopic accepts a real table page and a feed row WITHOUT the literal word", () => {
    const topic = ["live", "football", "scores"];
    const table = cite({
      url: "https://www.premierleague.com/table",
      title: "Premier League Table & Standings",
      snippet: "League table: positions, played, goal difference, points, fixtures, results.",
    });
    const feedRow = cite({
      url: "https://www.thesportsdb.com/team/133604",
      title: "Arsenal v Chelsea (English Premier League)",
      snippet: "Arsenal — 2-1, in play. Competition: English Premier League.",
    });
    expect(isOffTopic(table, topic)).toBe(false);
    expect(isOffTopic(feedRow, topic)).toBe(false);
    // ...while genuinely unrelated material stays off-topic.
    const recipe = cite({
      url: "https://food.example/paneer",
      title: "Paneer butter masala recipe",
      snippet: "A rich tomato gravy with soft paneer cubes.",
    });
    expect(isOffTopic(recipe, topic)).toBe(true);
  });

  test("the chat-path usable filter is wired to isOffTopic (source pin)", () => {
    const src = readFileSync("src/convex/omiChat.ts", "utf8");
    expect(src).toContain("!isOffTopic(c, topic)");
  });

  test("a citation from the STRUCTURED score feed is on-topic by construction", () => {
    // The measured AFCON row: no football word anywhere in title/snippet, yet
    // it is real live score data from the adapter that resolved the league.
    const row = cite({
      url: "https://www.thesportsdb.com/team/123",
      title: "Ethiopia v Senegal 0 – 1 (African Cup of Nations Qualifying · 31)",
      snippet: "Ethiopia — 0-1, in play. Competition: African Cup of Nations Qualifying.",
      providers: ["sports-scores"],
    });
    expect(isOffTopic(row, ["live", "football", "scores"])).toBe(false);
    // ...while the same text without feed provenance stays judged by content.
    const webCopy = { ...row, providers: ["searxng"] };
    expect(isOffTopic(webCopy, ["live", "football", "scores"])).toBe(true);
  });

  test("anti-garbage: spam TLDs, shorteners and malformed URLs are floored", () => {
    expect(usefulnessPenalty(cite({ url: "https://random-garbage.ru/post" }))).toBeGreaterThanOrEqual(0.45);
    expect(usefulnessPenalty(cite({ url: "https://bit.ly/abc123" }))).toBeGreaterThanOrEqual(0.45);
    expect(usefulnessPenalty(cite({ url: "not a url at all" }))).toBeGreaterThanOrEqual(0.45);
    expect(usefulnessPenalty(cite({ url: "https://www.reuters.com/sport/story" }))).toBe(0);
  });

  test("roundup/listings pages never rank for a specific sports question", () => {
    const la = cite({
      url: "https://welikela.com/week",
      title: "Things To Do This Week in Los Angeles [9-28-2026 to 10-2-2026]",
      snippet: "Formula 1 race weekend, concerts, food events.",
      publishedAt: iso(3),
    });
    expect(usefulnessPenalty(la)).toBeGreaterThanOrEqual(0.45);
    const bd = scoreSourceDetailed(la, keywordSet("Formula 1 2026 season results"), {
      askedEvent: "formula 1",
      freshnessMatters: true,
      freshnessTier: "now",
    });
    expect(bd.final).toBeLessThan(0.4);
  });

  test("a page headlined by ANOTHER sport is demoted below real coverage", () => {
    const kw = keywordSet("Formula 1 2026 season results");
    const mlb = cite({
      url: "https://sports.example/mlb-predictions",
      title: "MLB Exec Predicts Padres to Win 2026 World Series",
      snippet: "The formula 1 calendar came up in conversation about season results.",
      publishedAt: iso(3),
    });
    const real = cite({
      url: "https://www.formula1.com/en/results.html/2026",
      title: "F1 2026 Azerbaijan Grand Prix race results",
      snippet: "Race results and formula 1 season standings from the Azerbaijan Grand Prix.",
      publishedAt: iso(3),
    });
    const bdMlb = scoreSourceDetailed(mlb, kw, { askedEvent: "formula 1", freshnessMatters: true });
    const bdReal = scoreSourceDetailed(real, kw, { askedEvent: "formula 1", freshnessMatters: true });
    expect(bdReal.final).toBeGreaterThan(bdMlb.final * 3);
  });
});

// ---------------------------------------------------------------------------
// FAIL 3 — "current Premier League standings": stale is never presented as current
// ---------------------------------------------------------------------------

describe("FAIL 3: the 112-hour staleness gate", () => {
  const stale = iso(112);
  const kw = keywordSet("current Premier League standings");

  test("a 112h-old source cannot pass the freshness promise (plausibleAgeHours)", () => {
    const age = plausibleAgeHours(stale, now);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThan(72); // beyond every current-question window
  });

  test("the escalation gate fires for stale-only results — refuse, don't answer", () => {
    expect(shouldEscalateForFreshness([{ publishedAt: stale }], 24, now)).toBe(true);
  });

  test("the chat path drops sources older than the freshness promise (source pin)", () => {
    const src = readFileSync("src/convex/omiChat.ts", "utf8");
    // The usable filter enforces age <= preferFreshHours on freshness turns.
    expect(src).toContain("plausibleAgeHours(c.publishedAt, Date.now())");
    expect(src).toContain("age <= policy.preferFreshHours");
  });

  test("a genuinely current standings page passes the same gate", () => {
    const age = plausibleAgeHours(iso(5), now)!;
    expect(age).toBeLessThanOrEqual(24);
    expect(shouldEscalateForFreshness([{ publishedAt: iso(5) }], 24, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FAIL 4/5 — Formula 1 / NBA: a dead strict-vertical provider falls back
// ---------------------------------------------------------------------------

describe("FAIL 4/5: sports provider fallback", () => {
  test("the sports vertical's backstop is the dated general-web floor", () => {
    const backstop = strictVerticalFallbackFor("sports");
    expect(backstop).toEqual(["langsearch", "wikipedia-current-events", "searxng"]);
  });

  test("an empty strict-vertical result re-enters with the backstop providers (source pin)", () => {
    const src = readFileSync("src/convex/universalSearch.ts", "utf8");
    // When NO provider returned anything, the backstop ids are used directly —
    // even when configured-ness looked empty (the measured F1 failure path).
    expect(src).toContain(
      "const backstopIds = available.length > 0 ? available.map((p) => p.id) : backstop;",
    );
    // A vertical-specific filter that matches NOTHING also falls back to the
    // full fan-out rather than returning an empty list as if it were an answer.
    expect(src).toContain("preferredProviders: undefined");
  });

  test("a non-empty but DATALESS vertical result also re-enters the full fan-out (FAIL 4/5 pin)", () => {
    const src = readFileSync("src/convex/universalSearch.ts", "utf8");
    // TheSportsDB answered with zero rows → merged.length === 0 with ONE tried
    // provider must widen to all providers instead of throwing "all failed".
    expect(src).toContain("providers.length < allProviders.length");
    expect(src).toContain("attemptedBackstop: true");
  });

  test("freshness escalation widens beyond the stale narrow feed (FAIL 3 pin)", () => {
    for (const f of ["src/convex/omiChat.ts", "src/convex/omiSelfTest.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).toContain("strictVerticalFallbackFor(policy.vertical)");
    }
  });

  test("NBA standings resolves its league id for the structured feed", async () => {
    const { leagueFromQuery } = await import("../src/convex/searchProviders/sports");
    expect(leagueFromQuery("NBA standings")?.idLeague).toBe("4387");
    expect(leagueFromQuery("current Premier League standings")?.idLeague).toBe("4328");
  });

  test("entity anchors for the remaining named queries all extract", async () => {
    const { extractEvent } = await import("../src/convex/searchEngine/intent");
    expect(extractEvent("latest Champions League results")).toBe("champions league");
    expect(extractEvent("current NBA scores")).toBe("nba");
    expect(extractEvent("latest F1 results")).toBe("formula 1");
    expect(extractEvent("Formula 1 2026 season results")).toBe("formula 1");
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: the anchor can never be outranked by freshness
// ---------------------------------------------------------------------------

describe("the anchor beats freshness for every named sports query", () => {
  for (const [query, event] of [
    ["latest IPL news", "ipl"],
    ["current IPL standings", "ipl"],
    ["current Premier League standings", "premier league"],
    ["latest Champions League results", "champions league"],
    ["current NBA scores", "nba"],
    ["latest F1 results", "formula 1"],
  ] as const) {
    test(`"${query}": a 1h-old page with no ${event} mention is FINAL 0`, () => {
      const bd = scoreSourceDetailed(
        cite({
          url: "https://trending.example/fresh-but-unrelated",
          title: "Breaking: something else entirely",
          snippet: "A brand new story about a different thing.",
          publishedAt: iso(1),
        }),
        keywordSet(query),
        { askedEvent: event, freshnessMatters: true, freshnessTier: "now" },
      );
      expect(bd.final).toBe(0);
    });
  }
});
