"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { complete } from "./aiProviders";
import { friendlyAiError } from "./aiErrors";
import { toolCatalogPrompt, parseToolCall } from "./omiTools/registry";
import { executeTool } from "./omiTools/executor";
import { verifyResult, correctiveRetry } from "./verification";

/** AI plans the steps for an objective. Creates the task awaiting human approval. */
export const planTask = action({
  args: {
    agentId: v.id("omiAgents"),
    objective: v.string(),
  },
  handler: async (ctx, { agentId, objective }): Promise<{ taskId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to use agents.");

    const trimmed = objective.trim().slice(0, 1000);
    if (trimmed.length < 4) throw new Error("Describe the objective first.");

    const agent = await ctx.runQuery(internal.omiAgents.getInternal, { id: agentId });
    if (!agent || agent.userId !== userId) throw new Error("Not your agent.");

    // Routed as a reasoning task — planning benefits from the strong model.
    const result = await complete({
      task: "reasoning",
      messages: [
        {
          role: "system",
          content:
            'You are Omi\'s agent planner. Break the objective into 2-4 concrete, sequential steps. Respond with ONLY a JSON array of short step descriptions, e.g. ["Step one","Step two"]. No commentary. When research or live facts are involved, plan a step that uses the available tools (web search, page reading).',
        },
        {
          role: "user",
          content: `Agent specialty: ${agent.specialty}. Objective: ${trimmed}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 300,
    });

    if (!result.ok) {
      throw new Error(friendlyAiError(result.error));
    }

    const raw = result.content;
    let plan: string[];
    try {
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(parsed)) throw new Error("not an array");
      plan = parsed
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.slice(0, 200))
        .slice(0, 4);
    } catch {
      throw new Error("Omi's plan was malformed. Try again.");
    }
    if (plan.length === 0) throw new Error("Omi produced an empty plan.");

    const taskId = await ctx.runMutation(api.omiTasks.create, {
      agentId,
      objective: trimmed,
      plan,
    });

    return { taskId };
  },
});

/** Execute an approved plan: each step is reasoned over with prior outputs as context. */
export const runTask = action({
  args: { taskId: v.id("omiTasks") },
  handler: async (ctx, { taskId }): Promise<{ ok: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to use agents.");

    const task = await ctx.runQuery(internal.omiTasks.getInternal, { id: taskId });
    if (!task || task.userId !== userId) throw new Error("Not your task.");
    if (task.status !== "running") {
      throw new Error("Task must be approved before running.");
    }

    const agent = await ctx.runQuery(internal.omiAgents.getInternal, {
      id: task.agentId,
    });
    const specialty = agent?.specialty ?? "general";

    try {
      const steps: string[] = task.plan ?? [];
      const outputs: string[] = [];
      const toolLines: string[] = [];

      for (let i = 0; i < steps.length; i++) {
        // Routed as a conversational task — short, concrete step outputs.
        const stepResult = await complete({
          task: "conversational",
          messages: [
            {
              role: "system",
              content: `You are Omi's ${specialty} agent executing one step of a multi-step task. Produce the concrete output for this step only: concise, actionable, under 150 words. No preamble.\n\n${toolCatalogPrompt()}`,
            },
            {
              role: "user",
              content: [
                `Overall objective: ${task.objective}`,
                `Full plan: ${steps.map((s, j) => `${j + 1}. ${s}`).join(" | ")}`,
                outputs.length > 0
                  ? `Previous step outputs:\n${outputs
                      .map((o, j) => `Step ${j + 1}: ${o}`)
                      .join("\n")}`
                  : "",
                `Now execute step ${i + 1}: ${steps[i]}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
          temperature: 0.3,
          maxTokens: 350,
        });

        if (!stepResult.ok) {
          throw new Error(friendlyAiError(stepResult.error));
        }

        let output = stepResult.content.trim();
        if (!output) throw new Error(`Step ${i + 1} produced no output.`);

        // Tool execution (master plan Phase 1/6): the step's final line may
        // be a registry tool call. Execute it through the allowlisted
        // executor and keep the result as context for later steps.
        const call = parseToolCall(output);
        if (call.ok) {
          const run = await executeTool(ctx, userId, call.tool, call.args, {
            taskId,
            agentId: task.agentId,
          });
          toolLines.push(
            `${run.ok ? "✔" : "✖"} ${call.tool}: ${
              run.ok ? run.output.slice(0, 300) : run.error
            }`,
          );
          output = call.textBefore.trim();
          if (run.ok && run.output) {
            outputs.push(`[${call.tool}] ${run.output.slice(0, 1200)}`);
          }
        } else if (
          /^TOOL\s/.test(output.split("\n").pop() ?? "")
        ) {
          // Malformed call: surface the parser error honestly.
          toolLines.push(`✖ malformed tool call: ${call.error}`);
          output = call.textBefore.trim();
        }

        outputs.push(output);
        await ctx.runMutation(internal.omiTasks.saveStepInternal, {
          userId,
          taskId,
          index: i,
          description: steps[i],
          output: output.slice(0, 2000),
        });
        await ctx.runMutation(internal.omiAudit.addInternal, {
          userId,
          taskId,
          agentId: task.agentId,
          event: "step_completed",
          detail: `Step ${i + 1}/${steps.length}: ${steps[i].slice(0, 80)}`,
        });
      }

      // Synthesize the final result from all step outputs (summarization task)
      const final = await complete({
        task: "summarization",
        messages: [
          {
            role: "system",
            content:
              "You are Omi. Summarize the completed agent work into a clear final answer for the user: what was done, key findings, and the recommended next action. Under 180 words. No preamble.",
          },
          {
            role: "user",
            content: `Objective: ${task.objective}\n\nStep outputs:\n${outputs
              .map((o, j) => `Step ${j + 1}: ${o}`)
              .join("\n\n")}${
              toolLines.length > 0
                ? `\n\nTool runs:\n${toolLines.join("\n")}`
                : ""
            }`,
          },
        ],
        temperature: 0.3,
        maxTokens: 400,
      });

      const finalText =
        final.ok && final.content.trim().length > 0
          ? final.content.trim()
          : outputs[outputs.length - 1];

      // Phase 7 — Verification Intelligence: independent verifier checks the
      // final result against the recorded evidence BEFORE it is shown.
      let verification: "pass" | "warnings" | "unverified" | "failed" = "unverified";
      let verificationNotes: string[] = [];
      let resultText = finalText;
      try {
        const verdict = await verifyResult(task.objective, finalText, [...outputs, ...toolLines]);
        verification = verdict.verdict;
        verificationNotes = verdict.notes;

        // Bounded retry: one corrective pass on "failed" (master plan:
        // ANSWER → CHECK → IDENTIFY ERRORS → RETRY/CORRECT → FINAL).
        if (verdict.verdict === "failed" && verdict.notes.length > 0) {
          const corrected = await correctiveRetry(task.objective, finalText, verdict.notes);
          if (corrected) {
            resultText = corrected;
            const recheck = await verifyResult(task.objective, corrected, [
              ...outputs,
              ...toolLines,
            ]);
            verification = recheck.verdict === "failed" ? "warnings" : recheck.verdict;
            verificationNotes = [
              ...recheck.notes,
              ...(recheck.notes.length === 0 ? ["Corrected once after verification failure."] : []),
            ];
            await ctx.runMutation(internal.omiAudit.addInternal, {
              userId,
              taskId,
              agentId: task.agentId,
              event: "verification_retry",
              detail: "Corrective pass applied after failed verification",
            });
          }
        }

        await ctx.runMutation(internal.omiAudit.addInternal, {
          userId,
          taskId,
          agentId: task.agentId,
          event: "verification_run",
          detail: `Verdict: ${verification}${verificationNotes.length > 0 ? ` — ${verificationNotes[0].slice(0, 120)}` : ""}`,
        });
      } catch {
        verification = "unverified";
      }

      await ctx.runMutation(internal.omiTasks.setResultInternal, {
        id: taskId,
        result: resultText.slice(0, 3000),
        verification,
        verificationNotes: verificationNotes.slice(0, 5),
      });
      await ctx.runMutation(internal.omiTasks.setStatusInternal, {
        id: taskId,
        status: "done",
      });
      await ctx.runMutation(internal.omiAudit.addInternal, {
        userId,
        taskId,
        agentId: task.agentId,
        event: "task_completed",
        detail: `All ${steps.length} step(s) finished`,
      });

      return { ok: true };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Task failed unexpectedly.";
      await ctx.runMutation(internal.omiTasks.setStatusInternal, {
        id: taskId,
        status: "failed",
        error: message.slice(0, 500),
      });
      await ctx.runMutation(internal.omiAudit.addInternal, {
        userId,
        taskId,
        agentId: task.agentId,
        event: "task_failed",
        detail: message.slice(0, 200),
      });
      return { ok: false };
    }
  },
});
