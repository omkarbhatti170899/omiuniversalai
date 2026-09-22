/**
 * Phase 14 tests — the sandboxed calculation engine (master plan §5/§27).
 * These pins are security-relevant: the previous implementation compiled the
 * expression with `new Function`, so each vector here documents a property
 * the engine MUST have: closed token set, closed function table, bounded
 * compute, and honest failure (no silent wrong answers).
 */
import { describe, test, expect } from "bun:test";
import {
  CALC_LIMITS,
  evaluateExpression,
  extractMathExpression,
  normalizeMathOperators,
} from "../src/convex/searchEngine/calculator";
import { isCalculation } from "../src/convex/searchEngine/decision";

function ok(expr: string): number {
  const r = evaluateExpression(expr);
  expect(r.ok).toBe(true);
  return r.ok ? r.value : NaN;
}

/**
 * Regression suite for the real routing failure behind master-plan test 1.
 *
 * "What's 25 × 48?" — the most natural way to type a multiplication, and the
 * exact phrasing the plan specifies — never reached the calculator: the ×
 * (U+00D7) that phone keyboards and copied text produce was rejected as an
 * "unexpected character", the natural-language wrapper defeated the
 * arithmetic test, and the expression builder then deleted the operator and
 * produced nonsense like "Whats 25 48".
 */
describe("calculator routing from natural-language input", () => {
  const SHOULD_CALC: Array<[string, string]> = [
    ["What's 25 × 48?", "1200"],
    ["25 × 48", "1200"],
    ["what is 25 x 48", "1200"],
    ["Whats 25 * 48?", "1200"],
    ["100 ÷ 4", "25"],
    ["10 − 3", "7"],
    ["how much is 12*4", "48"],
    ["sqrt(144)", "12"],
    ["log(100)", "2"],
    ["25 * 48 =", "1200"],
  ];

  for (const [input, expected] of SHOULD_CALC) {
    test(`routes and computes: ${input}`, () => {
      expect(isCalculation(input)).toBe(true);
      const r = evaluateExpression(extractMathExpression(input));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.formatted).toBe(expected);
    });
  }

  test("factorial survives: `!` is an operator, not a question mark", () => {
    // Stripping `!` as punctuation silently turned 17! into 17.
    expect(isCalculation("17!")).toBe(true);
    expect(ok(extractMathExpression("17!"))).toBe(355687428096000);
    expect(ok(extractMathExpression("5!"))).toBe(120);
  });

  test("Unicode operators normalize to ASCII", () => {
    expect(normalizeMathOperators("6 × 7 ÷ 2 − 1")).toBe("6 * 7 / 2 - 1");
    expect(normalizeMathOperators("3 · 4")).toBe("3 * 4");
    expect(ok(normalizeMathOperators("6 × 7"))).toBe(42);
  });

  test("extractMathExpression keeps a clean expression intact", () => {
    expect(extractMathExpression("(12*4)+7")).toBe("(12*4)+7");
    expect(extractMathExpression("What's (12*4)+7?")).toBe("(12*4)+7");
  });

  test("ordinary questions are NOT hijacked into the calculator", () => {
    const notMath = [
      "what is the capital of France",
      "who created Bitcoin",
      "explain quantum entanglement",
      "compare iPhone vs Pixel",
      "best laptops 2026",
      "how do I reset my password",
    ];
    for (const q of notMath) expect(isCalculation(q)).toBe(false);
  });

  test("numbers without an operator are not calculations", () => {
    expect(isCalculation("2026")).toBe(false);
    expect(isCalculation("how many users in 2026")).toBe(false);
  });
});

function err(expr: string): string {
  const r = evaluateExpression(expr);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.error;
}

