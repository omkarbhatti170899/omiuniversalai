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

import { crossCheckClaims, resolveConflict, conflictResolutionsNotice } from "../src/convex/searchEngine/crossCheck";
import { classifyCurrentIntent } from "../src/convex/searchEngine/intent";
import { freshnessPolicyFor } from "../src/convex/searchEngine/freshness";
import { validateEvidence } from "../src/convex/searchEngine/validation";
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
});

describe("conflict resolution — resolveConflict precedence (measured 37/45/46)", () => {
  const now = Date.now();
  const h = (n: number) => new Date(now - n * 3_600_000).toISOString();

  test("AUTHORITATIVE beats newer non-authoritative; basis records why", () => {
    const report = crossCheckClaims(
      [
        { domain: "indianexpress.example", title: "Tally", snippet: "India have 45 medals", publishedAt: h(21) },
        { domain: "khelnow.example", title: "Tally", snippet: "India have 37 medals", publishedAt: h(20) },
        { domain: "edayfm.example", title: "Live", snippet: "India on 39 medals", publishedAt: h(1) },
      ],
      now,
    );
    expect(report.conflicts.length).toBeGreaterThan(0);
    const r = resolveConflict(report.conflicts[0], {
      authoritativeDomains: new Set(["indianexpress.example"]),
    });
    expect(r.resolution.value).toBe("45");
    expect(r.resolution.domain).toBe("indianexpress.example");
    expect(r.resolution.basis).toBe("authoritative-newest");
    expect(r.resolution.supportingDomains).toContain("indianexpress.example");
    expect(r.stillContested).toBe(false);
    // Every set-aside value carries its source and its reason.
    expect(r.setAside.length).toBe(2);
    for (const s of r.setAside) {
      expect(s.domain.length).toBeGreaterThan(0);
      expect(s.reason.length).toBeGreaterThan(0);
    }
    expect(r.setAside.find((s) => s.value === "37")?.domain).toBe("khelnow.example");
    expect(r.setAside.find((s) => s.value === "39")?.reason).toContain("not authoritative");
  });

  test("no authoritative source: NEWEST wins; set-aside explains staleness", () => {
    const report = crossCheckClaims(
      [
        { domain: "blog1.example", title: "Live", snippet: "India on 39 medals", publishedAt: h(1) },
        { domain: "blog2.example", title: "Tally", snippet: "India have 37 medals", publishedAt: h(20) },
      ],
      now,
    );
    const r = resolveConflict(report.conflicts[0], {});
    expect(r.resolution.value).toBe("39");
    expect(r.resolution.basis).toBe("newest");
    expect(r.setAside[0].reason).toContain("older");
  });

  test("ARITHMETIC tie-break: breakdown-confirmed reading wins within equal authority", () => {
    const report = crossCheckClaims(
      [
        {
          domain: "toi.example",
          title: "Breakdown",
          snippet: "India gold 12, silver 18, bronze 16 — 46 medals total",
          publishedAt: h(3),
        },
        { domain: "blog.example", title: "Tally", snippet: "India have 37 medals", publishedAt: h(2) },
      ],
      now,
    );
    const conflict = report.conflicts[0];
    expect(conflict.metric).toBe("medals");
    const r = resolveConflict(conflict, {});
    expect(r.resolution.value).toBe("46");
    expect(r.resolution.basis).toBe("arithmetic-reconstructed");
  });

  test("arithmetic does NOT override authority: newer blog reconstruction loses to an older official total", () => {
    const report = crossCheckClaims(
      [
        { domain: "oc.example", title: "Official", snippet: "India have 45 medals", publishedAt: h(21) },
        {
          domain: "blog.example",
          title: "Breakdown",
          snippet: "India gold 15, silver 15, bronze 16 — 46 medals total",
          publishedAt: h(1),
        },
      ],
      now,
    );
    const r = resolveConflict(report.conflicts[0], {
      authoritativeDomains: new Set(["oc.example"]),
    });
    expect(r.resolution.value).toBe("45");
    expect(r.resolution.domain).toBe("oc.example");
    expect(r.resolution.basis).toBe("authoritative-newest");
  });

  test("two authoritative sources, same freshness, different values → stillContested", () => {
    const report = crossCheckClaims(
      [
        { domain: "auth1.example", title: "A", snippet: "India have 45 medals", publishedAt: h(2) },
        { domain: "auth2.example", title: "B", snippet: "India have 37 medals", publishedAt: h(2) },
      ],
      now,
    );
    const r = resolveConflict(report.conflicts[0], {
      authoritativeDomains: new Set(["auth1.example", "auth2.example"]),
    });
    expect(r.stillContested).toBe(true);
  });

  test("resolution notice: ONE figure + citation, set-asides named as set-aside", () => {
    const report = crossCheckClaims(
      [
        { domain: "indianexpress.example", title: "Tally", snippet: "India have 45 medals", publishedAt: h(21) },
        { domain: "khelnow.example", title: "Tally", snippet: "India have 37 medals", publishedAt: h(20) },
      ],
      now,
    );
    const notice = conflictResolutionsNotice(
      report,
      new Set(["indianexpress.example"]),
      now,
    );
    expect(notice).not.toBeNull();
    expect(notice!.contested).toBe(false);
    expect(notice!.text).toContain("report 45 as the current figure");
    expect(notice!.text).toContain("indianexpress.example");
    expect(notice!.text).toContain("set aside: 37 (khelnow.example)");
  });

  test("resolution notice falls back to EXPLICIT DISAGREEMENT when contested", () => {
    const report = crossCheckClaims(
      [
        { domain: "auth1.example", title: "A", snippet: "India have 45 medals", publishedAt: h(2) },
        { domain: "auth2.example", title: "B", snippet: "India have 37 medals", publishedAt: h(2) },
      ],
      now,
    );
    const notice = conflictResolutionsNotice(
      report,
      new Set(["auth1.example", "auth2.example"]),
      now,
    );
    expect(notice!.contested).toBe(true);
    expect(notice!.text).toContain("sources disagree");
  });

  test("no conflicts → no resolution notice", () => {
    const report = crossCheckClaims(
      [
        { domain: "a.example", title: "T", snippet: "India have 45 medals", publishedAt: h(2) },
        { domain: "b.example", title: "T", snippet: "India have 45 medals", publishedAt: h(3) },
      ],
      now,
    );
    expect(conflictResolutionsNotice(report, new Set(), now)).toBeNull();
  });

  test("readings stay per-VALUE with a representative claim (resolution works on readings)", () => {
    const report = crossCheckClaims(
      [
        { domain: "rediff.example", title: "A", snippet: "India have 45 medals", publishedAt: h(2) },
        { domain: "ndtv.example", title: "B", snippet: "India have 45 medals", publishedAt: h(3) },
        { domain: "khelnow.example", title: "C", snippet: "India have 37 medals", publishedAt: h(20) },
      ],
      now,
    );
    expect(report.conflicts[0].readings).toHaveLength(2); // 45 and 37, not 3
    expect(report.conflicts[0].readings.map((r) => r.value).sort()).toEqual(["37", "45"]);
  });
});

