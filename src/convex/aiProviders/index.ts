/**
 * Omi AI Router — the single entry point for AI completions in the runtime
 * (master spec §3/§4). Call sites never import a vendor SDK and never name a
 * vendor model; they declare the TASK they need and this router decides:
 *
 *   1. which providers are configured (environment-based, no hard-coded keys)
 *   2. which model serves the task (fast models for summarization/extraction/
 *      classification, strong models for reasoning/coding/research)
 *   3. how to fall back: retired model → provider fallback models → next
 *      provider; the first success wins.
 *
 * Every result reports which provider/model actually served the request, and
 * getAiStatus() (via aiStatus.ts) surfaces the live routing to the UI.
 */

import {
  GROQ_URL,
  OPENAI_URL,
  getConfiguredAiProviders,
  type AiTask,
  type ProviderDescriptor,
} from "./catalog";
import {
  isCredentialish,
  isModelSpecific,
  openAiCompatibleCompletion,
} from "./openaiCompat";
import { vlyCompletion } from "./vly";
import type { CompletionRequest } from "../../lib/vly-integrations";

export {
  AI_TASKS,
  getAiStatus,
  hasAiProvider,
  type AiTask,
} from "./catalog";

export type AiAttempt = { provider: string; model: string; error?: string };

export type AiCompletionResult = {
  ok: boolean;
  content: string;
  /** Which provider actually served this request (null when all failed). */
  provider: string | null;
  model: string | null;
  /** Every attempt made, in order — for observability and debugging. */
  attempts: AiAttempt[];
  error?: string;
};

export type CompleteArgs = CompletionRequest & { task?: AiTask };

type Adapter = (
  model: string,
  req: CompletionRequest,
) => Promise<{ success: boolean; data?: { choices?: Array<{ message?: { content?: string } }> }; error?: string }>;

/** Adapter registry — one entry per registered provider. */
function adapterFor(p: ProviderDescriptor): Adapter {
  switch (p.id) {
    case "vly":
      return (model, req) => vlyCompletion({ ...req, model });
    case "groq":
      return (model, req) =>
        openAiCompatibleCompletion(
          GROQ_URL,
          process.env.GROQ_API_KEY as string,
          model,
          req,
          `Groq(${model})`,
        );
    case "openai":
      return (model, req) =>
        openAiCompatibleCompletion(
          OPENAI_URL,
          process.env.OPENAI_API_KEY as string,
          model,
          req,
          `OpenAI(${model})`,
        );
  }
}

/**
 * Run a completion through the provider chain. Never throws: every failure
 * mode comes back as ok:false with the attempt trace so call sites can use
 * their own graceful fallbacks (heuristic emotion analysis, extractive
 * briefs, saved messages with honest notes).
 */
export async function complete(args: CompleteArgs): Promise<AiCompletionResult> {
  const task: AiTask = args.task ?? "conversational";
  const req: CompletionRequest = {
    messages: args.messages,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
  };
  const attempts: AiAttempt[] = [];

  const providers = getConfiguredAiProviders();
  if (providers.length === 0) {
    return {
      ok: false,
      content: "",
      provider: null,
      model: null,
      attempts,
      error:
        "no AI provider is configured: add GROQ_API_KEY (free) or OPENAI_API_KEY in the project's API Keys tab",
    };
  }

  // Explicit model override pins the model on every provider (advanced use).
  const override = args.model?.trim();

  for (const p of providers) {
    const primary =
      override || p.taskModels[task] || p.taskModels.conversational;
    const candidates = [primary, ...p.fallbackModels.filter((m) => m !== primary)];
    let lastError = "";

    for (const model of candidates) {
      const result = await adapterFor(p)(model, req);
      if (result.success && result.data) {
        const content = (
          result.data.choices?.[0]?.message?.content ?? ""
        ).trim();
        if (content.length > 0) {
          return { ok: true, content, provider: p.id, model, attempts };
        }
        lastError = `${p.id} (${model}) returned an empty completion`;
      } else {
        lastError = result.error ?? `${p.id} failed`;
      }
      attempts.push({ provider: p.id, model, error: lastError.slice(0, 200) });

      // Model-specific rejection (retired/renamed) → try the provider's next
      // candidate. Anything else (credentials, quota, network, 5xx) → skip
      // the remaining candidates and fall through to the next provider.
      if (!isModelSpecific(lastError)) break;
    }
  }

  return {
    ok: false,
    content: "",
    provider: null,
    model: null,
    attempts,
    error:
      attempts
        .map((a) => `${a.provider}: ${a.error}`)
        .join(" | ")
        .slice(0, 400) || "all AI providers failed",
  };
}
