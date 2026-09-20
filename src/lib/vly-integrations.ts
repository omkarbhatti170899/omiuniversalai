// VLY Integrations Configuration
// See /integrations.md for usage documentation
//
// The VLY gateway is the primary AI path. If the workspace integration key is
// temporarily rejected (e.g. stale credential), we transparently fall back to
// a direct OpenAI-compatible completion so Omi keeps working. The fallback
// keeps the exact same response shape, so call sites never change.

import { createVlyIntegrations } from '@vly-ai/integrations';

export const vly = createVlyIntegrations({
  deploymentToken: process.env.VLY_INTEGRATION_KEY!,
  debug: process.env.NODE_ENV === 'development'
});

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

type CompletionRequest = {
  model?: string;
  messages: ChatMsg[];
  temperature?: number;
  maxTokens?: number;
};

type CompletionData = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { totalTokens?: number };
};

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Direct OpenAI fallback, used only when the VLY gateway refuses the
 * workspace key. Mirrors the @vly-ai/integrations completion() response shape.
 */
async function openAiCompletion(
  req: CompletionRequest
): Promise<{ success: boolean; data?: CompletionData; error?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error:
        "fallback unavailable: OPENAI_API_KEY is not configured in the project's API Keys tab",
    };
  }

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: req.model || "gpt-4o-mini",
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return {
        success: false,
        error: `OpenAI fallback error ${res.status}: ${bodyText.slice(0, 200)}`,
      };
    }

    const parsed = JSON.parse(bodyText) as CompletionData;
    return { success: true, data: parsed };
  } catch (e) {
    return {
      success: false,
      error: `OpenAI fallback failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Detects a workspace-key rejection from the VLY gateway. */
function isKeyRejection(error?: string): boolean {
  const msg = (error ?? "").toLowerCase();
  return (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("invalid token") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid_api_key")
  );
}

// Wrap the AI client so every call site keeps using `vly.ai.completion`
// unchanged: VLY gateway first, transparent OpenAI fallback on key rejection.
const vlyAi = vly.ai as {
  completion: (req: CompletionRequest) => Promise<{
    success: boolean;
    data?: CompletionData;
    error?: string;
  }>;
};

(vly as { ai: typeof vlyAi }).ai = {
  completion: async (req) => {
    const primary = await vlyAi.completion(req);
    if (primary.success && primary.data) return primary;

    if (isKeyRejection(primary.error) && process.env.OPENAI_API_KEY) {
      const fallback = await openAiCompletion(req);
      if (fallback.success && fallback.data) {
        return fallback; // same shape — callers can't tell the difference
      }
      // Both paths failed: prefer the primary (gateway) error for clarity.
      return primary;
    }

    return primary;
  },
};
