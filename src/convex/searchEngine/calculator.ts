/**
 * Omi Calculator — a grammar-restricted arithmetic engine (master plan §5
 * "calculation" intent, §27 "secure code execution", §28 "command
 * injection", §13 tool execution).
 *
 * Why a hand-written parser instead of `new Function`/eval: the previous
 * path compiled user text into JavaScript, which is arbitrary code
 * execution by another name (§27/§28 forbid exactly that). This engine is
 * sandboxed BY CONSTRUCTION:
 *
 *   • a fixed token whitelist — nothing that isn't a number, operator,
 *     parenthesis, or a known safe function name can ever be evaluated
 *   • a recursive-descent parser over that grammar — no dynamic compilation
 *   • every function call is a lookup into a closed table (no property
 *     access, no strings, no member expressions possible)
 *   • bounded compute: token/depth/iteration caps stop "9**9**9..."-style
 *     resource exhaustion before it starts
 *   • pure float math only — no state, no I/O, nothing to escape into
 *
 * PURE module: no Convex, no fetch, no Node APIs — unit-testable (Phase 14)
 * and importable from any runtime.
 */

// --- Public types -------------------------------------------------------------

export type CalcResult =
  | { ok: true; value: number; formatted: string }
  | { ok: false; error: string };

// --- Limits (compute-bounding, §27) --------------------------------------------

export const CALC_LIMITS = {
  maxInputChars: 200,
  maxTokens: 120,
  maxDepth: 40,
  /** Iteration cap shared by factorial and power loops. */
  maxLoopIterations: 170,
  /** Factorial input must be a non-negative integer below this. */
  maxFactorialArg: 170, // 170! is the largest double-precision factorial
} as const;

// --- Tokenizer -----------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "%" | "^" | "**" | "!" }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" };

const IDENT_RE = /^[a-z][a-z0-9_]*/i;

const KNOWN_FUNCTIONS = new Set([
  "sqrt",
  "abs",
  "sin",
  "cos",
  "tan",
  "log",
  "ln",
  "round",
  "floor",
  "ceil",
  "min",
  "max",
  "pow",
]);

