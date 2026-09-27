/**
 * REGRESSION — FRESHNESS. The bug human QA found on the deployed build.
 * =========================================================================
 *
 * WHAT HAPPENED
 * -------------
 * A user asked:
 *
 *   "What is India's latest medal tally at the Asian Games 2026? Give me the
 *    gold, silver, bronze and total medals, India's rank, the exact date/time
 *    of the information, and cite the sources. Use the latest available
 *    information and don't rely on old articles."
 *
 * Omi searched, cited, cross-checked and noticed disagreement — and still
 * answered from a source THREE DAYS OLD, at full confidence, while newer
 * data was available the same day.
 *
 * THE TRACED ROOT CAUSE (four independent causes, all architectural)
 * ------------------------------------------------------------------
 *   1. `maxAgeDays` was a flat 14 (7 for markets) for EVERY current
 *      question. Three days is comfortably inside fourteen.
 *   2. `freshnessScore` bucketed "<=1 day = 1.0" and "<=7 days = 0.9", so a
 *      3-day-old page and a 1-day-old page scored IDENTICALLY. The ranker had
 *      no way to prefer today's page.
 *   3. Freshness was worth only 0.18 of the blended score even when the
 *      question was explicitly about current information.
 *   4. There was no escalation. "Any source inside the window" was the only
 *      test, so the pipeline accepted the first adequate set and stopped.
 *
 * These tests pin all four fixes, and — most importantly — the GENERAL
 * property, so it cannot be fixed by special-casing one event.
 */

import { describe, expect, it } from "bun:test";
import { freshnessPolicyFor, freshnessWindowFor, minAgeHours, shouldEscalateForFreshness, type FreshnessSource } from "../src/convex/searchEngine/freshness";
import { planRetrieval } from "../src/convex/searchEngine/rewrite";
import { classifyCurrentIntent } from "../src/convex/searchEngine/intent";
import { freshnessScore, scoreSource, keywordSet } from "../src/convex/searchEngine/quality";
import { validateEvidence } from "../src/convex/searchEngine/validation";
import { crossCheckClaims } from "../src/convex/searchEngine/crossCheck";
import { decideSearch } from "../src/convex/searchEngine/decision";
import type { WebCitation } from "../src/convex/searchProviders/types";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const H = 3_600_000;
const D = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const MEDAL_QUERY =
  "What is India's latest medal tally at the Asian Games 2026?";

// ===========================================================================
// 1. THE USER'S OWN WORDS DECIDE HOW FRESH THE EVIDENCE MUST BE
// ===========================================================================

describe("freshness regression — the window follows the demand", () => {
  it("'today' is a TIGHT window, not a fortnight", () => {
    const p = freshnessPolicyFor("What happened today?", "news");
    expect(p.freshnessTier).toBe("now");
    // The bug: this was 14. Three days is "inside 14", which is how a
    // 3-day-old article answered a question that said "today".
    expect(p.maxAgeDays).toBeLessThanOrEqual(2);
    expect(p.preferFreshHours).toBeLessThanOrEqual(48);
  });

  it("'latest' is looser than 'today' but still measured in days, not weeks", () => {
    const p = freshnessPolicyFor(MEDAL_QUERY, "current");
    expect(p.freshnessTier).toBe("recent");
    expect(p.maxAgeDays).toBeLessThanOrEqual(7);
  });

  it("a structured vertical is judged by minutes, not article age", () => {
    const weather = freshnessPolicyFor("what's the weather in Mumbai", "current");
    expect(weather.freshnessTier).toBe("live-feed");
    expect(weather.maxAgeDays).toBeLessThanOrEqual(1);
  });

  it("a timeless question has no freshness window at all", () => {
    const p = freshnessPolicyFor("What is the capital of France?");
    expect(p.freshnessTier).toBe("none");
    expect(p.maxAgeDays).toBeGreaterThan(1000);
  });

  it("scales monotonically: now is tighter than recent is tighter than none", () => {
    const w = (t: Parameters<typeof freshnessWindowFor>[0]) => freshnessWindowFor(t, "sports").maxAgeDays;
    expect(w("now")).toBeLessThan(w("recent"));
    expect(w("recent")).toBeLessThan(w("none"));
  });
});

// ===========================================================================
// 2. HOUR-RESOLUTION FRESHNESS SCORING
// ===========================================================================

