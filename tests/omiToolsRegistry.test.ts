/**
 * OMI Tool Registry tests (master plan Phase 14 — every new tool layer ships
 * with tests). The registry is pure TypeScript, so these run with plain
 * `bun test` — no Convex runtime or network needed.
 *
 * Run: bun test tests/
 */
import { describe, expect, test } from "bun:test";

import {
  ARG_LIMITS,
  TOOLS,
  TOOL_IDS,
  clampStringArg,
  parseToolCall,
  toolById,
  toolCatalogPrompt,
  validateArgs,
  type ToolDescriptor,
} from "../src/convex/omiTools/registry";

const webSearch = toolById("web_search")!;

describe("tool registry catalog", () => {
  test("declares the expected keyless tools", () => {
    expect(TOOLS.length).toBe(7);
    expect(TOOL_IDS).toEqual([
      "web_search",
      "read_page",
      "knowledge_search",
      "memory_save",
      "memory_list",
      "andromeda_research",
      "calculate",
    ]);
  });

  test("every tool is safe/read-only or save-only with result caps", () => {
    for (const t of TOOLS) {
      expect(t.safe).toBe(true);
      expect(t.maxResultChars).toBeGreaterThan(0);
      expect(t.syntax.startsWith(`TOOL ${t.id}`)).toBe(true);
    }
  });

  test("toolById returns null for unknown ids", () => {
    expect(toolById("definitely_not_a_tool")).toBeNull();
  });

  test("catalog prompt lists every tool syntax", () => {
    const prompt = toolCatalogPrompt();
    for (const t of TOOLS) {
      expect(prompt).toContain(t.syntax);
    }
  });
});

describe("parseToolCall", () => {
  test("parses a valid call on the final line", () => {
    const out = 'Here is what I found.\nTOOL web_search {"query": "omi ai"}';
    const r = parseToolCall(out);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tool).toBe("web_search");
      expect(r.args).toEqual({ query: "omi ai" });
      expect(r.textBefore).toBe("Here is what I found.");
    }
  });

  test("rejects when the final line is not a tool call", () => {
    const r = parseToolCall("Just a normal answer with no tools.");
    expect(r.ok).toBe(false);
  });

  test("rejects unknown tools", () => {
    const r = parseToolCall('TOOL delete_everything {"a": 1}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown tool");
  });

  test("rejects invalid JSON args", () => {
    const r = parseToolCall('TOOL web_search {query: omi}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON");
  });

  test("rejects non-object args (arrays, strings, null)", () => {
    expect(parseToolCall('TOOL memory_list [1,2]').ok).toBe(false);
    expect(parseToolCall('TOOL memory_list "x"').ok).toBe(false);
  });

  test("multi-line JSON args still parse", () => {
    const out = 'TOOL web_search {\n  "query": "line broken"\n}';
    const r = parseToolCall(out);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.query).toBe("line broken");
  });
});

describe("validateArgs", () => {
  test("accepts valid required + optional args", () => {
    const r = validateArgs(webSearch, { query: "hello" });
    expect(r.ok).toBe(true);
  });

  test("rejects missing required args", () => {
    const r = validateArgs(webSearch, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('missing required argument "query"');
  });

  test("rejects wrong types", () => {
    const r = validateArgs(webSearch, { query: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("must be a string");
  });

  test("rejects empty strings", () => {
    const r = validateArgs(webSearch, { query: "   " });
    expect(r.ok).toBe(false);
  });

  test("rejects unknown arguments (no parameter smuggling)", () => {
    const r = validateArgs(webSearch, { query: "x", url: "javascript:alert(1)" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "url"');
  });

  test("optional args are type-checked too", () => {
    const knowledge = toolById("knowledge_search")!;
    expect(validateArgs(knowledge, { query: "x", limit: "lots" }).ok).toBe(false);
    expect(validateArgs(knowledge, { query: "x", limit: 3 }).ok).toBe(true);
  });

  test("memory_list has no required args", () => {
    const memoryList = toolById("memory_list")!;
    const r = validateArgs(memoryList, {});
    expect(r.ok).toBe(true);
  });
});

describe("clampStringArg", () => {
  test("passes through normal values", () => {
    expect(clampStringArg("  hello  ", 10)).toBe("hello");
  });

  test("nulls empty values", () => {
    expect(clampStringArg("   ", 10)).toBeNull();
  });

  test("nulls values over the cap (no silent truncation of malicious input)", () => {
    const big = "x".repeat(ARG_LIMITS.queryChars + 1);
    expect(clampStringArg(big, ARG_LIMITS.queryChars)).toBeNull();
  });
});

describe("registry tool descriptors", () => {
  test("all tools declare required args as string/number/boolean only", () => {
    for (const t of TOOLS as ToolDescriptor[]) {
      for (const type of [...Object.values(t.required), ...Object.values(t.optional)]) {
        expect(["string", "number", "boolean"]).toContain(type);
      }
    }
  });
});
