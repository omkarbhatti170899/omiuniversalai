import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getAiStatus } from "./aiProviders/catalog";

/**
 * OMI workspace health (master plan Phase 11/13 observability).
 *
 * Combines:
 *   • AI routing status (which provider is actually active, per task)
 *   • Tool-run metrics from omiToolRuns (success rate per tool — Phase 11
 *     self-improvement data: what works, what fails, and how often)
 *   • Verification verdict distribution (Phase 7 quality signal)
 *
 * These are READ-ONLY aggregations — improvement proposals stay human-approved
 * (master plan §11: PROPOSE → TEST → VERIFY → APPROVE → DEPLOY); nothing here
 * mutates prompts or routing automatically.
 */
export const workspaceHealth = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const ai = getAiStatus();

    const toolRuns = await ctx.db
      .query("omiToolRuns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);

    const byTool = new Map<
      string,
      { total: number; ok: number; totalMs: number }
    >();
    for (const r of toolRuns) {
      const e = byTool.get(r.tool) ?? { total: 0, ok: 0, totalMs: 0 };
      e.total += 1;
      if (r.ok) e.ok += 1;
      e.totalMs += r.durationMs;
      byTool.set(r.tool, e);
    }
    const toolMetrics = [...byTool.entries()]
      .map(([tool, e]) => ({
        tool,
        total: e.total,
        successRate: e.total === 0 ? 0 : Math.round((e.ok / e.total) * 100),
        avgMs: e.total === 0 ? 0 : Math.round(e.totalMs / e.total),
      }))
      .sort((a, b) => b.total - a.total);

    const tasks = await ctx.db
      .query("omiTasks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
    const checkedTasks = tasks.filter((t) => t.verification !== undefined);
    const passed = checkedTasks.filter(
      (t) => t.verification === "pass" || t.verification === "warnings",
    );
    const verification = {
      checked: checkedTasks.length,
      pass: checkedTasks.filter((t) => t.verification === "pass").length,
      warnings: checkedTasks.filter((t) => t.verification === "warnings").length,
      failed: checkedTasks.filter((t) => t.verification === "failed").length,
      passRate:
        checkedTasks.length === 0
          ? 0
          : Math.round((passed.length / checkedTasks.length) * 100),
    };

    return { ai, toolMetrics, verification };
  },
});
