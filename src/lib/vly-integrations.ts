// VLY Integrations Configuration
// See /integrations.md for usage documentation
//
// Resilient AI chain: the VLY gateway is the primary path; if the workspace
// key is rejected or the gateway fails, we transparently try OpenAI-compatible
// fallbacks (Groq free tier, then OpenAI). The response shape is identical for
// every provider, so call sites never change. Whichever provider succeeds is
// invisible to the rest of the app.

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

type CompletionResult = {
  success: boolean;
  data?: CompletionData;
  error?: string;
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

async function openAiCompatibleCompletion(
  url: string,
  apiKey: string,
  model: string,
  req: CompletionRequest,
  label: string,
): Promise<CompletionResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return {
        success: false,
        error: `${label} error ${res.status}: ${bodyText.slice(0, 160)}`,
      };
    }

    const parsed = JSON.parse(bodyText) as CompletionData;
    return { success: true, data: parsed };
  } catch (e) {
    return {
      success: false,
      error: `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** True when the failure looks like a credential problem (try another provider). */
function isCredentialish(error?: string): boolean {
  const msg = (error ?? "").toLowerCase();
  return (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("invalid token") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid_api_key") ||
    msg.includes("insufficient") || // OpenAI: no credits left
    msg.includes("quota")
  );
}

// Wrap the AI client so every call site keeps using `vly.ai.completion`
// unchanged: VLY first, then Groq (free tier), then OpenAI.
const vlyAi = vly.ai as {
  completion: (req: CompletionRequest) => Promise<CompletionResult>;
};

(vly as { ai: typeof vlyAi }).ai = {
  completion: async (req): Promise<CompletionResult> => {
    const attempts: Array<() => Promise<CompletionResult>> = [];

    // 1) Primary: the workspace VLY gateway.
    if (process.env.VLY_INTEGRATION_KEY) {
      attempts.push(() => vlyAi.completion(req));
    }

    // 2) Groq — free tier, OpenAI-compatible.
    if (process.env.GROQ_API_KEY) {
      attempts.push(() =>
        openAiCompatibleCompletion(
          GROQ_URL,
          process.env.GROQ_API_KEY as string,
          GROQ_MODEL,
          req,
          "Groq",
        ),
      );
    }

    // 3) OpenAI — direct API.
    if (process.env.OPENAI_API_KEY) {
      attempts.push(() =>
        openAiCompatibleCompletion(
          OPENAI_URL,
          process.env.OPENAI_API_KEY as string,
          req.model || "gpt-4o-mini",
          req,
          "OpenAI",
        ),
      );
    }

    if (attempts.length === 0) {
      return {
        success: false,
        error:
          "no AI provider is configured: add VLY_INTEGRATION_KEY (workspace), GROQ_API_KEY (free) or OPENAI_API_KEY in the project's API Keys tab",
      };
    }

    // Try each provider in order; the first success wins. Any failure
    // (credential, quota, timeout, 5xx) moves on to the next provider.
    let lastResult: CompletionResult = {
      success: false,
      error: "no AI provider responded",
    };

    for (const attempt of attempts) {
      const result = await attempt();
      if (result.success && result.data) return result;
      lastResult = result;
    }

    return lastResult;
  },
};
