import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { redact } from "../lib/observability";

/**
 * Server-side observability (Phase 11).
 *
 * Everything written here goes through the SAME redaction guarantees as the
 * client: `redact()` drops secret-shaped keys, masks credential-shaped
 * values, and removes email addresses. That is the whole point of keeping the
 * rules in one shared module rather than re-implementing them in a second
 * place where they would quietly drift.
 *
 * What is deliberately NOT stored:
 *   • the user's prompt or question text — only `summarize()` (length, word
 *     count, short hash) so repeated failures can be grouped;
 *   • the content of private knowledge articles;
 *   • any key, token, password or session value.
 *
 * What IS stored: subsystem, event name, outcome, latency, a small numeric
 * context, and a redacted error string. That is enough to answer "which
 * subsystem is failing, how often, and how slow" without keeping anyone's
 * content.
 */

export const record = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    subsystem: v.string(),
    event: v.string(),
    ok: v.optional(v.boolean()),
    ms: v.optional(v.number()),
    code: v.optional(v.string()),
    /** Free-form numeric context. Non-numbers are dropped by the validator. */
    context: v.optional(v.record(v.string(), v.number())),
    error: v.optional(v.string()),
    /** Optional shape-only summary of user text (never the text). */
    prompt: v.optional(v.object({ length: v.number(), words: v.number(), hash: v.string() })),
  },
  handler: async (ctx, args) => {
    const row = {
      userId: args.userId,
      subsystem: args.subsystem.slice(0, 40),
      event: args.event.slice(0, 60),
      ok: args.ok,
      ms: args.ms,
      code: args.code,
      context: args.context,
      // Redacted AND truncated: a log line must never be a data-exfiltration
      // path, and must never be unbounded.
      error: args.error ? truncate(redact(args.error), 300) : undefined,
      prompt: args.prompt,
      createdAt: Date.now(),
    };
    return await ctx.db.insert("omiTelemetry", row);
  },
});

function truncate(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Roll-up for the diagnostics surface: success rate and latency per
 * subsystem, newest events included so a single failure is inspectable.
 */
export const summary = internalQuery({
  args: { sinceMs: v.optional(v.number()) },
  handler: async (ctx, { sinceMs }) => {
    const rows = await ctx.db
      .query("omiTelemetry")
      .withIndex("by_created", (q) => q.gte("createdAt", sinceMs ?? 0))
      .order("desc")
      .take(500);

    const bySubsystem = new Map<
      string,
      { total: number; failed: number; totalMs: number }
    >();
    for (const r of rows) {
      const e = bySubsystem.get(r.subsystem) ?? { total: 0, failed: 0, totalMs: 0 };
      e.total += 1;
      if (r.ok === false) e.failed += 1;
      if (typeof r.ms === "number") e.totalMs += r.ms;
      bySubsystem.set(r.subsystem, e);
    }
    return {
      total: rows.length,
      bySubsystem: [...bySubsystem.entries()].map(([subsystem, e]) => ({
        subsystem,
        total: e.total,
        failed: e.failed,
        successRate: e.total === 0 ? 100 : Math.round(((e.total - e.failed) / e.total) * 100),
        avgMs: e.total === 0 ? 0 : Math.round(e.totalMs / e.total),
      })),
      recent: rows.slice(0, 25),
    };
  },
});

/** The signed-in user's own recent telemetry — never another user's. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("omiTelemetry")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
  },
});
