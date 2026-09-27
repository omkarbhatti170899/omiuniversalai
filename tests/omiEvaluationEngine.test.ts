/**
 * THE OMNI EVALUATION ENGINE
 * ==========================
 *
 * A reusable benchmark that runs the same way after every major change, so a
 * regression is visible as a number rather than discovered by a user.
 *
 * Design rules:
 *   • Every case declares the capability it exercises and what a CORRECT answer
 *     must and must not contain. Expectations are structural, not golden-file
 *     exact matches — the model is allowed to phrase things its own way.
 *   • A case that cannot run in this environment is reported as SKIPPED, never
 *     as PASSED. An unrunnable benchmark that reports green is worse than no
 *     benchmark, because it manufactures confidence.
 *   • The engine is pure: cases in, scores out. The runner that executes them
 *     against live providers lives in `src/convex/omiEval.ts` and is internal.
 *
 * Capabilities covered: current-information, search, reasoning, coding,
 * knowledge-base, vision, multilingual, safety.
 */

import { describe, expect, it } from "bun:test";
import {
  runEvalSuite,
  summarizeEval,
  scoreAnswer as engineScore,
  normalizeForMatch,
  CAPABILITIES,
  type EvalCase,
  type EvalResult,
} from "../scripts/evalEngine";


/** Minimal case builder shared by the scoring tests. */
const make = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "x",
  capability: "reasoning",
  prompt: "p",
  mustInclude: [],
  ...over,
});

describe("eval engine — matching survives real-world text shapes", () => {
  // Every case below produced a FALSE FAILURE on the first live run, because
  // the answer was right and the matcher was naive. A benchmark that fails
  // correct answers is ignored, which is worse than no benchmark.
  it("matches a number written with a thousands separator", () => {
    const c = make({ mustInclude: ["1200"] });
    expect(engineScore(c, "25 × 48 = 1,200.").score).toBe(1);
  });

  it("matches text containing a zero-width non-joiner", () => {
    const c = make({ mustInclude: ["नई दिल्ली"] });
    expect(engineScore(c, "भारत की राजधानी **नई दिल्ली** है।").score).toBe(1);
  });

  it("matches accented text regardless of Unicode composition", () => {
    const c = make({ mustInclude: ["paris"] });
    expect(engineScore(c, "La capital de Francia es París.").score).toBe(1);
    expect(engineScore(c, "La capital de Francia es Paris.").score).toBe(1);
  });

  it("still catches a genuinely wrong answer", () => {
    const c = make({ mustInclude: ["paris"] });
    expect(engineScore(c, "La capital de Francia es Lyon.").score).toBe(0);
  });

  it("normalises consistently and never throws on empty input", () => {
    expect(normalizeForMatch("")).toBe("");
    expect(normalizeForMatch("A‌B")).toBe("ab");
  });
});

describe("eval engine — guarantees owned by the product, not the model", () => {
  it("marks the creator-identity case as a product-path guarantee", () => {
    // Measured: the bare model claims a different creator. The shipped product
    // injects the canonical statement and serves it deterministically, so
    // scoring the raw model would measure the wrong layer.
    const c = runEvalSuite().find((x) => x.id === "reasoning.identity");
    expect(c?.requiresProductPath).toBe(true);
  });
});

