/**
 * Phase 14 tests — the ecosystem registry (§15–23/§31/§32) and the two new
 * Andromeda sources. Pins the zero-cost invariant (no ACTIVE entry may be
 * metered/subscription/paid) and the entry-shape contract the Settings UI
 * renders (every not-approved entry must carry its reason).
 */
import { describe, test, expect } from "bun:test";
import {
  ECOSYSTEM_ENTRIES,
  getEcosystemStatus,
  hasMandatoryPaidDependency,
} from "../src/convex/ecosystem";

describe("ecosystem registry — zero-cost invariant (§2)", () => {
  test("no active entry is metered, subscription-based, or paid", () => {
    expect(hasMandatoryPaidDependency()).toBe(false);
    for (const e of ECOSYSTEM_ENTRIES.filter((e) => e.status === "active")) {
      expect(e.cost).toMatch(/^\$0/);
    }
  });

  test("optional entries are explicitly not on by default", () => {
    for (const e of ECOSYSTEM_ENTRIES.filter((e) => e.status === "optional")) {
      expect(e.cost).not.toMatch(/^\$0 per query/); // never presented as free-per-use
      expect(/disabled unless|free tier|off unless/i.test(e.cost)).toBe(true);
    }
  });

  test("every not-approved entry states its reason (§32)", () => {
    for (const e of ECOSYSTEM_ENTRIES.filter((e) => e.status === "not-approved")) {
      expect(e.reason).toBeDefined();
      expect(e.reason!.length).toBeGreaterThan(20);
    }
  });

  test("all requested ecosystems are represented", () => {
    const ecosystems = new Set(ECOSYSTEM_ENTRIES.map((e) => e.ecosystem));
    for (const required of [
      "Google / Alphabet",
      "Meta",
      "OpenAI",
      "NVIDIA",
      "Apple",
      "Amazon / AWS",
      "Microsoft",
      "Anthropic",
      "DeepSeek",
      "Oracle",
      "AMD",
      "Salesforce",
    ]) {
      expect(ecosystems.has(required)).toBe(true);
    }
  });

  test("grouping exposes counts that add up", () => {
    const groups = getEcosystemStatus();
    const total = groups.reduce((n, g) => n + g.entries.length, 0);
    expect(total).toBe(ECOSYSTEM_ENTRIES.length);
    for (const g of groups) {
      expect(g.counts.active + g.counts.optional + g.counts.notApproved).toBe(
        g.entries.length,
      );
    }
  });
});

describe("new Andromeda sources — contract shape", () => {
  test("wikidata provider is keyless and registered with honest labeling", async () => {
    const { createWikidataProvider } = await import(
      "../src/convex/searchProviders/wikidata"
    );
    const p = createWikidataProvider();
    expect(p.isConfigured()).toBe(true);
    expect(p.missingKeyHint).toBe("");
    expect(p.id).toBe("wikidata");
  });

  test("commoncrawl provider is keyless and metadata-only by design", async () => {
    const { createCommonCrawlProvider } = await import(
      "../src/convex/searchProviders/commoncrawl"
    );
    const p = createCommonCrawlProvider();
    expect(p.isConfigured()).toBe(true);
    expect(p.missingKeyHint).toBe("");
    expect(p.id).toBe("commoncrawl");
  });

  test("both sources appear in the Andromeda registry", async () => {
    const { getProviderStatus } = await import("../src/convex/searchProviders");
    const ids = getProviderStatus().map((p) => p.id);
    expect(ids).toContain("wikidata");
    expect(ids).toContain("commoncrawl");
    // And nothing metered ever registers.
    for (const p of getProviderStatus()) {
      expect(p.cost).toMatch(/\$0/);
    }
  });
});
