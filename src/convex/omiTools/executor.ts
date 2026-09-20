"use node";

/**
 * OMI Tool executor — the only place that actually runs tools (master plan
 * Phase 1 "Tool execution" / Phase 12 "Tool allowlists, rate limits, audit").
 *
 * Design:
 *   • allowlist-only: tools are looked up in the registry; nothing else runs
 *   • every run is persisted (omiToolRuns) for observability + Phase 11 loops
 *   • rate limit + result caps + no-throw: failures return { ok:false }
 *   • tools wrap capabilities that already exist (Andromeda search, page
 *     retrieval, knowledge base, memory) — no new external dependencies,
 *     zero mandatory cost
 */

import type { GenericActionCtx } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  ARG_LIMITS,
  clampStringArg,
  toolById,
  type ToolId,
} from "./registry";
import { runUniversalSearch } from "../universalSearch";
import { fetchPageText } from "../searchProviders/pageFetcher";
import { rateLimit, withTimeout } from "../searchEngine/resilience";

type ToolCtx = GenericActionCtx<DataModel>;

export type ToolRunResult = {
  ok: boolean;
  tool: ToolId;
  output: string;
  error?: string;
  ms: number;
};

const TOOL_TIMEOUT_MS = 30_000;

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 20)}\n…[truncated ${text.length - cap} chars]`;
}

/**
 * Execute one validated tool call inside an action context.
 * Guaranteed to resolve (never throw) so an agent step can never be killed
 * by a misbehaving tool.
 */
export async function executeTool(
  ctx: ToolCtx,
  userId: Id<"users">,
  tool: ToolId,
  rawArgs: Record<string, string | number | boolean>,
  opts?: { taskId?: Id<"omiTasks">; agentId?: Id<"omiAgents"> },
): Promise<ToolRunResult> {
  const started = Date.now();
  const descriptor = toolById(tool);
  if (!descriptor) {
    return { ok: false, tool, output: "", error: "unknown tool", ms: 0 };
  }

  // Rate limit per user across all tools (master plan §12).
  const rl = rateLimit(`tool:${userId}`, 20);
  if (!rl.ok) {
    return await finish(ctx, userId, opts, {
      ok: false,
      tool,
      output: "",
      error: `rate limited — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
      ms: Date.now() - started,
    });
  }

  let result: ToolRunResult;
  try {
    result = await withTimeout(
      runTool(ctx, userId, tool, rawArgs),
      TOOL_TIMEOUT_MS,
      `tool ${tool}`,
    );
  } catch (err) {
    result = {
      ok: false,
      tool,
      output: "",
      error: (err instanceof Error ? err.message : "tool failed").slice(0, 300),
      ms: Date.now() - started,
    };
  }

  return await finish(ctx, userId, opts, result);
}