describe("calculator — arithmetic correctness", () => {
  test("precedence and parentheses", () => {
    expect(ok("2+3*4")).toBe(14);
    expect(ok("(2+3)*4")).toBe(20);
    expect(ok("10/4")).toBe(2.5);
    expect(ok("2*(3+(4-1))")).toBe(12);
    expect(ok("-3+5")).toBe(2);
    expect(ok("--3")).toBe(3); // unary double negation
    expect(ok("10 % 3")).toBe(1);
  });

  test("right-associative powers", () => {
    expect(ok("2**3**2")).toBe(512); // 2**(3**2), not (2**3)**2
    expect(ok("2^10")).toBe(1024);
  });

  test("scientific notation and decimals", () => {
    expect(ok("1.5e3")).toBe(1500);
    expect(ok(".5 + .25")).toBe(0.75);
  });

  test("functions from the closed table", () => {
    expect(ok("sqrt(144)")).toBe(12);
    expect(ok("abs(-7)")).toBe(7);
    expect(ok("max(3, 9, 2)")).toBe(9);
    expect(ok("min(3, 9, 2)")).toBe(2);
    expect(ok("round(2.6)")).toBe(3);
    expect(ok("floor(2.9)")).toBe(2);
    expect(ok("ceil(2.1)")).toBe(3);
    expect(ok("pow(2, 8)")).toBe(256);
    expect(ok("log(1000)")).toBe(3); // base-10
    expect(ok("ln(e)")).toBe(1); // e constant
    expect(Math.abs(ok("sin(pi/2) - 1"))).toBeLessThan(1e-9); // pi constant
  });

  test("factorial", () => {
    expect(ok("5!")).toBe(120);
    expect(ok("0!")).toBe(1);
    expect(ok("3! + 4!")).toBe(30);
  });
});

describe("calculator — sandbox enforcement (§27/§28)", () => {
  test("rejects identifiers outside the closed function table", () => {
    for (const e of [
      "constructor",
      "process",
      "globalThis",
      "window",
      "this",
      "eval(1)",
      "Function('return 1')()",
    ]) {
      expect(err(e).length).toBeGreaterThan(0);
    }
  });

  test("rejects property access / member expressions", () => {
    for (const e of [
      "a.b",
      "process.exit",
      "Math.pow(2,3)", // dotted access — Math is not in the table
      "obj['x']",
      "f(1).g",
    ]) {
      expect(err(e).length).toBeGreaterThan(0);
    }
  });

  test("rejects strings, brackets and template tricks", () => {
    for (const e of [
      "'1'+1",
      '"a"',
      "[1][0]",
      "{1:2}",
      "String(1)",
      "`${1}`",
    ]) {
      expect(err(e).length).toBeGreaterThan(0);
    }
  });

  test("unknown bare words are rejected, known functions required", () => {
    expect(err("foo(1)")).toContain("unexpected");
    expect(err("sqrt(1)+x")).toContain("unexpected");
  });

  test("malformed input fails honestly", () => {
    expect(err("")).toContain("empty");
    expect(err("   ")).toContain("empty");
    expect(err("2+")).toContain("unexpected end");
    expect(err("(2+3")).toContain("parenthesis");
    expect(err("2 3")).toContain("trailing");
    expect(err("1..2")).toContain("unexpected");
    expect(err("sqrt()")).toContain("argument");
  });

  test("division and modulo by zero are errors, not Infinity", () => {
    expect(err("1/0")).toContain("zero");
    expect(err("5%0")).toContain("zero");
  });

  test("domain errors are honest", () => {
    expect(err("sqrt(-1)")).toContain("negative");
    expect(err("log(0)")).toContain("positive");
    expect(err("ln(-2)")).toContain("positive");
    expect(ok("-1!")).toBe(-1); // postfix ! binds tighter than unary minus: -(1!)
    expect(err("2.5!")).toContain("whole");
  });

  test("compute-bounding: runaway exponents and long chains are rejected", () => {
    expect(err("9**9**9")).toContain("too large");
    expect(err("2**100000")).toContain("too large");
    expect(err("171!")).toContain("too large"); // above the factorial cap
    expect(err("1+".repeat(CALC_LIMITS.maxTokens) + "1")).toContain("too long");
    const deep = "(".repeat(CALC_LIMITS.maxDepth + 5) + "1" + ")".repeat(CALC_LIMITS.maxDepth + 5);
    expect(err(deep)).toContain("nested");
  });

  test("input length cap", () => {
    expect(err("1+".repeat(150) + "1")).toContain("too long");
    expect(err("x".repeat(500))).toContain("too long");
  });
});

describe("calculator — determinism and purity", () => {
  test("same input, same output; no state leaks between calls", () => {
    expect(ok("2+2")).toBe(4);
    expect(ok("2+2")).toBe(4);
    expect(ok("max(1,2)")).toBe(2);
    expect(ok("max(3,4)")).toBe(4);
  });

  test("results are finite numbers with a formatted string", () => {
    const r = evaluateExpression("(1/3)*3");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Number.isFinite(r.value)).toBe(true);
      expect(typeof r.formatted).toBe("string");
      expect(r.formatted.length).toBeGreaterThan(0);
    }
  });
});
