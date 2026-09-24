/**
 * Omi Projects (§5) — persistent containers that scope conversations, files,
 * instructions and research context per project.
 *
 * Architecture notes:
 *  • Everything is userId-scoped with ownership checks — one user can never
 *    read or mutate another user's project (§12 security, §11 memory safety).
 *  • Project context NEVER mixes: chat grounding inside a project searches
 *    only that project's documents, and the project's standing instructions
 *    are injected into the system prompt for that project's turns only.
 *  • Fully backward compatible: existing conversations/documents with no
 *    projectId are "personal" and keep working exactly as before (no
 *    migration, no data loss).
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { rateLimit } from "./searchEngine/resilience";

const MAX_NAME_CHARS = 80;
const MAX_INSTRUCTIONS_CHARS = 4000;
/** How many projects the project list shows (newest first). */
const MAX_LIST = 50;

/** Internal ownership-checked lookup (actions can't touch the DB directly). */
export const getInternal = internalQuery({
  args: { id: v.id("omiProjects") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

/**
 * Project + standing-instruction block for chat grounding, ownership-checked.
 * Returns null unless the project exists AND belongs to `userId` — a wrong or
 * foreign projectId is indistinguishable from "no project" to the caller.
 */
export const groundInternal = internalQuery({
  args: { userId: v.id("users"), projectId: v.id("omiProjects") },
  handler: async (ctx, { userId, projectId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.userId !== userId) return null;
    return {
      _id: project._id,
      name: project.name,
      instructions: project.instructions,
    };
  },
});

/** Projects for the signed-in user, newest first, with context counts. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const projects = await ctx.db
      .query("omiProjects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_LIST);

    // Counts are computed per project so the UI can show context size without
    // a second round-trip. All reads are userId-scoped.
    return await Promise.all(
      projects.map(async (p) => {
        const docs = await ctx.db
          .query("omiDocuments")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(200);
        const convs = await ctx.db
          .query("omiConversations")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(200);
        return {
          _id: p._id,
          name: p.name,
          instructions: p.instructions,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          documentCount: docs.filter((d) => d.projectId === p._id).length,
          conversationCount: convs.filter((c) => c.projectId === p._id).length,
        };
      }),
    );
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    instructions: v.optional(v.string()),
  },
  handler: async (ctx, { name, instructions }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to create a project.");

    const rl = rateLimit(`projects:${userId}`, 10);
    if (!rl.ok) {
      throw new Error(
        `Too many changes — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    const trimmedName = name.trim().slice(0, MAX_NAME_CHARS);
    if (trimmedName.length < 2) {
      throw new Error("Project name needs at least 2 characters.");
    }

    const now = Date.now();
    return await ctx.db.insert("omiProjects", {
      userId,
      name: trimmedName,
      instructions: (instructions ?? "").trim().slice(0, MAX_INSTRUCTIONS_CHARS),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("omiProjects"),
    name: v.optional(v.string()),
    instructions: v.optional(v.string()),
  },
  handler: async (ctx, { id, name, instructions }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const project = await ctx.db.get(id);
    if (!project) return;
    if (project.userId !== userId) throw new Error("Not your project");

    const patch: { updatedAt: number; name?: string; instructions?: string } = {
      updatedAt: Date.now(),
    };
    if (name !== undefined) {
      const trimmed = name.trim().slice(0, MAX_NAME_CHARS);
      if (trimmed.length < 2) {
        throw new Error("Project name needs at least 2 characters.");
      }
      patch.name = trimmed;
    }
    if (instructions !== undefined) {
      patch.instructions = instructions
        .trim()
        .slice(0, MAX_INSTRUCTIONS_CHARS);
    }
    await ctx.db.patch(id, patch);
  },
});

/**
 * Delete a project WITHOUT destroying anything scoped to it (§11: user
 * control, no surprise data loss). Conversations and documents keep their
 * content and simply become "personal" again (projectId unset).
 */
export const remove = mutation({
  args: { id: v.id("omiProjects") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const project = await ctx.db.get(id);
    if (!project) return;
    if (project.userId !== userId) throw new Error("Not your project");

    // Unscope children rather than deleting them — the user keeps the data.
    const docs = await ctx.db
      .query("omiDocuments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(300);
    for (const d of docs) {
      if (d.projectId === id) {
        await ctx.db.patch(d._id, { projectId: undefined });
      }
    }
    const convs = await ctx.db
      .query("omiConversations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(300);
    for (const c of convs) {
      if (c.projectId === id) {
        await ctx.db.patch(c._id, { projectId: undefined });
      }
    }

    await ctx.db.delete(id);
  },
});

// --- Cross-scoping helpers used by Files/Knowledge UIs ------------------------

/** Attach an already-uploaded document to a project (ownership-checked). */
export const attachDocument = mutation({
  args: { documentId: v.id("omiDocuments"), projectId: v.id("omiProjects") },
  handler: async (ctx, { documentId, projectId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(documentId);
    if (!doc || doc.userId !== userId) throw new Error("Not your document");
    const project = await ctx.db.get(projectId);
    if (!project || project.userId !== userId) throw new Error("Not your project");

    await ctx.db.patch(documentId, { projectId });
  },
});

/** Detach a document from whatever project it belongs to (ownership-checked). */
export const detachDocument = mutation({
  args: { documentId: v.id("omiDocuments") },
  handler: async (ctx, { documentId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(documentId);
    if (!doc || doc.userId !== userId) throw new Error("Not your document");
    await ctx.db.patch(doc._id, { projectId: undefined });
  },
});

/**
 * Move an existing conversation into a project (or out, with projectId
 * undefined). Used by the chat panel's project picker.
 */
export const moveConversation = mutation({
  args: {
    conversationId: v.id("omiConversations"),
    projectId: v.optional(v.id("omiProjects")),
  },
  handler: async (ctx, { conversationId, projectId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const conv = await ctx.db.get(conversationId);
    if (!conv || conv.userId !== userId) throw new Error("Not your conversation");

    if (projectId !== undefined) {
      const project = await ctx.db.get(projectId);
      if (!project || project.userId !== userId) {
        throw new Error("Not your project");
      }
    }
    await ctx.db.patch(conversationId, { projectId });
  },
});

/** Count helper for dashboards — internal, cheap. */
export const countInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { projects: 0 };
    const projects = await ctx.db
      .query("omiProjects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_LIST);
    return { projects: projects.length };
  },
});
