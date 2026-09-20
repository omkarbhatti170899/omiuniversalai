/**
 * OMI Tool Registry (master plan Phase 1 "OMI Core → Tool discovery /
 * Tool execution" + Phase 6 "Agents must use the same OMI tool registry").
 *
 * This module is PURE: no Convex, no fetch, no Node APIs. It defines:
 *   • the tool catalog (metadata only — the executable layer lives in
 *     executor.ts so this file stays unit-testable and provider-neutral)
 *   • `parseToolCall` — the strict parser for Omi's tool-call syntax
 *   • `validateArgs` — per-tool argument validation shared by every caller
 *
 * Provider neutrality: tools wrap Omi capabilities (search, retrieval,
 * memory, knowledge). Adding a provider later (e.g. a different web search
 * backend) changes the executor's internals, never this catalog or the
 * call sites.
 */

// --- Tool catalog -----------------------------------------------------------

export type ToolId =
  | "web_search"
  | "read_page"
  | "knowledge_search"
  | "memory_save"
  | "memory_list"
  | "calculate";

export type ToolInputSchema = {
  [K in string]: "string" | "number" | "boolean";
};

export type ToolDescriptor = {
  id: ToolId;
  label: string;
  description: string;
  /** Required argument names and their primitive types. */
  required: ToolInputSchema;
  /** Optional argument names and their primitive types. */
  optional: ToolInputSchema;
  /** Parseable risk class — read-only tools need no human approval. */
  safe: boolean;
  /** Hard per-call output budget (chars) so a tool can never flood context. */
  maxResultChars: number;
  /** Tool-call syntax shown to the model in agent prompts. */
  syntax: string;
};

export const TOOLS: ToolDescriptor[] = [
  {
    id: "web_search",
    label: "Web search (Andromeda)",
    description:
      "Multi-source live web search with dedupe, ranking and provenance. Use for anything current, external, or beyond your own knowledge.",
    required: { query: "string" },
    optional: {},
    safe: true,
    maxResultChars: 2400,
    syntax: 'TOOL web_search {"query": "..."}',
  },
  {
    id: "read_page",
    label: "Read page",
    description:
      "Fetch and extract the readable text of one web page (SSRF-guarded, robots-respecting, truncated). Use after web_search to go deeper.",
    required: { url: "string" },
    optional: {},
    safe: true,
    maxResultChars: 3000,
    syntax: 'TOOL read_page {"url": "https://..."}',
  },
  {
    id: "knowledge_search",
    label: "Knowledge base search",
    description:
      "Keyword retrieval over the user's own saved documents — their highest-trust source. Use before web search when the answer may be in their files.",
    required: { query: "string" },
    optional: { limit: "number" },
    safe: true,
    maxResultChars: 2000,
    syntax: 'TOOL knowledge_search {"query": "...", "limit": 4}',
  },
  {
    id: "memory_save",
    label: "Save memory",
    description:
      "Persist one user-approved long-term memory (a durable fact about the user or their work). Only when the user clearly wants it remembered.",
    required: { content: "string" },
    optional: {},
    safe: true,
    maxResultChars: 400,
    syntax: 'TOOL memory_save {"content": "..."}',
  },
  {
    id: "memory_list",
    label: "List memories",
    description: "List the user's approved long-term memories.",
    required: {},
    optional: { limit: "number" },
    safe: true,
    maxResultChars: 1200,
    syntax: 'TOOL memory_list {"limit": 10}',
  },
  {
    id: "calculate",
    label: "Calculator",
    description:
      'Evaluate an arithmetic expression exactly (e.g. "(1240*3)+7.5", "sqrt(144)+2^10", "17!"). Supports + - * / % ^ ** ! parentheses and sqrt, abs, sin, cos, tan, log, ln, round, floor, ceil, min, max, pow. Use for ANY numeric work instead of mental math.',
    required: { expression: "string" },
    optional: {},
    safe: true,
    maxResultChars: 300,
    syntax: 'TOOL calculate {"expression": "(1240*3)+7.5"}',
  },
];

export const TOOL_IDS: ToolId[] = TOOLS.map((t) => t.id);

export function toolById(id: string): ToolDescriptor | null {
  return TOOLS.find((t) => t.id === id) ?? null;
}

/**
 * Prompt fragment listing tools + syntax — shared by agent runtime.
 * Pass an allowlist to show only the tools the caller may execute
 * (the executor still enforces the same list — prompts are never the
 * security boundary).
 */
