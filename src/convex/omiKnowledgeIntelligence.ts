import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { retrieve } from "./searchEngine/retrieval";
import { sanitizeUntrustedText } from "./searchEngine/security";
import {
  canManageKnowledge,
  canPublish,
  canTransition,
  changedFields,
  isAuthoritative,
  nextVersion,
  rolesForUser,
  type KnowledgeRole,
  type KnowledgeStatus,
} from "./knowledgeEngine/governance";
import {
  filterByMetadata,
  filterVisible,
  selectEffectiveVersions,
  type ArticleLike,
  type MetadataFilter,
} from "./knowledgeEngine/select";
import {
  buildActionPlan,
  normalizeQuestionKey,
  type ActionPlan,
  type KnowledgePassage,
} from "./knowledgeEngine/grounding";
import { critiqueKnowledge, countBySeverity, SEVERITY_ORDER, type CriticFlag } from "./knowledgeEngine/critic";
import { summarizeKnowledge } from "./knowledgeEngine/analytics";
import { mergeHybrid, type SemanticallyRanked } from "./knowledgeEngine/embedding";
import { filterByTenant, isInTenant, resolveTenantId } from "./knowledgeEngine/tenant";
import { compareVersions, type VersionComparison } from "./knowledgeEngine/diff";
import { buildArtifact, isArtifactKind, type ArtifactKind } from "./knowledgeEngine/artifact";
import { embedOne, embedTexts, hasEmbeddingProvider } from "./aiProviders/embeddings";

// --- helpers ----------------------------------------------------------------

