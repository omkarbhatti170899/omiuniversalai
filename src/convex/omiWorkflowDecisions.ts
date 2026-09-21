import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { decide, type ApprovalGate } from "./workflows/approval";

/**
 * Phase 10 — human approval decisions on gated workflow runs (§11).
 *
 * APPROVE: the exact artifact the user previewed (approvalReport, capped 60k
 * at gate-build time) is saved to their knowledge base — nothing more, nothing
 * less. REJECT: nothing is written; the run ends `rejected` and the preview
 * stays visible for the record. Both paths re-run the pure gate machine, so
 * expiry/idempotence rules live in ONE tested place.
 */

async function loadOwnedRun(ctx: MutationCtx, runId: Id<"omiWorkflows">) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Sign in to manage workflows.");
  const run = await ctx.db.get(runId);
  if (!run || run.userId !== userId) throw new Error("Not your workflow run.");
  return { userId, run };
}

export const approve = mutation({
  args: {
    runId: v.id("omiWorkflows"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { runId, note }) => {
    const { userId, run } = await loadOwnedRun(ctx, runId);
    if (run.status !== "awaiting_approval" || !run.approval) {
      throw new Error("This run is not awaiting approval.");
    }

    const outcome = decide(run.approval as ApprovalGate, "approved", Date.now(), note);
    if (!outcome.ok) throw new Error(outcome.message);

    // Save EXACTLY the approved artifact (already capped by the gate).
    const report = run.approvalReport ?? "";
    const documentId = await ctx.db.insert("omiDocuments", {
      userId,
      title: run.title.startsWith("Research report:")
        ? run.title
        : `Research report: ${run.title.slice(0, 140)}`,
      content: report,
      source: "omi",
      fileType: "report",
      fileSize: report.length,
      wordCount: report.split(/\s+/).filter(Boolean).length,
      createdAt: Date.now(),
    });

    const stepIndex = (run.approval as ApprovalGate).stepIndex;
    const steps = (run.steps ?? []).map((s, i) =>
      i === stepIndex
        ? { ...s, status: "done", detail: "Approved by you — saved to knowledge" }
        : s,
    );

    await ctx.db.patch(runId, {
      status: "done",
      stage: "Done",
      steps,
      approval: outcome.gate,
      documentId,
      completedAt: Date.now(),
    });
    return { ok: true as const, documentId };
  },
});

export const reject = mutation({
  args: {
    runId: v.id("omiWorkflows"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { runId, note }) => {
    const { run } = await loadOwnedRun(ctx, runId);
    if (run.status !== "awaiting_approval" || !run.approval) {
      throw new Error("This run is not awaiting approval.");
    }

    const outcome = decide(run.approval as ApprovalGate, "rejected", Date.now(), note);
    if (!outcome.ok) throw new Error(outcome.message);

    const stepIndex = (run.approval as ApprovalGate).stepIndex;
    const steps = (run.steps ?? []).map((s, i) =>
      i === stepIndex
        ? { ...s, status: "failed", detail: "Rejected by you — report not saved" }
        : s,
    );

    await ctx.db.patch(runId, {
      status: "rejected",
      stage: "Rejected",
      steps,
      approval: outcome.gate,
      completedAt: Date.now(),
    });
    return { ok: true as const };
  },
});
