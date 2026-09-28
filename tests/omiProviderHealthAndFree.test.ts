/**
 * REGRESSION — PROVIDER HEALTH, FREE PROVIDERS, AND HONEST FAILURE REPORTING.
 * =========================================================================
 *
 * Three things are pinned here, all of which came out of the standardized
 * provider benchmark (scripts/providerBenchmark.ts, 51 queries x 5 providers).
 *
 * 1. THE NO-DATE RULE. Mwmbl and DuckDuckGo Instant Answers were both measured
 *    live and NEITHER returns a publication or update timestamp. An undated
 *    source is not evidence of recency, so allowing either into a
 *    freshness-gated turn would reintroduce the original bug class ("latest"
 *    answered from a page of unknown age). Both are registered for breadth and
 *    are excluded from every freshness tier.
 *
 * 2. THE GDELT MISDIAGNOSIS. A 15 s upstream timeout was being rethrown as
 *    `MissingKeyError: ... is not configured`, telling the user to add an API
 *    key to a provider that is keyless. The real fault was availability. A
 *    wrong diagnosis sends whoever is debugging in the wrong direction, so the
 *    error type now matches the actual cause.
 *
 * 3. HEALTH METRICS. Availability, latency percentiles, timeout rate, result
 *    counts, freshness quality and duplicate rate are computed from real
 *    observations, and telemetry can never throw into a search.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  allProviderHealth,
  providerHealth,
  recordProviderObservation,
  resetProviderHealth,
  PROVIDER_FACTS,
  type ProviderObservation,
} from "../src/convex/searchEngine/providerHealth";
import { createMwmblProvider, MWMBL_RETURNS_TIMESTAMPS } from "../src/convex/searchProviders/mwmbl";
import {
  createDuckDuckGoInstantProvider,
  DUCK_DUCK_GO_INSTANT_RETURNS_TIMESTAMPS,
} from "../src/convex/searchProviders/duckduckgoInstant";
import {
  createGdeltProvider,
  describeGdeltFailure,
  isGdeltEnabled,
} from "../src/convex/searchProviders/gdelt";
import { getProviderStatus } from "../src/convex/searchProviders";
import { freshnessPolicyFor } from "../src/convex/searchEngine/freshness";
import { decideSearch } from "../src/convex/searchEngine/decision";

function obs(over: Partial<ProviderObservation> = {}): ProviderObservation {
  return {
    ok: true,
    timedOut: false,
    latencyMs: 100,
    results: 5,
    datedResults: 0,
    duplicates: 0,
    at: Date.now(),
    ...over,
  };
}

beforeEach(() => resetProviderHealth());

describe("provider health — measured, not assumed", () => {
  it("reports nothing for a provider that has never been called", () => {
    expect(providerHealth("never-called")).toBeNull();
  });

  it("computes availability from real outcomes", () => {
    for (let i = 0; i < 7; i++) recordProviderObservation("p", obs({ ok: true }));
    for (let i = 0; i < 3; i++) recordProviderObservation("p", obs({ ok: false, timedOut: true }));
    const h = providerHealth("p")!;
    expect(h.calls).toBe(10);
    expect(h.successes).toBe(7);
    expect(h.availability).toBe(0.7);
    expect(h.timeoutRate).toBe(0.3);
  });

  it("uses percentiles, not an average, so a timeout cannot be hidden", () => {
    // Nine fast calls and one 12 s timeout. The mean (~1.3 s) looks fine;
    // only p95 exposes the failure that actually matters.
    for (let i = 0; i < 9; i++) recordProviderObservation("p", obs({ latencyMs: 100 }));
    recordProviderObservation("p", obs({ latencyMs: 12_000 }));
    const h = providerHealth("p")!;
    expect(h.latencyP50Ms).toBe(100);
    expect(h.latencyP95Ms).toBe(12_000);
  });

  it("measures freshness quality as the share of results carrying a date", () => {
    recordProviderObservation("p", obs({ results: 10, datedResults: 3 }));
    recordProviderObservation("p", obs({ results: 10, datedResults: 2 }));
    expect(providerHealth("p")!.freshnessQuality).toBe(0.25);
  });

  it("measures duplicate rate, so an echoing provider is visible", () => {
    recordProviderObservation("p", obs({ results: 8, duplicates: 4 }));
    expect(providerHealth("p")!.duplicateRate).toBe(0.5);
  });

  it("keeps only a rolling window", () => {
    for (let i = 0; i < 50; i++) recordProviderObservation("p", obs());
    expect(providerHealth("p")!.calls).toBe(20);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => {
      recordProviderObservation("p", undefined as never);
      allProviderHealth();
    }).not.toThrow();
  });
});

describe("providers that return no dates stay out of freshness tiers", () => {
  it("Mwmbl is registered and declares it returns no timestamps", () => {
    expect(getProviderStatus().some((p) => p.id === "mwmbl")).toBe(true);
    expect(MWMBL_RETURNS_TIMESTAMPS).toBe(false);
    expect(PROVIDER_FACTS.mwmbl.returnsTimestamps).toBe(false);
  });

  it("DuckDuckGo Instant is registered and declares it returns no timestamps", () => {
    expect(getProviderStatus().some((p) => p.id === "duckduckgo-instant")).toBe(true);
    expect(DUCK_DUCK_GO_INSTANT_RETURNS_TIMESTAMPS).toBe(false);
    expect(PROVIDER_FACTS["duckduckgo-instant"].returnsTimestamps).toBe(false);
  });

  it("NEITHER appears in any freshness-gated vertical's routing", () => {
    for (const q of [
      "latest AI news",
      "What is India's medal tally in Asian Games 2026?",
      "latest election results",
      "current USD INR rate",
      "what is happening right now?",
      "latest flight status",
    ]) {
      const policy = freshnessPolicyFor(q, decideSearch(q).intent);
      expect(policy.preferredProviders).not.toContain("mwmbl");
      expect(policy.preferredProviders).not.toContain("duckduckgo-instant");
    }
  });

  it("the providers that DO serve freshness are still routed for it", () => {
    const news = freshnessPolicyFor("latest AI news", decideSearch("latest AI news").intent);
    expect(news.preferredProviders).toContain("gdelt");
    expect(news.preferredProviders).toContain("wikipedia-current-events");
  });

  it("both new providers are free and need no key", () => {
    expect(createMwmblProvider().isConfigured()).toBe(true);
    expect(createDuckDuckGoInstantProvider().isConfigured()).toBe(true);
    for (const p of getProviderStatus()) {
      expect(p.cost).toMatch(/\$0/);
    }
  });
});

describe("honest failure reporting — an outage is not a missing key", () => {
  // Tested via the exported classifier so this is deterministic and does not
  // depend on GDELT being up or down on the day it runs.
  it("a timeout is reported as an availability problem, not a missing key", () => {
    const msg = describeGdeltFailure(new Error("timeout of 15000ms exceeded"));
    expect(msg).toMatch(/availability problem/i);
    expect(msg).toMatch(/no key required/i);
    expect(msg).not.toMatch(/not configured|MissingKey/i);
  });

  it("never blames configuration for any upstream failure", () => {
    for (const raw of [
      "timeout of 15000ms exceeded",
      "ECONNABORTED",
      "socket hang up",
      "Request failed with status code 503",
      "getaddrinfo ENOTFOUND",
    ]) {
      const msg = describeGdeltFailure(new Error(raw));
      expect(msg).not.toMatch(/is not configured|MissingKey/i);
      expect(msg).toMatch(/^gdelt:/);
    }
  });

  it("is still registered and reports a $0 cost", () => {
    // Registered, its cost still stated honestly — but GATED ON THE FEATURE
    // FLAG. GDELT measured 0% availability from the Convex runtime across three
    // sessions (TCP connects, HTTPS never answers), so it is out of the fan-out
    // rather than costing every freshness-gated turn 15–20 s of latency. The
    // disable is a product decision with a recorded reason, not a missing key:
    // the status hint says which, and `ENABLE_GDELT=true` forces it back on.
    const status = getProviderStatus().find((p) => p.id === "gdelt");
    expect(status).toBeDefined();
    expect(status?.cost).toMatch(/\$0/);
    expect(status?.enabled).toBe(isGdeltEnabled());
    expect(createGdeltProvider().isConfigured()).toBe(isGdeltEnabled());
    if (!isGdeltEnabled()) {
      expect(String(status?.hint)).toMatch(/Disabled by product decision/i);
      expect(String(status?.hint)).not.toMatch(/API key/i);
    }
  });
});