function toArticleLike(a: Doc<"omiKnowledgeArticles">): ArticleLike {
  return {
    _id: a._id,
    familyId: a.familyId,
    title: a.title,
    content: a.content,
    status: a.status,
    version: a.version,
    effectiveDate: a.effectiveDate,
    expirationDate: a.expirationDate,
    reviewDate: a.reviewDate,
    audience: a.audience,
    category: a.category,
    product: a.product,
    department: a.department,
    region: a.region,
    tags: a.tags,
    sourceType: a.sourceType,
    projectId: a.projectId,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

async function viewerRoles(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<KnowledgeRole[]> {
  const user = await ctx.db.get(userId);
  return rolesForUser(user?.role);
}

/** The tenant a viewer's knowledge operations are scoped to (never empty). */
async function viewerTenant(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const memberships = await ctx.db
    .query("omiTenantMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(20);
  return resolveTenantId(
    memberships.map((m) => ({ tenantId: m.tenantId, userId: m.userId })),
    userId,
  );
}

async function requireManager(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const roles = await viewerRoles(ctx, userId);
  if (!canManageKnowledge(roles)) {
    throw new Error("Only knowledge managers can approve, publish or archive articles.");
  }
}

/**
 * Ownership + TENANT checked article read. Every mutation goes through this,
 * so a foreign id fails exactly as a missing id does and leaks nothing about
 * its existence (§2/§18).
 */
async function owned(
  ctx: MutationCtx | QueryCtx,
  userId: Id<"users">,
  id: Id<"omiKnowledgeArticles">,
): Promise<Doc<"omiKnowledgeArticles">> {
  const doc = await ctx.db.get(id);
  if (!doc || doc.userId !== userId) throw new Error("Not your knowledge article.");
  const tenant = await viewerTenant(ctx, userId);
  if (!isInTenant(doc, tenant)) throw new Error("Not your knowledge article.");
  return doc;
}

async function recordRevision(
  ctx: MutationCtx,
  doc: Doc<"omiKnowledgeArticles">,
  changed: string[],
  note?: string,
) {
  await ctx.db.insert("omiKnowledgeRevisions", {
    userId: doc.userId,
    tenantId: doc.tenantId,
    articleId: doc._id,
    familyId: doc.familyId,
    version: doc.version,
    status: doc.status,
    title: doc.title,
    content: doc.content.slice(0, 4000),
    changedFields: changed,
    note,
    at: Date.now(),
  });
}

/**
 * Shared retrieval: tenant → visibility → metadata → version-selected →
 * keyword (BM25) + semantic (embeddings) MERGED and re-ranked. The semantic
 * half is skipped entirely when there is no query vector, so a deployment with
 * no embedding provider behaves exactly as before.
 */
async function retrievePassages(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  question: string,
  filters?: MetadataFilter,
  limit = 6,
  queryVector?: number[],
): Promise<{ passages: KnowledgePassage[]; roles: KnowledgeRole[]; tenantId: string }> {
  const roles = await viewerRoles(ctx, userId);
  const tenantId = await viewerTenant(ctx, userId);
  const all = await ctx.db
    .query("omiKnowledgeArticles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(300);

  // Tenant isolation FIRST — before visibility, filters or ranking.
  let candidates = filterByTenant(
    all.map((doc) => ({ ...toArticleLike(doc), tenantId: doc.tenantId })),
    tenantId,
  );
  candidates = filterVisible(candidates, roles);
  if (filters) candidates = filterByMetadata(candidates, filters);
  const effective = selectEffectiveVersions(candidates, Date.now());

  const docs = effective.map((a) => ({ _id: a._id, title: a.title, content: a.content }));
  const keyword = retrieve(question, docs, Math.max(limit * 2, 8), "hybrid");

  // Semantic half — only when the caller supplied a query vector and the
  // candidate articles actually have stored embeddings.
  let ranking: typeof keyword = keyword;
  if (queryVector && queryVector.length > 0) {
    const byId = new Map(all.map((d) => [d._id.toString(), d] as const));
    const semanticDocs = effective.map((a) => ({
      id: a._id,
      vector: byId.get(a._id.toString())?.embedding,
    }));
    const semantic: SemanticallyRanked[] = [];
    for (const d of semanticDocs) {
      if (!d.vector || d.vector.length === 0) continue;
      // cosine, clamped at 0 — reused from the pure engine via mergeHybrid's
      // input contract (score is only used for the semantic-only floor).
      const v = d.vector;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < Math.min(v.length, queryVector.length); i++) {
        dot += v[i] * queryVector[i];
        na += v[i] * v[i];
        nb += queryVector[i] * queryVector[i];
      }
      const cos = na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
      semantic.push({ id: d.id, score: Math.max(0, cos) });
    }
    semantic.sort((a, b) => b.score - a.score);
    if (semantic.length > 0) {
      const keywordRanked: SemanticallyRanked[] = keyword.map((k) => ({
        id: k.documentId,
        score: k.score,
      }));
      const fused = mergeHybrid(keywordRanked, semantic, { limit: limit * 2 });
      const byKeyword = new Map(keyword.map((k) => [k.documentId, k]));
      ranking = fused
        .map((f) => {
          const k = byKeyword.get(f.id);
          if (k) return { ...k, score: f.score };
          const a = effective.find((x) => x._id === f.id);
          return a
            ? {
                documentId: a._id,
                title: a.title,
                snippet: a.content.slice(0, 400),
                score: f.score,
              }
            : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, limit);
    }
  } else {
    ranking = keyword.slice(0, limit);
  }

  const passages: KnowledgePassage[] = ranking.map((r) => {
    const a = effective.find((x) => x._id === r.documentId)!;
    return {
      articleId: a._id,
      familyId: a.familyId,
      title: a.title,
      version: a.version,
      status: a.status,
      effectiveDate: a.effectiveDate,
      sourceType: a.sourceType,
      snippet: r.snippet,
      content: a.content,
      score: r.score,
    };
  });
  return { passages, roles, tenantId };
}

// --- internal (used by chat + the action) -----------------------------------

export const retrieveInternal = internalQuery({
  args: {
    userId: v.id("users"),
    question: v.string(),
    limit: v.optional(v.number()),
    category: v.optional(v.string()),
    product: v.optional(v.string()),
    region: v.optional(v.string()),
    department: v.optional(v.string()),
    tag: v.optional(v.string()),
    /** Optional query embedding for semantic hybrid retrieval. */
    queryVector: v.optional(v.array(v.number())),
  },
  handler: async (ctx, { userId, question, limit, queryVector, ...filters }) => {
    const { passages } = await retrievePassages(
      ctx,
      userId,
      question,
      filters,
      limit ?? 6,
      queryVector,
    );
    return { passages };
  },
});

export const logQueryInternal = internalMutation({
  args: {
    userId: v.id("users"),
    tenantId: v.optional(v.string()),
    query: v.string(),
    answered: v.boolean(),
    topArticleId: v.optional(v.id("omiKnowledgeArticles")),
    latencyMs: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("omiKnowledgeQueryLog", {
      ...args,
      query: args.query.slice(0, 500),
      createdAt: Date.now(),
    });
  },
});

/** Upsert a knowledge gap (shared by the action and feedback paths). */
async function upsertGap(
  ctx: MutationCtx,
  userId: Id<"users">,
  question: string,
  projectId?: Id<"omiProjects">,
): Promise<Id<"omiKnowledgeGaps">> {
  const key = normalizeQuestionKey(question);
  const tenantId = await viewerTenant(ctx, userId);
  const existing = await ctx.db
    .query("omiKnowledgeGaps")
    .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
    .first();
  const now = Date.now();
  if (existing && isInTenant(existing, tenantId)) {
    await ctx.db.patch(existing._id, {
      count: existing.count + 1,
      lastSeenAt: now,
      question:
        existing.question.length >= question.length
          ? existing.question
          : question.slice(0, 200),
    });
    return existing._id;
  }
  return await ctx.db.insert("omiKnowledgeGaps", {
    userId,
    tenantId,
    key,
    question: question.slice(0, 200),
    count: 1,
    suggestedTitle: suggestTitle(question),
    status: "open",
    projectId,
    firstSeenAt: now,
    lastSeenAt: now,
  });
}

export const recordGapInternal = internalMutation({
  args: {
    userId: v.id("users"),
    question: v.string(),
    projectId: v.optional(v.id("omiProjects")),
  },
  handler: async (ctx, { userId, question, projectId }) =>
    upsertGap(ctx, userId, question, projectId),
});

function suggestTitle(question: string): string {
  const clean = question.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "");
  const short = clean.charAt(0).toUpperCase() + clean.slice(1);
  return `${short.slice(0, 80)} — Guide`;
}

/** Structured provenance for the "Why this answer?" panel (§8). */
export type WhyThisAnswer = {
  sources: Array<{
    articleId: string;
    title: string;
    version: number;
    status: string;
    sourceType: "internal" | "external";
    effectiveDate?: number;
    score: number;
  }>;
  conflicts: string[];
  /** True when the evidence met the confidence floor. */
  grounded: boolean;
  /** Which retrieval layer actually contributed. */
  retrieval: "hybrid" | "keyword";
};

export type AskResult = {
  answer: ActionPlan;
  why: WhyThisAnswer;
};

/** Embed one article into its stored vector (internal action, best-effort). */
export const embedArticleInternal = internalAction({
  args: { articleId: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { articleId }) => {
    const doc = await ctx.runQuery(internal.omiKnowledgeIntelligence.getArticleInternal, {
      id: articleId,
    });
    if (!doc) return { ok: false, reason: "missing" };
    const text = `${doc.title}\n${doc.content}`;
    const embedded = await embedTexts([text]);
    if (!embedded) return { ok: false, reason: "no-embedding-provider" };
    await ctx.runMutation(internal.omiKnowledgeIntelligence.setEmbeddingInternal, {
      articleId,
      vector: embedded.vectors[0],
      model: `${embedded.provider}:${embedded.model}`,
    });
    return { ok: true, model: embedded.model };
  },
});

export const getArticleInternal = internalQuery({
  args: { id: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const setEmbeddingInternal = internalMutation({
  args: {
    articleId: v.id("omiKnowledgeArticles"),
    vector: v.array(v.number()),
    model: v.string(),
  },
  handler: async (ctx, { articleId, vector, model }) => {
    await ctx.db.patch(articleId, {
      embedding: vector,
      embeddingModel: model,
      embeddedAt: Date.now(),
    });
  },
});

/** Chat integration: grounded internal answer, gap + query logged. */
export const askInternal = internalAction({
  args: {
    userId: v.id("users"),
    question: v.string(),
    projectId: v.optional(v.id("omiProjects")),
    limit: v.optional(v.number()),
    /** Knowledge-only mode refuses external research upstream; the flag only
     * affects wording here, so it stays an optional hint. */
    knowledgeOnly: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { userId, question, projectId, limit },
  ): Promise<AskResult> => {
    // Semantic half: embed the question when a provider exists. A null here is
    // normal and silent — retrieval falls back to BM25 keyword search.
    const embedded = await embedOne(question);
    const queryVector = embedded?.vectors[0];

    const { passages } = await ctx.runQuery(
      internal.omiKnowledgeIntelligence.retrieveInternal,
      { userId, question, limit: limit ?? 4, queryVector },
    );
    const answer = buildActionPlan(question, passages);
    if (!answer.answered) {
      await ctx.runMutation(internal.omiKnowledgeIntelligence.recordGapInternal, {
        userId,
        question,
        projectId,
      });
    }
    const why: WhyThisAnswer = {
      sources: passages.slice(0, 4).map((p: KnowledgePassage) => ({
        articleId: p.articleId,
        title: p.title,
        version: p.version,
        status: p.status,
        sourceType: p.sourceType,
        effectiveDate: p.effectiveDate,
        score: p.score,
      })),
      conflicts: answer.conflicts,
      grounded: answer.answered,
      retrieval: queryVector ? "hybrid" : "keyword",
    };
    return { answer, why };
  },
});

// --- tenants ----------------------------------------------------------------

export const createTenant = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const clean = name.trim().slice(0, 80);
    if (clean.length < 2) throw new Error("Give the organization a name.");
    const tenantId = `org:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await ctx.db.insert("omiTenants", {
      name: clean,
      ownerUserId: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("omiTenantMembers", {
      tenantId,
      userId,
      role: "knowledge_manager",
      createdAt: Date.now(),
    });
    return tenantId;
  },
});

export const listTenants = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const members = await ctx.db
      .query("omiTenantMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);
    const out: Array<{ tenantId: string; role: string; name: string }> = [];
    for (const m of members) {
      const tenant = await ctx.db
        .query("omiTenants")
        .withIndex("by_owner", (q) => q.eq("ownerUserId", userId))
        .first();
      out.push({ tenantId: m.tenantId, role: m.role, name: tenant?.name ?? m.tenantId });
    }
    return out;
  },
});

// --- public queries ---------------------------------------------------------

/** Articles visible to the caller (managers also see drafts/in-review). */
export const listArticles = query({
  args: {
    query: v.optional(v.string()),
    status: v.optional(v.string()),
    category: v.optional(v.string()),
    product: v.optional(v.string()),
    region: v.optional(v.string()),
    department: v.optional(v.string()),
    tag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const roles = await viewerRoles(ctx, userId);
    const manager = canManageKnowledge(roles);
    const tenantId = await viewerTenant(ctx, userId);

    const all = await ctx.db
      .query("omiKnowledgeArticles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(300);

    let rows = filterByTenant(all, tenantId);
    rows = rows.filter((a) => (manager ? true : isAuthoritative(a.status)));
    if (args.status) rows = rows.filter((a) => a.status === args.status);
    rows = rows.filter(
      (a) =>
        (!args.category || (a.category ?? "").toLowerCase() === args.category.toLowerCase()) &&
        (!args.product || (a.product ?? "").toLowerCase() === args.product.toLowerCase()) &&
        (!args.region || (a.region ?? "").toLowerCase() === args.region.toLowerCase()) &&
        (!args.department || (a.department ?? "").toLowerCase() === args.department.toLowerCase()) &&
        (!args.tag || (a.tags ?? []).some((t) => t.toLowerCase() === args.tag!.toLowerCase())),
    );
    if (args.query && args.query.trim().length > 0) {
      const needle = args.query.trim().toLowerCase();
      rows = rows.filter(
        (a) =>
          a.title.toLowerCase().includes(needle) ||
          a.content.toLowerCase().includes(needle) ||
          (a.tags ?? []).some((t) => t.toLowerCase().includes(needle)),
      );
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const getArticle = query({
  args: { id: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const doc = await ctx.db.get(id);
    if (!doc || doc.userId !== userId) return null;
    const tenantId = await viewerTenant(ctx, userId);
    if (!isInTenant(doc, tenantId)) return null;
    const roles = await viewerRoles(ctx, userId);
    if (!canManageKnowledge(roles) && !isAuthoritative(doc.status)) return null;
    return doc;
  },
});

export const history = query({
  args: { articleId: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { articleId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const doc = await ctx.db.get(articleId);
    if (!doc || doc.userId !== userId) return [];
    const tenantId = await viewerTenant(ctx, userId);
    if (!isInTenant(doc, tenantId)) return [];
    return await ctx.db
      .query("omiKnowledgeRevisions")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .order("desc")
      .take(50);
  },
});

/**
 * §9 "What changed?" — compare two versions of the same family. Both ids must
 * belong to the caller's tenant and family, so an unauthorized version can
 * never be diffed (or even confirmed to exist).
 */
export const compareVersionsQuery = query({
  args: {
    beforeId: v.id("omiKnowledgeArticles"),
    afterId: v.id("omiKnowledgeArticles"),
  },
  handler: async (ctx, { beforeId, afterId }): Promise<VersionComparison | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const roles = await viewerRoles(ctx, userId);
    const manager = canManageKnowledge(roles);
    const tenantId = await viewerTenant(ctx, userId);

    const [before, after] = await Promise.all([
      ctx.db.get(beforeId),
      ctx.db.get(afterId),
    ]);
    if (!before || !after) return null;
    if (before.userId !== userId || after.userId !== userId) return null;
    if (!isInTenant(before, tenantId) || !isInTenant(after, tenantId)) return null;
    if (before.familyId !== after.familyId) return null;
    // Non-managers may only diff authoritative versions.
    if (!manager && !(isAuthoritative(before.status) && isAuthoritative(after.status))) {
      return null;
    }
    return compareVersions(
      {
        ...before,
        version: before.version,
        effectiveDate: before.effectiveDate,
        content: before.content,
      },
      {
        ...after,
        version: after.version,
        effectiveDate: after.effectiveDate,
        content: after.content,
      },
    );
  },
});

export const listGaps = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const tenantId = await viewerTenant(ctx, userId);
    const rows = await ctx.db
      .query("omiKnowledgeGaps")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);
    return filterByTenant(rows, tenantId);
  },
});

export const listFeedback = query({
  args: { articleId: v.optional(v.id("omiKnowledgeArticles")) },
  handler: async (ctx, { articleId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const tenantId = await viewerTenant(ctx, userId);
    if (articleId) {
      const doc = await ctx.db.get(articleId);
      if (!doc || doc.userId !== userId || !isInTenant(doc, tenantId)) return [];
      const rows = await ctx.db
        .query("omiKnowledgeFeedback")
        .withIndex("by_article", (q) => q.eq("articleId", articleId))
        .order("desc")
        .take(50);
      return filterByTenant(rows, tenantId);
    }
    const rows = await ctx.db
      .query("omiKnowledgeFeedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
    return filterByTenant(rows, tenantId);
  },
});

/** Persisted critic findings, optionally filtered by severity. */
export const listFindings = query({
  args: {
    severity: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const tenantId = await viewerTenant(ctx, userId);
    const rows = await ctx.db
      .query("omiKnowledgeCriticFindings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(300);
    return filterByTenant(rows, tenantId).filter(
      (f) =>
        (!args.severity || f.severity === args.severity) &&
        (!args.status || f.status === args.status),
    );
  },
});

/**
 * The admin dashboard: counts, critic flags, review queue. Falls back to a
 * live critique when the scheduled sweep has not run yet, so the panel is
 * never empty just because the cron hasn't fired.
 */
export const dashboard = query({
  args: {
    category: v.optional(v.string()),
    status: v.optional(v.string()),
    severity: v.optional(v.string()),
    owner: v.optional(v.string()),
    /** Only articles updated at/after this timestamp (§4 date filter). */
    updatedSince: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const roles = await viewerRoles(ctx, userId);
    const tenantId = await viewerTenant(ctx, userId);

    const [allArticles, allGaps, allFeedback, logs, persisted] = await Promise.all([
      ctx.db
        .query("omiKnowledgeArticles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(300),
      ctx.db
        .query("omiKnowledgeGaps")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(200),
      ctx.db
        .query("omiKnowledgeFeedback")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(200),
      ctx.db
        .query("omiKnowledgeQueryLog")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .order("desc")
        .take(300),
      ctx.db
        .query("omiKnowledgeCriticFindings")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(300),
    ]);

    // Tenant filter on every collection before any aggregation.
    let articles = filterByTenant(allArticles, tenantId);
    const gaps = filterByTenant(allGaps, tenantId);
    const feedback = filterByTenant(allFeedback, tenantId);
    const tenantLogs = filterByTenant(logs, tenantId);
    const findings = filterByTenant(persisted, tenantId);

    // Dashboard filters (§4).
    if (args.status) articles = articles.filter((a) => a.status === args.status);
    if (args.category) {
      articles = articles.filter(
        (a) => (a.category ?? "").toLowerCase() === args.category!.toLowerCase(),
      );
    }
    if (args.owner) {
      articles = articles.filter(
        (a) => (a.owner ?? "").toLowerCase() === args.owner!.toLowerCase(),
      );
    }
    if (args.updatedSince !== undefined) {
      articles = articles.filter((a) => a.updatedAt >= args.updatedSince!);
    }
    const now = Date.now();
    const likes = articles.map(toArticleLike);
    const analytics = summarizeKnowledge({
      articles: likes,
      gaps,
      feedback,
      logs: tenantLogs,
      now,
    });
    const liveFlags: CriticFlag[] = critiqueKnowledge({ articles: likes, gaps, now });
    const severityFiltered = args.severity
      ? findings.filter((f) => f.severity === args.severity)
      : findings;

    return {
      manager: canManageKnowledge(roles),
      embeddingProviderConfigured: hasEmbeddingProvider(),
      analytics,
      flags: liveFlags,
      flagCounts: countBySeverity(liveFlags),
      persistedFindings: severityFiltered.sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]) -
          SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]),
      ),
      reviewQueue: articles
        .filter((a) => a.status === "in_review" || a.status === "approved")
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, 50),
      gaps: gaps.slice().sort((a, b) => b.count - a.count).slice(0, 50),
    };
  },
});

export const listArtifacts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const tenantId = await viewerTenant(ctx, userId);
    const rows = await ctx.db
      .query("omiKnowledgeArtifacts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
    return filterByTenant(rows, tenantId);
  },
});

// --- public actions ---------------------------------------------------------

/**
 * Answer a question from approved knowledge, or log a gap. The question is
 * embedded (when a provider exists) so retrieval is hybrid; the response
 * carries structured provenance for the "Why this answer?" panel.
 */
export const ask = action({
  args: {
    question: v.string(),
    limit: v.optional(v.number()),
    knowledgeOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { question, limit, knowledgeOnly }): Promise<AskResult> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to ask knowledge.");
    const q = question.trim().slice(0, 500);
    if (q.length < 2) throw new Error("Ask a question first.");
    const started = Date.now();
    const result = await ctx.runAction(
      internal.omiKnowledgeIntelligence.askInternal,
      { userId, question: q, limit: limit ?? 4, knowledgeOnly },
    );
    await ctx.runMutation(internal.omiKnowledgeIntelligence.logQueryInternal, {
      userId,
      query: q,
      answered: result.answer.answered,
      topArticleId: result.why.sources[0]?.articleId as Id<"omiKnowledgeArticles"> | undefined,
      latencyMs: Date.now() - started,
    });
    return result;
  },
});

/**
 * §5 — turn a knowledge answer into a Procedure / Checklist / SOP / Training
 * guide / Report. The plan is REBUILT server-side from current approved
 * knowledge, so a client can never fabricate an artifact's contents, and the
 * attribution is always the live article.
 */
export const saveArtifact = action({
  args: {
    question: v.string(),
    kind: v.string(),
    projectId: v.optional(v.id("omiProjects")),
  },
  handler: async (ctx, { question, kind, projectId }): Promise<{ id: Id<"omiKnowledgeArtifacts">; markdown: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to save a knowledge artifact.");
    const q = question.trim().slice(0, 500);
    if (q.length < 2) throw new Error("Ask a question first.");
    if (!isArtifactKind(kind)) throw new Error("Unknown artifact type.");
    const { answer } = await ctx.runAction(
      internal.omiKnowledgeIntelligence.askInternal,
      { userId, question: q, limit: 4 },
    );
    const markdown = buildArtifact(answer, kind as ArtifactKind);
    const title = answer.source
      ? `${kind}: ${answer.source.title}`
      : `${kind}: ${q.slice(0, 60)}`;
    const id = await ctx.runMutation(
      internal.omiKnowledgeIntelligence.insertArtifactInternal,
      {
        userId,
        kind,
        title,
        markdown,
        articleId: answer.source?.articleId as Id<"omiKnowledgeArticles"> | undefined,
        articleTitle: answer.source?.title,
        version: answer.source?.version,
        question: q,
        projectId,
      },
    );
    return { id, markdown };
  },
});

export const insertArtifactInternal = internalMutation({
  args: {
    userId: v.id("users"),
    kind: v.string(),
    title: v.string(),
    markdown: v.string(),
    articleId: v.optional(v.id("omiKnowledgeArticles")),
    articleTitle: v.optional(v.string()),
    version: v.optional(v.number()),
    question: v.optional(v.string()),
    projectId: v.optional(v.id("omiProjects")),
  },
  handler: async (ctx, args) => {
    const tenantId = await viewerTenant(ctx, args.userId);
    return await ctx.db.insert("omiKnowledgeArtifacts", {
      ...args,
      tenantId,
      createdAt: Date.now(),
    });
  },
});

export const removeArtifact = mutation({
  args: { id: v.id("omiKnowledgeArtifacts") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const doc = await ctx.db.get(id);
    if (!doc || doc.userId !== userId) throw new Error("Not your artifact.");
    const tenantId = await viewerTenant(ctx, userId);
    if (!isInTenant(doc, tenantId)) throw new Error("Not your artifact.");
    await ctx.db.delete(id);
  },
});

// --- scheduled critic (§3) --------------------------------------------------

/** Rebuild the persisted finding set for one tenant. Flags only — never edits. */
export const runCriticInternal = internalAction({
  args: { userId: v.id("users") },
  handler: async (
    ctx,
    { userId },
  ): Promise<{ ok: boolean; count?: number }> => {
    const data = await ctx.runQuery(
      internal.omiKnowledgeIntelligence.criticInputsInternal,
      { userId },
    );
    if (!data) return { ok: false };
    const flags = critiqueKnowledge({
      articles: data.articles,
      gaps: data.gaps,
      now: Date.now(),
    });
    await ctx.runMutation(
      internal.omiKnowledgeIntelligence.replaceFindingsInternal,
      {
        userId,
        // The critic stays storage-agnostic (`articleId: string`); the id is
        // narrowed here, at the one boundary that persists it.
        flags: flags.map((f) => ({
          ...f,
          articleId: f.articleId as Id<"omiKnowledgeArticles"> | undefined,
        })),
      },
    );
    return { ok: true, count: flags.length };
  },
});

export const criticInputsInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const tenantId = await viewerTenant(ctx, userId);
    const [articles, gaps] = await Promise.all([
      ctx.db
        .query("omiKnowledgeArticles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(300),
      ctx.db
        .query("omiKnowledgeGaps")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(200),
    ]);
    return {
      articles: filterByTenant(articles, tenantId).map(toArticleLike),
      gaps: filterByTenant(gaps, tenantId).map((g) => ({
        key: g.key,
        question: g.question,
        count: g.count,
        status: g.status,
      })),
    };
  },
});

export const replaceFindingsInternal = internalMutation({
  args: {
    userId: v.id("users"),
    flags: v.array(
      v.object({
        code: v.string(),
        severity: v.union(
          v.literal("critical"),
          v.literal("high"),
          v.literal("medium"),
          v.literal("low"),
        ),
        message: v.string(),
        articleId: v.optional(v.id("omiKnowledgeArticles")),
        familyId: v.optional(v.string()),
        gapKey: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { userId, flags }) => {
    const tenantId = await viewerTenant(ctx, userId);
    // Replace only OPEN findings — acknowledged/resolved history is retained.
    const existing = await ctx.db
      .query("omiKnowledgeCriticFindings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(300);
    const now = Date.now();
    for (const f of existing) {
      if (isInTenant(f, tenantId) && f.status === "open") {
        await ctx.db.delete(f._id);
      }
    }
    for (const flag of flags) {
      await ctx.db.insert("omiKnowledgeCriticFindings", {
        userId,
        tenantId,
        code: flag.code,
        severity: flag.severity,
        message: flag.message,
        articleId: flag.articleId as Id<"omiKnowledgeArticles"> | undefined,
        familyId: flag.familyId,
        gapKey: flag.gapKey,
        status: "open",
        detectedAt: now,
      });
    }
  },
});

export const setFindingStatus = mutation({
  args: {
    id: v.id("omiKnowledgeCriticFindings"),
    status: v.union(
      v.literal("acknowledged"),
      v.literal("resolved"),
      v.literal("open"),
    ),
  },
  handler: async (ctx, { id, status }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    await requireManager(ctx, userId);
    const doc = await ctx.db.get(id);
    if (!doc || doc.userId !== userId) throw new Error("Finding not found.");
    const tenantId = await viewerTenant(ctx, userId);
    if (!isInTenant(doc, tenantId)) throw new Error("Finding not found.");
    await ctx.db.patch(id, { status });
  },
});

/** On-demand sweep (the UI "Run critic now" button). */
export const runCriticNow = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; count?: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const result = await ctx.runAction(
      internal.omiKnowledgeIntelligence.runCriticInternal,
      { userId },
    );
    return result as { ok: boolean; count?: number };
  },
});

/**
 * Daily sweep across every users table row. Best-effort: one user's failure
 * never stops the rest, and the action only FLAGS.
 */
export const sweepAllUsersInternal = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ ok: number; failed: number; total: number }> => {
    const ids: Id<"users">[] = await ctx.runQuery(
      internal.omiKnowledgeIntelligence.allUserIdsInternal,
      {},
    );
    let ok = 0;
    let failed = 0;
    for (const userId of ids) {
      try {
        await ctx.runAction(internal.omiKnowledgeIntelligence.runCriticInternal, {
          userId,
        });
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed, total: ids.length };
  },
});

export const allUserIdsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").take(1000);
    return users.map((u) => u._id);
  },
});

// --- public mutations -------------------------------------------------------

export const createDraft = mutation({
  args: {
    title: v.string(),
    content: v.string(),
    category: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    product: v.optional(v.string()),
    department: v.optional(v.string()),
    region: v.optional(v.string()),
    owner: v.optional(v.string()),
    audience: v.optional(v.array(v.string())),
    effectiveDate: v.optional(v.number()),
    reviewDate: v.optional(v.number()),
    expirationDate: v.optional(v.number()),
    sourceType: v.optional(v.union(v.literal("internal"), v.literal("external"))),
    sourceRef: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const title = args.title.trim().slice(0, 200);
    const content = sanitizeUntrustedText(args.content.trim().slice(0, 40_000), 40_000);
    if (title.length < 2) throw new Error("Give the article a title.");
    if (content.length < 20) throw new Error("Add at least a sentence of content.");

    const tenantId = await viewerTenant(ctx, userId);
    const now = Date.now();
    const familyId = `fam_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const id = await ctx.db.insert("omiKnowledgeArticles", {
      userId,
      tenantId,
      familyId,
      title,
      content,
      category: args.category?.trim().slice(0, 80),
      tags: args.tags?.map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20),
      product: args.product?.trim().slice(0, 80),
      department: args.department?.trim().slice(0, 80),
      region: args.region?.trim().slice(0, 80),
      owner: args.owner?.trim().slice(0, 120),
      status: "draft",
      version: 1,
      effectiveDate: args.effectiveDate,
      reviewDate: args.reviewDate,
      expirationDate: args.expirationDate,
      sourceType: args.sourceType ?? "internal",
      sourceRef: args.sourceRef?.slice(0, 300),
      audience: args.audience?.slice(0, 10),
      createdAt: now,
      updatedAt: now,
    });
    const doc = (await ctx.db.get(id))!;
    await recordRevision(ctx, doc, ["created"], "Draft created");
    return id;
  },
});

const EDITABLE: KnowledgeStatus[] = ["draft", "in_review"];

export const updateArticle = mutation({
  args: {
    id: v.id("omiKnowledgeArticles"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    category: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    product: v.optional(v.string()),
    department: v.optional(v.string()),
    region: v.optional(v.string()),
    owner: v.optional(v.string()),
    audience: v.optional(v.array(v.string())),
    effectiveDate: v.optional(v.number()),
    reviewDate: v.optional(v.number()),
    expirationDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const doc = await owned(ctx, userId, args.id);
    if (!EDITABLE.includes(doc.status)) {
      throw new Error(
        "Published or archived knowledge is immutable — create a new version instead.",
      );
    }
    const before = { ...doc } as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title.trim().slice(0, 200);
    if (args.content !== undefined) {
      const clean = sanitizeUntrustedText(args.content.trim().slice(0, 40_000), 40_000);
      if (clean.length < 20) throw new Error("Add at least a sentence of content.");
      patch.content = clean;
    }
    if (args.category !== undefined) patch.category = args.category.trim().slice(0, 80);
    if (args.tags !== undefined)
      patch.tags = args.tags.map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20);
    if (args.product !== undefined) patch.product = args.product.trim().slice(0, 80);
    if (args.department !== undefined) patch.department = args.department.trim().slice(0, 80);
    if (args.region !== undefined) patch.region = args.region.trim().slice(0, 80);
    if (args.owner !== undefined) patch.owner = args.owner.trim().slice(0, 120);
    if (args.audience !== undefined) patch.audience = args.audience.slice(0, 10);
    if (args.effectiveDate !== undefined) patch.effectiveDate = args.effectiveDate;
    if (args.reviewDate !== undefined) patch.reviewDate = args.reviewDate;
    if (args.expirationDate !== undefined) patch.expirationDate = args.expirationDate;
    patch.updatedAt = Date.now();

    const changed = changedFields(before, { ...before, ...patch });
    if (changed.length === 0) return doc._id;
    await ctx.db.patch(doc._id, patch);
    const after = (await ctx.db.get(doc._id))!;
    await recordRevision(ctx, after, changed);
    return doc._id;
  },
});

/** Generic status transition with governance + role enforcement. */
async function transition(
  ctx: MutationCtx,
  userId: Id<"users">,
  id: Id<"omiKnowledgeArticles">,
  to: KnowledgeStatus,
  opts: { managerOnly?: boolean; note?: string } = {},
): Promise<void> {
  const doc = await owned(ctx, userId, id);
  if (opts.managerOnly) await requireManager(ctx, userId);
  if (!canTransition(doc.status, to)) {
    throw new Error(`Cannot move an article from ${doc.status} to ${to}.`);
  }
  const now = Date.now();
  const patch: Record<string, unknown> = { status: to, updatedAt: now };
  if (to === "published") {
    if (!canPublish(doc.status)) {
      throw new Error("An article must be approved before it can be published.");
    }
    // Version bump against the family's highest existing version.
    const family = await ctx.db
      .query("omiKnowledgeArticles")
      .withIndex("by_family", (q) => q.eq("familyId", doc.familyId))
      .take(50);
    const maxVersion = family.reduce((m, a) => Math.max(m, a.version), 0);
    patch.version = Math.max(nextVersion(maxVersion), doc.version);
    patch.publishedAt = now;
    if (doc.effectiveDate === undefined) patch.effectiveDate = now;
    patch.approvedBy = doc.approvedBy ?? "knowledge_manager";
    // Retire older published versions in the same family.
    for (const other of family) {
      if (other._id !== doc._id && other.status === "published") {
        await ctx.db.patch(other._id, { status: "expired", updatedAt: now });
      }
    }
  }
  await ctx.db.patch(doc._id, patch);
  const after = (await ctx.db.get(doc._id))!;
  await recordRevision(ctx, after, ["status", "version"], opts.note ?? `Status → ${to}`);
  // Publish is the moment knowledge becomes authoritative — embed it then (and
  // on re-open) so the semantic index tracks what users can actually retrieve.
  if (to === "published" || to === "approved") {
    await ctx.scheduler.runAfter(0, internal.omiKnowledgeIntelligence.embedArticleInternal, {
      articleId: doc._id,
    });
  }
}

export const submitForReview = mutation({
  args: { id: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    await transition(ctx, userId, id, "in_review");
  },
});

export const approve = mutation({
  args: { id: v.id("omiKnowledgeArticles"), note: v.optional(v.string()) },
  handler: async (ctx, { id, note }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    await transition(ctx, userId, id, "approved", { managerOnly: true, note });
  },
});

export const publish = mutation({
  args: { id: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    await transition(ctx, userId, id, "published", { managerOnly: true });
  },
});

export const expire = mutation({
  args: { id: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    await transition(ctx, userId, id, "expired", { managerOnly: true });
  },
});

export const archive = mutation({
  args: { id: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    await transition(ctx, userId, id, "archived", { managerOnly: true });
  },
});

export const reopen = mutation({
  args: { id: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    await transition(ctx, userId, id, "in_review", { managerOnly: true });
  },
});

/** Fork a published article into a new draft version (same family). */
export const newVersion = mutation({
  args: {
    id: v.id("omiKnowledgeArticles"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
  },
  handler: async (ctx, { id, title, content }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const src = await owned(ctx, userId, id);
    const family = await ctx.db
      .query("omiKnowledgeArticles")
      .withIndex("by_family", (q) => q.eq("familyId", src.familyId))
      .take(50);
    const maxVersion = family.reduce((m, a) => Math.max(m, a.version), 0);
    const now = Date.now();
    const newId = await ctx.db.insert("omiKnowledgeArticles", {
      userId,
      tenantId: src.tenantId,
      familyId: src.familyId,
      title: (title ?? src.title).trim().slice(0, 200),
      content: (content ?? src.content).trim().slice(0, 40_000),
      category: src.category,
      tags: src.tags,
      product: src.product,
      department: src.department,
      region: src.region,
      owner: src.owner,
      status: "draft",
      version: nextVersion(maxVersion),
      effectiveDate: undefined,
      reviewDate: src.reviewDate,
      expirationDate: src.expirationDate,
      sourceType: src.sourceType,
      sourceRef: src.sourceRef,
      audience: src.audience,
      projectId: src.projectId,
      createdAt: now,
      updatedAt: now,
    });
    const doc = (await ctx.db.get(newId))!;
    await recordRevision(ctx, doc, ["created"], `New version v${doc.version} from v${src.version}`);
    return newId;
  },
});

export const submitFeedback = mutation({
  args: {
    articleId: v.optional(v.id("omiKnowledgeArticles")),
    verdict: v.union(
      v.literal("correct"),
      v.literal("incorrect"),
      v.literal("outdated"),
      v.literal("missing"),
      v.literal("improvement"),
    ),
    question: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const tenantId = await viewerTenant(ctx, userId);
    if (args.articleId) {
      const doc = await ctx.db.get(args.articleId);
      if (!doc || doc.userId !== userId || !isInTenant(doc, tenantId)) {
        throw new Error("Not your knowledge article.");
      }
    }
    await ctx.db.insert("omiKnowledgeFeedback", {
      userId,
      tenantId,
      articleId: args.articleId,
      verdict: args.verdict,
      question: args.question?.slice(0, 300),
      note: args.note?.slice(0, 1000),
      createdAt: Date.now(),
    });
    // A "missing" verdict is a knowledge-gap signal — recorded, never
    // auto-answered.
    if (args.verdict === "missing" && args.question) {
      await upsertGap(ctx, userId, args.question);
    }
  },
});

export const setGapStatus = mutation({
  args: {
    key: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("in_progress"),
      v.literal("resolved"),
    ),
  },
  handler: async (ctx, { key, status }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const tenantId = await viewerTenant(ctx, userId);
    const gap = await ctx.db
      .query("omiKnowledgeGaps")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .first();
    if (!gap || !isInTenant(gap, tenantId)) throw new Error("Knowledge gap not found.");
    await ctx.db.patch(gap._id, { status });
  },
});

export const removeArticle = mutation({
  args: { id: v.id("omiKnowledgeArticles") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const doc = await owned(ctx, userId, id);
    if (doc.status !== "draft") {
      throw new Error("Only drafts can be deleted — archive published knowledge instead.");
    }
    await ctx.db.delete(id);
  },
});
