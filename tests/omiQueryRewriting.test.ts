/**
 * Query rewriting tests (spec §2 / "improve actual source relevance").
 *
 * The rewriter is the UPSTREAM half of the search fix: a well-formed query
 * produces relevant results no matter how they are ranked. These tests pin the
 * three properties that matter:
 *
 *   1. ANCHORING — the asked year and event are always present, so a bare
 *      "medal tally" cannot return a previous Games.
 *   2. NO NOISE — vertical terms are added ONLY when the user has not already
 *      said it, and an "angle" that merely repeats a token already present is
 *      dropped rather than costing a provider call.
 *   3. NO INVENTION — a rewrite never asserts a fact the user did not ask
 *      about, and the original question is never mutated.
 */

import { describe, expect, it } from "bun:test";
import { planRetrieval, providersForVariant, GENERAL_WEB_PROVIDERS } from "../src/convex/searchEngine/rewrite";
import { classifyCurrentIntent, retrievalQuery, namesEvent } from "../src/convex/searchEngine/intent";
import { freshnessPolicyFor } from "../src/convex/searchEngine/freshness";
import { getProviderStatus } from "../src/convex/searchProviders";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const plan = (q: string) => planRetrieval(q, classifyCurrentIntent(q, undefined, NOW));

describe("query rewriting — anchoring the year and the event", () => {
  it("keeps the asked year in the retrieval string", () => {
    // The year is the thing that stops a previous Games being returned, so
    // its PRESENCE is the invariant — whether it was re-added or preserved.
    expect(plan("Asian Games 2026 medal tally").primary).toContain("2026");
  });

  it("never duplicates a year the user already typed", () => {
    const p = plan("What is India's medal tally in Asian Games 2026?");
    const years = p.primary.match(/20\d\d/g) ?? [];
    expect(new Set(years).size).toBe(years.length);
  });

  it("does not bolt a canonical name onto a synonym the user already wrote", () => {
    // "Indian Premier League" IS the IPL. Appending "ipl" would add a token
    // and buy nothing.
    const p = plan("Indian Premier League 2026 standings");
    expect(p.primary.toLowerCase().match(/\bipl\b/g) ?? []).toHaveLength(0);
    expect(p.notes.join(" ")).toContain("already named");
  });

  it("strips the interrogative frame before anything else", () => {
    expect(retrievalQuery("What is the Indian contingent medal tally?")).toBe(
      "Indian contingent medal tally",
    );
  });
});

describe("query rewriting — no added noise", () => {
  it("does NOT append sports terms to a query that already says score", () => {
    // "India cricket score result report" is WORSE than "India cricket score":
    // the two extra tokens compete with the two that identify the request.
    // (The trailing "today" is a deliberate, measured addition — see the
    // freshness regression suite; it is the recency signal, not filler.)
    const p = plan("latest India cricket score");
    expect(p.primary).toBe("India cricket score today");
    expect(p.primary).not.toContain("result report");
  });

  it("does NOT append sports terms to a standings or medal query", () => {
    expect(plan("current IPL standings").primary).toBe("IPL standings today");
    expect(plan("medal tally Asian Games 2026").primary).not.toContain("result report");
  });

  it("DOES add vertical terms when the query is genuinely underspecified", () => {
    // "Asian Games 2026" alone does not say what is being asked for.
    const p = plan("Asian Games 2026");
    expect(p.primary.length).toBeGreaterThan("Asian Games 2026".length);
  });

  it("never produces a variant identical to the primary", () => {
    for (const q of [
      "What is the Indian contingent medals tally in Asian Games 2026?",
      "latest India cricket score",
      "current IPL standings",
      "latest election results",
      "current USD INR rate",
      "latest AI news",
    ]) {
      const p = plan(q);
      expect(p.variants).not.toContain(p.primary);
    }
  });

  it("bounds the fan-out — an unbounded fan-out is a latency bug", () => {
    for (const q of ["Asian Games 2026", "latest AI news", "current gold price India"]) {
      expect(plan(q).variants.length).toBeLessThanOrEqual(3);
    }
  });

  it("drops an angle that only repeats a token already present", () => {
    // "IPL standings ipl" bought nothing and cost a provider call.
    for (const v of plan("current IPL standings").variants) {
      expect(v.toLowerCase().match(/ipl/g) ?? []).toHaveLength(1);
    }
  });
});

