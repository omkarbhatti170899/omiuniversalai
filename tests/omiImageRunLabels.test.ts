import { describe, expect, test } from "bun:test";
import { formatElapsed, runSentenceForOp, runVerbForOp } from "../src/lib/imageRunLabels";

describe("runVerbForOp — the running state names the REAL operation", () => {
  test("edit-family ops never say 'generating'", () => {
    for (const op of ["edit", "remove", "replace", "background", "style", "upscale", "enhance", "combine", "outpaint"]) {
      const verb = runVerbForOp(op);
      expect(verb.toLowerCase()).not.toContain("generating");
      expect(verb.length).toBeGreaterThan(3);
    }
  });

  test("edit specifically reads as editing", () => {
    expect(runVerbForOp("edit")).toBe("editing your image");
    expect(runVerbForOp("remove")).toBe("removing the background");
    expect(runVerbForOp("upscale")).toBe("upscaling your image");
  });

  test("generation ops do read as generating (that is what they are)", () => {
    expect(runVerbForOp("generate")).toContain("generating");
    expect(runVerbForOp("variation")).toContain("generating a variation");
  });

  test("an unknown or pending op never claims a specific operation", () => {
    expect(runVerbForOp(null)).toBe("working on your request");
    expect(runVerbForOp(undefined)).toBe("working on your request");
    expect(runVerbForOp("mystery-op")).toBe("working on your request");
  });
});

describe("formatElapsed — measured time, shown only when it matters", () => {
  test("below 5 seconds there is no counter (silence is not a lie)", () => {
    expect(formatElapsed(0)).toBeNull();
    expect(formatElapsed(1_200)).toBeNull();
    expect(formatElapsed(4_999)).toBeNull();
  });

  test("from 5 seconds the elapsed time is shown in whole seconds", () => {
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(5_400)).toBe("5s");
    expect(formatElapsed(21_700)).toBe("21s");
  });

  test("non-finite values never render", () => {
    expect(formatElapsed(Number.NaN)).toBeNull();
  });
});

describe("runSentenceForOp — one honest sentence per run state", () => {
  test("names the op without fabricated stages", () => {
    const s = runSentenceForOp("edit");
    expect(s).toBe("Omi is editing your image…");
    expect(s.toLowerCase()).not.toContain("analyzing");
    expect(s.toLowerCase()).not.toContain("finalizing");
  });

  test("appends elapsed time only once the run is slow", () => {
    expect(runSentenceForOp("edit", 1_000)).toBe("Omi is editing your image…");
    expect(runSentenceForOp("edit", 9_000)).toBe("Omi is editing your image… (9s)");
  });

  test("stays a clean single line for every op", () => {
    for (const op of ["generate", "edit", "remove", "replace", "background", "style", "upscale", "enhance", "variation", "combine", "outpaint", null]) {
      const s = runSentenceForOp(op, 12_000);
      expect(s.length).toBeLessThan(80);
      expect(s).not.toContain("{");
      expect(s).not.toContain('"');
      expect(s.startsWith("Omi is")).toBe(true);
    }
  });
});