export function toolCatalogPrompt(allow?: readonly ToolId[]): string {
  const shown = allow ? TOOLS.filter((t) => allow.includes(t.id)) : TOOLS;
  const lines = shown.map((t) => `- ${t.syntax} — ${t.description}`);
  return [
    "You can call tools by writing a tool-call line inside your step output, exactly:",
    ...(lines.length > 0
      ? lines
      : ["(No tools are available for this step — answer from the provided context.)"]),
    "Rules: one tool call per step output, only at the very end of the output.",
    "The system executes the call and gives you the result as context for the next step.",
  ].join("\n");
}

// --- Tool-call parsing ------------------------------------------------------

export type ParsedToolCall =
  | { ok: true; tool: ToolId; args: Record<string, string | number | boolean>; textBefore: string }
  | { ok: false; error: string; textBefore: string };

/**
 * Extract a tool call from a model output. The call must be at the very end
 * of the output, matching `TOOL <id> {json}` (JSON may span multiple lines)
 * — anything else is treated as plain text. `textBefore` is the output with
 * the tool-call line removed. Never throws.
 */
export function parseToolCall(output: string): ParsedToolCall {
  const trimmed = output.trim();
  const startIdx = trimmed.search(/(?:^|\n)TOOL\s/);
  if (startIdx === -1) {
    return { ok: false, error: "no tool call at the end of the output", textBefore: trimmed };
  }
  const textBefore = trimmed.slice(0, startIdx).trim();
  const callText = trimmed.slice(startIdx).replace(/^\n/, "");

  const match = callText.match(/^TOOL\s+(\S+)\s+(\{[\s\S]*\})$/);
  if (!match) {
    return {
      ok: false,
      error: "the final TOOL line is malformed (expected: TOOL <id> {json})",
      textBefore,
    };
  }

  const tool = toolById(match[1]);
  if (!tool) {
    return {
      ok: false,
      error: `unknown tool "${match[1].slice(0, 40)}"`,
      textBefore,
    };
  }

  let args: unknown;
  try {
    args = JSON.parse(match[2]);
  } catch {
    return { ok: false, error: "tool arguments are not valid JSON", textBefore };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "tool arguments must be a JSON object", textBefore };
  }

  const validation = validateArgs(tool, args as Record<string, unknown>);
  if (!validation.ok) {
    return { ok: false, error: validation.error, textBefore };
  }

  return { ok: true, tool: tool.id, args: validation.args, textBefore };
}

// --- Argument validation ----------------------------------------------------

export type ValidatedArgs =
  | { ok: true; args: Record<string, string | number | boolean> }
  | { ok: false; error: string };

/** Validate raw JSON args against a tool's declared schema. Never throws. */
export function validateArgs(
  tool: ToolDescriptor,
  raw: Record<string, unknown>,
): ValidatedArgs {
  for (const [name, type] of Object.entries(tool.required)) {
    const v = raw[name];
    if (v === undefined || v === null) {
      return { ok: false, error: `missing required argument "${name}"` };
    }
    if (typeof v !== type) {
      return {
        ok: false,
        error: `argument "${name}" must be a ${type}`,
      };
    }
    if (type === "string" && (v as string).trim().length === 0) {
      return { ok: false, error: `argument "${name}" must not be empty` };
    }
  }
  for (const [name, type] of Object.entries(tool.optional)) {
    const v = raw[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== type) {
      return { ok: false, error: `argument "${name}" must be a ${type}` };
    }
  }
  // Unknown keys are rejected: agents must not smuggle parameters in.
  const known = new Set([...Object.keys(tool.required), ...Object.keys(tool.optional)]);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) {
      return { ok: false, error: `unknown argument "${k.slice(0, 40)}"` };
    }
  }
  return {
    ok: true,
    args: raw as Record<string, string | number | boolean>,
  };
}

// --- String argument bounds (defense-in-depth, applied by the executor) -----

/** Hard caps so even a compromised model cannot flood storage or context. */
export const ARG_LIMITS = {
  queryChars: 400,
  urlChars: 2000,
  contentChars: 500,
  limitMax: 10,
  expressionChars: 200,
} as const;

/** Clamp a validated string arg to its cap. Returns null when it overflows. */
export function clampStringArg(
  value: string,
  cap: number,
): string | null {
  const t = value.trim();
  if (t.length === 0) return null;
  return t.length > cap ? null : t;
}