/** Closed constant table (still just numbers — nothing callable). */
const KNOWN_CONSTANTS = new Set(["e", "pi"]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Tokenize; numbers must be finite and canonical (no `Infinity`, `0x..`…). */
export function tokenize(input: string): Token[] | { error: string } {
  const src = input.slice(0, CALC_LIMITS.maxInputChars);
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (isDigit(ch) || (ch === "." && isDigit(src[i + 1] ?? ""))) {
      // Canonical decimal only: digits, one dot, optional exponent digits.
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) return { error: "malformed number" };
      const v = Number(m[0]);
      if (!Number.isFinite(v)) return { error: "number out of range" };
      tokens.push({ t: "num", v });
      i += m[0].length;
      continue;
    }
    if (ch === "*" && src[i + 1] === "*") {
      tokens.push({ t: "op", v: "**" });
      i += 2;
      continue;
    }
    if ("+-*/%^!".includes(ch)) {
      tokens.push({ t: "op", v: ch as Extract<Token, { t: "op" }>["v"] });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "lp" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "rp" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ t: "comma" });
      i += 1;
      continue;
    }
    const rest = src.slice(i);
    const id = IDENT_RE.exec(rest);
    if (
      id &&
      (KNOWN_FUNCTIONS.has(id[0].toLowerCase()) ||
        KNOWN_CONSTANTS.has(id[0].toLowerCase()))
    ) {
      tokens.push({ t: "ident", v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    // Anything else — letters, `_`, `$`, quotes, brackets — is rejected here.
    return { error: `unexpected character "${ch}"` };
  }
  if (tokens.length > CALC_LIMITS.maxTokens) {
    return { error: "expression too long" };
  }
  return tokens;
}

// --- Parser (recursive descent) -------------------------------------------------

type ParserState = { tokens: Token[]; pos: number; depth: number };

function peek(s: ParserState): Token | undefined {
  return s.tokens[s.pos];
}

function next(s: ParserState): Token | undefined {
  return s.tokens[s.pos++];
}

function parseExpression(s: ParserState): number | { error: string } {
  // expression := term (('+'|'-') term)*
  let left = parseTerm(s);
  if (typeof left === "object") return left;
  for (;;) {
    const tk = peek(s);
    if (tk && tk.t === "op" && (tk.v === "+" || tk.v === "-")) {
      s.pos += 1;
      const right = parseTerm(s);
      if (typeof right === "object") return right;
      left = tk.v === "+" ? left + right : left - right;
      if (!Number.isFinite(left)) return { error: "result out of range" };
    } else {
      return left;
    }
  }
}

function parseTerm(s: ParserState): number | { error: string } {
  // term := unary (('*'|'/'|'%') unary)*
  let left = parseUnary(s);
  if (typeof left === "object") return left;
  for (;;) {
    const tk = peek(s);
    if (tk && tk.t === "op" && (tk.v === "*" || tk.v === "/" || tk.v === "%")) {
      s.pos += 1;
      const right = parseUnary(s);
      if (typeof right === "object") return right;
      if (tk.v === "/" && right === 0) return { error: "division by zero" };
      if (tk.v === "%" && right === 0) return { error: "modulo by zero" };
      left = tk.v === "*" ? left * right : tk.v === "/" ? left / right : left % right;
      if (!Number.isFinite(left)) return { error: "result out of range" };
    } else {
      return left;
    }
  }
}

function parseUnary(s: ParserState): number | { error: string } {
  // unary := ('-'|'+') unary | postfix
  const tk = peek(s);
  if (tk && tk.t === "op" && (tk.v === "-" || tk.v === "+")) {
    s.pos += 1;
    const v = parseUnary(s);
    if (typeof v === "object") return v;
    return tk.v === "-" ? -v : v;
  }
  return parsePostfix(s);
}

function parsePostfix(s: ParserState): number | { error: string } {
  // postfix := primary ('!' | '^' | '**' ...)   (right-assoc powers, postfix !)
  let base = parsePrimary(s);
  if (typeof base === "object") return base;
  for (;;) {
    const tk = peek(s);
    if (tk && tk.t === "op" && (tk.v === "^" || tk.v === "**")) {
      s.pos += 1;
      const exp = parseUnary(s); // right-assoc: 2**3**2 = 2**(3**2)
      if (typeof exp === "object") return exp;
      // Bound the exponent work; huge exponents are rejected, not computed.
      if (Math.abs(exp) > 1e4) return { error: "exponent too large" };
      const r = Math.pow(base, exp);
      if (!Number.isFinite(r)) return { error: "result out of range" };
      base = r;
    } else if (tk && tk.t === "op" && tk.v === "!") {
      s.pos += 1;
      const r = factorial(base);
      if (typeof r === "object") return r;
      base = r;
    } else {
      return base;
    }
  }
}

function parsePrimary(s: ParserState): number | { error: string } {
  if (s.depth > CALC_LIMITS.maxDepth) return { error: "expression too deeply nested" };
  s.depth += 1;
  try {
    const tk = next(s);
    if (!tk) return { error: "unexpected end of expression" };
    if (tk.t === "num") return tk.v;
    if (tk.t === "lp") {
      const v = parseExpression(s);
      if (typeof v === "object") return v;
      const close = next(s);
      if (!close || close.t !== "rp") return { error: "missing closing parenthesis" };
      return v;
    }
    if (tk.t === "ident") {
      // Constants resolve immediately (closed table, just numbers).
      if (tk.v === "e") return Math.E;
      if (tk.v === "pi") return Math.PI;
      // Function call: closed lookup — no dynamic property access possible.
      const open = next(s);
      if (!open || open.t !== "lp") return { error: `expected "(" after ${tk.v}` };
      const args: number[] = [];
      if (peek(s) && peek(s)!.t !== "rp") {
        for (;;) {
          const a = parseExpression(s);
          if (typeof a === "object") return a;
          args.push(a);
          const sep = next(s);
          if (!sep) return { error: "unclosed function call" };
          if (sep.t === "rp") break;
          if (sep.t !== "comma") return { error: "expected , or ) in function call" };
        }
      } else {
        s.pos += 1; // consume ')'
        return { error: `${tk.v}() needs at least one argument` };
      }
      return applyFunction(tk.v, args);
    }
    return { error: "unexpected token" };
  } finally {
    s.depth -= 1;
  }
}

// --- Safe function table (closed set — nothing else can be called) --------------

function applyFunction(name: string, args: number[]): number | { error: string } {
  switch (name) {
    case "sqrt": {
      if (args.length !== 1) return { error: "sqrt takes exactly 1 argument" };
      if (args[0] < 0) return { error: "sqrt of a negative number" };
      return Math.sqrt(args[0]);
    }
    case "abs":
      return args.length === 1 ? Math.abs(args[0]) : { error: "abs takes exactly 1 argument" };
    case "sin":
    case "cos":
    case "tan": {
      if (args.length !== 1) return { error: `${name} takes exactly 1 argument` };
      const r = Math[name as "sin" | "cos" | "tan"](args[0]);
      return Number.isFinite(r) ? r : { error: "result out of range" };
    }
    case "log": {
      if (args.length !== 1) return { error: "log takes exactly 1 argument" };
      if (args[0] <= 0) return { error: "log needs a positive argument" };
      return Math.log10(args[0]);
    }
    case "ln": {
      if (args.length !== 1) return { error: "ln takes exactly 1 argument" };
      if (args[0] <= 0) return { error: "ln needs a positive argument" };
      return Math.log(args[0]);
    }
    case "round":
    case "floor":
    case "ceil": {
      if (args.length !== 1) return { error: `${name} takes exactly 1 argument` };
      return Math[name as "round" | "floor" | "ceil"](args[0]);
    }
    case "min":
    case "max": {
      if (args.length < 1) return { error: `${name} needs at least 1 argument` };
      return Math[name as "min" | "max"](...args);
    }
    case "pow": {
      if (args.length !== 2) return { error: "pow takes exactly 2 arguments" };
      if (Math.abs(args[1]) > 1e4) return { error: "exponent too large" };
      const r = Math.pow(args[0], args[1]);
      return Number.isFinite(r) ? r : { error: "result out of range" };
    }
    default:
      // Unreachable: the tokenizer only admits KNOWN_FUNCTIONS.
      return { error: "unknown function" };
  }
}

function factorial(n: number): number | { error: string } {
  if (n < 0 || !Number.isInteger(n)) {
    return { error: "factorial needs a non-negative whole number" };
  }
  if (n > CALC_LIMITS.maxFactorialArg) {
    return { error: `factorial input too large (max ${CALC_LIMITS.maxFactorialArg})` };
  }
  let acc = 1;
  for (let i = 2; i <= n; i++) {
    acc *= i;
    if (!Number.isFinite(acc)) return { error: "result out of range" };
  }
  return acc;
}

// --- Input normalization --------------------------------------------------------

/**
 * Map Unicode maths symbols onto their ASCII operators.
 *
 * Users type × and ÷ constantly — phone keyboards default to them, and text
 * copied out of rendered documents carries − (U+2212) and en/em dashes. The
 * evaluator used to reject these outright ("unexpected character ×"), so
 * "What's 25 × 48?" — the single most natural way to type a multiplication —
 * never reached the calculator at all.
 */
export function normalizeMathOperators(input: string): string {
  return input
    .replace(/[\u00D7\u22C5\u00B7\u2217\uFF0A]/g, "*") // × ⋅ · ∗ ＊
    .replace(/[\u00F7\u2215\u2044\uFF0F]/g, "/") // ÷ ∕ ⁄ ／
    .replace(/[\u2212\u2013\u2014\u2010\u2011\uFF0D]/g, "-") // − – — ‐ ‑ －
    .replace(/[\uFF0B]/g, "+")
    .replace(/[\uFF08]/g, "(")
    .replace(/[\uFF09]/g, ")")
    .replace(/[\u02C6\uFF3E]/g, "^")
    .replace(/[\uFF0C]/g, ",")
    // "25 x 48" — the letter x between two digits is multiplication in every
    // real-world usage (nobody means the variable x there), and it was the
    // last common way of writing × that still failed.
    .replace(/(\d)\s*[xX]\s*(\d)/g, "$1*$2");
}

/**
 * Natural-language wrapper in front of a maths expression, e.g. "What's " in
 * "What's 25 * 48?". Stripped before the arithmetic-character test so a polite
 * question is still recognised as a calculation.
 */
const CALC_PREFIX_RE =
  /^\s*(?:what(?:'s|s| is| are)?|how\s+much\s+is|how\s+many\s+is|calculate|compute|work\s+out|solve|evaluate|equals?)\s+/i;

/**
 * Pull the arithmetic expression out of a natural-language question.
 *
 * This exists because the same naive strip was duplicated in two call sites
 * (chat and search) and both mangled Unicode operators, silently producing
 * nonsense like "Whats 25 48" instead of an expression. One shared helper
 * means one place to get it right.
 */
export function extractMathExpression(input: string): string {
  return normalizeMathOperators(input)
    .replace(CALC_PREFIX_RE, "")
    // Strip question/assignment wrappers only. `!` is deliberately NOT
    // stripped — it is the factorial operator, and removing it silently
    // turned "17!" into "17".
    .replace(/[?=]+/g, " ")
    // Keep only characters the evaluator understands, plus letters so
    // function names (sqrt, log, …) survive; unknown words fail honestly
    // in the evaluator rather than being silently deleted into a wrong sum.
    .replace(/[^0-9a-zA-Z+\-*/().,%^\s!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Entry point ----------------------------------------------------------------

/** Evaluate a grammar-restricted arithmetic expression. Never throws. */
export function evaluateExpression(input: string): CalcResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: "empty expression" };
  }
  if (input.length > CALC_LIMITS.maxInputChars) {
    return { ok: false, error: "expression too long" };
  }
  // Accept the operators users actually type (× ÷ −) before tokenizing.
  const normalized = normalizeMathOperators(input);
  const tokens = tokenize(normalized);
  if ("error" in tokens) return { ok: false, error: tokens.error };
  if (tokens.length === 0) return { ok: false, error: "empty expression" };

  const state: ParserState = { tokens, pos: 0, depth: 0 };
  const value = parseExpression(state);
  if (typeof value === "object") return { ok: false, error: value.error };
  if (state.pos !== tokens.length) {
    return { ok: false, error: "unexpected trailing characters" };
  }
  if (!Number.isFinite(value)) return { ok: false, error: "result out of range" };

  return { ok: true, value, formatted: formatNumber(value) };
}

function formatNumber(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const r = Number(v.toPrecision(12));
  return String(r);
}
