/**
 * Phase 14 tests — Phase 10 Automation Engine planning helpers.
 * Pins the security- and honesty-relevant semantics: URL canonicalization,
 * title-dedupe that never discards cross-domain evidence (master plan §9),
 * step transitions, and the report verdict lines that must never fake a ✓.
 */
import { describe, test, expect } from "bun:test";
import {
  RESEARCH_REPORT_STEPS,
  composeReport,
  dedupeCitations,
  freshSteps,
  setStep,
  stageOf,
} from "../src/convex/workflows/plan";

describe("workflow plan — steps", () => {
  test("fresh steps match the flagship pipeline", () => {
    const steps = freshSteps();
    expect(steps.map((s) => s.label)).toEqual([
      "Understand objective",
      "Multi-source search (Andromeda)",
      "Read top sources",
      "Synthesize with citations",
      "Independent verification",
      "Save report to knowledge",
    ]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  test("setStep marks in place and keeps array identity", () => {
    const steps = freshSteps();
    const same = setStep(steps, 1, "active");
    expect(same).toBe(steps);
    expect(steps[1].status).toBe("active");
    setStep(steps, 1, "done", "5 sources");
    expect(steps[1]).toEqual({
      label: "Multi-source search (Andromeda)",
      status: "done",
      detail: "5 sources",
    });
  });

  test("setStep clears a previous detail when omitted", () => {
    const steps = freshSteps();
    setStep(steps, 0, "active", "temp");
    setStep(steps, 0, "done");
    expect(steps[0].detail).toBeUndefined();
  });

  test("stageOf reports the active step, then the first pending", () => {
    const steps = freshSteps();
    expect(stageOf(steps)).toBe("Understand objective");
    setStep(steps, 0, "done");
    setStep(steps, 1, "active");
    expect(stageOf(steps)).toBe("Multi-source search (Andromeda)");
    for (let i = 0; i < steps.length; i++) setStep(steps, i, "done");
    expect(stageOf(steps)).toBe("Finishing");
  });

  test("step count matches the exported pipeline", () => {
    expect(RESEARCH_REPORT_STEPS.length).toBe(6);
  });
});

describe("workflow plan — citation dedupe (§9)", () => {
  test("drops exact and normalized URL duplicates (scheme/www/trailing slash/utm)", () => {
    const out = dedupeCitations([
      { title: "A", url: "https://example.com/page" },
      { title: "A (copy)", url: "http://www.example.com/page/" },
      { title: "A (copy2)", url: "https://example.com/page?utm_source=x&utm_medium=y" },
    ]);
    expect(out.length).toBe(1);
  });

  test("keeps cross-domain same-headline results (different evidence)", () => {
    const out = dedupeCitations([
      { title: "Battery breakthrough announced", url: "https://site-a.com/news/battery" },
      { title: "Battery breakthrough announced", url: "https://site-b.com/story/battery" },
    ]);
    expect(out.length).toBe(2);
  });

  test("keeps short or generic titles even within one domain", () => {
    const out = dedupeCitations([
      { title: "Home", url: "https://example.com/" },
      { title: "Home", url: "https://example.com/about" },
    ]);
    expect(out.length).toBe(2);
  });

  test("drops same-domain long-title duplicates", () => {
    const out = dedupeCitations([
      {
        title: "Solid-state batteries: manufacturing challenges remain large",
        url: "https://example.com/ssb-1",
      },
      {
        title: "Solid-state batteries: manufacturing challenges remain large!",
        url: "https://example.com/ssb-2",
      },
    ]);
    expect(out.length).toBe(1);
  });

  test("preserves first-seen order and all fields", () => {
    const src = [
      { title: "One", url: "https://a.com/1", snippet: "s1", publishedAt: "2026-01-01" },
      { title: "Two", url: "https://b.com/2", snippet: "s2" },
    ];
    const out = dedupeCitations(src);
    expect(out.map((c) => c.url)).toEqual(["https://a.com/1", "https://b.com/2"]);
    expect(out[0].snippet).toBe("s1");
    expect(out[0].publishedAt).toBe("2026-01-01");
  });
});

describe("workflow plan — report composition (§35 honesty)", () => {
  test("pass verdict states the check happened", () => {
    const r = composeReport("Objective", "Answer body", "[1] Src", {
      verdict: "pass",
      notes: [],
    });
    expect(r).toContain("# Omi Research Report");
    expect(r).toContain("**Objective:** Objective");
    expect(r).toContain("independent check found no material issues");
    expect(r).toContain("[1] Src");
  });

  test("warnings verdict lists the concerns", () => {
    const r = composeReport("Obj", "A", "F", {
      verdict: "warnings",
      notes: ["gap one", "gap two"],
    });
    expect(r).toContain("noted concerns — gap one; gap two");
  });

  test("failed verdict surfaces the problems, never hides them", () => {
    const r = composeReport("Obj", "A", "F", {
      verdict: "failed",
      notes: ["contradiction with [3]"],
    });
    expect(r).toContain("found problems — contradiction with [3]");
  });

  test("unverified verdict says NOT verified instead of faking a check", () => {
    const r = composeReport("Obj", "A", "F", {
      verdict: "unverified",
      notes: [],
    });
    expect(r).toContain("not independently verified");
    expect(r).not.toContain("no material issues");
  });
});
