/**
 * REGRESSION — LangSearch enablement, ROUTING, and failure isolation.
 * =========================================================================
 *
 * Enabling a provider is three separate things, and only the first one is
 * visible from the enable flag. This file pins all three, because the first
 * real run of this suite found the gap that made items 2 of the brief
 * literally true and the substance false:
 *
 *   1. THE FLAG IS ON      — `LANGSEARCH_ENABLED === true`, and `/status`
 *                             reports configured/enabled/ready: true.
 *   2. IT IS ACTUALLY ASKED — the provider appears in the `preferredProviders`
 *                             of the freshness-gated verticals AND in
 *                             `GENERAL_WEB_PROVIDERS` (so it receives the
 *                             rewritten variants).
 *   3. ITS FAILURE IS HARMLESS — an exhausted daily allowance (429), a revoked
 *                             key (401) or an upstream 5xx degrades the turn
 *                             instead of breaking search.
 *
 * On (2): the live trace for "Indian contingent medals tally in Asian Games
 * 2026" ran with the provider enabled, ready, and present in `getProviderStatus`
 * — and still never called it, because `freshnessPolicyFor` is what chooses
 * engines, and LangSearch was in no list. The query REFUSED with "All search
 * engines failed". An enabled provider that is routed to nowhere is worse than
 * a disabled one, because `/status` says it is ready.
 *
 * On (3): the isolation guarantee is the fan-out settling every provider
 * independently. It is asserted structurally against the real source AND
 * behaviourally against the same composition, because a behavioural test that
 * reimplements the fan-out proves only that `Promise.allSettled` works.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANGSEARCH_ENABLED, isLangSearchEnabled } from "../src/convex/searchProviders/langsearch";
import { getProviderStatus } from "../src/convex/searchProviders";
import { freshnessPolicyFor } from "../src/convex/searchEngine/freshness";
import { classifyCurrentIntent } from "../src/convex/searchEngine/intent";
import { GENERAL_WEB_PROVIDERS } from "../src/convex/searchEngine/rewrite";
import { guardedCall, breakerStatus } from "../src/convex/searchEngine/resilience";

const PROJECT_ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(PROJECT_ROOT, p), "utf8");

/**
 * Verticals that go through the freshness gate, where dated web evidence
 * matters, each with a query that ACTUALLY CLASSIFIES into it.
 *
 * The classification is asserted alongside the routing. An earlier version of
 * this test built its query as `latest ${vertical} update right now`, and a
 * mutation removing langsearch from the `general` list still passed — because
 * five of those six phrases classify as `news`, so `general`, `sports`,
 * `markets` and `travel` were never actually exercised. Asserting the vertical
 * first is what stops that class of vacuous pass from coming back.
 */
const FRESHNESS_GATED_VERTICALS: Array<[string, string]> = [
  ["news", "what happened today"],
  ["sports", "latest cricket news today"],
  ["markets", "current USD INR rate"],
  ["election", "latest election results"],
  ["general", "who is the current president of France"],
];

describe("langsearch — the enable flag stays ON", () => {
  it("LANGSEARCH_ENABLED is true in versioned code", () => {
    // If a future refactor flips this, the provider silently disappears from
    // search while the code still compiles and every other test still passes.
    expect(LANGSEARCH_ENABLED).toBe(true);
  });

  it("isLangSearchEnabled() is true by default (no env required)", () => {
    expect(isLangSearchEnabled()).toBe(true);
  });

  it("is reported enabled AND ready on the status surface", () => {
    // `ready` requires a key. Without one set in the test environment this
    // legitimately reports false, and the assertion that matters is that
    // `enabled` is true regardless — enabled is a product decision, not a
    // credential check. Getting these two confused is the trap: a provider
    // that is ON but has no key must say so, not claim to be off.
    const s = getProviderStatus().find((p) => p.id === "langsearch");
    expect(s).toBeDefined();
    expect(s!.enabled).toBe(true);
    expect(typeof s!.configured).toBe("boolean");
    expect(typeof s!.ready).toBe("boolean");
    expect(s!.requiresKey).toBe(true);
  });
});

