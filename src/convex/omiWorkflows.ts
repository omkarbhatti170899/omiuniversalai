"use node";

/**
 * Phase 10 — Automation Engine (master plan §45/Phase 10).
 *
 * Flagship workflow: "Research this and prepare a report."
 *   Understand objective → Andromeda multi-source search → read top sources →
 *   grounded synthesis with citations → INDEPENDENT verification → save
 *   report as a knowledge document (source "omi").
 *
 * Everything composes EXISTING capabilities — the same engines Andromeda and
 * the Research view use (runUniversalSearch fans out to SearXNG/Wikipedia/
 * DuckDuckGo/etc.) — into one persistent run with per-step status, so a
 * failed run reports exactly where it stopped (§40). The pipeline runs even
 * when no AI provider is configured: synthesis degrades to the extractive
 * brief and verification reports "unverified" honestly (§35).
 */

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { rateLimit } from "./searchEngine/resilience";
import { runUniversalSearch, extractiveBrief } from "./universalSearch";
import { fetchPageText } from "./searchProviders/pageFetcher";
import {
  buildEvidencePack,
  synthesizeResearchAnswer,
  sourcesFooter,
} from "./searchEngine/evidence";
import { verifyResult } from "./verification";
import {
  freshSteps,
  setStep,
  stageOf,
  dedupeCitations,
  composeReport,
  type StepStatus,
} from "./workflows/plan";
import { planQuery } from "./andromeda/query";

const SUBQUERY_TIMEOUT_MS = 30_000;
const MAX_PAGES_READ = 6;

type Citation = {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  providers?: string[];
  relevance?: number;
  author?: string;
};

type StepRow = { label: string; status: string; detail?: string };

// --- Small helpers -----------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
        ms,
      ),
    ),
  ]);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function toStepRows(
  steps: Array<{ label: string; status: StepStatus; detail?: string }>,
): StepRow[] {
  return steps.map((s) => ({ label: s.label, status: s.status, detail: s.detail }));
}

// --- The workflow runner -----------------------------------------------------

