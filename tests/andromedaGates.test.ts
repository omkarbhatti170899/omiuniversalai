/**
 * Milestone 2 tests — Andromeda source gates (master plan §4).
 * Pins: low-tier sources never reach synthesis; stale evidence is rejected
 * on freshness-sensitive questions (with honest insufficiency rather than
 * stale answers); corroboration counts DOMAINS not engine repeats (§10);
 * every rejection is auditable.
 */
import { describe, test, expect } from "bun:test";
import { applySourceGates, GATE_LIMITS } from "../src/convex/andromeda/gates";

const NOW = Date.parse("2026-09-20T12:00:00Z");

function cite(overrides: Partial<{ url: string; publishedAt: string; snippet: string; title: string }> = {}) {
  return {
    title: "T",
    url: "https://example.com/a",
    snippet: "s".repeat(120),
    ...overrides,
  };
}

describe("andromeda gates — quality floor", () => {
  test("low-tier sources are rejected with a reason", () => {
    const r = applySourceGates(
      [cite({ url: "https://www.quora.com/what-is-x" }), cite({ url: "https://www.who.int/news" })],
      { freshnessMatters: false, corroborationRequired: false, now: NOW },
    );
    expect(r.accepted.map((c) => c.url)).toEqual(["https://www.who.int/news"]);
    expect(r.rejected[0].reasons.join(" ")).toContain("low-quality");
  });
});

describe("andromeda gates — freshness", () => {
  test("stale sources are rejected on freshness-sensitive questions", () => {
    const r = applySourceGates(
      [
        cite({ url: "https://a.com/1", publishedAt: "2024-01-01" }),
        cite({ url: "https://b.com/2", publishedAt: "2026-08-01" }),
      ],
      { freshnessMatters: true, corroborationRequired: true, now: NOW },
    );
    expect(r.accepted.map((c) => c.url)).toEqual(["https://b.com/2"]);
    expect(r.rejected[0].reasons.join(" ")).toContain("stale");
  });

  test("age is IGNORED when the question is not freshness-sensitive", () => {
    const r = applySourceGates(
      [cite({ url: "https://a.com/1", publishedAt: "2024-01-01" })],
      { freshnessMatters: false, corroborationRequired: false, now: NOW },
    );
    expect(r.accepted.length).toBe(1);
    expect(r.rejected.length).toBe(0);
  });

  test("all-stale evidence reports honest insufficiency, not a stale answer", () => {
    const r = applySourceGates(
      [cite({ url: "https://a.com/1", publishedAt: "2023-01-01" })],
      { freshnessMatters: true, corroborationRequired: false, now: NOW },
    );
    expect(r.insufficient).toBe(true);
    expect(r.accepted.length).toBe(0);
  });

  test("undated sources score neutral and are not auto-rejected", () => {
    const r = applySourceGates(
      [cite({ url: "https://a.com/1" }), cite({ url: "https://b.com/2" })],
      { freshnessMatters: true, corroborationRequired: false, now: NOW },
    );
    expect(r.insufficient).toBe(false);
    expect(r.accepted.length).toBe(2);
  });
});

describe("andromeda gates — corroboration (§10)", () => {
  test("independent domains satisfy corroboration", () => {
    const r = applySourceGates(
      [cite({ url: "https://a.com/1" }), cite({ url: "https://b.org/2" })],
      { freshnessMatters: false, corroborationRequired: true, now: NOW },
    );
    expect(r.independentDomains).toBe(2);
    expect(r.warnings.join(" ")).not.toContain("Corroboration not met");
  });

  test("many results from ONE domain do NOT satisfy corroboration", () => {
    const r = applySourceGates(
      [cite({ url: "https://a.com/1" }), cite({ url: "https://a.com/2" }), cite({ url: "https://a.com/3" })],
      { freshnessMatters: false, corroborationRequired: true, now: NOW },
    );
    expect(r.independentDomains).toBe(1);
    expect(r.warnings.join(" ")).toContain("Corroboration not met");
  });

  test("www and scheme variants count as the SAME domain", () => {
    const r = applySourceGates(
      [cite({ url: "https://a.com/1" }), cite({ url: "http://www.a.com/2" })],
      { freshnessMatters: false, corroborationRequired: true, now: NOW },
    );
    expect(r.independentDomains).toBe(1);
  });

  test("corroboration threshold matches the spec constant", () => {
    expect(GATE_LIMITS.minIndependentDomains).toBe(2);
  });
});

describe("andromeda gates — auditability", () => {
  test("every rejection carries a non-empty reason", () => {
    const r = applySourceGates(
      [
        cite({ url: "https://www.quora.com/x", publishedAt: "2020-01-01" }),
      ],
      { freshnessMatters: true, corroborationRequired: false, now: NOW },
    );
    expect(r.rejected.length).toBe(1);
    expect(r.rejected[0].reasons.length).toBeGreaterThan(0);
    expect(r.rejected[0].reasons.every((s) => s.length > 3)).toBe(true);
  });

  test("gates never throw on malformed citations", () => {
    expect(() =>
      applySourceGates(
        [cite({ url: "not-a-url", publishedAt: "garbage-date" })],
        { freshnessMatters: true, corroborationRequired: true, now: NOW },
      ),
    ).not.toThrow();
  });
});
