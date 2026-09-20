/**
 * Tests — Andromeda insight layer (confidence + follow-ups).
 * Pins honesty: confidence is derived from measured state, never invented;
 * unverified stays unverified; follow-ups are questions, not conclusions.
 */
import { describe, test, expect } from "bun:test";
import {
  deriveConfidence,
  suggestFollowUps,
} from "../src/convex/andromeda/insight";
import { planQuery } from "../src/convex/andromeda/query";
import { applySourceGates } from "../src/convex/andromeda/gates";
import type { WebCitation } from "../src/convex/searchProviders/types";

const NOW = Date.parse("2026-09-20T12:00:00Z");

function cite(url: string, publishedAt?: string): WebCitation {
  return { title: "T", url, snippet: "s".repeat(150), publishedAt };
}

describe("confidence labels — honesty contract", () => {
  test("no AI means unverified, never a confident label", () => {
    const plan = planQuery("state of fusion energy");
    const c = deriveConfidence(plan, null, "pass", false);
    expect(c.level).toBe("unverified");
  });

  test("failed verification caps confidence at low", () => {
    const plan = planQuery("state of fusion energy");
    const c = deriveConfidence(plan, null, "failed", true);
    expect(c.level).toBe("low");
    expect(c.reason).toContain("problems");
  });

  test("high confidence requires pass + corroboration + 3 domains", () => {
    const plan = planQuery("state of fusion energy");
    const gates = applySourceGates(
      [cite("https://a.com/1"), cite("https://b.org/2"), cite("https://c.edu/3")],
      { freshnessMatters: false, corroborationRequired: false, now: NOW },
    );
    const c = deriveConfidence(plan, gates, "pass", true);
    expect(c.level).toBe("high");
    expect(c.reason).toContain("3 independent domains");
  });

  test("single-domain evidence cannot exceed low on corroborated questions", () => {
    const plan = planQuery("Postgres vs MySQL"); // corroboration required
    const gates = applySourceGates(
      [cite("https://a.com/1"), cite("https://a.com/2")],
      { freshnessMatters: false, corroborationRequired: true, now: NOW },
    );
    const c = deriveConfidence(plan, gates, "pass", true);
    expect(c.level).toBe("low");
    expect(c.reason).toContain("thin independence");
  });

  test("moderate for two domains and a passing check", () => {
    const plan = planQuery("state of fusion energy");
    const gates = applySourceGates(
      [cite("https://a.com/1"), cite("https://b.org/2")],
      { freshnessMatters: false, corroborationRequired: false, now: NOW },
    );
    const c = deriveConfidence(plan, gates, "pass", true);
    expect(c.level).toBe("moderate");
  });
});

describe("follow-up suggestions — deepen, never conclude", () => {
  test("comparative questions propose criticism + cost angles", () => {
    const plan = planQuery("CRDTs vs OT");
    const f = suggestFollowUps(plan, null);
    expect(f.length).toBeGreaterThan(0);
    expect(f.some((x) => /criticisms/i.test(x.question))).toBe(true);
    expect(f.some((x) => /cost/i.test(x.question))).toBe(true);
    expect(f.every((x) => x.question.endsWith("?"))).toBe(true);
  });

  test("temporal questions propose recency re-checks", () => {
    const plan = planQuery("latest fusion milestone");
    const f = suggestFollowUps(plan, null);
    expect(f.some((x) => /last 30 days/i.test(x.question))).toBe(true);
  });

  test("thin independence triggers a primary-source hunt", () => {
    const plan = planQuery("state of fusion energy");
    const gates = applySourceGates(
      [cite("https://a.com/1")],
      { freshnessMatters: false, corroborationRequired: false, now: NOW },
    );
    const f = suggestFollowUps(plan, gates);
    expect(f.some((x) => /primary or official sources/i.test(x.question))).toBe(true);
  });

  test("rejected sources surface an auditability follow-up", () => {
    const plan = planQuery("state of fusion energy");
    const gates = applySourceGates(
      [cite("https://www.quora.com/x"), cite("https://b.org/2")],
      { freshnessMatters: false, corroborationRequired: false, now: NOW },
    );
    const f = suggestFollowUps(plan, gates);
    expect(f.some((x) => /excluded/i.test(x.question))).toBe(true);
  });

  test("capped at 4 and deduped", () => {
    const plan = planQuery("Postgres vs MySQL");
    const gates = applySourceGates(
      [cite("https://a.com/1"), cite("https://www.quora.com/x")],
      { freshnessMatters: false, corroborationRequired: true, now: NOW },
    );
    const f = suggestFollowUps(plan, gates);
    expect(f.length).toBeLessThanOrEqual(4);
    expect(new Set(f.map((x) => x.question)).size).toBe(f.length);
  });
});
