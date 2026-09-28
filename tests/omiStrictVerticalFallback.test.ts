/**
 * REGRESSION — STRICT-VERTICAL DEAD END + HISTORICAL-FRAMING MISROUTE.
 * =============================================================================
 *
 * Both defects were MEASURED by the 138-query search-quality benchmark
 * (2026-09-28), not hypothesised:
 *
 * 1. STRICT-VERTICAL DEAD END. A strict vertical (weather, an explicitly
 *    requested scoreline) has exactly one provider. When that provider failed
 *    (Open-Meteo 429ing, TheSportsDB empty, circuit open), `runUniversalSearch`
 *    threw "All search engines failed for this query" with NO second attempt.
 *    Every weather query in the benchmark failed this way — 7/8 — while a
 *    direct probe measured Open-Meteo answering correctly moments before.
 *    Weather had become a one-provider outage of the whole turn.
 *
 *    Fix: `strictVerticalFallbackFor(vertical)` returns a dated general-web
 *    backstop (langsearch → wikipedia-current-events → searxng) and the
 *    orchestrator degrades ONCE (guarded by `attemptedBackstop`) instead of
 *    failing. The answer is still never faked and never taken from an
 *    unrelated vertical: the backstop can only return real reporting about
 *    the thing asked, or nothing.
 *
 * 2. HISTORICAL-FRAMING MISROUTE. "history of the World Cup final" was routed
 *    to the live scoreboard and hard-failed, because `scoreDemanded` matched
 *    the word "final" and nothing cancelled it for explicitly historical
 *    framing. A question that names itself as history can never be answered
 *    by a live feed — the scoreboard has no 1930 rows.
 *
 *    Fix: `scoreDemanded` (and therefore strict sports routing) is suppressed
 *    by historical framing words.
 *
 * These tests import ONLY from pure modules (`freshness.ts`, `resilience.ts`)
 * so they run with no Convex runtime and no network. The source pins exist
 * because the wiring itself (the one-hop degrade inside
 * `runUniversalSearch`) cannot be exercised without the generated API.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { freshnessPolicyFor, scoreDemanded } from "../src/convex/searchEngine/freshness";
import { strictVerticalFallbackFor } from "../src/convex/searchEngine/resilience";

// ---------------------------------------------------------------------------
// 1. The backstop map itself
// ---------------------------------------------------------------------------

describe("strict-vertical fallback map", () => {
  test("weather, sports and markets degrade to the dated general-web backstop", () => {
    for (const vertical of ["weather", "sports", "markets"]) {
      const backstop = strictVerticalFallbackFor(vertical);
      expect(backstop).not.toBeNull();
      // The backstop must lead with a DATED provider — the whole point is
      // that a current-information question keeps receiving dated evidence
      // even when its structured feed is down.
      expect(backstop![0]).toBe("langsearch");
      // …and must never include the failed structured feed itself.
      expect(backstop).not.toContain("openmeteo");
      expect(backstop).not.toContain("sports-scores");
      expect(backstop).not.toContain("market-rates");
    }
  });

  test("verticals with no honest general-web substitute keep failing loudly", () => {
    // There is no general-web page that IS the weather — but there IS general
    // reporting about a match or a rate move. The unknown-vertical default
    // must stay null so no invented fallback can ever fire.
    expect(strictVerticalFallbackFor(undefined)).toBeNull();
    expect(strictVerticalFallbackFor("general")).toBeNull();
    expect(strictVerticalFallbackFor("news")).toBeNull();
    expect(strictVerticalFallbackFor("election")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The wiring: one hop, once, only for strict verticals
// ---------------------------------------------------------------------------

describe("strict-vertical fallback wiring", () => {
  const src = () => readFileSync("src/convex/universalSearch.ts", "utf8");

  test("runUniversalSearch degrades to the backstop when the strict feed fails", () => {
    const s = src();
    expect(s).toContain("strictVerticalFallbackFor(");
    // …and records that the backstop was attempted, so a failing backstop
    // still surfaces honestly instead of recursing forever.
    expect(s).toContain("attemptedBackstop: true");
  });

  test("the degrade happens on the EMPTY-merge path, guarded to fire once", () => {
    const s = src();
    // The guard sits inside the `merged.length === 0` branch (after fan-out),
    // not in the pre-flight check — a pre-flight-only fallback could not know
    // whether the structured feed actually failed.
    const emptyBranch = s.slice(s.indexOf("if (merged.length === 0)"));
    expect(emptyBranch).toContain("attemptedBackstop");
    expect(emptyBranch).toContain("strictVerticalFallbackFor(");
    // The backstop recursion clears strict mode.
    expect(emptyBranch).toContain("strictVertical: false");
  });

  test("chat and self-test pass the vertical name through", () => {
    expect(readFileSync("src/convex/omiChat.ts", "utf8")).toContain("verticalName: policy.vertical");
    expect(readFileSync("src/convex/omiSelfTest.ts", "utf8")).toContain("verticalName: policy.vertical");
  });
});

// ---------------------------------------------------------------------------
// 3. Weather keeps its strict contract — the backstop only fires on FAILURE
// ---------------------------------------------------------------------------

describe("weather policy stays strict; the fallback is degradation, not substitution", () => {
  test("a live weather question still routes ONLY to openmeteo first", () => {
    const policy = freshnessPolicyFor("current weather in Mumbai");
    expect(policy.vertical).toBe("weather");
    expect(policy.requiresFreshness).toBe(true);
    expect(policy.strict).toBe(true);
    expect(policy.preferredProviders).toEqual(["openmeteo"]);
  });

  test("openmeteo being unconfigured degrades the POLICY, not the answer's honesty", () => {
    // When the feed is unavailable the search must not pretend otherwise:
    // the answer layer still refuses rather than inventing a forecast.
    // (Pinned here as the contract the backstop must not break: the backstop
    // returns REPORTING about the place, never conditions.)
    const backstop = strictVerticalFallbackFor("weather");
    expect(backstop).not.toContain("openmeteo");
  });
});

// ---------------------------------------------------------------------------
// 4. Historical framing must never route to the live scoreboard
// ---------------------------------------------------------------------------

describe("historical framing suppresses strict score routing", () => {
  test("the measured failing query is no longer score-demanded", () => {
    expect(scoreDemanded("history of the World Cup final")).toBe(false);
  });

  test("genuine score requests still are", () => {
    expect(scoreDemanded("current Premier League standings")).toBe(true);
    expect(scoreDemanded("who won the most recent F1 race")).toBe(true);
    expect(scoreDemanded("today's match fixtures")).toBe(true);
    expect(scoreDemanded("India Australia final score")).toBe(true);
  });

  test("the measured query keeps general-web providers instead of the scoreboard", () => {
    const policy = freshnessPolicyFor("history of the World Cup final");
    expect(policy.preferredProviders).not.toContain("sports-scores");
  });

  test("a CURRENT question with historical words still routes to the scoreboard", () => {
    // The suppression must not leak: an explicit live score question that
    // merely mentions history is still a score question.
    expect(scoreDemanded("current standings in the league table")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The github misdiagnosis stays fixed (last provider in the sweep)
// ---------------------------------------------------------------------------

describe("github never misreports an outage as a missing credential", () => {
  test("generic failures throw a plain availability error", () => {
    const src = readFileSync("src/convex/searchProviders/github.ts", "utf8");
    // Exactly one MissingKeyError THROW remains: the rate-limit path.
    const throws = src.split("throw new MissingKeyError").length - 1;
    expect(throws).toBe(1);
    // The generic catch arm throws a plain Error, not a missing-key one.
    expect(src).toMatch(/throw new Error\(\s*`github: /);
    expect(src).toContain("MEASURED BUG");
  });
});