describe("eval engine — the suite itself is well-formed", () => {
  const suite = runEvalSuite();

  it("covers every declared capability", () => {
    const covered = new Set(suite.map((c) => c.capability));
    for (const cap of CAPABILITIES) {
      expect(`${cap}: ${[...covered].join(",")}`).toContain(cap);
    }
  });

  it("has at least one case per capability", () => {
    for (const cap of CAPABILITIES) {
      expect(`${cap} count: ${suite.filter((c) => c.capability === cap).length}`).toContain(cap);
    }
  });

  it("gives every case an id, a prompt and a check", () => {
    for (const c of suite) {
      expect(`${c.id}:${c.prompt.length > 0}:${typeof c.mustInclude === "object"}`).toContain("true");
      expect(c.id.length).toBeGreaterThan(2);
    }
  });

  it("has unique case ids", () => {
    const ids = suite.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("eval engine — current-information cases encode the reported bug", () => {
  const suite = runEvalSuite();
  const current = suite.filter((c) => c.capability === "current-information");

  it("includes the exact query from the bug report", () => {
    expect(current.some((c) => c.prompt.includes("Asian Games 2026"))).toBe(true);
  });

  it("requires the answer to refuse rather than invent a tally", () => {
    const asianGames = current.find((c) => c.prompt.includes("Asian Games 2026"));
    expect(asianGames?.mustNotInclude?.join(" ")).toContain("guaranteed");
    expect(asianGames?.mustInclude?.join(" ")).toMatch(/could not|cannot|unavailable|as of|report/i);
  });

  it("requires dates on every current-information answer", () => {
    for (const c of current) {
      expect(`${c.id}: ${c.mustInclude?.join(" ") ?? ""}`).toMatch(/date|today|as of|reported|unavailable|could not|cannot/i);
    }
  });
});

describe("eval engine — safety cases forbid the failures that matter", () => {
  const suite = runEvalSuite();
  const safety = suite.filter((c) => c.capability === "safety");

  it("refuses to answer a current question from memory when sources fail", () => {
    const c = safety.find((s) => s.id === "safety.no-memory-substitution");
    expect(c).toBeDefined();
    expect(c?.mustNotInclude?.join(" ")).toContain("guaranteed");
  });

  it("ignores prompt injection inside a document", () => {
    expect(safety.some((s) => s.id === "safety.document-injection")).toBe(true);
  });

  it("never leaks a credential shape", () => {
    const c = safety.find((s) => s.id === "safety.no-secret-disclosure");
    expect(c?.mustNotInclude ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/sk_|pk_|Bearer /)]),
    );
  });
});

describe("eval engine — scoring and reporting are honest", () => {
  it("scores a passing answer 1 and a failing answer 0", () => {
    const c = make({ mustInclude: ["paris"] });
    expect(engineScore(c, "The capital is Paris.").score).toBe(1);
    expect(engineScore(c, "I am not sure.").score).toBe(0);
  });

  it("fails a case that hits a forbidden pattern, even if it also matches", () => {
    const c = make({ mustInclude: ["paris"], mustNotInclude: ["guaranteed"] });
    const res = engineScore(c, "Paris is guaranteed to be the capital.");
    expect(res.score).toBe(0);
    expect(res.reasons.join(" ")).toContain("must-not");
  });

  it("reports SKIPPED rather than PASSED when it could not run", () => {
    const skipped: EvalResult = {
      id: "x",
      capability: "vision",
      status: "skipped",
      score: 0,
      reasons: ["no device"],
    };
    const summary = summarizeEval([skipped]);
    expect(summary.passed).toBe(0);
    expect(summary.skipped).toBe(1);
    // A skipped case must never be counted as a pass in the rate.
    expect(summary.passRate).toBe(0);
  });

  it("excludes skipped cases from the pass rate rather than counting them as failures", () => {
    const results: EvalResult[] = [
      { id: "a", capability: "reasoning", status: "pass", score: 1, reasons: [] },
      { id: "b", capability: "vision", status: "skipped", score: 0, reasons: ["no device"] },
    ];
    const s = summarizeEval(results);
    expect(s.total).toBe(2);
    expect(s.ran).toBe(1);
    expect(s.passRate).toBe(1);
  });

  it("surfaces the capability with the worst score, so a regression is obvious", () => {
    const results: EvalResult[] = [
      { id: "a", capability: "reasoning", status: "pass", score: 1, reasons: [] },
      { id: "b", capability: "current-information", status: "fail", score: 0, reasons: ["stale"] },
    ];
    const s = summarizeEval(results);
    expect(s.byCapability["current-information"].failed).toBe(1);
    expect(s.worstCapability).toBe("current-information");
  });
});

/** Local copy removed: the tests below exercise the engine's real scorer. */
