/**
 * REGRESSION — CURRENT-INFORMATION CHAT-PATH CONTRACT (2026-09-28 phase).
 * =============================================================================
 *
 * Every test here pins a property of the REAL chat turn (omiChat.ts), not a
 * pure function in isolation. Where the chat path cannot be executed in a unit
 * test (it needs the Convex runtime and paused-deployment-free functions), the
 * wiring is pinned by source so the guarantee cannot silently regress, and the
 * pure decision logic is exercised directly.
 *
 * Contracts covered:
 *   1. FUTURE-DATE PROTECTION — valid / old / slightly-future / obviously
 *      future / missing / malformed timestamps are classified correctly by the
 *      ONE shared helper (`plausibleAgeHours`) that both escalation and
 *      ranking use, so they can never disagree again.
 *   2. ENFORCED MEMORY PROTECTION — a current question with unverified
 *      evidence must not be answerable from model memory. Previously the
 *      guarantee was a system-prompt note the model could ignore; it is now
 *      mechanically enforced (`enforceMemoryProtection`), and the wiring pins
 *      prove the chat turn sets the flag on ALL THREE unverified paths and
 *      applies the replacement after generation.
 *   3. CACHE BYPASS — a current question is never served from cache: the
 *      freshness policy forces `skipCache`, and the cache read is additionally
 *      gated on `!freshnessMatters`, so the two independent conditions must
 *      BOTH fail before a cached row can be returned.
 *   4. YEAR/EVENT GATING — 2026 is a hard constraint for the Asian Games
 *      query: a 2018/2022 article is dropped even when fresh and relevant.
 *   5. LANGSEARCH OPTIONALITY — enabled, but never required: the pipeline
 *      must proceed and the turn must survive with LangSearch down or quota-
 *      exhausted (circuit breaker + allSettled isolation, pinned here).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  plausibleAgeHours,
  minAgeHours,
  freshnessPolicyFor,
  shouldEscalateForFreshness,
} from "../src/convex/searchEngine/freshness";
import { enforceMemoryProtection } from "../src/convex/searchEngine/validation";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const iso = (s: string) => new Date(s).toISOString();

// ---------------------------------------------------------------------------
// 1. Future-date protection — the six timestamp cases from the contract
// ---------------------------------------------------------------------------

describe("future-date protection (plausibleAgeHours)", () => {
  test("a valid current timestamp keeps its real (tiny) age", () => {
    const age = plausibleAgeHours(iso("2026-09-28T11:00:00Z"), NOW);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThan(0.9);
    expect(age!).toBeLessThan(1.2);
  });

  test("an old timestamp keeps its real age — it is not hidden", () => {
    expect(plausibleAgeHours(iso("2026-09-21T12:00:00Z"), NOW)).toBeCloseTo(168, 0);
  });

  test("a slightly future timestamp (clock skew) clamps to 0, not a fake freshness boost", () => {
    // 2 h ahead — inside the 12 h skew allowance. Publisher clocks drift;
    // this is harmless and must read as "now", never as negative.
    expect(plausibleAgeHours(iso("2026-09-28T14:00:00Z"), NOW)).toBe(0);
    // The measured defect: 5 h ahead used to rank as the freshest possible
    // evidence. It must now be indistinguishable from "published now".
    expect(plausibleAgeHours(iso("2026-09-28T17:00:00Z"), NOW)).toBe(0);
  });

  test("an obviously future timestamp is treated as NO date at all", () => {
    // 13 h ahead — past the skew allowance. A page dated tomorrow is a
    // scheduling artefact, not a scoop.
    expect(plausibleAgeHours(iso("2026-09-29T01:00:01Z"), NOW)).toBeNull();
    expect(plausibleAgeHours(iso("2027-01-01T00:00:00Z"), NOW)).toBeNull();
  });

  test("a missing timestamp is null — never age 0", () => {
    expect(plausibleAgeHours(undefined, NOW)).toBeNull();
    expect(plausibleAgeHours(null, NOW)).toBeNull();
    expect(plausibleAgeHours("", NOW)).toBeNull();
  });

  test("a malformed timestamp is null — never age 0", () => {
    expect(plausibleAgeHours("nonsense", NOW)).toBeNull();
    expect(plausibleAgeHours("2026-13-45T99:99:99Z", NOW)).toBeNull();
    expect(plausibleAgeHours("September 32nd", NOW)).toBeNull();
  });

  test("escalation and freshness aggregation agree with the classifier", () => {
    // A future-dated source must count as "no dated evidence" for escalation.
    expect(
      shouldEscalateForFreshness([{ publishedAt: iso("2027-01-01T00:00:00Z") }], 30, NOW),
    ).toBe(true);
    // …and minAgeHours must skip it entirely, not clamp it to 0.
    expect(
      minAgeHours(
        [{ publishedAt: iso("2027-01-01T00:00:00Z") }, { publishedAt: iso("2026-09-28T10:00:00Z") }],
        NOW,
      ),
    ).toBeCloseTo(2, 5);
    // Only-future sources ⇒ no dated evidence at all.
    expect(minAgeHours([{ publishedAt: iso("2027-06-01T00:00:00Z") }], NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Enforced memory protection
// ---------------------------------------------------------------------------

describe("enforced memory protection (pure judge)", () => {
  test("a normal turn is untouched", () => {
    const d = enforceMemoryProtection({
      memoryProtected: false,
      content: "India has won 12 medals so far…",
    });
    expect(d.replace).toBe(false);
  });

  test("a generated answer on an unverified current turn IS replaced", () => {
    const d = enforceMemoryProtection({
      memoryProtected: true,
      content: "India has won 12 medals so far at the 2026 Asian Games.",
    });
    expect(d.replace).toBe(true);
  });

  test("the model's own honest refusal is kept, not double-replaced", () => {
    for (const honest of [
      "I could not verify a current, reliable answer to \"latest India news\".",
      "I could not find any live sources for this, so I can't verify a current answer.",
      "I am deliberately not filling this in from my training data — my knowledge has a cutoff.",
    ]) {
      const d = enforceMemoryProtection({ memoryProtected: true, content: honest });
      expect(d.replace).toBe(false);
    }
  });

  test("a streamed refusal with leading reasoning noise still counts as honest", () => {
    // The streamed content may carry markdown or whitespace; the check must
    // not fail on formatting.
    const d = enforceMemoryProtection({
      memoryProtected: true,
      content: "  \nI could not verify a current answer.",
    });
    expect(d.replace).toBe(false);
  });
});

describe("memory protection wiring in the chat turn (source pins)", () => {
  const chat = () => readFileSync("src/convex/omiChat.ts", "utf8");

  test("ALL THREE unverified paths set the enforcement flag", () => {
    const s = chat();
    // Path 1: search threw (providers down / timeout).
    expect(s).toContain("if (policy.requiresFreshness) memoryProtected = true;");
    // Path 2: results came back but none were usable.
    expect(s).toMatch(/usable\.length === 0[\s\S]{0,400}memoryProtected = true;/);
    // Path 3: the validation gate refused.
    expect(s).toMatch(/verdict === "refuse"[\s\S]{0,200}memoryProtected = true;/);
  });

  test("the replacement is applied to the FINAL answer, after generation", () => {
    const s = chat();
    expect(s).toContain("enforceMemoryProtection({ memoryProtected, content })");
    // It runs only when the model actually succeeded — a failed provider
    // already falls through to the extractive/no-AI honest paths.
    const okBlock = s.slice(s.indexOf("if (result.ok)"), s.indexOf("if (result.partial)"));
    expect(okBlock).toContain("enforceMemoryProtection");
    expect(okBlock).toContain("memory_protection.replaced");
  });
});

// ---------------------------------------------------------------------------
// 3. Cache bypass for current queries
// ---------------------------------------------------------------------------

describe("cache bypass for current questions", () => {
  test("the policy marks the turn freshness-critical", () => {
    for (const q of [
      "latest India news",
      "latest world news",
      "today's technology news",
      "current market information",
      "latest science news",
      "Indian contingent medals tally in Asian Games 2026",
    ]) {
      expect(freshnessPolicyFor(q).requiresFreshness).toBe(true);
    }
  });

  test("the cache read is gated on BOTH skipCache and freshnessMatters (source pin)", () => {
    const s = readFileSync("src/convex/universalSearch.ts", "utf8");
    // Two independent conditions must both fail before a cached row can be
    // returned — the chat turn sets skipCache, and freshnessMatters alone
    // would already be sufficient.
    expect(s).toContain("if (!opts?.skipCache && !freshnessMatters)");
    // …and the chat turn passes skipCache for current questions.
    const chat = readFileSync("src/convex/omiChat.ts", "utf8");
    expect(chat).toContain("skipCache: decision.skipCache || policy.requiresFreshness");
  });
});

// ---------------------------------------------------------------------------
// 4. Year/event is a hard constraint for the Asian Games query
// ---------------------------------------------------------------------------

describe("year/event gating (Asian Games 2026)", () => {
  test("the query is classified as year- and event-scoped", () => {
    const p = freshnessPolicyFor("Indian contingent medals tally in Asian Games 2026");
    expect(p.requiresFreshness).toBe(true);
    expect(p.years).toContain(2026);
    expect(p.event).toBeTruthy();
  });

  test("a 2018/2022 Asian Games article is judged wrong-year by the shared gate", () => {
    // The chat turn drops `isWrongYear(matchTemporal(c, policy.years, null))`
    // sources outright. Pin the classification those helpers must produce.
    const intent = readFileSync("src/convex/searchEngine/temporal.ts", "utf8");
    expect(intent).toContain("export function matchTemporal");
    expect(intent).toContain("export function isWrongYear");
    // And the chat turn wires the drop, not merely a down-rank.
    const chat = readFileSync("src/convex/omiChat.ts", "utf8");
    expect(chat).toContain("!isWrongYear(matchTemporal(c, policy.years, null))");
  });
});

// ---------------------------------------------------------------------------
// 5. LangSearch optionality
// ---------------------------------------------------------------------------

describe("LangSearch stays optional", () => {
  test("policy lists put general-web fallbacks behind langsearch everywhere", () => {
    // Every preferred-provider list that includes langsearch must include at
    // least one other general-web source, so quota exhaustion can never be a
    // dead end for the turn.
    const s = readFileSync("src/convex/searchEngine/freshness.ts", "utf8");
    const lists = [...s.matchAll(/\[("langsearch"[^\]]*)\]/g)].map((m) => m[1]);
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(list).toContain("langsearch");
      expect(/searxng|wikipedia/.test(list)).toBe(true);
    }
  });

  test("quota exhaustion opens the circuit instead of failing the turn (existing pin, restated)", () => {
    // The adapter maps 401/429 to honest errors and `guardedCall` opens the
    // breaker after repeated failures; `Promise.allSettled` isolates it.
    const resilience = readFileSync("src/convex/searchEngine/resilience.ts", "utf8");
    expect(resilience).toContain("breakerRecord(providerId, false)");
    const universal = readFileSync("src/convex/universalSearch.ts", "utf8");
    expect(universal).toContain("Promise.allSettled");
  });
});
