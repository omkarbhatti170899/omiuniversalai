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
import { critiqueKnowledge, countBySeverity } from "./knowledgeEngine/critic";
import { summarizeKnowledge } from "./knowledgeEngine/analytics";

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
 * Ownership-checked article read. Every mutation goes through this so a
 * foreign id can never be touched.
 */
async function owned(
  ctx: MutationCtx,
  userId: Id<"users">,
  id: Id<"omiKnowledgeArticles">,
): Promise<Doc<"omiKnowledgeArticles">> {
  const doc = await ctx.db.get(id);
  if (!doc || doc.userId !== userId) throw new Error("Not your knowledge article.");
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

/** Shared retrieval: visible + metadata-filtered + version-selected + ranked. */
async function retrievePassages(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  question: string,
  filters?: MetadataFilter,
  limit = 6,
): Promise<{ passages: KnowledgePassage[]; roles: KnowledgeRole[] }> {
  const roles = await viewerRoles(ctx, userId);
  const all = await ctx.db
    .query("omiKnowledgeArticles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(300);

  const likes = all.map(toArticleLike);
  let candidates = filterVisible(likes, roles);
  if (filters) candidates = filterByMetadata(candidates, filters);
  const effective = selectEffectiveVersions(candidates, Date.now());

  const ranked = retrieve(
    question,
    // `retrieve` keys documents by `_id` (the same corpus shape the personal
    // knowledge base uses), so the article id is passed through unchanged.
    effective.map((a) => ({ _id: a._id, title: a.title, content: a.content })),
    limit,
    "hybrid",
  );

  const passages: KnowledgePassage[] = ranked.map((r) => {
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
  return { passages, roles };
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
  },
  handler: async (ctx, { userId, question, limit, ...filters }) => {
    const { passages } = await retrievePassages(ctx, userId, question, filters, limit ?? 6);
    return { passages };
  },
});

export const logQueryInternal = internalMutation({
  args: {
    userId: v.id("users"),
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
  const existing = await ctx.db
    .query("omiKnowledgeGaps")
    .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
    .first();
  const now = Date.now();
  if (existing) {
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

/** Chat integration: grounded internal answer, gap + query logged. */
export const askInternal = internalAction({
  args: {
    userId: v.id("users"),
    question: v.string(),
    projectId: v.optional(v.id("omiProjects")),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { userId, question, projectId, limit },
  ): Promise<{ answer: ActionPlan; passages: KnowledgePassage[] }> => {
    const { passages } = await ctx.runQuery(
      internal.omiKnowledgeIntelligence.retrieveInternal,
      { userId, question, limit: limit ?? 4 },
    );
    const answer = buildActionPlan(question, passages);
    if (!answer.answered) {
      await ctx.runMutation(internal.omiKnowledgeIntelligence.recordGapInternal, {
        userId,
        question,
        projectId,
      });
    }
    return { answer, passages };
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

    const all = await ctx.db
      .query("omiKnowledgeArticles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(300);

    let rows = all.filter((a) => (manager ? true : isAuthoritative(a.status)));
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
    return await ctx.db
      .query("omiKnowledgeRevisions")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .order("desc")
      .take(50);
  },
});

export const listGaps = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("omiKnowledgeGaps")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);
  },
});

export const listFeedback = query({
  args: { articleId: v.optional(v.id("omiKnowledgeArticles")) },
  handler: async (ctx, { articleId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    if (articleId) {
      const doc = await ctx.db.get(articleId);
      if (!doc || doc.userId !== userId) return [];
      return await ctx.db
        .query("omiKnowledgeFeedback")
        .withIndex("by_article", (q) => q.eq("articleId", articleId))
        .order("desc")
        .take(50);
    }
    return await ctx.db
      .query("omiKnowledgeFeedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
  },
});

/** The admin dashboard: counts, critic flags, review queue. */
export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const roles = await viewerRoles(ctx, userId);

    const [articles, gaps, feedback, logs] = await Promise.all([
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
    ]);

    const now = Date.now();
    const likes = articles.map(toArticleLike);
    const analytics = summarizeKnowledge({
      articles: likes,
      gaps,
      feedback,
      logs,
      now,
    });
    const flags = critiqueKnowledge({ articles: likes, gaps, now });

    return {
      manager: canManageKnowledge(roles),
      analytics,
      flags,
      flagCounts: countBySeverity(flags),
      reviewQueue: articles
        .filter((a) => a.status === "in_review" || a.status === "approved")
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, 50),
      gaps: gaps
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, 50),
    };
  },
});

// --- public actions ---------------------------------------------------------

/** Answer a question from approved knowledge, or log a gap. */
export const ask = action({
  args: {
    question: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { question, limit }): Promise<{ answer: ActionPlan }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to ask knowledge.");
    const q = question.trim().slice(0, 500);
    if (q.length < 2) throw new Error("Ask a question first.");
    const started = Date.now();
    const { answer, passages } = await ctx.runAction(
      internal.omiKnowledgeIntelligence.askInternal,
      { userId, question: q, limit: limit ?? 4 },
    );
    await ctx.runMutation(internal.omiKnowledgeIntelligence.logQueryInternal, {
      userId,
      query: q,
      answered: answer.answered,
      topArticleId: passages[0]?.articleId as Id<"omiKnowledgeArticles"> | undefined,
      latencyMs: Date.now() - started,
    });
    return { answer };
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

    const now = Date.now();
    const familyId = `fam_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const id = await ctx.db.insert("omiKnowledgeArticles", {
      userId,
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
    if (args.articleId) {
      const doc = await ctx.db.get(args.articleId);
      if (!doc || doc.userId !== userId) throw new Error("Not your knowledge article.");
    }
    await ctx.db.insert("omiKnowledgeFeedback", {
      userId,
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
    const gap = await ctx.db
      .query("omiKnowledgeGaps")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .first();
    if (!gap) throw new Error("Knowledge gap not found.");
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
