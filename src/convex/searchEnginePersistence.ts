import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * SEARXNG HEALTH PERSISTENCE — the DB side of the engine-health mirror.
 *
 * The in-memory engine registry (searchProviders/searxngEngineHealth.ts) is per
 * server isolate, which left the operator snapshot reading EMPTY while real
 * searches succeeded through SearXNG (measured round 8). These mutations MERGE
 * drained deltas into `searxEngineStats` — one row per engine, counters
 * accumulated, latency window and timestamps replaced with the newest view —
 * so health survives isolate restarts. Counts and timings only; no queries,
 * no user data.
 */

export const upsertFromDeltas = internalMutation({
  args: {
    deltas: v.array(
      v.object({
        engine: v.string(),
        successes: v.number(),
        totalFailures: v.number(),
        timeouts: v.number(),
        latencySamples: v.array(v.number()),
        resultsContributed: v.number(),
        datedResults: v.number(),
        lastError: v.union(v.string(), v.null()),
        lastOkAt: v.union(v.number(), v.null()),
        lastFailAt: v.union(v.number(), v.null()),
        suspendedUntil: v.union(v.number(), v.null()),
      }),
    ),
  },
  handler: async (ctx, { deltas }) => {
    const now = Date.now();
    for (const d of deltas) {
      const existing = await ctx.db
        .query("searxEngineStats")
        .withIndex("by_engine", (q) => q.eq("engine", d.engine))
        .unique();
      if (!existing) {
        // Trim the FIRST window to the bounded size the registry uses.
        const window = [...d.latencySamples].slice(-10);
        await ctx.db.insert("searxEngineStats", {
          engine: d.engine,
          successes: d.successes,
          totalFailures: d.totalFailures,
          timeouts: d.timeouts,
          latencySumMs: window.reduce((a, b) => a + b, 0),
          latencySamples: window,
          resultsContributed: d.resultsContributed,
          datedResults: d.datedResults,
          suspendedUntil: d.suspendedUntil ?? undefined,
          lastError: d.lastError ?? undefined,
          lastOkAt: d.lastOkAt ?? undefined,
          lastFailAt: d.lastFailAt ?? undefined,
          updatedAt: now,
        });
        continue;
      }
      // MERGE: accumulate counters, keep the NEWEST latency window (replacing
      // rather than appending prevents unbounded growth and double-counting).
      const mergedWindow = [...d.latencySamples];
      while (mergedWindow.length < 10 && existing.latencySamples.length > 0) {
        // Backfill from the tail of the stored window to keep the p50 honest.
        mergedWindow.unshift(existing.latencySamples.pop() as number);
      }
      const latencySumMs = mergedWindow.reduce((a, b) => a + b, 0);
      await ctx.db.patch(existing._id, {
        successes: existing.successes + d.successes,
        totalFailures: existing.totalFailures + d.totalFailures,
        timeouts: existing.timeouts + d.timeouts,
        latencySumMs,
        latencySamples: mergedWindow,
        resultsContributed: existing.resultsContributed + d.resultsContributed,
        datedResults: existing.datedResults + d.datedResults,
        suspendedUntil: d.suspendedUntil ?? undefined,
        lastError: d.lastError ?? existing.lastError,
        lastOkAt: d.lastOkAt ?? existing.lastOkAt,
        lastFailAt: d.lastFailAt ?? existing.lastFailAt,
        updatedAt: now,
      });
    }
  },
});

/** Read-side: all persisted engine rows, worst first. */
export const allEngineStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("searxEngineStats").collect();
    return rows
      .map((r) => {
        const sorted = [...r.latencySamples].sort((a, b) => a - b);
        const attempts = r.successes + r.totalFailures;
        return {
          engine: r.engine,
          successes: r.successes,
          failures: r.totalFailures,
          successRate: attempts > 0 ? Math.round((r.successes / attempts) * 100) / 100 : 0,
          timeoutRate: attempts > 0 ? Math.round((r.timeouts / attempts) * 100) / 100 : 0,
          latencyP50Ms: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null,
          avgResults:
            r.successes > 0 ? Math.round((r.resultsContributed / r.successes) * 10) / 10 : null,
          freshnessShare:
            r.resultsContributed > 0
              ? Math.round((r.datedResults / r.resultsContributed) * 100) / 100
              : null,
          suspended: typeof r.suspendedUntil === "number" && r.suspendedUntil > Date.now(),
          lastError: r.lastError ?? null,
          lastOkAt: r.lastOkAt ?? null,
          lastFailAt: r.lastFailAt ?? null,
          updatedAt: r.updatedAt,
        };
      })
      .sort(
        (a, b) =>
          Number(b.suspended) - Number(a.suspended) || b.failures - a.failures,
      );
  },
});

/**
 * CONFIG AUDIT upsert — one row per configured/probed base stating EXPLICITLY
 * where SearXNG comes from: self-hosted vs public, configured or measured
 * fallback, last probe verdict and time. The operator surface reads this
 * instead of asking humans to remember env vars.
 */
export const recordInstanceConfig = internalMutation({
  args: {
    rows: v.array(
      v.object({
        base: v.string(),
        origin: v.union(v.literal("self-hosted"), v.literal("public")),
        configured: v.boolean(),
        lastProbeHealthy: v.boolean(),
        lastProbeDetail: v.string(),
        lastProbedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    const now = Date.now();
    for (const r of rows) {
      const existing = await ctx.db
        .query("searxInstanceConfig")
        .withIndex("by_base", (q) => q.eq("base", r.base))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { ...r, updatedAt: now });
      } else {
        await ctx.db.insert("searxInstanceConfig", { ...r, updatedAt: now });
      }
    }
  },
});

/** Read-side: explicit instance configuration as last recorded. */
export const instanceConfig = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("searxInstanceConfig").collect();
  },
});