async function runTool(
  ctx: ToolCtx,
  userId: Id<"users">,
  tool: ToolId,
  rawArgs: Record<string, string | number | boolean>,
): Promise<ToolRunResult> {
  const started = Date.now();

  switch (tool) {
    case "web_search": {
      const query = clampStringArg(String(rawArgs.query), ARG_LIMITS.queryChars);
      if (!query) return fail(tool, "query too long or empty", started);
      const res = await runUniversalSearch(ctx, query, {
        perEngineLimit: 3,
        maxCitations: 5,
        enrichPages: false,
      });
      if (res.citations.length === 0) {
        return { ok: true, tool, output: "No results found for that query.", ms: Date.now() - started };
      }
      const lines = res.citations.map(
        (c, i) =>
          `[${i + 1}] ${c.title}\nURL: ${c.url}\n${(c.snippet ?? "").slice(0, 240)}\nSources: ${(c.providers ?? []).join(", ") || "web"}`,
      );
      return {
        ok: true,
        tool,
        output: truncate(lines.join("\n\n"), descriptorMax("web_search")),
        ms: Date.now() - started,
      };
    }

    case "read_page": {
      const url = clampStringArg(String(rawArgs.url), ARG_LIMITS.urlChars);
      if (!url) return fail(tool, "url too long or empty", started);
      const page = await fetchPageText(url);
      if (!page.ok) {
        return { ok: false, tool, output: "", error: (page.error ?? "fetch failed").slice(0, 200), ms: Date.now() - started };
      }
      return {
        ok: true,
        tool,
        output: truncate(`TITLE: ${page.title}\nURL: ${page.url}\n\n${page.text}`, descriptorMax("read_page")),
        ms: Date.now() - started,
      };
    }

    case "knowledge_search": {
      const query = clampStringArg(String(rawArgs.query), ARG_LIMITS.queryChars);
      if (!query) return fail(tool, "query too long or empty", started);
      const limit =
        typeof rawArgs.limit === "number" && rawArgs.limit >= 1
          ? Math.min(Math.floor(rawArgs.limit), ARG_LIMITS.limitMax)
          : 4;
      const passages = await ctx.runQuery(internal.omiKnowledge.searchInternal, {
        userId,
        query,
        limit,
      });
      if (!passages || passages.length === 0) {
        return { ok: true, tool, output: "No matching passages in the user's knowledge base.", ms: Date.now() - started };
      }
      const lines = passages.map(
        (p: { title: string; snippet: string }, i: number) => `[K${i + 1}] ${p.title}: ${p.snippet}`,
      );
      return {
        ok: true,
        tool,
        output: truncate(lines.join("\n\n"), descriptorMax("knowledge_search")),
        ms: Date.now() - started,
      };
    }

    case "memory_save": {
      const content = clampStringArg(String(rawArgs.content), ARG_LIMITS.contentChars);
      if (!content) return fail(tool, "content too long or empty", started);
      await ctx.runMutation(internal.omiMemories.createInternal, {
        userId,
        content,
      });
      return {
        ok: true,
        tool,
        output: `Memory saved: "${content}"`,
        ms: Date.now() - started,
      };
    }

    case "memory_list": {
      const limit =
        typeof rawArgs.limit === "number" && rawArgs.limit >= 1
          ? Math.min(Math.floor(rawArgs.limit), ARG_LIMITS.limitMax)
          : 10;
      const memories = await ctx.runQuery(internal.omiMemories.listInternal, {
        userId,
        limit,
      });
      if (!memories || memories.length === 0) {
        return { ok: true, tool, output: "No memories saved yet.", ms: Date.now() - started };
      }
      return {
        ok: true,
        tool,
        output: truncate(
          memories.map((m: { content: string }, i: number) => `${i + 1}. ${m.content}`).join("\n"),
          descriptorMax("memory_list"),
        ),
        ms: Date.now() - started,
      };
    }
  }
}

function descriptorMax(tool: ToolId): number {
  return toolById(tool)?.maxResultChars ?? 2000;
}

function fail(tool: ToolId, error: string, started: number): ToolRunResult {
  return { ok: false, tool, output: "", error, ms: Date.now() - started };
}

/** Persist every run (success or failure) — observability + Phase 11 data. */
async function finish(
  ctx: ToolCtx,
  userId: Id<"users">,
  opts: { taskId?: Id<"omiTasks">; agentId?: Id<"omiAgents"> } | undefined,
  result: ToolRunResult,
): Promise<ToolRunResult> {
  try {
    await ctx.runMutation(internal.omiToolRuns.recordInternal, {
      userId,
      taskId: opts?.taskId,
      agentId: opts?.agentId,
      tool: result.tool,
      argsSummary: "",
      ok: result.ok,
      output: result.output.slice(0, 2000),
      error: result.error,
      durationMs: result.ms,
    });
    if (opts?.taskId) {
      await ctx.runMutation(internal.omiAudit.addInternal, {
        userId,
        taskId: opts.taskId,
        agentId: opts.agentId,
        event: result.ok ? "tool_succeeded" : "tool_failed",
        detail: `${result.tool} (${result.ms}ms)${result.error ? `: ${result.error.slice(0, 120)}` : ""}`,
      });
    }
  } catch {
    // Observability must never break execution.
  }
  return result;
}
