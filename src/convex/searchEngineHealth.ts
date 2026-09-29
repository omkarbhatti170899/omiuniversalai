"use node";

import { internalAction } from "./_generated/server";
import { allProviderHealth } from "./searchEngine/providerHealth";
import {
  drainSearxEngineDeltas,
  searxEngineHealthSnapshot,
} from "./searchProviders/searxngEngineHealth";
import {
  describeSearxSelection,
  verifiedSearxngInstances,
} from "./searchProviders/searxng";
import { internal } from "./_generated/api";

/**
 * ENGINE HEALTH SNAPSHOT — the operator surface for "no single engine may
 * block Andromeda".
 *
 * Returns, per PROVIDER (searxng, langsearch, gdelt, sports-scores, …):
 *   calls, successes, timeouts, errors, availability, timeoutRate, errorRate,
 *   latencyP50/P95, avgResults, freshnessQuality (share dated), duplicateRate,
 *   relevanceAvg (mean final score of contributed citations), lastOkAt,
 *   lastError.
 *
 * And per SearXNG UPSTREAM ENGINE (google/duckduckgo/wikipedia inside the
 * instance): failures, suspended, lastError, lastOkAt — the instance's own
 * unresponsive_engines report, accumulated with suspension + automatic
 * recovery (cooldown expiry + first-success clear).
 *
 * SAFETY: counts, rates, latencies and booleans only — no keys, no queries,
 * no user data. Diagnostic use: `bunx convex run searchEngineHealth:snapshot '{}'`.
 */
export const snapshot = internalAction({
  args: {},
  handler: async (ctx) => {
    // PERSIST the engine deltas drained since the last snapshot, so per-engine
    // health survives isolate restarts (measured round 8: the isolate-local
    // registry read empty while production searches succeeded).
    let persistedEngines: Array<Record<string, unknown>> = [];
    const deltas = drainSearxEngineDeltas();
    if (deltas.size > 0) {
      try {
        await ctx.runMutation(internal.searchEnginePersistence.upsertFromDeltas, {
          deltas: [...deltas.entries()].map(([engine, d]) => ({ engine, ...d })),
        });
      } catch {
        /* best-effort: observability must never fail the diagnostic */
      }
    }
    try {
      persistedEngines = (await ctx.runQuery(
        internal.searchEnginePersistence.allEngineStats,
        {},
      )) as Array<Record<string, unknown>>;
    } catch {
      /* a cold deployment has no rows yet */
    }

    // EXPLICIT CONFIGURATION: which instance serves production, public or
    // self-hosted, how it was selected, and its last probe verdict — recorded
    // to the audit table so the answer never depends on who remembers the env.
    const selection = describeSearxSelection();
    try {
      await ctx.runMutation(internal.searchEnginePersistence.recordInstanceConfig, {
        rows: [
          ...(selection.configuredBase
            ? [
                {
                  base: selection.configuredBase,
                  origin: selection.origin ?? ("public" as const),
                  configured: true,
                  lastProbeHealthy: selection.lastProbe?.healthy ?? false,
                  lastProbeDetail: selection.lastProbe?.detail ?? "no probe recorded in this isolate",
                  lastProbedAt: selection.lastProbe?.checkedAt ?? 0,
                },
              ]
            : []),
          ...selection.verifiedInstances.map((b) => ({
            base: b,
            origin: "public" as const,
            configured: false,
            lastProbeHealthy: true,
            lastProbeDetail: "verified JSON fallback (probeSearxngCandidates)",
            lastProbedAt: Date.now(),
          })),
        ],
      });
    } catch {
      /* best-effort */
    }
    let instanceConfig: Array<Record<string, unknown>> = [];
    try {
      instanceConfig = (await ctx.runQuery(
        internal.searchEnginePersistence.instanceConfig,
        {},
      )) as Array<Record<string, unknown>>;
    } catch {
      /* cold deployment */
    }

    // Persisted aggregation over recent REAL traffic — survives isolate
    // restarts, unlike the in-memory windows below.
    let telemetryHealth: Array<Record<string, unknown>> = [];
    try {
      telemetryHealth = (await ctx.runQuery(internal.searchTelemetry.healthByEngine, {
        limit: 300,
      })) as Array<Record<string, unknown>>;
    } catch {
      /* best-effort: a cold deployment with no rows yields an empty map */
    }
    return {
      searxSelection: selection,
      searxInstanceConfig: instanceConfig,
      providers: allProviderHealth(),
      // Isolate-local view (what THIS isolate saw since it started).
      searxEngines: searxEngineHealthSnapshot(),
      // Persisted, merged view across isolates and restarts.
      searxEnginesPersisted: persistedEngines,
      searxVerifiedInstances: verifiedSearxngInstances(),
      telemetryHealth,
    };
  },
});