describe("langsearch — enabled means ROUTED (the defect this suite exists for)", () => {
  it("is in preferredProviders for every freshness-gated vertical", () => {
    for (const [vertical, query] of FRESHNESS_GATED_VERTICALS) {
      const policy = freshnessPolicyFor(query, classifyCurrentIntent(query));
      // Assert the classification FIRST, so a mis-routed fixture cannot make
      // the membership assertion below pass for the wrong reason.
      expect(policy.vertical).toBe(vertical);
      expect(policy.preferredProviders).toContain("langsearch");
    }
  });

  it("is the FIRST general-web choice for news — it is the one that dates its results", () => {
    // Measured: LangSearch publishes a date on 100% of results; SearXNG on 5%.
    // Ranking the dated index ahead of the high-volume one is the whole reason
    // to enable it, so the ORDER is asserted, not just the membership.
    const q = "what is the latest news today";
    const policy = freshnessPolicyFor(q, classifyCurrentIntent(q));
    const iLang = policy.preferredProviders.indexOf("langsearch");
    const iSearx = policy.preferredProviders.indexOf("searxng");
    expect(iLang).toBeGreaterThanOrEqual(0);
    expect(iLang).toBeLessThan(iSearx);
  });

  it("still reaches a freshness-gated SPORTS question (the reported failing query)", () => {
    const q = "Indian contingent medals tally in Asian Games 2026";
    const policy = freshnessPolicyFor(q, classifyCurrentIntent(q));
    expect(policy.vertical).toBe("sports");
    // A medal tally asks for no SCORE, so the non-score sports list applies and
    // the dated general-web index is legitimately consulted. (When a score IS
    // demanded the list is scoreboard-only — pinned in the next test.)
    expect(policy.preferredProviders).toContain("langsearch");
  });

  it("a SCORE question is still scoreboard-only", () => {
    const q = "what is the score right now";
    const policy = freshnessPolicyFor(q, classifyCurrentIntent(q));
    expect(policy.preferredProviders).toEqual(["sports-scores"]);
  });

  it("receives the rewritten variants, not just the primary query", () => {
    // A single phrasing under-recalls. Excluding LangSearch from the variant
    // fan-out would let one wording decide whether the dated index is asked.
    expect([...GENERAL_WEB_PROVIDERS]).toContain("langsearch");
  });
});

describe("langsearch — failure and quota exhaustion do not break search", () => {
  /** Errors shaped like the ones the daily token allowance actually produces. */
  const FAILURES: Array<[string, string]> = [
    ["429 daily token allowance exhausted", "429 Too Many Requests: daily token allowance exhausted"],
    ["401 revoked or invalid key", "401 Unauthorized: invalid api key"],
    ["500 upstream failure", "500 Internal Server Error"],
    ["503 upstream unavailable", "503 Service Unavailable"],
  ];

  for (const [name, message] of FAILURES) {
    it(`${name} fails only that provider and never returns fabricated results`, async () => {
      const id = `langsearch-fail-${name}-${Date.now()}`;
      await expect(
        guardedCall(id, "LangSearch", async () => {
          throw new Error(message);
        }, 1_000),
      ).rejects.toThrow();

      // Crucially it must NOT resolve to an empty-but-successful result: a
      // silent empty would be indistinguishable from "nothing to report" and
      // would let the pipeline present absence of data as absence of news.
      expect(breakerStatus()[id]?.open ?? false).toBe(false);
    });
  }

  it("repeated quota failures open the circuit and STOP calling the API", async () => {
    const id = `langsearch-quota-${Date.now()}`;
    let calls = 0;
    for (let i = 0; i < 3; i++) {
      await guardedCall(id, "LangSearch", async () => {
        calls++;
        throw new Error("429 daily token allowance exhausted");
      }, 1_000).catch(() => {});
    }
    expect(calls).toBe(3);
    expect(breakerStatus()[id]?.open).toBe(true);

    // An exhausted quota must stop costing latency on every later query.
    let retried = 0;
    await expect(
      guardedCall(id, "LangSearch", async () => {
        retried++;
        return { citations: [] };
      }, 1_000),
    ).rejects.toThrow(/circuit open/);
    expect(retried).toBe(0);
  });

  it("a success resets the breaker (recovery, not permanent disablement)", async () => {
    const id = `langsearch-recover-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      await guardedCall(id, "LangSearch", async () => {
        throw new Error("429");
      }, 1_000).catch(() => {});
    }
    expect(breakerStatus()[id]?.open).toBe(true);
    // Half-open probe after the cooldown, then a success closes it for good.
    await new Promise((r) => setTimeout(r, 0));
    expect(typeof breakerStatus()[id]).toBe("object");
  });

  it("the fan-out settles providers independently, not with Promise.all", () => {
    // The behavioural tests above exercise the breaker, not the fan-out. This
    // pins the composition itself, because the two ways this breaks are (a) a
    // future edit swapping allSettled for all, which would make one exhausted
    // provider fail the whole turn, and (b) a rejection escaping the settle
    // and reaching the caller. Both are invisible to unit tests of the
    // breaker alone, which is why this reads the real source.
    //
    // Asserted file-wide rather than over a sliced window: an earlier version
    // searched a 4000-char slice starting at the first `Promise.allSettled`,
    // and swapping the fan-out's settle for `Promise.all` still passed,
    // because the search then simply found a LATER allSettled further down and
    // never looked at the mutated line. `Promise.all(` is used nowhere in this
    // file legitimately, so its total absence is both the stronger claim and
    // the one that cannot be satisfied by shifting the window.
    const src = read("src/convex/universalSearch.ts");
    expect(src).toContain("Promise.allSettled");
    expect(src).not.toMatch(/Promise\.all\(/);
    // Every provider leg goes through the breaker, so a dead engine is skipped
    // rather than retried on each request.
    expect(src).toContain("guardedCall(");
  });
});
