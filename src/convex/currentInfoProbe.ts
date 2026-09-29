import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  probeCurrentInfo,
  probeCurrentInfoSuite,
  CURRENT_INFO_SCENARIOS,
} from "./omiSelfTest";

/**
 * CLI-runnable wrappers around the current-information probes.
 *
 * WHY THIS EXISTS: `/currentinfo` is served by the Convex HTTP router, which
 * has been flapping to a platform-paused state even while internal actions
 * execute normally. These internal actions run the SAME functions
 * (`probeCurrentInfo` / `probeCurrentInfoSuite` — the mirrors of the real chat
 * turn) through the action runner, so live validation does not depend on the
 * HTTP surface. They are `internalAction`: no client can invoke them; they are
 * an operator diagnostic, not an API.
 */

/** One query through the real pipeline. Mirrors the /currentinfo?query= route. */
export const runOne = internalAction({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const row = await probeCurrentInfo(ctx, query);
    return { row };
  },
});

/** The full 10-scenario suite. Mirrors the /currentinfo route. */
export const runSuite = internalAction({
  args: {},
  handler: async (ctx) => {
    const suite = await probeCurrentInfoSuite(ctx);
    return {
      scenarios: CURRENT_INFO_SCENARIOS.length,
      total: suite.total,
      passed: suite.passed,
      failed: suite.failed,
      rows: suite.rows,
      cached: suite.cached,
    };
  },
});

/** Self-test row for one query including what Omi would actually say. */
export const runOneWithAnswer = internalAction({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const row = await probeCurrentInfo(ctx, query);
    return {
      query: row.query,
      status: row.status,
      detail: row.detail,
      userMessage: row.userMessage ?? row.answer ?? "",
      sources: row.sources,
      enginesTried: row.enginesTried,
      enginesWithResults: row.enginesWithResults,
      failedEngines: row.failedEngines,
      resultsFound: row.resultsFound,
      freshResults: row.freshResults,
      freshness: row.freshness,
      searchMs: row.searchMs,
      escalated: (row as { escalated?: boolean }).escalated ?? false,
    };
  },
});

// Referenced so the import stays meaningful for the suite wrapper.
void internal;