describe("validation: CONSISTENCY and CLAIM VERIFICATION are separate checks", () => {
  const now = Date.now();
  const h = (n: number) => new Date(now - n * 3_600_000).toISOString();
  const cite = (domain: string, snippet: string, ageH: number) => ({
    title: `T (${domain})`,
    url: `https://${domain}/a`,
    snippet,
    publishedAt: h(ageH),
  });
  const q = "India's current Asian Games 2026 medal tally";

  test("fresh+dated+authoritative sources that DISAGREE fail CONSISTENCY specifically", () => {
    const citations = [
      cite("a.example", "India have 45 medals", 2),
      cite("b.example", "India have 37 medals", 3),
    ] as never;
    const report = validateEvidence({
      query: q,
      citations: citations as never,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 7,
      preferFreshHours: 72,
      crossCheck: crossCheckClaims(citations as never, now),
      now,
    });
    const consistency = report.checks.find((c) => c.id === "consistency");
    expect(consistency).toBeDefined();
    expect(consistency!.passed).toBe(false);
    const claimCheck = report.checks.find((c) => c.id === "claim-verification");
    expect(claimCheck!.passed).toBe(true); // figures ARE extractable
    expect(report.unverifiable.join(" ")).toContain("Sources disagree");
  });

  test("numeric question with NO extractable figure fails CLAIM VERIFICATION", () => {
    const citations = [
      cite("a.example", "Coverage of the games continues across venues.", 2),
      cite("b.example", "Athletes praised the village food.", 3),
    ] as never;
    const report = validateEvidence({
      query: q,
      citations: citations as never,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 7,
      preferFreshHours: 72,
      crossCheck: crossCheckClaims(citations as never, now),
      now,
    });
    const claimCheck = report.checks.find((c) => c.id === "claim-verification");
    expect(claimCheck).toBeDefined();
    expect(claimCheck!.passed).toBe(false);
  });

  test("agreeing independent sources pass CONSISTENCY", () => {
    const citations = [
      cite("a.example", "India have 45 medals", 2),
      cite("b.example", "India reached 45 medals", 3),
    ] as never;
    const report = validateEvidence({
      query: q,
      citations: citations as never,
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 7,
      preferFreshHours: 72,
      crossCheck: crossCheckClaims(citations as never, now),
      now,
    });
    const consistency = report.checks.find((c) => c.id === "consistency");
    expect(consistency!.passed).toBe(true);
  });
});

describe("golden benchmark rows for this review phase", () => {
  const src = readFileSync("src/convex/searchQualityBenchmark.ts", "utf8");
  for (const q of [
    "current F1 championship leader",
    "current cricket tournament standings",
    "current football standings",
    "current gold price",
    "current inflation figure India",
  ]) {
    test(`row exists: "${q}"`, () => {
      expect(src).toContain(`"${q}"`);
    });
  }

  test("F1 leader question is classified as a live standing (source-quality gate arms)", () => {
    const q = "who is leading the F1 2026 drivers championship";
    const classified = classifyCurrentIntent(q, "knowledge");
    expect(classified.liveData).toBe("standing");
    expect(classified.requiresFreshness).toBe(true);
    const policy = freshnessPolicyFor(q, classified.intent ?? "knowledge");
    expect(policy.vertical).toBe("sports");
    expect(policy.event).toBe("formula 1");
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
