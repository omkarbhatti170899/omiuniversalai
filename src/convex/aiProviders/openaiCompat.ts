/**
 * Generic OpenAI-compatible chat-completions transport, shared by every
 * adapter that speaks the protocol (Groq, OpenAI, and any future
 * self-hosted endpoint: vLLM, Ollama, LM Studio…). Never throws —
 * failures come back as result objects so the router can fall through.
 */

import type {
  CompletionRequest,
  CompletionResult,
} from "../../lib/vly-integrations";

export async function openAiCompatibleCompletion(
  url: string,
  apiKey: string,
  model: string,
  req: CompletionRequest,
  label: string,
): Promise<CompletionResult> {
  // Deadline (§40): a hung provider must fail its attempt inside the router
  // (which then falls through to the next provider) instead of stalling the
  // whole request. AbortSignal.timeout is supported on Node ≥18 / Bun.
  const timeoutMs = Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 45_000);
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return {
        success: false,
        error: `${label} error ${res.status}: ${bodyText.slice(0, 160)}`,
      };
    }

    const parsed = JSON.parse(bodyText) as CompletionResult["data"];
    return { success: true, data: parsed };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = /abort|timeout|timed out/i.test(raw)
      ? `${label} timed out after ${Math.round(timeoutMs / 1000)}s`
      : `${label} failed: ${raw}`;
    return { success: false, error: msg };
  }
}

/** True when the failure looks like a credential/quota problem (try next provider). */
export function isCredentialish(error?: string): boolean {
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

/** True when the failure is specific to the chosen model (try its fallbacks). */
export function isModelSpecific(error?: string): boolean {
  const msg = (error ?? "").toLowerCase();
  return (
    msg.includes("model_not_found") ||
    msg.includes("model not found") ||
    msg.includes("does not exist") ||
    msg.includes("decommissioned") ||
    msg.includes("no longer supported") ||
    (msg.includes("model") && msg.includes("404"))
  );
}
