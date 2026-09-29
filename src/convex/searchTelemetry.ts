import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Observability (spec §24): one row per search/research/URL run.
 * Never stores secrets — only timings, engine names, and counts.
 */

export const write = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    query: v.string(),
    mode: v.string(),
    engines: v.array(v.string()),
    failedEngines: v.array(v.string()),
    resultCount: v.number(),
    cacheHit: v.boolean(),
    searchMs: v.number(),
    aiMs: v.optional(v.number()),
    pagesFetched: v.optional(v.number()),
    extractionFailures: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, row) => {
    await ctx.db.insert("searchTelemetry", {
      ...row,
      query: row.query.slice(0, 300),
      error: row.error?.slice(0, 300),
      createdAt: Date.now(),
    });
  },
});

/** Recent rows for the admin/debug view. No secrets — timings and names only. */
export const recent = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return ctx.db
      .query("searchTelemetry")
      .withIndex("by_created", (q) => q.gte("createdAt", 0))
      .order("desc")
      .take(Math.min(limit ?? 50, 100));
  },
});

/**
 * PERSISTED ENGINE HEALTH — per-engine aggregation over recent real traffic.
 *
 * WHY: the in-memory provider-health window (searchEngine/providerHealth.ts)
 * lives per isolate, so a cold diagnostic isolate sees nothing while real
 * chat-path history sits unused. This query makes the operator surface
 * (`searchEngineHealth:snapshot`) reflect ACTUAL traffic: calls, failures,
 * latency and result counts per engine from the searchTelemetry table —
 * counts and timings only, never query text or user data.
 */
export const healthByEngine = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("searchTelemetry")
      .withIndex("by_created", (q) => q.gte("createdAt", 0))
      .order("desc")
      .take(Math.min(limit ?? 200, 500));
    const byEngine = new Map<
      string,
      { engine: string; calls: number; failures: number; totalMs: number; totalResults: number; lastError: string | null; lastOkAt: number | null; lastSeenAt: number }
    >();
    for (const row of rows) {
      const failed = row.failedEngines.length > 0;
      const engines = row.engines.length > 0 ? row.engines : ["(fan-out)"];
      for (const engine of engines) {
        const e = byEngine.get(engine) ?? {
          engine,
          calls: 0,
          failures: 0,
          totalMs: 0,
          totalResults: 0,
          lastError: null as string | null,
          lastOkAt: null as number | null,
          lastSeenAt: 0,
        };
        e.calls += 1;
        e.failures += failed ? 1 : 0;
        e.totalMs += row.searchMs;
        e.totalResults += row.resultCount;
        e.lastSeenAt = Math.max(e.lastSeenAt, row.createdAt);
        if (failed) e.lastError = row.failedEngines[0] ?? null;
        else e.lastOkAt = Math.max(e.lastOkAt ?? 0, row.createdAt);
        byEngine.set(engine, e);
      }
    }
    return [...byEngine.values()].map((e) => ({
      engine: e.engine,
      calls: e.calls,
      failures: e.failures,
      errorRate: e.calls > 0 ? Math.round((e.failures / e.calls) * 100) / 100 : 0,
      latencyAvgMs: e.calls > 0 ? Math.round(e.totalMs / e.calls) : 0,
      avgResults: e.calls > 0 ? Math.round((e.totalResults / e.calls) * 10) / 10 : 0,
      lastError: e.lastError,
      lastOkAt: e.lastOkAt,
      lastSeenAt: e.lastSeenAt,
    }));
  },
});
