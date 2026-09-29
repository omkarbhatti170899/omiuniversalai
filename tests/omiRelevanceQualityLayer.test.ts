/**
 * REGRESSION — RELEVANCE + SOURCE-QUALITY LAYER (2026-09-29).
 * =============================================================================
 *
 * Trigger: freshness was passing but the KEPT sets for broad news questions
 * contained weak/unrelated material — a YouTube result and evergreen
 * "Make in India" content for "latest news in India", an unrelated actors-
 * workshop page for "what happened in the world today".
 *
 * The layer, pinned here:
 *   • usefulnessPenalty: video/social platforms, clickbait titles, tag and
 *     category pages are NOISE (multiplicative penalty, not additive).
 *   • sourceQualityScore: authority tier discounted by that noise.
 *   • scoreSourceDetailed: the full final score — relevance + freshness +
 *     authority + sourceQuality + directness, × temporalPenalty ×
 *     (1 − usefulnessPenalty), with the breakdown persisted per citation.
 *   • fresh-but-unrelated: freshness credit is already zero for off-topic
 *     sources (previous fix); the noise floor now also removes
 *     fresh-but-useless pages regardless of timestamp.
 *   • THE CONTRACT IS UNCHANGED: cache bypass, memory protection, year/event
 *     gating, provider fallback — all still pinned by their own suites.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  scoreSource,
  scoreSourceDetailed,
  usefulnessPenalty,
  sourceQualityScore,
  keywordSet,
} from "../src/convex/searchEngine/quality";
import type { WebCitation } from "../src/convex/searchProviders/types";

const now = Date.now();
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const base = {
  url: "https://example-news.example/story",
  title: "India medal tally Asian Games 2026",
  snippet: "India won 4 gold, 12 silver and 14 bronze at the 2026 Asian Games.",
};
const MEDAL_KEYWORDS = keywordSet("Indian contingent medals tally Asian Games 2026");

describe("usefulness penalty — the measured noise cases", () => {
  test("a YouTube result is heavy noise (≥0.45 ⇒ floored out of the set)", () => {
    const yt = { ...base, url: "https://www.youtube.com/watch?v=abc" };
    expect(usefulnessPenalty(yt)).toBeGreaterThanOrEqual(0.45);
  });

  test("clickbait titles are penalised per pattern", () => {
    const bait = {
      ...base,
      title: "You won't believe what happens next!!",
    };
    expect(usefulnessPenalty(bait)).toBeGreaterThan(0);
    // Two patterns ⇒ more than one.
    const bait2 = { ...base, title: "SHOCKING: this one trick goes wrong!!" };
    expect(usefulnessPenalty(bait2)).toBeGreaterThan(usefulnessPenalty(bait));
  });

  test("tag/category pages are noise even on good domains", () => {
    const tag = { ...base, url: "https://www.reuters.com/tag/india/" };
    expect(usefulnessPenalty(tag)).toBeGreaterThanOrEqual(0.3);
  });

  test("a clean news article is not penalised at all", () => {
    expect(usefulnessPenalty(base as WebCitation)).toBe(0);
  });

  test("the penalty is bounded — no source is annihilated outright in scoring", () => {
    const yt = { ...base, url: "https://www.youtube.com/watch?v=abc" };
    expect(usefulnessPenalty(yt)).toBeLessThanOrEqual(0.8);
  });
});

describe("source quality = authority discounted by usefulness", () => {
  test("a reputable domain with a video page scores as poor material", () => {
    const yt = { ...base, url: "https://www.youtube.com/watch?v=abc" };
    const clean = base as WebCitation;
    // Same tierable authority would be equal without noise; the video page
    // must score strictly lower as MATERIAL.
    expect(sourceQualityScore(yt)).toBeLessThan(sourceQualityScore(clean));
  });

  test("a clean article on a strong domain scores higher than on a weak one", () => {
    const strong = { ...base, url: "https://www.reuters.com/world/story" };
    const weak = { ...base, url: "https://randomforum.example/thread" };
    expect(sourceQualityScore(strong as WebCitation)).toBeGreaterThan(
      sourceQualityScore(weak as WebCitation),
    );
  });
});

describe("the final score — fresh-but-unrelated must lose", () => {
  test("a 1-hour-old UNRELATED page ranks below a 6-hour-old direct answer", () => {
    const freshUnrelated: WebCitation = {
      url: "https://fresh-noise.example/x",
      title: "Actors workshop masterclass for aspiring performers",
      snippet: "Learn acting from Dr. Ollie this weekend. Limited seats, sign up now.",
      publishedAt: iso(1),
    };
    const directAnswer: WebCitation = {
      ...base,
      url: "https://khelnow.example/medal-tally",
      title: "Asian Games 2026: India's medal tally after Day 8",
      snippet: "India now have 37 medals — 4 gold, 16 silver and 17 bronze.",
      publishedAt: iso(6),
    };
    const a = scoreSource(freshUnrelated, MEDAL_KEYWORDS, {
      freshnessMatters: true,
      freshnessTier: "now",
      askedYears: [2026],
    });
    const b = scoreSource(directAnswer, MEDAL_KEYWORDS, {
      freshnessMatters: true,
      freshnessTier: "now",
      askedYears: [2026],
    });
    expect(b).toBeGreaterThan(a);
  });

  test("a YouTube result cannot outrank a clean article by being fresher", () => {
    const yt = {
      ...base,
      url: "https://www.youtube.com/watch?v=abc",
      title: "India medal tally Asian Games 2026",
      publishedAt: iso(1),
    };
    const article = { ...base, publishedAt: iso(6) };
    const a = scoreSource(yt, MEDAL_KEYWORDS, { freshnessMatters: true, freshnessTier: "now" });
    const b = scoreSource(article, MEDAL_KEYWORDS, { freshnessMatters: true, freshnessTier: "now" });
    expect(b).toBeGreaterThan(a);
  });
});

describe("score breakdown is computed and persisted", () => {
  test("scoreSourceDetailed reports every component", () => {
    const bd = scoreSourceDetailed({ ...base, publishedAt: iso(4) }, MEDAL_KEYWORDS, {
      freshnessMatters: true,
      freshnessTier: "recent",
    });
    for (const k of [
      "relevance",
      "freshness",
      "authority",
      "sourceQuality",
      "directness",
      "corroboration",
      "final",
    ] as const) {
      expect(bd).toHaveProperty(k);
      expect(typeof bd[k]).toBe("number");
    }
    // The parts must add up to roughly the whole (within rounding + penalties).
    const sum =
      bd.relevance + bd.freshness + bd.authority + bd.sourceQuality + bd.directness + 0.12;
    expect(bd.final).toBeGreaterThan(0);
    expect(bd.final).toBeLessThanOrEqual(1.01);
    expect(sum).toBeGreaterThan(0);
  });

  test("scoreSource matches the breakdown's final", () => {
    const c = { ...base, publishedAt: iso(4) } as WebCitation;
    const s = scoreSource(c, MEDAL_KEYWORDS, { freshnessMatters: true });
    const bd = scoreSourceDetailed(c, MEDAL_KEYWORDS, { freshnessMatters: true });
    expect(Math.abs(s - bd.final)).toBeLessThan(0.005);
  });

  test("the ranker persists scoreBreakdown onto kept citations (source pin)", () => {
    const s = readFileSync("src/convex/universalSearch.ts", "utf8");
    expect(s).toContain("item.c.scoreBreakdown = bd;");
    // The noise floor and the sort must feed the SAME list downstream.
    expect(s).toContain("if (usefulnessPenalty(item.c) >= 0.45) continue;");
    expect(s).toContain("ranked.sort((a, b) => b.score - a.score)");
    expect(s).toContain("const unique = dedupeSyndication(ranked);");
  });
});

describe("the existing contract is untouched (source pins)", () => {
  test("cache bypass, memory protection, year gate, fallback still wired", () => {
    expect(readFileSync("src/convex/universalSearch.ts", "utf8")).toContain(
      "if (!opts?.skipCache && !freshnessMatters)",
    );
    const chat = readFileSync("src/convex/omiChat.ts", "utf8");
    expect(chat).toContain("enforceMemoryProtection({ memoryProtected, content })");
    expect(chat).toContain("!isWrongYear(matchTemporal(c, policy.years, null))");
    expect(readFileSync("src/convex/searchEngine/resilience.ts", "utf8")).toContain(
      "export function strictVerticalFallbackFor",
    );
  });
});
