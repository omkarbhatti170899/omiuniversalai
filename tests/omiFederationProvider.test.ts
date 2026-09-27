/**
 * REGRESSION — SEARCH FEDERATION: Mojeek added, DuckDuckGo scraper removed.
 * =========================================================================
 *
 * Two changes, one root cause: Andromeda's general-web floor was a single
 * point of failure AND a compliance violation at the same time.
 *
 * REMOVAL (2026-09-27, compliance). The previous fallback POSTed to
 * `https://html.duckduckgo.com/html/` — DuckDuckGo's no-JS consumer endpoint —
 * with a spoofed browser User-Agent. DuckDuckGo publishes no search API, so
 * that is scraping a consumer results page while defeating bot protection,
 * which the project forbids. It was also dead weight: measured twice on
 * 2026-09-26 it returns HTTP 202 with an "anomaly"/"challenge" body and zero
 * result links, so it could never return anything at all.
 *
 * ADDITION. Mojeek replaces it as the federated general-web floor. Verified
 * against Mojeek's own documentation before choosing it: official REST API,
 * its OWN crawler and index (so it is genuine ecosystem independence, not a
 * second view of Google's), and "AI Usage" sold as an explicit plan right.
 * See docs/ANDROMEDA_PROVIDER_CAPABILITY_MATRIX.md.
 *
 * Rejected and recorded so the reasoning survives:
 *   Qwant — no official API; needs a reverse-engineered DataDome anti-bot
 *           cookie. Scraping. Never.
 *   Baidu — no general web-search API at all.
 */

import { describe, expect, it } from "bun:test";
import { getProviderStatus, getConfiguredProviders } from "../src/convex/searchProviders";
import { createMojeekProvider } from "../src/convex/searchProviders/mojeek";
import { MissingKeyError } from "../src/convex/searchProviders/types";
import { freshnessPolicyFor } from "../src/convex/searchEngine/freshness";
import { decideSearch } from "../src/convex/searchEngine/decision";

describe("federation — the DuckDuckGo scraper is gone and stays gone", () => {
  it("is NOT registered as a provider", () => {
    const ids = getProviderStatus().map((p) => p.id);
    expect(ids).not.toContain("duckduckgo");
  });

  it("appears in NO vertical's provider routing", () => {
    // A removed provider that lingers in a routing list is a silent
    // re-introduction: the orchestrator would try to reach an endpoint that
    // no longer exists as an adapter.
    const queries = [
      "latest AI news",
      "What is India's medal tally in Asian Games 2026?",
      "latest election results",
      "current USD INR rate",
      "what is the weather in Mumbai",
      "live sports score",
      "latest flight status",
      "Tell me a joke",
    ];
    for (const q of queries) {
      const policy = freshnessPolicyFor(q, decideSearch(q).intent);
      expect(policy.preferredProviders).not.toContain("duckduckgo");
    }
  });
});

describe("federation — Mojeek is registered and honestly gated", () => {
  it("is registered in the provider registry", () => {
    const mojeek = getProviderStatus().find((p) => p.id === "mojeek");
    expect(mojeek).toBeDefined();
    expect(mojeek!.label).toContain("Mojeek");
  });

  it("is NOT ready without a key, and says why", () => {
    // A keyed provider must never appear ready without credentials — that is
    // how a hidden bill or a silent failure gets introduced.
    const original = process.env.MOJEEK_API_KEY;
    delete process.env.MOJEEK_API_KEY;
    try {
      const p = createMojeekProvider();
      expect(p.isConfigured()).toBe(false);
      expect(getConfiguredProviders().some((x) => x.id === "mojeek")).toBe(false);
      const status = getProviderStatus().find((x) => x.id === "mojeek")!;
      expect(status.ready).toBe(false);
      expect(status.hint).toContain("MOJEEK_API_KEY");
    } finally {
      if (original !== undefined) process.env.MOJEEK_API_KEY = original;
    }
  });

  it("is configured once a key is present", () => {
    const original = process.env.MOJEEK_API_KEY;
    process.env.MOJEEK_API_KEY = "test-key-not-real";
    try {
      expect(createMojeekProvider().isConfigured()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.MOJEEK_API_KEY;
      else process.env.MOJEEK_API_KEY = original;
    }
  });

  it("throws MissingKeyError rather than silently searching without a key", async () => {
    const original = process.env.MOJEEK_API_KEY;
    delete process.env.MOJEEK_API_KEY;
    try {
      await expect(createMojeekProvider().search("test query", 5)).rejects.toThrow(
        MissingKeyError,
      );
    } finally {
      if (original !== undefined) process.env.MOJEEK_API_KEY = original;
    }
  });

  it("is declared a general-web fallback in the current verticals", () => {
    for (const q of [
      "latest AI news",
      "What is India's medal tally in Asian Games 2026?",
      "latest election results",
    ]) {
      const policy = freshnessPolicyFor(q, decideSearch(q).intent);
      expect(policy.preferredProviders).toContain("mojeek");
    }
  });

  it("declines image/video categories rather than burning quota", async () => {
    const original = process.env.MOJEEK_API_KEY;
    process.env.MOJEEK_API_KEY = "test-key-not-real";
    try {
      const p = createMojeekProvider();
      expect((await p.search("q", 5, { category: "images" })).citations).toEqual([]);
      expect((await p.search("q", 5, { category: "videos" })).citations).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.MOJEEK_API_KEY;
      else process.env.MOJEEK_API_KEY = original;
    }
  });
});