export const startResearchReport = action({
  args: {
    topic: v.string(),
    focus: v.optional(v.string()),
  },
  handler: async (ctx, { topic, focus }): Promise<{ runId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to run workflows.");

    const rl = rateLimit(`workflow:${userId}`, 6);
    if (!rl.ok) {
      throw new Error(
        `Too many workflow runs — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    const trimmed = topic.trim().slice(0, 400);
    if (trimmed.length < 8) {
      throw new Error("Give the workflow a topic of at least 8 characters.");
    }

    const steps = freshSteps();

    // 1) Persist the run BEFORE any network work (auditable, resumable).
    const runId = await ctx.runMutation(internal.omiWorkflowStore.insertRun, {
      userId,
      title: trimmed.slice(0, 80),
      objective: trimmed,
      steps: steps.map((s) => ({ label: s.label, status: s.status })),
    });

    try {
      // --- Step 1: Understand objective (deterministic, no AI dependency)
      setStep(steps, 0, "done", "Objective set");
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      // --- Step 2: Andromeda multi-source search (parallel subqueries)
      setStep(steps, 1, "active");
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      const focused =
        focus && focus.trim().length > 0
          ? `${trimmed} ${focus.trim().slice(0, 120)}`
          : trimmed;
      // Chain depth: use Andromeda's query planner for subquery angles when
      // available (deterministic planner is pure and always available; the
      // AI planner is a bonus, not a dependency — §2).
      const plan = planQuery(focused);
      const queries = plan.subqueries.slice(0, 3);

      const batches = await Promise.allSettled(
        queries.map((q) =>
          withTimeout(
            runUniversalSearch(ctx, q, {
              perEngineLimit: 6,
              maxCitations: 8,
              skipCache: true, // reports must be fresh, not cached
            }),
            SUBQUERY_TIMEOUT_MS,
            `search "${q}"`,
          ).then((r) => r.citations),
        ),
      );
      const flat: Citation[] = [];
      for (const b of batches) {
        if (b.status === "fulfilled") flat.push(...b.value);
      }
      const citations = dedupeCitations(flat);

      if (citations.length === 0) {
        throw new Error(
          "No sources found for this topic. Omi will not fabricate a report.",
        );
      }

      setStep(
        steps,
        1,
        "done",
        `${citations.length} sources across ${new Set(citations.map((c) => safeHost(c.url))).size} domains`,
      );
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      // --- Step 3: Read top sources (fault-tolerant, capped)
      setStep(steps, 2, "active");
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      const pageTexts = new Map<string, string>();
      const readResults = await Promise.allSettled(
        citations.slice(0, MAX_PAGES_READ).map((c) => fetchPageText(c.url, 2500)),
      );
      for (const r of readResults) {
        if (r.status === "fulfilled" && r.value.ok) {
          pageTexts.set(r.value.url, r.value.text);
        }
      }
      const readCount = pageTexts.size;
      setStep(
        steps,
        2,
        "done",
        readCount > 0 ? `${readCount} page(s) read in text` : "Snippets only (pages unreadable)",
      );
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      // --- Step 4: Grounded synthesis (cite-or-keep-silent)
      setStep(steps, 3, "active");
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      const pack = buildEvidencePack(citations, {
        perSourceChars: 650,
        maxSources: 10,
        pageTexts,
      });
      const research = await synthesizeResearchAnswer(trimmed, pack);

      const answer =
        research?.answer ??
        `${extractiveBrief(trimmed, citations)}\n\n(Note: Omi's AI layer is unavailable — this is a source extract, not full synthesis.)`;
      const summary =
        research?.summary ??
        `${citations.length} sources across ${new Set(citations.map((c) => safeHost(c.url))).size} domains.`;
      const footer = sourcesFooter(pack);

      setStep(
        steps,
        3,
        "done",
        research ? "Synthesized with citation-checked claims" : "Extractive brief (no AI available)",
      );
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      // --- Step 5: Independent verification (Phase 7 agent, separate prompt path)
      setStep(steps, 4, "active");
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      const verification = await verifyResult(trimmed, answer, [
        `Evidence pack (${pack.items.length} sources):`,
        ...pack.items.map(
          (e) => `[${e.idx}] ${e.title} — ${e.domain}: ${e.excerpt.slice(0, 200)}`,
        ),
      ]);

      setStep(steps, 4, "done", `Verdict: ${verification.verdict}`);
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        stage: stageOf(steps),
      });

      // --- Step 6: Save the report deliverable (knowledge base, searchable)
      const report = composeReport(trimmed, answer, footer, verification);
      const documentId = await ctx.runMutation(
        internal.omiWorkflowStore.insertReportDocument,
        {
          userId,
          title: `Research report: ${trimmed.slice(0, 150)}`,
          content: report.slice(0, 60_000),
          wordCount: report.split(/\s+/).filter(Boolean).length,
        },
      );

      setStep(steps, 5, "done", "Report saved to knowledge");
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: toStepRows(steps),
        status: "done",
        stage: "Done",
        result: answer.slice(0, 8000),
        summary: summary.slice(0, 500),
        citations: pack.items.map((e) => ({
          title: e.title,
          url: e.url,
          snippet: e.excerpt.slice(0, 300),
        })),
        verification: verification.verdict,
        verificationNotes: verification.notes,
        documentId,
        completedAt: Date.now(),
      });

      return { runId };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failedSteps: StepRow[] = steps.map((s) => ({
        label: s.label,
        status: s.status === "active" ? "failed" : s.status,
        detail:
          s.status === "active" ? message.slice(0, 200) : s.detail,
      }));
      await ctx.runMutation(internal.omiWorkflowStore.updateRun, {
        runId,
        steps: failedSteps,
        status: "failed",
        stage: "Failed",
        error: message.slice(0, 400),
        completedAt: Date.now(),
      });
      throw new Error(message);
    }
  },
});
