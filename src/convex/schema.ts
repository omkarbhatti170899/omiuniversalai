import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // Human Emotions AI — one analysis record per run, scoped to the signed-in user
    emotionAnalyses: defineTable({
      userId: v.id("users"),
      text: v.string(),
      emotion: v.string(),
      confidence: v.number(), // 0..1
      rantScore: v.optional(v.number()),
      rantInterpretation: v.optional(v.string()),
      sentiment: v.optional(v.string()),
      sentimentScore: v.optional(v.number()),
      urgency: v.optional(v.string()),
      urgencyScore: v.optional(v.number()),
      signalFields: v.optional(v.string()),
      advice: v.optional(v.string()),
      omiNote: v.optional(v.string()),
      // "ai" | "heuristic" — how the read was produced (honesty in the history list).
      source: v.optional(v.string()),
    }).index("by_user", ["userId"]),

    // Omi Search — saved web searches with Omi's cited answer
    webSearches: defineTable({
      userId: v.id("users"),
      query: v.string(),
      answer: v.string(),
      citations: v.array(
        v.object({
          title: v.string(),
          url: v.string(),
          snippet: v.optional(v.string()),
          imageUrl: v.optional(v.string()),
          publishedAt: v.optional(v.string()),
          // Andromeda provenance (spec §8/§29): which sources surfaced it.
          providers: v.optional(v.array(v.string())),
          author: v.optional(v.string()),
        }),
      ),
      engine: v.optional(v.string()),
    }).index("by_user", ["userId"]),

    // Omi Search — result cache shared across users (zero-cost layer:
    // identical queries within the TTL skip the engines entirely)
    searchCache: defineTable({
      cacheKey: v.string(), // fingerprint of query + options
      query: v.string(),
      citations: v.array(
        v.object({
          title: v.string(),
          url: v.string(),
          snippet: v.optional(v.string()),
          imageUrl: v.optional(v.string()),
          publishedAt: v.optional(v.string()),
          providers: v.optional(v.array(v.string())),
          author: v.optional(v.string()),
        }),
      ),
      engine: v.string(),
      createdAt: v.number(),
    }).index("by_cache_key", ["cacheKey"]),

    // Omi Search — retrieved-page cache (evidence store, zero-cost)
    pageCache: defineTable({
      urlKey: v.string(),
      url: v.string(),
      title: v.string(),
      text: v.string(),
      fetchedAt: v.number(),
    }).index("by_url_key", ["urlKey"]),

    // Omi Search — observability (one row per search/research/url run)
    searchTelemetry: defineTable({
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
      createdAt: v.number(),
    }).index("by_created", ["createdAt"]),

    // Omi Deep Research — one run, live progress for the UI
    researchRuns: defineTable({
      userId: v.id("users"),
      query: v.string(),
      status: v.union(
        v.literal("planning"),
        v.literal("searching"),
        v.literal("reading"),
        v.literal("synthesizing"),
        v.literal("done"),
        v.literal("failed"),
      ),
      stage: v.optional(v.string()),
      plan: v.optional(v.array(v.string())),
      searchesDone: v.optional(v.number()),
      answer: v.optional(v.string()),
      summary: v.optional(v.string()),
      findings: v.optional(v.array(v.string())),
      conflicts: v.optional(v.array(v.string())),
      unverified: v.optional(v.array(v.string())),
      citations: v.optional(
        v.array(
          v.object({
            title: v.string(),
            url: v.string(),
            snippet: v.optional(v.string()),
          }),
        ),
      ),
      error: v.optional(v.string()),
      createdAt: v.number(),
      completedAt: v.optional(v.number()),
    }).index("by_user", ["userId"]),

    // §12 Settings — one row per user (defaults documented in omiSettings.ts).
    // Only preferences live here: never a key, token or credential.
    omiSettings: defineTable({
      userId: v.id("users"),
      providerPreference: v.optional(v.string()),
      memoryEnabled: v.optional(v.boolean()),
      alwaysSearch: v.optional(v.boolean()),
      autoSpeak: v.optional(v.boolean()),
      voiceLang: v.optional(v.string()),
      imageAspectRatio: v.optional(v.string()),
      reduceMotion: v.optional(v.boolean()),
      /** Human Emotions AI: read tone automatically each turn and adapt replies. */
      emotionAware: v.optional(v.boolean()),
      /** Explicit opt-in (default OFF): also keep auto read-outs in the history. */
      emotionHistory: v.optional(v.boolean()),
    }).index("by_user", ["userId"]),

    // Omi Assistant — conversations
    omiConversations: defineTable({
      userId: v.id("users"),
      title: v.string(),
      // §5 Projects: optional parent project. Unset = personal/global chat
      // (pre-Projects conversations keep working unchanged — no migration).
      projectId: v.optional(v.id("omiProjects")),
      // §10 Stop generation: set by the Stop button while a turn is running.
      // The chat action checks it at stage boundaries and finalizes honestly
      // with whatever it had — an in-flight provider HTTP call cannot be
      // interrupted, so this is a cooperative cancel, not a fake one.
      stopRequestedAt: v.optional(v.number()),
    }).index("by_user", ["userId"]),

    // Omi Assistant — messages (reasoning = Omi's transparent "why this answer" summary)
    omiMessages: defineTable({
      userId: v.id("users"),
      conversationId: v.id("omiConversations"),
      role: v.union(v.literal("user"), v.literal("omi")),
      content: v.string(),
      reasoning: v.optional(v.string()),
      // Progressive responses (§40): "streaming" messages update in place as
      // pipeline stages complete, then are patched to "final". Legacy rows
      // (no status) render as final — backward compatible.
      status: v.optional(
        v.union(v.literal("streaming"), v.literal("final")),
      ),
      // Image Studio in chat: images Omi generated/edited for THIS reply.
      // Ownership is guaranteed server-side (the action that saved them is
      // the same one that attaches them), so the gallery query is the only
      // read path and it is per-user.
      images: v.optional(v.array(v.id("omiImages"))),
      // Phase 4 (multimodal): files/images attached to this message by its
      // author — ownership-checked before persisting. Images carry their
      // original blob; documents carry extracted text in omiDocuments.
      attachments: v.optional(
        v.array(
          v.object({
            documentId: v.id("omiDocuments"),
            title: v.string(),
            kind: v.union(v.literal("image"), v.literal("file")),
          }),
        ),
      ),
    })
      .index("by_conversation", ["conversationId"])
      // §10 "search conversations": message-content search, scoped to the
      // searcher's own messages via the userId filter field, so one user's
      // search can never surface another user's text.
      .searchIndex("search_content", {
        searchField: "content",
        filterFields: ["userId"],
      }),

    // Omi persistent memory — user-controlled (view/edit/delete in the UI)
    omiMemories: defineTable({
      userId: v.id("users"),
      content: v.string(),
      source: v.union(v.literal("user"), v.literal("omi")),
    }).index("by_user", ["userId"]),

    // Omi Knowledge — Phase 3 local knowledge base. Documents live in Convex
    // (zero cost) and retrieval is keyword-scored locally — no vector DB or
    // paid embedding API is required. A FAISS/OpenSearch backend can replace
    // the scorer later without changing call sites.
    omiDocuments: defineTable({
      userId: v.id("users"),
      title: v.string(),
      content: v.string(),
      source: v.union(v.literal("user"), v.literal("omi")),
      wordCount: v.number(),
      createdAt: v.number(),
      // Phase 4 (multimodal): documents ingested from uploaded files keep a
      // reference to the original blob in Convex file storage (zero cost).
      fileId: v.optional(v.id("_storage")),
      fileType: v.optional(v.string()),
      fileSize: v.optional(v.number()),
      // §5 Projects: documents can belong to a project's context. Unset =
      // personal knowledge, visible in every project (backward compatible).
      projectId: v.optional(v.id("omiProjects")),
    }).index("by_user", ["userId"]),

    // §5 Projects — the container that scopes conversations, files, research
    // and instructions. Project context never mixes across projects.
    omiProjects: defineTable({
      userId: v.id("users"),
      name: v.string(),
      // Standing instructions for Omi inside THIS project only (§5).
      instructions: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    // Omi Agents — specialized agents owned by the user
    omiAgents: defineTable({
      userId: v.id("users"),
      name: v.string(),
      description: v.string(),
      specialty: v.string(), // e.g. research, analysis, operations, writing
    }).index("by_user", ["userId"]),

    // Omi agent tasks — one execution run assigned to an agent
    omiTasks: defineTable({
      userId: v.id("users"),
      agentId: v.id("omiAgents"),
      objective: v.string(),
      status: v.union(
        v.literal("awaiting_approval"),
        v.literal("running"),
        v.literal("needs_input"),
        v.literal("done"),
        v.literal("failed"),
      ),
      plan: v.optional(v.array(v.string())), // planned steps
      result: v.optional(v.string()), // final summary when done
      error: v.optional(v.string()),
      // Phase 7 — Verification Intelligence: independent check of the result
      // against the step outputs before it is shown as final.
      verification: v.optional(
        v.union(v.literal("pass"), v.literal("warnings"), v.literal("unverified"), v.literal("failed")),
      ),
      verificationNotes: v.optional(v.array(v.string())),
    }).index("by_user", ["userId"]).index("by_agent", ["agentId"]),

    // Individual step outputs of a task run
    omiTaskSteps: defineTable({
      userId: v.id("users"),
      taskId: v.id("omiTasks"),
      index: v.number(),
      description: v.string(),
      output: v.optional(v.string()),
    }).index("by_task", ["taskId"]),

    // Human-in-the-loop approval requests raised by the runtime
    omiApprovals: defineTable({
      userId: v.id("users"),
      taskId: v.id("omiTasks"),
      action: v.string(),
      reason: v.string(),
      status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
    }).index("by_task", ["taskId"]),

    // Phase 10 — Automation Engine: persistent, resumable workflow runs.
    // Workflows chain Omi capabilities (Andromeda retrieval → page reading →
    // grounded synthesis → verification → deliverable) with per-step status,
    // so a failed/timeouted run reports exactly where it stopped (§40).
    omiWorkflows: defineTable({
      userId: v.id("users"),
      title: v.string(),
      objective: v.string(),
      workflowType: v.literal("research_report"), // more types plug in later
      status: v.union(
        v.literal("running"),
        v.literal("awaiting_approval"),
        v.literal("done"),
        v.literal("rejected"),
        v.literal("failed"),
      ),
      stage: v.optional(v.string()), // human-readable progress
      steps: v.optional(
        v.array(
          v.object({
            label: v.string(),
            // Statuses are code-controlled (workflows/plan.ts); kept a plain
            // string in the validator so legacy runs can be patched freely.
            status: v.string(),
            detail: v.optional(v.string()),
          }),
        ),
      ),
      // Deliverable: saved into omiDocuments (source: "omi") so the report
      // joins the knowledge base and stays searchable/quotable.
      documentId: v.optional(v.id("omiDocuments")),
      result: v.optional(v.string()),
      summary: v.optional(v.string()),
      // Phase 10 approval gate: populated while status = awaiting_approval.
      // approvalReport holds the FULL composed report (capped 60k) so the
      // user approves the exact artifact that would be saved — never a
      // promise to compose one later (§35 no-fake-features).
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
      citations: v.optional(
        v.array(v.object({ title: v.string(), url: v.string(), snippet: v.optional(v.string()) })),
      ),
      verification: v.optional(
        v.union(v.literal("pass"), v.literal("warnings"), v.literal("unverified"), v.literal("failed")),
      ),
      verificationNotes: v.optional(v.array(v.string())),
      error: v.optional(v.string()),
      createdAt: v.number(),
      completedAt: v.optional(v.number()),
    }).index("by_user", ["userId"]),

    // Audit trail — every agent action, newest first in queries
    omiAuditLog: defineTable({
      userId: v.id("users"),
      taskId: v.optional(v.id("omiTasks")),
      agentId: v.optional(v.id("omiAgents")),
      event: v.string(),
      detail: v.optional(v.string()),
    }).index("by_user", ["userId"]),

    // Image Studio — one row per generated/edited image. Private per user.
    // `parentId` links multi-turn edit chains; `sourceImageIds` lists the
    // input image(s) an edit/variation/combine op was derived from, so a
    // user can revisit the full lineage in the gallery.
    omiImages: defineTable({
      userId: v.id("users"),
      op: v.union(
        v.literal("generate"),
        v.literal("edit"),
        v.literal("remove"),
        v.literal("replace"),
        v.literal("background"),
        v.literal("style"),
        v.literal("upscale"),
        v.literal("variation"),
        v.literal("combine"),
      ),
      prompt: v.string(),
      fileId: v.id("_storage"), // generated image blob (private storage)
      provider: v.string(),
      model: v.string(),
      width: v.number(),
      height: v.number(),
      transparent: v.optional(v.boolean()),
      parentId: v.optional(v.id("omiImages")),
      sourceImageIds: v.optional(v.array(v.id("omiImages"))),
      // Conversation the image was produced in — enables multi-turn editing
      // ("now make it bluer" finds the previous image without a re-upload).
      conversationId: v.optional(v.id("omiConversations")),
      createdAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_conversation", ["conversationId"]),

    // OMI Tool Registry — every tool execution for observability + the
    // Phase 11 self-improvement loop (what ran, with what, and whether it
    // succeeded). Args are summarized, never stored raw with secrets.
    omiToolRuns: defineTable({
      userId: v.id("users"),
      taskId: v.optional(v.id("omiTasks")),
      agentId: v.optional(v.id("omiAgents")),
      tool: v.string(),
      argsSummary: v.optional(v.string()),
      ok: v.boolean(),
      output: v.optional(v.string()),
      error: v.optional(v.string()),
      durationMs: v.number(),
    }).index("by_user", ["userId"]).index("by_task", ["taskId"]),

    // add other tables here

    // tableName: defineTable({
    //   ...
    //   // table fields
    // }).index("by_field", ["field"])
  },
  {
    schemaValidation: false,
  },
);

export default schema;
