import { getAuthUserId } from "@convex-dev/auth/server";
import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Agents owned by the signed-in user, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    return await ctx.db
      .query("omiAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    specialty: v.string(),
  },
  handler: async (ctx, { name, description, specialty }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const trimmedName = name.trim().slice(0, 60);
    const trimmedDescription = description.trim().slice(0, 300);
    if (trimmedName.length < 1 || trimmedDescription.length < 3) {
      throw new Error("Agent needs a name and a short description.");
    }

    return await ctx.db.insert("omiAgents", {
      userId,
      name: trimmedName,
      description: trimmedDescription,
      specialty: specialty.trim().slice(0, 40) || "general",
    });
  },
});

/** Internal lookup used by the agent runtime action. */
export const getInternal = internalQuery({
  args: { id: v.id("omiAgents") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const remove = mutation({
  args: { id: v.id("omiAgents") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your agent");

    await ctx.db.delete(id);
  },
});
