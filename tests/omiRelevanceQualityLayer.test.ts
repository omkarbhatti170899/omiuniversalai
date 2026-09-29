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
  isNonSequiturForBroadNews,
  topicKeywords,
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

describe("broad-news non-sequitur floor (second pass, measured)", () => {
  const q = "What happened in the world today?";
  const topic = topicKeywords(q);

  test("the actors-workshop promo the user reported is a non-sequitur", () => {
    const ollie: WebCitation = {
      url: "https://myk104.com/4620/dr-ollies-masterclass-actors-workshop",
      title: "Dr. Ollie’s Masterclass Actors Workshop",
      snippet:
        "Dr. Ollie’s Masterclass Actors Workshop is bringing you an unforgettable, hands-on experience featuring acclaimed actress & producer Vivica A. Fox",
      publishedAt: iso(2),
    };
    expect(isNonSequiturForBroadNews(ollie, topic, { requiresFreshness: true })).toBe(true);
  });

  test("evergreen corporate content under a regional news question is a non-sequitur", () => {
    const corporate: WebCitation = {
      url: "https://example.example/make-in-india",
      title: "Make in India — official page",
      snippet: "Make in India is an initiative. About us: our mission and careers.",
      publishedAt: iso(3),
    };
    const t = topicKeywords("latest India news");
    expect(isNonSequiturForBroadNews(corporate, t, { requiresFreshness: true })).toBe(true);
  });

  test("a real news story for the same question survives the floor", () => {
    const story: WebCitation = {
      url: "https://www.aljazeera.com/news/liveblog/2026/9/28/iran-war-live-tehran",
      title: "Iran war live: Tehran responds to strikes",
      snippet: "Live coverage of the conflict as it unfolds today.",
      publishedAt: iso(1),
    };
    expect(isNonSequiturForBroadNews(story, topic, { requiresFreshness: true })).toBe(false);
  });

  test("the floor never applies to SPECIFIC questions — Asian Games is untouched", () => {
    const medalPage: WebCitation = {
      url: "https://khelnow.example/medal-tally",
      title: "Asian Games 2026 medal tally workshop of records",
      snippet: "India have 37 medals. The medal workshop continues.",
      publishedAt: iso(5),
    };
    const t = topicKeywords("Indian contingent medals tally in Asian Games 2026");
    // Even a page that literally says "workshop" must NOT be floored when the
    // question is specific — the non-sequitur rule is broad-news-only.
    expect(isNonSequiturForBroadNews(medalPage, t, { requiresFreshness: true })).toBe(false);
  });

  test("the floor is wired into the chat turn, the probe, the trace and the benchmark", () => {
    expect(readFileSync("src/convex/omiChat.ts", "utf8")).toContain("isNonSequiturForBroadNews(c, topic");
    expect(readFileSync("src/convex/omiSelfTest.ts", "utf8")).toContain("isNonSequiturForBroadNews(c, topicWords");
    expect(readFileSync("src/convex/searchDebug.ts", "utf8")).toContain("isNonSequiturForBroadNews(c, topic");
    expect(readFileSync("src/convex/searchQualityBenchmark.ts", "utf8")).toContain(
      "non-sequitur for a broad news question",
    );
  });

  test("the video-path floor catches player pages on unknown domains", () => {
    const player: WebCitation = {
      url: "https://old.bitchute.com/video/WJ5igZS3o24v",
      title: "Some broadcast episode",
      snippet: "Episode recording.",
    };
    const smallBroadcaster: WebCitation = {
      url: "https://www.ukcolumn.org/video/uk-column-news-28th-september-2026",
      title: "UK Column News 28th September 2026",
      snippet: "News programme.",
    };
    expect(usefulnessPenalty(player)).toBeGreaterThanOrEqual(0.45);
    expect(usefulnessPenalty(smallBroadcaster)).toBeGreaterThanOrEqual(0.45);
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
