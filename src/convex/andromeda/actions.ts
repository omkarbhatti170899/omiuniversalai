"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { rateLimit } from "../searchEngine/resilience";
import { runAndromeda } from "./orchestrator";
import { internal } from "../_generated/api";

/**
 * Public Andromeda pipeline entry for the workspace UI (master plan §4).
 * One natural-language research query in, the full audited pipeline out:
 * plan → retrieval (internal + web) → dedupe → gates → reading → grounded
 * synthesis → independent verification. Persisted to search history so the
 * answer and citations are reviewable/replayable.
 */
export const research = action({
  args: {
    query: v.string(),
    focus: v.optional(v.string()),
  },
  handler: async (ctx, { query, focus }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to use Andromeda Research.");

    const rl = rateLimit(`andromeda:${userId}`, 10);
    if (!rl.ok) {
      throw new Error(
        `Andromeda is rate-limited — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    const result = await runAndromeda(ctx, query, { focus, userId });
    if (!result.ok) {
      // Honest refusal surfaces in the UI with the pipeline's own reason.
      throw new Error(result.error ?? "Andromeda could not complete this research.");
    }

    // Persist like any other search so history/citations stay consistent.
    try {
      await ctx.runMutation(internal.searchHistory.saveSearch, {
        userId,
        query: result.query,
        answer: result.answer,
        citations: result.citations.map((c) => ({
          title: c.title,
          url: c.url,
          snippet: undefined,
        })),
        engine: `Andromeda pipeline (${result.citations.length} sources, ${result.plan.kind})`,
      });
    } catch {
      // History is observability, never the request path.
    }

    return {
      answer: result.answer,
      summary: result.summary,
      citations: result.citations,
      sourcesFooter: result.sourcesFooter,
      verification: result.verification,
      usedAi: result.usedAi,
      confidence: result.confidence,
      followUps: result.followUps,
      stages: result.stages,
      gates: {
        accepted: result.gates?.accepted.length ?? 0,
        rejected: result.gates?.rejected.length ?? 0,
        independentDomains: result.gates?.independentDomains ?? 0,
        warnings: result.gates?.warnings ?? [],
      },
      rawCount: result.rawCount,
      dedupedCount: result.dedupedCount,
      pagesRead: result.pagesRead,
      totalMs: result.totalMs,
    };
  },
});
