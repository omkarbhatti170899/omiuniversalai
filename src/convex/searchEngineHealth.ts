"use node";

import { internalAction } from "./_generated/server";
import { allProviderHealth } from "./searchEngine/providerHealth";
import { searxEngineHealthSnapshot } from "./searchProviders/searxngEngineHealth";
import { verifiedSearxngInstances } from "./searchProviders/searxng";
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
      providers: allProviderHealth(),
      searxEngines: searxEngineHealthSnapshot(),
      searxVerifiedInstances: verifiedSearxngInstances(),
      telemetryHealth,
    };
  },
});
