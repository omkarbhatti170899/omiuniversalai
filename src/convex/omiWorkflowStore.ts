import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Persistence for the Automation Engine (Phase 10). Kept out of the
 * "use node" runner module: Convex mutations must not run in the Node
 * runtime — the runner action calls these via ctx.runMutation.
 */
export const insertRun = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    objective: v.string(),
    steps: v.array(v.object({ label: v.string(), status: v.string() })),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiWorkflows", {
      userId: args.userId,
      title: args.title,
      objective: args.objective,
      workflowType: "research_report",
      status: "running",
      stage: "Starting",
      steps: args.steps,
      createdAt: Date.now(),
    });
  },
});

export const updateRun = internalMutation({
  args: {
    runId: v.id("omiWorkflows"),
    steps: v.optional(
      v.array(
        v.object({
          label: v.string(),
          status: v.string(),
          detail: v.optional(v.string()),
        }),
      ),
    ),
    stage: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("running"),
        v.literal("awaiting_approval"),
        v.literal("done"),
        v.literal("rejected"),
        v.literal("failed"),
      ),
    ),
    result: v.optional(v.string()),
    summary: v.optional(v.string()),
    citations: v.optional(
      v.array(
        v.object({
          title: v.string(),
          url: v.string(),
          snippet: v.optional(v.string()),
        }),
      ),
    ),
    verification: v.optional(
      v.union(
        v.literal("pass"),
        v.literal("warnings"),
        v.literal("unverified"),
        v.literal("failed"),
      ),
    ),
    verificationNotes: v.optional(v.array(v.string())),
    // Phase 10 approval gate (composed in workflows/approval.ts)
    approval: v.optional(
      v.object({
        stepIndex: v.number(),
        reason: v.string(),
        requestedAt: v.number(),
        expiresAt: v.number(),
        decision: v.optional(
          v.union(v.literal("approved"), v.literal("rejected")),
        ),
        decidedAt: v.optional(v.number()),
        decisionNote: v.optional(v.string()),
      }),
    ),
    approvalReport: v.optional(v.string()),
    documentId: v.optional(v.id("omiDocuments")),
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { runId, ...patch } = args;
    await ctx.db.patch(runId, patch);
  },
});

/**
 * Report deliverable insert — a document WITHOUT an uploaded blob (unlike
 * omiFiles.createFileDocument, which requires a storage id).
 */
export const insertReportDocument = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    content: v.string(),
    wordCount: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiDocuments", {
      userId: args.userId,
      title: args.title,
      content: args.content,
      source: "omi",
      fileType: "report",
      fileSize: args.content.length,
      wordCount: args.wordCount,
      createdAt: Date.now(),
    });
  },
});
