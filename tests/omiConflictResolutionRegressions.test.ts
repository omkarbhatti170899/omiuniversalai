/**
 * REGRESSION — CONFLICT RESOLUTION (7 REVIEW CASES) + SEARXNG FALLBACK PIN.
 * =============================================================================
 * The owner's review round (commits 325e8e5 / a583591) approved the conflict-
 * resolution architecture and required regression tests for exactly seven
 * cases, plus a pin that Andromeda never depends on a single SearXNG instance.
 *
 * The seven cases and where each was already pinned are listed here so the
 * coverage is auditable:
 *
 *   1. two sources AGREE                        → omiGoldenSearchSuite.test.ts
 *      ("the SAME value across 3 independent domains corroborates")
 *   2. two sources DISAGREE                     → omiGoldenSearchSuite.test.ts
 *      ("DIFFERENT values across independent domains produce a conflict")
 *   3. AUTHORITATIVE vs weak source             → omiGoldenSearchSuite.test.ts
 *      ("AUTHORITATIVE beats newer non-authoritative")
 *   4. OLD authoritative vs NEW weak source     → omiGoldenSearchSuite.test.ts
 *      ("arithmetic does NOT override authority" — official 45 at -21h wins
 *      against a newer reconstruction; pinned again here directly as
 *      age-vs-authority, since the review named this case explicitly)
 *   5. ARITHMETIC CONTRADICTION                 → THIS FILE. The demotion arm
 *      of the arithmetic tie-breaker (a total contradicted by its own
 *      gold+silver+bronze breakdown ranks BELOW a plain reading of equal
 *      authority) had NO test. Measured failure mode: an inconsistent total
 *      (48 with gold 12+silver 18+bronze 16 = 46) could outrank a consistent
 *      one depending on array position — the per-reading arithmeticRank fix.
 *   6. MISSING FIGURES                          → omiGoldenSearchSuite.test.ts
 *      ("numeric question with NO extractable figure fails CLAIM VERIFICATION")
 *   7. THREE OR MORE conflicting values         → THIS FILE. Precedence across
 *      a 3-way split and ORDER-INDEPENDENCE (the same three readings must
 *      resolve identically in every input permutation) were only partially
 *      pinned.
 *
 * The SearXNG pins cover: multi-base fallthrough (no single-instance
 * dependence), fan-out continuation (Promise.allSettled isolation), and the
 * honest refusal contract (NO_VERIFIED_RESULTS, never fabricated). They are
 * wiring pins because the fan-out needs the generated Convex API to run.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  crossCheckClaims,
  resolveConflict,
} from "../src/convex/searchEngine/crossCheck";

const now = Date.now();
const h = (n: number) => new Date(now - n * 3_600_000).toISOString();

// ---------------------------------------------------------------------------
// Case 4 (restated): old authoritative vs new weak
// ---------------------------------------------------------------------------

describe("case 4 — old authoritative vs new weak source", () => {
  test("an older official figure beats a NEWER weak one; basis records authority, not recency", () => {
    const report = crossCheckClaims(
      [
        // Weak but fresher: the failure mode the review named. (Figures use
        // the medal extractor vocabulary — "points" is deliberately NOT a
        // cross-checkable metric, so an unextracted figure can never conflict.)
        { domain: "gpblog.example", title: "Live blog", snippet: "Tally now at 46 medals", publishedAt: h(1) },
        // Official but older in wall-clock terms.
        { domain: "formula1.com", title: "Standings", snippet: "Official tally stands at 45 medals", publishedAt: h(9) },
      ],
      now,
    );
    expect(report.conflicts.length).toBeGreaterThan(0);
    const r = resolveConflict(report.conflicts[0], {
      authoritativeDomains: new Set(["formula1.com"]),
    });
    expect(r.resolution.value).toBe("45");
    expect(r.resolution.domain).toBe("formula1.com");
    expect(r.resolution.basis).toBe("authoritative-newest");
    expect(r.stillContested).toBe(false);
    const aside = r.setAside.find((s) => s.value === "46");
    expect(aside?.domain).toBe("gpblog.example");
    expect(aside?.reason).toContain("not authoritative");
  });

  test("two authoritative readings at different freshness still resolve to the NEWEST one", () => {
    const report = crossCheckClaims(
      [
        { domain: "fia.com", title: "Classification", snippet: "India have 45 medals", publishedAt: h(20) },
        { domain: "formula1.com", title: "Updated standings", snippet: "India have 47 medals", publishedAt: h(2) },
      ],
      now,
    );
    const r = resolveConflict(report.conflicts[0], {
      authoritativeDomains: new Set(["fia.com", "formula1.com"]),
    });
    expect(r.resolution.value).toBe("47");
    expect(r.resolution.domain).toBe("formula1.com");
    // The OLDER authoritative reading is set aside, not hidden, and the
    // reason says it lost to a newer reading of the SAME authority class.
    const older = r.setAside.find((s) => s.value === "45");
    expect(older?.reason).toContain("older than the selected authoritative reading");
  });
});

// ---------------------------------------------------------------------------
// Case 5: arithmetic contradiction (the missing demotion pin)
// ---------------------------------------------------------------------------

describe("case 5 — arithmetic contradiction (breakdown contradicts total)", () => {
  const contradictory = {
    domain: "blog1.example",
    title: "Tally",
    snippet: "India gold 12, silver 18, bronze 16 — 48 medals total", // 12+18+16=46 ≠ 48
    publishedAt: h(2),
  };
  const consistent = {
    domain: "blog2.example",
    title: "Tally",
    snippet: "India gold 12, silver 18, bronze 16 — 46 medals total", // sums correctly
    publishedAt: h(3), // OLDER than the contradictory reading
  };

  test("a breakdown-contradicted total is DEMOTED within equal authority", () => {
    const report = crossCheckClaims([contradictory, consistent], now);
    expect(report.conflicts.length).toBeGreaterThan(0);
    const r = resolveConflict(report.conflicts[0], {});
    // The consistent total wins even though it is the OLDER reading.
    expect(r.resolution.value).toBe("46");
    expect(r.resolution.domain).toBe("blog2.example");
  });

  test("an inconsistent total still loses when it claims authority for a rival figure", () => {
    // Same two readings, now both treated as authoritative pools: arithmetic
    // still separates them INSIDE the pool, so the contradiction is never
    // the presented figure when a valid rival exists at equal authority.
    const report = crossCheckClaims([contradictory, consistent], now);
    const r = resolveConflict(report.conflicts[0], {
      authoritativeDomains: new Set(["blog1.example", "blog2.example"]),
    });
    expect(r.resolution.value).toBe("46");
  });

  test("a contradicted reading ALONE still resolves (demotion never empties the resolution)", () => {
    const report = crossCheckClaims([contradictory, { ...consistent, domain: "blog1b.example", snippet: "India have 37 medals" }], now);
    const r = resolveConflict(report.conflicts[0], {});
    expect(r.resolution).toBeDefined();
    expect(r.resolution.value.length).toBeGreaterThan(0);
  });

  test("arithmetic demotion is position-independent (the inconsistent-comparator fix)", () => {
    // MEASURED: with an argument-order-dependent comparator, Array#sort made
    // the arithmetic check silently vanish depending on array position. Both
    // permutations must resolve to the same figure.
    for (const order of [[contradictory, consistent], [consistent, contradictory]]) {
      const report = crossCheckClaims(order, now);
      const r = resolveConflict(report.conflicts[0], {});
      expect(r.resolution.value).toBe("46");
      expect(r.resolution.domain).toBe("blog2.example");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 7: three or more conflicting values
// ---------------------------------------------------------------------------

describe("case 7 — three or more conflicting values", () => {
  const readings = [
    { domain: "rediff.example", title: "Day 8", snippet: "India have 45 medals", publishedAt: h(21) },
    { domain: "khelnow.example", title: "Tally", snippet: "India have 37 medals", publishedAt: h(20) },
    { domain: "liveblog.example", title: "Live", snippet: "India on 39 medals", publishedAt: h(1) },
  ];

  test("3-way conflict: newest non-authoritative reading wins, other TWO are set aside with reasons", () => {
    const report = crossCheckClaims(readings, now);
    expect(report.conflicts[0].readings).toHaveLength(3);
    const r = resolveConflict(report.conflicts[0], {});
    expect(r.resolution.value).toBe("39"); // newest
    expect(r.resolution.basis).toBe("newest");
    expect(r.setAside.map((s) => s.value).sort()).toEqual(["37", "45"]);
    for (const s of r.setAside) expect(s.reason).toContain("older");
  });

  test("3-way conflict WITH one authoritative reading: authority wins against two weak rivals", () => {
    const report = crossCheckClaims(readings, now);
    const r = resolveConflict(report.conflicts[0], {
      authoritativeDomains: new Set(["rediff.example"]),
    });
    expect(r.resolution.value).toBe("45");
    expect(r.resolution.basis).toBe("authoritative-newest");
    expect(r.setAside.length).toBe(2);
    expect(r.stillContested).toBe(false);
  });

  test("resolution is identical for EVERY input permutation (order-independence)", () => {
    const perms = [
      [readings[0], readings[1], readings[2]],
      [readings[0], readings[2], readings[1]],
      [readings[1], readings[0], readings[2]],
      [readings[1], readings[2], readings[0]],
      [readings[2], readings[0], readings[1]],
      [readings[2], readings[1], readings[0]],
    ];
    const auth = new Set(["rediff.example"]);
    for (const order of perms) {
      const report = crossCheckClaims(order, now);
      const r = resolveConflict(report.conflicts[0], { authoritativeDomains: auth });
      expect(r.resolution.value).toBe("45");
      expect(r.resolution.domain).toBe("rediff.example");
      expect(r.setAside.map((s) => s.value).sort()).toEqual(["37", "39"]);
    }
  });

  test("4+ values: the extra reading is still tracked, never silently dropped", () => {
    const report = crossCheckClaims(
      [...readings, { domain: "wire.example", title: "Wire", snippet: "India touch 41 medals", publishedAt: h(4) }],
      now,
    );
    expect(report.conflicts[0].readings).toHaveLength(4);
    const r = resolveConflict(report.conflicts[0], { authoritativeDomains: new Set(["rediff.example"]) });
    expect(r.resolution.value).toBe("45");
    expect(r.setAside.map((s) => s.value).sort()).toEqual(["37", "39", "41"]);
  });
});

// ---------------------------------------------------------------------------
// SearXNG fallback pin
// ---------------------------------------------------------------------------

describe("SearXNG fallback — no single instance or provider may block Andromeda", () => {
  const searxngSrc = () => readFileSync("src/convex/searchProviders/searxng.ts", "utf8");
  const universalSrc = () => readFileSync("src/convex/universalSearch.ts", "utf8");
  const chatSrc = () => readFileSync("src/convex/omiChat.ts", "utf8");

  test("search falls through multiple bases; failure of one base never ends the call", () => {
    const s = searxngSrc();
    // The attempt loop iterates BASES and breaks only via `stop`, which is set
    // on success or exhausted budget — a failing base moves on to the next.
    expect(s).toContain("for (let b = 0; b < attemptBases.length && !stop; b++)");
    // Base failures are recorded and the loop CONTINUES (record → continue),
    // it does not rethrow inside the loop.
    const loopStart = s.indexOf("for (let b = 0; b < attemptBases.length && !stop; b++)");
    const loopBody = s.slice(loopStart, s.indexOf("if (merged.length > 0)", loopStart));
    expect(loopBody).toContain("noteSearxngBaseResult(");
    expect(loopBody).toContain("lastError = err;");
  });

  test("a dead configured base is skipped via health memory, with one recovery attempt kept open", () => {
    const s = searxngSrc();
    expect(s).toContain("const dialable = bases.filter((b) => !isKnownDead(b))");
    // Fail-open, round-8 form: when every base is known-dead, the FIRST base
    // still gets a recovery dial — but RATE-LIMITED (30 s), so the escalation
    // pass cannot re-pay the same timeout seconds after pass 1 recorded the
    // failure. Cross-call recovery remains possible via the probe TTL.
    expect(s).toContain("RECOVERY_DIAL_MIN_MS");
    expect(s).toContain("recoveryDialAt.set(first, Date.now())");
  });

  test("the fan-out continues when SearXNG fails entirely (allSettled isolation)", () => {
    const s = universalSrc();
    expect(s).toContain("Promise.allSettled(");
    expect(s).toContain("never block the fan-out");
  });

  test("unavailable SearXNG is reported honestly and never counts as a working general-web source", () => {
    const s = searxngSrc();
    // The readiness hint names the real fix instead of pretending partial health.
    expect(s).toContain("this instance has search.formats JSON disabled");
    // Readiness is MEASURED, never inferred from configuration alone.
    expect(s).toContain("HONEST readiness");
    // And the chat turn REFUSES rather than dressing weak or absent evidence up
    // as a current answer.
    const c = chatSrc();
    expect(c).toContain("NO_VERIFIED_RESULTS");
  });
});