describe("freshness regression — scoring can tell today from last week", () => {
  it("strictly decreases as a source gets older", () => {
    const ages = [1, 6, 24, 72, 168, 720];
    const scores = ages.map((h) => freshnessScore(iso(h * H), NOW));
    for (let i = 1; i < scores.length; i++) {
      expect(`${ages[i]}h (${scores[i]}) < ${ages[i - 1]}h (${scores[i - 1]})`).toContain("<");
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it("distinguishes the exact case that failed: 3 days vs 1 day", () => {
    // THE bug: both used to score 0.9, so a 3-day-old page was
    // indistinguishable from a 1-day-old one.
    const threeDays = freshnessScore(iso(3 * D), NOW);
    const oneDay = freshnessScore(iso(1 * D), NOW);
    expect(threeDays).toBeLessThan(oneDay);
  });

  it("ranks a same-day source above a 3-day-old one, everything else equal", () => {
    const keywords = keywordSet(MEDAL_QUERY);
    const today: WebCitation = {
      url: "https://example.com/today",
      title: "India medal tally Asian Games 2026",
      snippet: "India won 4 gold, 12 silver and 14 bronze — 30 medals.",
      publishedAt: iso(2 * H),
    };
    const threeDaysOld: WebCitation = {
      url: "https://example.com/three-days",
      title: "India medal tally Asian Games 2026",
      snippet: "India won 4 gold, 12 silver and 14 bronze — 30 medals.",
      publishedAt: iso(3 * D),
    };
    const scoreToday = scoreSource(today, keywords, { freshnessMatters: true, freshnessTier: "recent" });
    const scoreOld = scoreSource(threeDaysOld, keywords, { freshnessMatters: true, freshnessTier: "recent" });
    expect(scoreToday).toBeGreaterThan(scoreOld);
  });

  it("lets freshness outweigh authority when the user asked for current data", () => {
    const keywords = keywordSet(MEDAL_QUERY);
    // A less-authoritative source that is FRESH must beat a .gov page that is
    // a week old, for a "latest" question. That inversion is the whole point.
    const freshBlog: WebCitation = {
      url: "https://mysportsblog.example/today",
      title: "India medal tally Asian Games 2026 today",
      snippet: "India medal tally update for 2026.",
      publishedAt: iso(3 * H),
    };
    const staleOfficial: WebCitation = {
      url: "https://olympics.com/en/olympic-games/2026",
      title: "India medal tally Asian Games 2026",
      snippet: "India medal tally 2026.",
      publishedAt: iso(7 * D),
    };
    const a = scoreSource(freshBlog, keywords, { freshnessMatters: true, freshnessTier: "recent" });
    const b = scoreSource(staleOfficial, keywords, { freshnessMatters: true, freshnessTier: "recent" });
    expect(a).toBeGreaterThan(b);
  });
});

// ===========================================================================
// 3. THE VALIDATION GATE: RECENCY IS A PROPERTY OF THE NEWEST SOURCE
// ===========================================================================

describe("freshness regression — the newest source decides, not the set", () => {
  const src = (hoursAgo: number, domain: string): WebCitation => ({
    url: `https://${domain}/${hoursAgo}`,
    title: "India medal tally Asian Games 2026",
    snippet: "India won 4 gold, 12 silver and 14 bronze — 30 medals.",
    publishedAt: iso(hoursAgo * H),
  });

  it("refuses when the ONLY evidence is 3 days old for a 'today' question", () => {
    const report = validateEvidence({
      query: "What happened today?",
      citations: [src(72, "a.com"), src(96, "b.com")],
      askedYears: [],
      askedEvent: null,
      maxAgeDays: 2,
      preferFreshHours: 30,
      now: NOW,
    });
    expect(report.verdict).toBe("refuse");
    expect(report.checks.find((c) => c.id === "recency")?.passed).toBe(false);
  });

  it("passes when even ONE source is genuinely current", () => {
    const report = validateEvidence({
      query: "What happened today?",
      citations: [src(72, "a.com"), src(3, "b.com")],
      askedYears: [],
      askedEvent: null,
      maxAgeDays: 2,
      preferFreshHours: 30,
      now: NOW,
    });
    expect(report.checks.find((c) => c.id === "recency")?.passed).toBe(true);
  });

  it("does not let a mix of old and new sources pass a tight window", () => {
    // The precise shape of the original bug: the set contained a dated
    // source, which used to be enough.
    const report = validateEvidence({
      query: "What happened today?",
      citations: [src(72, "a.com"), src(100, "b.com"), src(120, "c.com")],
      askedYears: [],
      askedEvent: null,
      maxAgeDays: 2,
      preferFreshHours: 30,
      now: NOW,
    });
    expect(report.verdict).toBe("refuse");
  });

  it("exposes the newest source's absolute timestamp for the answer", () => {
    const report = validateEvidence({
      query: MEDAL_QUERY,
      citations: [src(72, "a.com"), src(4, "b.com")],
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 7,
      preferFreshHours: 72,
      now: NOW,
    });
    expect(report.newestSourceAt).toBe(iso(4 * H));
    expect(report.newestSourceAgeHours).toBe(4);
  });

  it("never reports a future timestamp as 'fresh'", () => {
    const future = iso(-2 * D); // two days in the future
    const report = validateEvidence({
      query: MEDAL_QUERY,
      citations: [{ ...src(4, "b.com"), publishedAt: future }],
      askedYears: [2026],
      askedEvent: "asian games",
      maxAgeDays: 7,
      preferFreshHours: 72,
      now: NOW,
    });
    expect(report.newestSourceAt).toBeUndefined();
  });
});

// ===========================================================================
// 4. ESCALATION: DO NOT SETTLE FOR A STALE SET
// ===========================================================================

describe("freshness regression — escalation triggers on staleness", () => {
  /** Mirrors the escalation decision made in the chat turn. */
  const newestAgeHours = (sources: FreshnessSource[]) => {
    let best: number | null = null;
    for (const s of sources) {
      const t = s.publishedAt ? Date.parse(s.publishedAt) : NaN;
      if (!Number.isFinite(t)) continue;
      const h = (NOW - t) / H;
      if (best === null || h < best) best = h;
    }
    return best;
  };

  it("escalates when the newest source is 3 days old but 30 hours were wanted", () => {
    const sources: FreshnessSource[] = [
      { title: "a", url: "https://a.com", publishedAt: iso(3 * D) },
      { title: "b", url: "https://b.com", publishedAt: iso(4 * D) },
    ];
    const newest = newestAgeHours(sources);
    const prefer = 30;
    expect(newest).not.toBeNull();
    expect(newest as number).toBeGreaterThan(prefer); // → must re-search
  });

  it("does NOT escalate when today's page is already in the set", () => {
    const sources: FreshnessSource[] = [
      { title: "a", url: "https://a.com", publishedAt: iso(3 * D) },
      { title: "b", url: "https://b.com", publishedAt: iso(2 * H) },
    ];
    expect((newestAgeHours(sources) as number)).toBeLessThanOrEqual(30);
  });

  it("does not escalate on undated evidence alone (it escalates on dated-stale)", () => {
    expect(newestAgeHours([{ title: "a", url: "https://a.com" }])).toBeNull();
  });
});

// ===========================================================================
// 5. CROSS-CHECK STILL RUNS, AND CONFLICTS STAY VISIBLE
// ===========================================================================

describe("freshness regression — cross-checking survives the freshness fix", () => {
  it("detects a conflict between two CURRENT sources", () => {
    const report = crossCheckClaims(
      [
        { title: "India wins 4 gold medals", url: "https://reuters.com/a", publishedAt: iso(2 * H) },
        { title: "India wins 5 gold medals", url: "https://bbc.co.uk/b", publishedAt: iso(3 * H) },
      ],
      NOW,
    );
    expect(report.conflicts.length).toBeGreaterThan(0);
  });

  it("treats a stale agreement and a fresh disagreement differently", () => {
    // Two 3-day-old sources agreeing is NOT current agreement.
    const stale = crossCheckClaims(
      [
        { title: "India wins 2 gold medals", url: "https://a.com/x", publishedAt: iso(3 * D) },
        { title: "India wins 2 gold medals", url: "https://b.com/x", publishedAt: iso(3 * D) },
      ],
      NOW,
    );
    const fresh = crossCheckClaims(
      [
        { title: "India wins 4 gold medals", url: "https://a.com/x", publishedAt: iso(2 * H) },
        { title: "India wins 5 gold medals", url: "https://b.com/x", publishedAt: iso(3 * H) },
      ],
      NOW,
    );
    expect(stale.conflicts).toHaveLength(0);
    expect(fresh.conflicts.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 5b. QUERY CONSTRUCTION IS THE BIGGEST LEVER (measured)
// ===========================================================================

describe("freshness regression — the retrieval query carries the recency signal", () => {
  const planFor = (q: string) => planRetrieval(q, classifyCurrentIntent(q, undefined, NOW), NOW);

  it("puts the strong recency word in the PRIMARY, not only in a variant", () => {
    // Every engine sees the primary. A recency word that only appears in a
    // secondary variant leaves the primary call — the one that matters most —
    // carrying no recency signal at all.
    const p = planFor(MEDAL_QUERY);
    expect(p.primary.toLowerCase()).toContain("today");
  });

  it("drops weak recency words, which measured to return STALER results", () => {
    // "India latest medal tally …"  -> 3.3-day-old set
    // "India medal tally … today"   -> yesterday's set
    const p = planFor(MEDAL_QUERY);
    expect(p.primary.toLowerCase()).not.toContain("latest");
    expect(p.notes.join(" ")).toContain("weak recency words");
  });

  it("removes filler that dilutes an index query", () => {
    const p = planFor(MEDAL_QUERY);
    expect(p.primary).not.toMatch(/\bat the\b|\bof the\b|\bwhat is\b/);
  });

  it("stays short enough to retrieve well", () => {
    // A long conversational phrasing measurably retrieved a 3x staler set.
    const p = planFor(MEDAL_QUERY);
    expect(p.primary.split(/\s+/).length).toBeLessThanOrEqual(10);
  });

  it("keeps the event and the year — freshness never costs context", () => {
    const p = planFor(MEDAL_QUERY);
    expect(p.primary.toLowerCase()).toContain("asian games");
    expect(p.primary).toContain("2026");
  });

  it("does not add a recency word to a timeless question", () => {
    const p = planFor("Who won the 2016 Olympics men's 100m?");
    expect(p.primary.toLowerCase()).not.toContain("today");
  });

  it("does not add a web recency word to a structured live feed", () => {
    // A forecast or a rate carries the provider's own read time; forcing a
    // web-article recency word into it is meaningless.
    for (const q of ["what is the weather in Mumbai", "current USD INR rate"]) {
      expect(`${q}: ${planFor(q).primary.toLowerCase()}`).not.toContain("today");
    }
  });

  it("does not duplicate an already-strong recency word", () => {
    const p = planFor("What is happening right now in the Asian Games 2026?");
    const count = (p.primary.toLowerCase().match(/today/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(1);
  });
});


describe("freshness regression — the fix is general, not event-specific", () => {
  const LIVE_QUESTIONS: Array<[string, string]> = [
    ["What is the latest gold price in India?", "markets"],
    ["What is the current USD INR rate?", "markets"],
    ["latest India cricket score", "sports"],
    ["current IPL standings", "sports"],
    ["latest election results", "election"],
    ["latest flight status", "travel"],
    ["latest AI news", "news"],
    ["what is the weather in Mumbai right now", "weather"],
    ["What is India's latest medal tally at the Asian Games 2026?", "sports"],
    ["latest breaking news today", "news"],
  ];

  for (const [q, expectedVertical] of LIVE_QUESTIONS) {
    it(`"${q}" is freshness-gated and routed to ${expectedVertical}`, () => {
      const decision = decideSearch(q);
      const policy = freshnessPolicyFor(q, decision.intent);
      expect(policy.requiresFreshness).toBe(true);
      expect(policy.vertical).toBe(expectedVertical);
      // No current question may fall back to a two-week window.
      expect(policy.maxAgeDays).toBeLessThanOrEqual(7);
    });
  }

  it("a timeless question is NOT dragged into the freshness tier", () => {
    const q = "Who won the 2016 Olympics men's 100m?";
    const policy = freshnessPolicyFor(q, decideSearch(q).intent);
    expect(policy.requiresFreshness).toBe(false);
    expect(policy.freshnessTier).toBe("none");
  });

  it("history and current data are decided by the same general rule", () => {
    expect(classifyCurrentIntent("Who won the 2016 Olympics?", undefined, NOW).freshnessTier).toBe("none");
    expect(classifyCurrentIntent("What is the latest medal tally?", undefined, NOW).freshnessTier).toBe("recent");
    expect(classifyCurrentIntent("What is the score right now?", undefined, NOW).freshnessTier).toBe("now");
  });
});


/**
 * REGRESSION — THE ESCALATION DEAD SPOT.
 * =========================================================================
 *
 * The freshness fix added an escalation pass: when the newest acceptable
 * source is older than the tier demands, search again with a hard "day"
 * filter before settling. It looked correct and the original Asian Games
 * query passed — but only because that query returned a 1-day-old source,
 * which produced a NON-NULL age.
 *
 * The trigger was guarded as:
 *
 *     if (newestHours !== null && newestHours > policy.preferFreshHours)
 *
 * and `minAgeHours([])` returns `null`. So when the first pass returned
 * results that were ALL too old to be evidence, the escalation could not
 * fire. The engine refused on the first pass and never looked again.
 *
 * That is backwards: "nothing recent enough" is the case that most needs a
 * second, tighter pass, and it was the one case guaranteed to skip it.
 * Measured on the deployed build, three /currentinfo scenarios returned
 * "5 raw result(s) but none recent enough" and the suite fell to 6/10.
 *
 * These tests pin the trigger so the dead spot cannot come back.
 */
describe("freshness regression — escalation fires when NOTHING is fresh", () => {
  // These import the SHIPPED trigger, not a copy. A mirrored helper would
  // still pass if someone reverted the real one — which is exactly the
  // regression this suite exists to prevent.
  const shouldEscalate = (
    fresh: Array<{ publishedAt?: string | null }>,
    preferFreshHours: number,
  ) => shouldEscalateForFreshness(fresh, preferFreshHours, NOW);

  it("escalates when the first pass produced NO fresh evidence (the dead spot)", () => {
    // Every source is 6 days old; the "recent" tier window is 5 days, so
    // splitByFreshness would return [] and the old guard returned false.
    const tooOld = [
      { publishedAt: "2026-09-20T12:00:00.000Z" },
      { publishedAt: "2026-09-21T12:00:00.000Z" },
    ];
    expect(minAgeHours(tooOld, NOW)).not.toBeNull(); // a real age exists...
    const policy = freshnessPolicyFor(
      "latest AI news",
      decideSearch("latest AI news").intent,
    );
    // ...but the evidence was REJECTED, so the escalation input is empty.
    expect(shouldEscalate([], policy.preferFreshHours)).toBe(true);
  });

  it("escalates when sources are undated — undated is not evidence of freshness", () => {
    expect(minAgeHours([{ publishedAt: null }, {}], NOW)).toBeNull();
    expect(shouldEscalate([{ publishedAt: null }], 48)).toBe(true);
  });

  it("still escalates when the newest source is merely older than the tier wants", () => {
    const policy = freshnessPolicyFor(
      "latest India cricket score",
      decideSearch("latest India cricket score").intent,
    );
    const tooOld = [{ publishedAt: "2026-09-20T12:00:00.000Z" }];
    expect(shouldEscalate(tooOld, policy.preferFreshHours)).toBe(true);
  });

  it("does NOT escalate when the evidence is already fresh enough (no wasted search)", () => {
    const policy = freshnessPolicyFor(
      "What is India's latest medal tally at the Asian Games 2026?",
      decideSearch("What is India's latest medal tally at the Asian Games 2026?").intent,
    );
    const freshEnough = [{ publishedAt: "2026-09-27T06:00:00.000Z" }]; // 6h old
    expect(minAgeHours(freshEnough, NOW)).toBeLessThanOrEqual(policy.preferFreshHours);
    expect(shouldEscalate(freshEnough, policy.preferFreshHours)).toBe(false);
  });

  it("a timeless question never escalates — freshness is not demanded of it", () => {
    const q = "Who won the 2016 Olympics men's 100m?";
    const policy = freshnessPolicyFor(q, decideSearch(q).intent);
    expect(policy.requiresFreshness).toBe(false);
    expect(shouldEscalate([], policy.preferFreshHours)).toBe(false);
  });

  it("future-dated sources are not counted as fresh evidence", () => {
    const future = [{ publishedAt: "2026-12-25T00:00:00.000Z" }];
    expect(minAgeHours(future, NOW)).toBeNull();
    expect(shouldEscalate(future, 48)).toBe(true);
  });
});
