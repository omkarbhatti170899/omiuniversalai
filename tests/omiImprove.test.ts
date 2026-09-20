/**
 * Phase 14 tests — Phase 11 proposal derivation (master plan §11).
 * Pins: threshold behavior, stable ids, honest "no proposals" state, and
 * the read-only contract (deriving must not mutate the snapshot).
 */
import { describe, test, expect } from "bun:test";
import { deriveProposals, type HealthSnapshot } from "../src/convex/omiImprove";

function snap(overrides?: Partial<HealthSnapshot>): HealthSnapshot {
  return {
    toolMetrics: [],
    verification: { checked: 0, pass: 0, warnings: 0, failed: 0, passRate: 0 },
    ai: {
      activeProvider: "vly",
      providers: [
        { id: "vly", label: "Workspace gateway", configured: true, cost: "included", hint: "" },
      ],
    },
    ...overrides,
  };
}

describe("improvement proposals — tools", () => {
  test("no proposal below the evidence threshold (no noise)", () => {
    const p = deriveProposals(
      snap({
        toolMetrics: [{ tool: "web_search", total: 3, successRate: 0, avgMs: 100 }],
      }),
    );
    expect(p.find((x) => x.id.startsWith("tool-"))).toBeUndefined();
  });

  test("watch fires between 50–80% success", () => {
    const p = deriveProposals(
      snap({
        toolMetrics: [{ tool: "web_search", total: 10, successRate: 65, avgMs: 200 }],
      }),
    );
    const w = p.find((x) => x.id === "tool-watch:web_search");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("watch");
  });

  test("action fires below 50% success", () => {
    const p = deriveProposals(
      snap({
        toolMetrics: [{ tool: "read_page", total: 8, successRate: 37, avgMs: 900 }],
      }),
    );
    const a = p.find((x) => x.id === "tool-critical:read_page");
    expect(a).toBeDefined();
    expect(a!.severity).toBe("action");
    expect(a!.ask).toContain("fix, replace, or disable");
  });

  test("no proposal for healthy tools", () => {
    const p = deriveProposals(
      snap({
        toolMetrics: [{ tool: "calculate", total: 20, successRate: 100, avgMs: 1 }],
      }),
    );
    expect(p.find((x) => x.id.startsWith("tool-"))).toBeUndefined();
  });
});

describe("improvement proposals — verification", () => {
  test("failures trigger an action proposal", () => {
    const p = deriveProposals(
      snap({
        verification: { checked: 10, pass: 7, warnings: 2, failed: 1, passRate: 70 },
      }),
    );
    expect(p.find((x) => x.id === "verification:failures")).toBeDefined();
  });

  test("warnings-majority triggers a watch proposal", () => {
    const p = deriveProposals(
      snap({
        verification: { checked: 10, pass: 4, warnings: 6, failed: 0, passRate: 40 },
      }),
    );
    const w = p.find((x) => x.id === "verification:warnings-majority");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("watch");
  });

  test("nothing fires below the minimum checked count", () => {
    const p = deriveProposals(
      snap({
        verification: { checked: 2, pass: 0, warnings: 0, failed: 2, passRate: 0 },
      }),
    );
    expect(p.find((x) => x.area === "verification")).toBeUndefined();
  });
});

describe("improvement proposals — providers", () => {
  test("single vly-only dependency is flagged as info", () => {
    const p = deriveProposals(snap());
    const s = p.find((x) => x.id === "providers:single");
    expect(s).toBeDefined();
    expect(s!.ask).toContain("GROQ_API_KEY");
  });

  test("three or more providers report healthy redundancy", () => {
    const p = deriveProposals(
      snap({
        ai: {
          activeProvider: "vly",
          providers: [
            { id: "vly", label: "v", configured: true, cost: "", hint: "" },
            { id: "groq", label: "g", configured: true, cost: "", hint: "" },
            { id: "deepseek", label: "d", configured: true, cost: "", hint: "" },
          ],
        },
      }),
    );
    expect(p.find((x) => x.id === "providers:healthy")).toBeDefined();
    expect(p.find((x) => x.id === "providers:single")).toBeUndefined();
  });
});

describe("improvement proposals — honesty contract", () => {
  test("quiet system yields an explicit no-proposals result, not silence", () => {
    const p = deriveProposals(
      snap({
        ai: {
          activeProvider: "vly",
          providers: [
            { id: "vly", label: "v", configured: true, cost: "", hint: "" },
            { id: "groq", label: "g", configured: true, cost: "", hint: "" },
          ],
        },
      }),
    );
    expect(p.length).toBe(1);
    expect(p[0].id).toBe("none");
    expect(p[0].title).toContain("No improvement proposals");
  });

  test("deriving is read-only — the snapshot is not mutated", () => {
    const s = snap({
      toolMetrics: [{ tool: "web_search", total: 10, successRate: 30, avgMs: 5 }],
    });
    const before = JSON.stringify(s);
    deriveProposals(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  test("same input produces identical output (stable ids, deterministic)", () => {
    const s = snap({
      toolMetrics: [{ tool: "read_page", total: 9, successRate: 44, avgMs: 10 }],
    });
    expect(deriveProposals(s)).toEqual(deriveProposals(s));
  });
});
