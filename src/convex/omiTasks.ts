import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";

/** Tasks of the signed-in user with their agent names, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const tasks = await ctx.db
      .query("omiTasks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);

    return Promise.all(
      tasks.map(async (t) => {
        const agent = await ctx.db.get(t.agentId);
        return {
          ...t,
          agentName: agent?.name ?? "Unknown agent",
          agentSpecialty: agent?.specialty ?? "general",
        };
      }),
    );
  },
});

/** Steps + audit for the task detail view (ownership verified). */
export const detail = query({
  args: { taskId: v.id("omiTasks") },
  handler: async (ctx, { taskId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const task = await ctx.db.get(taskId);
    if (!task || task.userId !== userId) return null;

    const agent = await ctx.db.get(task.agentId);
    const steps = await ctx.db
      .query("omiTaskSteps")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .order("asc")
      .collect();

    const approvals = await ctx.db
      .query("omiApprovals")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .order("desc")
      .take(10);

    return {
      task,
      agentName: agent?.name ?? "Unknown agent",
      steps,
      approvals,
    };
  },
});

/** Create a task in awaiting_approval status (planning happens in the action). */
export const create = mutation({
  args: {
    agentId: v.id("omiAgents"),
    objective: v.string(),
    plan: v.array(v.string()),
  },
  handler: async (ctx, { agentId, objective, plan }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const agent = await ctx.db.get(agentId);
    if (!agent || agent.userId !== userId) {
      throw new Error("Not your agent");
    }

    const trimmed = objective.trim().slice(0, 1000);
    if (trimmed.length < 4) throw new Error("Describe the objective first.");

    const taskId = await ctx.db.insert("omiTasks", {
      userId,
      agentId,
      objective: trimmed,
      status: "awaiting_approval",
      plan,
    });

    await ctx.db.insert("omiAuditLog", {
      userId,
      taskId,
      agentId,
      event: "task_planned",
      detail: `Planned ${plan.length} step(s)`,
    });

    return taskId;
  },
});

/** Human approves the plan → task becomes runnable. */
export const approve = mutation({
  args: { id: v.id("omiTasks") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const task = await ctx.db.get(id);
    if (!task || task.userId !== userId) throw new Error("Not your task");
    if (task.status !== "awaiting_approval") {
      throw new Error("Task is not awaiting approval.");
    }

    await ctx.db.patch(id, { status: "running" });
    await ctx.db.insert("omiAuditLog", {
      userId,
      taskId: id,
      agentId: task.agentId,
      event: "task_approved",
      detail: "Human approved the plan",
    });
  },
});

/** Human denies a plan or cancels a running task. */
export const cancel = mutation({
  args: { id: v.id("omiTasks") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const task = await ctx.db.get(id);
    if (!task || task.userId !== userId) throw new Error("Not your task");
    if (task.status === "done" || task.status === "failed") {
      throw new Error("Task already finished.");
    }

    await ctx.db.patch(id, { status: "failed", error: "Cancelled by user" });
    await ctx.db.insert("omiAuditLog", {
      userId,
      taskId: id,
      agentId: task.agentId,
      event: "task_cancelled",
      detail: "Cancelled by user",
    });
  },
});

/** Remove a task and its steps. */
export const remove = mutation({
  args: { id: v.id("omiTasks") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const task = await ctx.db.get(id);
    if (!task) return;
    if (task.userId !== userId) throw new Error("Not your task");

    const steps = await ctx.db
      .query("omiTaskSteps")
      .withIndex("by_task", (q) => q.eq("taskId", id))
      .collect();
    for (const s of steps) {
      await ctx.db.delete(s._id);
    }
    await ctx.db.delete(id);
  },
});

// ----- internal accessors used by the agent runtime action -----

export const getInternal = internalQuery({
  args: { id: v.id("omiTasks") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const setStatusInternal = internalMutation({
  args: {
    id: v.id("omiTasks"),
    status: v.union(
      v.literal("awaiting_approval"),
      v.literal("running"),
      v.literal("needs_input"),
      v.literal("done"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, error }) => {
    await ctx.db.patch(id, { status, ...(error !== undefined ? { error } : {}) });
  },
});

export const setResultInternal = internalMutation({
  args: { id: v.id("omiTasks"), result: v.string() },
  handler: async (ctx, { id, result }) => {
    await ctx.db.patch(id, { result });
  },
});

export const saveStepInternal = internalMutation({
  args: {
    userId: v.id("users"),
    taskId: v.id("omiTasks"),
    index: v.number(),
    description: v.string(),
    output: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiTaskSteps", args);
  },
});

/** Approvals used by the runtime's human-in-the-loop gate. */
export const createApprovalInternal = internalMutation({
  args: {
    userId: v.id("users"),
    taskId: v.id("omiTasks"),
    action: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiApprovals", {
      ...args,
      status: "pending",
    });
  },
});
