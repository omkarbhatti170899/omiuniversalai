"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { vly } from "../lib/vly-integrations";
import { friendlyAiError } from "./aiErrors";

const OMI_SYSTEM = `You are Omi, the Universal AI inside Ominnovations Intelligence. You coordinate intelligence rather than just answering: you reason before acting, and you explain your thinking.

Rules:
1. Before your answer, think step by step: identify what the user actually needs, what is missing, and how you will approach it.
2. Answer in clear, direct language. Use short paragraphs or bullet points where helpful.
3. After your answer, include a final paragraph starting exactly with "Because:" that explains WHY you reached that answer (your reasoning trail, 1-3 sentences).
4. If the user's approved memories are provided, use them as personal context and respect them.
5. If you are uncertain or lack information, say so plainly and suggest what would help.
6. Never invent facts. If something needs live data, say Omi Search can verify it.`;

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

function splitReasoning(raw: string): { content: string; reasoning: string } {
  const marker = /(?:^|\n)\s*Because:\s*/i;
  const match = raw.match(marker);
  if (!match || match.index === undefined) {
    return { content: raw.trim(), reasoning: "" };
  }
  return {
    content: raw.slice(0, match.index).trim(),
    reasoning: raw
      .slice(match.index + match[0].length)
      .trim()
      .slice(0, 600),
  };
}

export const send = action({
  args: {
    conversationId: v.id("omiConversations"),
    message: v.string(),
  },
  handler: async (
    ctx,
    { conversationId, message },
  ): Promise<{ userMessageId: string; omiMessageId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to talk with Omi.");

    const trimmed = message.trim().slice(0, 4000);
    if (trimmed.length < 1) throw new Error("Type a message first.");

    // Verify the conversation belongs to this user.
    const conversation = await ctx.runQuery(internal.omiConversations.getInternal, {
      id: conversationId,
    });
    if (!conversation || conversation.userId !== userId) {
      throw new Error("Not your conversation.");
    }

    // 1) Save the user's message
    const userMessageId = await ctx.runMutation(internal.omiMessages.saveInternal, {
      userId,
      conversationId,
      role: "user",
      content: trimmed,
    });

    // 2) Ground Omi: persistent memory + recent conversation context
    const [memories, recent] = await Promise.all([
      ctx.runQuery(internal.omiMemories.listInternal, { userId, limit: 40 }),
      ctx.runQuery(internal.omiMessages.recentInternal, {
        conversationId,
        limit: 12,
      }),
    ]);

    const memoryBlock =
      memories.length > 0
        ? `The user has approved these long-term memories about themselves — use them as context:\n${memories
            .map((m) => `- ${m.content}`)
            .join("\n")}`
        : "";

    // 3) Build the conversation for the model
    const chat: ChatMsg[] = [
      { role: "system", content: OMI_SYSTEM },
    ];
    if (memoryBlock) chat.push({ role: "system", content: memoryBlock });
    for (const m of recent) {
      chat.push({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      });
    }
    // The just-saved user message is included via recent (it was saved first),
    // but ensure it's the last user turn even if recent was empty.
    const lastIsThisMessage =
      chat.length > 0 && chat[chat.length - 1].content === trimmed;
    if (!lastIsThisMessage) {
      chat.push({ role: "user", content: trimmed });
    }

    // 4) Reason + answer
    const result = await vly.ai.completion({
      model: "gpt-4o-mini",
      messages: chat,
      temperature: 0.4,
      maxTokens: 900,
    });

    if (!result.success || !result.data) {
      throw new Error(friendlyAiError(result.error));
    }

    const raw = result.data.choices?.[0]?.message?.content ?? "";
    const { content, reasoning } = splitReasoning(raw);

    if (!content) {
      throw new Error("Omi returned an empty answer. Try again.");
    }

    // 5) Save Omi's reply with its transparent reasoning trail
    const omiMessageId = await ctx.runMutation(internal.omiMessages.saveInternal, {
      userId,
      conversationId,
      role: "omi",
      content,
      reasoning,
    });

    return { userMessageId, omiMessageId };
  },
});
