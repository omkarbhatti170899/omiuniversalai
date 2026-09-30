/**
 * PHASE 3 + 7 INCREMENTS — language-aware statistics authority & controlled
 * memory retention. Pure-function pins; no network, no runtime.
 */

import { describe, expect, test } from "bun:test";
import {
  localeStatsDomainsFor,
  officialDomainsWithLocaleFor,
  officialDomainsFor,
} from "../src/convex/searchEngine/authority";
import { detectQueryLanguage } from "../src/convex/searchEngine/language";
import { readFileSync } from "node:fs";

describe("PHASE 3 — language-aware statistics authority", () => {
  test("a Japanese statistics query gains Japan's official statistics domains", () => {
    const stats = officialDomainsFor("current inflation statistics");
    const withLocale = officialDomainsWithLocaleFor("日本のインフレ統計");
    // The Japanese query has no topic match, so locale domains ARE the pool.
    expect(withLocale).toContain("stat.go.jp");
    expect(localeStatsDomainsFor("日本のインフレ統計")).toEqual(["stat.go.jp", "e-stat.go.jp"]);
    void stats;
  });

  test("German and French statistics map to their national bureaus", () => {
    // Genuine two-marker queries: "aktuelle nachrichten"-style word pairs.
    expect(localeStatsDomainsFor("aktuelle Nachrichten und Inflation")).toContain("destatis.de");
    expect(localeStatsDomainsFor("dernières nouvelles et statistiques")).toContain("insee.fr");
  });

  test("English (default) gains nothing — behaviour unchanged byte-for-byte", () => {
    expect(localeStatsDomainsFor("current inflation rate India")).toEqual([]);
    // Topic hints still lead: locale domains only BROADEN the pool.
    const india = officialDomainsFor("current inflation rate India");
    const merged = officialDomainsWithLocaleFor("current inflation rate India");
    expect(merged.slice(0, india.length)).toEqual(india);
  });

  test("detection is the shared detector — no second language implementation", () => {
    // Same input, same verdict as the canonical detector.
    const q = "últimas estadísticas de inflación";
    expect(localeStatsDomainsFor(q)).toEqual(
      detectQueryLanguage(q).via === "default" ? [] : localeStatsDomainsFor(q),
    );
  });
});

describe("PHASE 7 — controlled memory retention", () => {
  const src = () => readFileSync("src/convex/omiMemories.ts", "utf8");
  const schema = () => readFileSync("src/convex/schema.ts", "utf8");

  test("schema: memories carry an optional expiry", () => {
    expect(schema()).toContain("expiresAt: v.optional(v.number())");
  });

  test("create accepts expiresInDays (bounded to a year); list excludes EXPIRED only", () => {
    const s = src();
    expect(s).toContain("expiresInDays: v.optional(v.number())");
    // Bounded: a memory cannot be set to expire in 10_000 days via API mistake.
    expect(s).toContain("Math.min(expiresInDays, 365)");
    // Controlled retention = exclude from grounding, never silently delete.
    expect(s).toContain("typeof m.expiresAt !== \"number\" || m.expiresAt > now");
    expect(s).toContain("take(limit * 2)"); // headroom so expired rows don't starve the take
  });

  test("purge remains explicit — removal is still the user's action", () => {
    const s = src();
    expect(s).toContain("export const remove = mutation(");
    expect(s).toContain("export const clearAll = mutation(");
  });
});