describe("query rewriting — never invents anything", () => {
  it("adds only the year and event the USER named", () => {
    const p = plan("latest Apple stock price");
    // No year or event was asked for, so none may be invented.
    expect(p.primary).toBe("Apple stock price");
    expect(p.primary).not.toMatch(/\b20\d\d\b/);
  });

  it("adds only a recency word for a current question", () => {
    // Measured: "latest" is a WEAK recency signal to a search index and
    // returned a 3x staler result set than "today" on the same event, so the
    // rewriter substitutes the strong word.
    const p = plan("latest AI news");
    expect(p.primary).toBe("AI news today");
    expect(p.variants.join(" ")).toContain("latest");
  });

  it("does not add recency wording to a historical question", () => {
    const p = plan("Who won the 2016 Olympics men's 100m?");
    expect(p.primary.toLowerCase()).not.toContain("latest");
  });

  it("never mutates the question used for validation and synthesis", () => {
    const original = "What is the Indian contingent medals tally in Asian Games 2026?";
    plan(original);
    expect(original).toBe("What is the Indian contingent medals tally in Asian Games 2026?");
  });
});

describe("query rewriting — only general-web providers see the variants", () => {
  it("sends variants to general web and not to structured providers", () => {
    const p = plan("current USD INR rate");
    // A rate provider knows what to ask for; a rewrite only confuses it.
    expect(providersForVariant("searxng", p)).toBe(true);
    expect(providersForVariant("gdelt", p)).toBe(true);
    expect(providersForVariant("market-rates", p)).toBe(false);
    expect(providersForVariant("openmeteo", p)).toBe(false);
    expect(providersForVariant("sports-scores", p)).toBe(false);
  });

  it("names no provider that is not a registered general-web source", () => {
    // The invariant is what matters: every variant target must be a provider
    // that actually exists in the registry, or a rewrite is spent on a fan-out
    // leg that can never return anything. Asserted against the real registry
    // rather than a second hardcoded list, which is how a genuine provider
    // addition (langsearch) previously broke this test while the product
    // worked correctly.
    const registered = new Set(getProviderStatus().map((p) => p.id));
    for (const id of GENERAL_WEB_PROVIDERS) {
      expect(registered.has(id)).toBe(true);
    }
  });

  it("routes variants to langsearch — it is the only dated general-web index", () => {
    // LangSearch returned a publication date on 100% of benchmark results
    // against SearXNG's 5%. Excluding it from the variant fan-out would mean
    // a single phrasing decided whether the dated index was ever asked.
    const p = plan("current USD INR rate");
    expect(providersForVariant("langsearch", p)).toBe(true);
  });
});

describe("query rewriting — works across the reported live queries", () => {
  const REPORTED = [
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

  for (const q of REPORTED) {
    it(`"${q}" produces a usable, non-empty retrieval plan`, () => {
      const p = plan(q);
      expect(p.primary.length).toBeGreaterThan(2);
      expect(p.primary).not.toMatch(/\?$/);
      // The event the user asked about survives the rewrite — under its own
      // wording or a recognised synonym, not necessarily the canonical name.
      const classified = classifyCurrentIntent(q, undefined, NOW);
      if (classified.event) {
        expect(namesEvent(p.primary, classified.event)).toBe(true);
      }
    });
  }

  it("the historical control is NOT rewritten into a live query", () => {
    const p = plan("Who won the 2016 Olympics men's 100m?");
    expect(p.primary.toLowerCase()).not.toContain("latest");
    const policy = freshnessPolicyFor("Who won the 2016 Olympics men's 100m?");
    expect(policy.requiresFreshness).toBe(false);
  });
});
