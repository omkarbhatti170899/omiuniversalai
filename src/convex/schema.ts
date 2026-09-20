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

    // Omi Assistant — conversations
    omiConversations: defineTable({
      userId: v.id("users"),
      title: v.string(),
    }).index("by_user", ["userId"]),

    // Omi Assistant — messages (reasoning = Omi's transparent "why this answer" summary)
    omiMessages: defineTable({
      userId: v.id("users"),
      conversationId: v.id("omiConversations"),
      role: v.union(v.literal("user"), v.literal("omi")),
      content: v.string(),
      reasoning: v.optional(v.string()),
    }).index("by_conversation", ["conversationId"]),

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

    // Audit trail — every agent action, newest first in queries
    omiAuditLog: defineTable({
      userId: v.id("users"),
      taskId: v.optional(v.id("omiTasks")),
      agentId: v.optional(v.id("omiAgents")),
      event: v.string(),
      detail: v.optional(v.string()),
    }).index("by_user", ["userId"]),

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
