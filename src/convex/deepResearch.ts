"use node";

/**
 * Omi Deep Research (spec §9 / master §F).
 *
 * Flow: plan subqueries → search each (cache-aware) → read top pages →
 * synthesize with the Research Agent (strict grounding, conflicts,
 * unverified) → stop when enough evidence, never run away.
 *
 * Live progress: the run row in `researchRuns` is updated after each
 * phase so the UI can subscribe reactively. Only high-level stages are
 * exposed — never private chain-of-thought.
 */

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { runUniversalSearch, extractiveBrief } from "./universalSearch";
import { fetchPageText } from "./searchProviders/pageFetcher";
import { assertSafeUrl } from "./searchEngine/security";
import { rateLimit, withTimeout } from "./searchEngine/resilience";
import { decideSearch, detectScriptLanguage } from "./searchEngine/decision";
import {
  buildEvidencePack,
  synthesizeResearchAnswer,
  sourcesFooter,
} from "./searchEngine/evidence";
import type { WebCitation } from "./searchProviders/types";
import { complete } from "./aiProviders";

const MAX_SEARCHES = 4; // stop condition: hard cap
const MIN_EVIDENCE_FOR_EARLY_STOP = 12; // unique citations across searches
const MIN_SEARCHES_BEFORE_EARLY_STOP = 2;
const MAX_PAGES_READ = 4;
const SEARCH_TIMEOUT_MS = 60_000;

// --- Run tracking lives in deepResearchRuns.ts (pure-DB module) ------------
// getRun / listRuns (public queries) and createRun / updateRun (internal
// mutations) — split out because Convex mutations cannot run in Node files.

// --- Query planner -----------------------------------------------------------

/**
 * Plan subqueries. AI-assisted when the model is up; heuristic otherwise
 * (comparative queries split on "and"/"vs", plus targeted variants).
 * Always includes the original query first.
 */
export async function planSubqueries(query: string): Promise<string[]> {
  const fallback = () => {
    const base = [query];
    const comp = query.match(/(.+?)\s+(?:vs\.?|versus|and|compare(?:\s+with)?)\s+(.+)/i);
    if (comp) {
      base.push(comp[1].trim());
      base.push(comp[2].trim());
      base.push(`${comp[1].trim()} vs ${comp[2].trim()} comparison`);
    }
    if (/\b(limits?|pricing|free tier)\b/i.test(query)) {
      base.push(`${query} official documentation`);
    }
    const lang = detectScriptLanguage(query);
    if (lang) base.push(`${query} (${lang})`);
    return [...new Set(base)].slice(0, 4);
  };

  try {
    // Routed as a reasoning task — subquery planning benefits from the
    // strong model when one is available; heuristic fallback otherwise.
    const completion = await complete({
      task: "reasoning",
      messages: [
        {
          role: "system",
          content:
            "You are Omi's research planner. Break the user's question into 2-4 focused web-search subqueries that together fully answer it. Prefer official sources for pricing/limits. Return ONLY a JSON array of strings, no other text.",
        },
        { role: "user", content: query },
      ],
      temperature: 0.2,
      maxTokens: 250,
    });
    if (!completion.ok) return fallback();
    const raw = completion.content;
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end <= start) return fallback();
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return fallback();
    const subs = arr
      .filter((s): s is string => typeof s === "string" && s.trim().length > 1)
      .map((s) => s.trim().slice(0, 200));
    const planned = [query, ...subs.filter((s) => s !== query)];
    return [...new Set(planned)].slice(0, 4);
  } catch {
    return fallback();
  }
}

// --- The orchestrator --------------------------------------------------------

