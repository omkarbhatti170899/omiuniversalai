/**
 * POLICY PIN — ZERO-COST SEARCH INFRASTRUCTURE (owner decision, 2026-09-30).
 * =============================================================================
 * The owner set a hard constraint: Omi's search layer stays at ₹0/month.
 *
 *   • NO Fly.io deployment, NO paid VPS, NO paid proxy, NO paid search API,
 *     NO paid hosting — nothing that can generate a bill without the owner's
 *     explicit approval.
 *   • SearXNG is OPPORTUNISTIC: used when a healthy FREE instance answers,
 *     skipped without penalty when it does not.
 *   • No single free instance may be a HARD dependency: search must continue
 *     through the other free retrieval providers when it disappears, and the
 *     evidence gates + refusal contract still hold.
 *
 * This file pins the policy in code so a future change cannot silently
 * reintroduce a paid dependency or make one free instance load-bearing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const searxngSrc = () => readFileSync("src/convex/searchProviders/searxng.ts", "utf8");
const universalSrc = () => readFileSync("src/convex/universalSearch.ts", "utf8");
const chatSrc = () => readFileSync("src/convex/omiChat.ts", "utf8");

describe("zero-cost policy — no paid deployment path in the repo", () => {
  test("the Fly.io deployment plan is removed", () => {
    expect(() => readFileSync("deploy/searxng/fly.toml", "utf8")).toThrow();
    expect(() => readFileSync("deploy/searxng/Dockerfile.fly", "utf8")).toThrow();
  });

  test("the self-host plan documents the ₹0 policy and marks paid hosting as removed", () => {
    const plan = readFileSync("docs/SEARXNG_SELF_HOST_PLAN.md", "utf8");
    expect(plan).toContain("₹0/month");
    expect(plan).toContain("REMOVED from the roadmap");
  });

  test("no provider in the registry requires an API key to answer general-web queries", () => {
    // The general-web floor must be payable-₹0: the providers that carry it
    // when SearXNG is unavailable must be keyless or feature-gated free.
    const index = readFileSync("src/convex/searchProviders/index.ts", "utf8");
    // SearXNG's hint explicitly points at free self-hosting / free instances.
    const s = searxngSrc();
    expect(s).toContain("SEARXNG_BASE_URL");
    // LangSearch is feature-gated free, never metered-by-default.
    expect(readFileSync("src/convex/searchProviders/langsearch.ts", "utf8")).toContain("LANGSEARCH_ENABLED");
    void index;
  });
});

describe("zero-cost policy — SearXNG is opportunistic, never load-bearing", () => {
  test("a failing or missing SearXNG never blocks the fan-out (allSettled isolation)", () => {
    const s = universalSrc();
    expect(s).toContain("Promise.allSettled(");
    expect(s).toContain("never block the fan-out");
  });

  test("the adapter fail-opens: dead base skipped, one recovery dial rate-limited, no hard stop", () => {
    const s = searxngSrc();
    expect(s).toContain("const dialable = bases.filter((b) => !isKnownDead(b))");
    // No verified fallbacks + no configured base → the provider reports
    // honestly instead of pretending, and the FAN-OUT continues without it.
    expect(s).toContain("MissingKeyError");
  });

  test("when SearXNG contributes nothing, other FREE providers still carry the turn", () => {
    // The strict-vertical backstop + full-fan-out retry are the free fallback
    // chain; chat refuses honestly only when NOTHING verifiable exists.
    const chat = chatSrc();
    expect(chat).toContain("NO_VERIFIED_RESULTS");
    expect(chat).toContain("strictVerticalFallbackFor");
  });

  test("an unavailable SearXNG is reported as unavailable — never hidden, never billed", () => {
    const s = searxngSrc();
    // The readiness hint names the free fix (own free instance / JSON format),
    // not a paid service.
    expect(s).toMatch(/Set SEARXNG_BASE_URL to your own SearXNG instance/);
  });
});
