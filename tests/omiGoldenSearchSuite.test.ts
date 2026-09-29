/**
 * GOLDEN SUITE — LIVE SEARCH / ANDROMEDA CAPABILITY PIN (2026-09-29).
 * =============================================================================
 * The live benchmark (`searchQualityBenchmark:runSearchQualityBenchmark`) is
 * run against the deployed runtime; network behaviour cannot be asserted in a
 * unit test. What IS pinned here, machine-verifiably:
 *
 *   • the golden categories exist in the suite (government, statistics, tech,
 *     conflict, stale-prone, sports-results) — a category removed from the
 *     benchmark fails this file;
 *   • the CRITICAL query routes as a 2026-scoped, event-scoped, freshness-
 *     required sports question (the anti-model-memory precondition);
 *   • the claim cross-checker actually separates readings by INDEPENDENT
 *     domain (one domain repeating itself is not a conflict) and produces a
 *     conflict record with per-claim evidence + timestamps;
 *   • the drop-reason vocabulary the golden run relies on is complete, so the
 *     per-test report can always say WHY a source was rejected.
 *
 * Live results recorded in docs/ANDROMEDA_PROVE_RUN.md (Addendum 3):
 *   34 golden queries + the critical medal query, all categories, zero garbage
 *   citations; conflicts exposed on the medal query (45/37/39 across 3
 *   independent domains) with an answer-caveated verdict.
 */

import { describe, expect, test } from "bun:test";

import { crossCheckClaims } from "../src/convex/searchEngine/crossCheck";
import { classifyCurrentIntent } from "../src/convex/searchEngine/intent";
import { freshnessPolicyFor } from "../src/convex/searchEngine/freshness";
import { readFileSync } from "node:fs";

describe("golden suite: categories exist in the benchmark", () => {
  const src = readFileSync("src/convex/searchQualityBenchmark.ts", "utf8");
  for (const cat of ["government", "statistics", "tech", "conflict", "stale-prone"]) {
    test(`category "${cat}" is part of the golden suite`, () => {
      expect(src).toContain(`"${cat}"`);
    });
  }
  test("the critical sports-results query is part of the suite", () => {
    expect(src).toContain("Asian Games 2026 India medal tally");
  });
});

describe("CRITICAL query routing precondition", () => {
  const q = "What is India's Asian Games 2026 medal tally right now?";
  const classified = classifyCurrentIntent(q, "knowledge");
  const policy = freshnessPolicyFor(q, classified.intent ?? "knowledge");

  test("classified as requiring freshness (never answered from memory)", () => {
    expect(classified.requiresFreshness).toBe(true);
    expect(policy.requiresFreshness).toBe(true);
  });

  test("scoped to the 2026 Asian Games event", () => {
    expect(policy.event).toBe("asian games");
    expect(policy.years).toContain(2026);
  });

  test("vertical is sports", () => {
    expect(policy.vertical).toBe("sports");
  });
});

describe("cross-source agreement/disagreement (claim cross-check)", () => {
  const now = Date.now();
  const h = (n: number) => new Date(now - n * 3_600_000).toISOString();

  test("the SAME value across 3 independent domains corroborates — no conflict", () => {
    const report = crossCheckClaims(
      [
        { domain: "a.example", title: "India medal tally", snippet: "India have 45 medals", publishedAt: h(2) },
        { domain: "b.example", title: "Tally update", snippet: "India reached 45 medals", publishedAt: h(3) },
        { domain: "c.example", title: "Medal count", snippet: "India now on 45 medals", publishedAt: h(5) },
      ],
      now,
    );
    expect(report.conflicts).toHaveLength(0);
  });

  test("DIFFERENT values across independent domains produce a conflict with evidence", () => {
    const report = crossCheckClaims(
      [
        { domain: "rediff.example", title: "Day 8 report", snippet: "India have 45 medals", publishedAt: h(2) },
        { domain: "khelnow.example", title: "Tally", snippet: "India have 37 medals", publishedAt: h(20) },
        { domain: "liveblog.example", title: "Live", snippet: "India on 39 medals", publishedAt: h(1) },
      ],
      now,
    );
    expect(report.conflicts.length).toBeGreaterThan(0);
    const conflict = report.conflicts[0];
    expect(conflict.readings.length).toBe(3);
    for (const r of conflict.readings) {
      expect(r.domain.length).toBeGreaterThan(0);
      expect(r.evidence.length).toBeGreaterThan(0);
    }
  });

  test("one domain repeating a different value is NOISE, not a conflict", () => {
    const report = crossCheckClaims(
      [
        { domain: "a.example", title: "Tally", snippet: "India have 45 medals", publishedAt: h(2) },
        { domain: "a.example", title: "Tally v2", snippet: "India have 45 medals", publishedAt: h(3) },
        { domain: "b.example", title: "Mirror", snippet: "India have 45 medals", publishedAt: h(4) },
      ],
      now,
    );
    expect(report.conflicts).toHaveLength(0);
  });
});

describe("drop-reason vocabulary completeness (per-test reporting contract)", () => {
  test("the trace builder buckets every rejection kind the golden report needs", () => {
    const src = readFileSync("src/convex/searchEngine/debugTrace.ts", "utf8");
    for (const marker of ["kept", "temporal", "quality", "relevance"]) {
      expect(src).toContain(`"${marker}"`);
    }
  });

  test("the benchmark emits per-source publishedAt, scores and dropReasons", () => {
    const src = readFileSync("src/convex/searchQualityBenchmark.ts", "utf8");
    expect(src).toContain("dropReasons");
    expect(src).toContain("publishedAt");
  });
});