export const startDeepResearch = action({
  args: { query: v.string() },
  handler: async (ctx, { query }): Promise<{ runId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to use Deep Research.");

    const trimmed = query.trim().slice(0, 500);
    if (trimmed.length < 4) {
      throw new Error("Give Deep Research a real question to investigate.");
    }

    const rl = rateLimit(`research:${userId}`, 5);
    if (!rl.ok) {
      throw new Error(
        `Too many research runs — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    // 1) Plan
    const subqueries = await planSubqueries(trimmed);
    // Inferred as Id<"researchRuns"> — annotating it as `string` here broke
    // every subsequent updateRun call (Id is a branded type).
    const runId = await ctx.runMutation(internal.deepResearchRuns.createRun, {
      userId,
      query: trimmed,
      plan: subqueries,
    });

    await ctx.runMutation(internal.deepResearchRuns.updateRun, {
      runId,
      status: "searching",
      stage: "Searching sources",
      searchesDone: 0,
    });

    // 2) Search each subquery (stop condition inside the loop)
    const allCitations: WebCitation[] = [];
    const seen = new Set<string>();
    let searchesDone = 0;
    let stopReason = "search plan exhausted";

    for (const sub of subqueries) {
      if (searchesDone >= MAX_SEARCHES) {
        stopReason = `stop condition: search cap (${MAX_SEARCHES}) reached`;
        break;
      }
      let result;
      try {
        result = await withTimeout(
          runUniversalSearch(ctx, sub, {
            perEngineLimit: 6,
            maxCitations: 8,
            skipCache: true, // research must be fresh, not cached
          }),
          SEARCH_TIMEOUT_MS,
          `search "${sub}"`,
        );
      } catch {
        continue; // one failed subquery never kills the run
      }
      searchesDone += 1;
      for (const c of result.citations) {
        const key = c.url.replace(/\/+$/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        allCitations.push(c);
      }

      await ctx.runMutation(internal.deepResearchRuns.updateRun, {
        runId,
        searchesDone,
        stage: `Searched ${searchesDone}/${subqueries.length} — ${allCitations.length} sources so far`,
      });

      // Stop condition: enough independent evidence collected already.
      if (
        searchesDone >= MIN_SEARCHES_BEFORE_EARLY_STOP &&
        allCitations.length >= MIN_EVIDENCE_FOR_EARLY_STOP
      ) {
        stopReason = `stop condition: enough evidence (${allCitations.length} sources after ${searchesDone} searches)`;
        break;
      }
    }

    if (allCitations.length === 0) {
      await ctx.runMutation(internal.deepResearchRuns.updateRun, {
        runId,
        status: "failed",
        stage: "No sources found",
        error: "All searches returned no results. Omi will not fabricate an answer.",
        completedAt: Date.now(),
      });
      return { runId };
    }

    // 3) Read the most promising pages (tiered order already applied by rank)
    await ctx.runMutation(internal.deepResearchRuns.updateRun, {
      runId,
      status: "reading",
      stage: "Reading top sources",
    });

    const pageTexts = new Map<string, string>();
    let extractionFailures = 0;
    const readTargets = allCitations.slice(0, MAX_PAGES_READ);
    const readResults = await Promise.allSettled(
      readTargets.map((c) => fetchPageText(c.url, 2500)),
    );
    for (const r of readResults) {
      if (r.status === "fulfilled" && r.value.ok) {
        pageTexts.set(r.value.url, r.value.text);
      } else {
        extractionFailures += 1;
      }
    }

    // 4) Synthesize with the Research Agent (grounded, conflicts, unverified)
    await ctx.runMutation(internal.deepResearchRuns.updateRun, {
      runId,
      status: "synthesizing",
      stage: "Cross-checking and preparing answer",
    });

    const pack = buildEvidencePack(allCitations, {
      perSourceChars: 650,
      maxSources: 10,
      pageTexts,
    });
    const research = await synthesizeResearchAnswer(trimmed, pack);

    const answer =
      research?.answer ??
      `${extractiveBrief(trimmed, allCitations)}\n\n(Note: Omi's AI layer is unavailable — this is a source extract, not full synthesis.)`;
    const summary =
      research?.summary ??
      `${allCitations.length} sources across ${new Set(allCitations.map((c) => c.url.split("/")[2])).size} domains.`;
    const findings = research?.findings ?? [];
    const conflicts = research?.conflicts ?? [];
    const unverified = research?.unverified ?? [];
    const footer = sourcesFooter(pack);

    const finalAnswer = `${answer}\n\n${footer}${
      stopReason ? `\n\nResearch stopped after ${searchesDone} searches — ${stopReason}.` : ""
    }`;

    await ctx.runMutation(internal.deepResearchRuns.updateRun, {
      runId,
      status: "done",
      stage: "Done",
      answer: finalAnswer,
      summary,
      findings,
      conflicts,
      unverified,
      citations: pack.items.map((e) => ({
        title: e.title,
        url: e.url,
        snippet: e.excerpt.slice(0, 300),
      })),
      completedAt: Date.now(),
    });

    return { runId };
  },
});
