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
  DEEPSEEK_URL,
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
// Provider-level circuit breaking, shared with the search layer (one
// resilience primitive for the whole runtime, not two divergent ones).
import { breakerAllow, breakerRecord } from "../searchEngine/resilience";
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

export type AttemptDecision = "next_candidate" | "next_provider";

/**
 * Decide what to do after one model attempt produced no usable content.
 *
 * This is the single most failure-prone decision in the router, so it is
 * pure and unit-tested (tests/omiAiProviders.test.ts) rather than buried in
 * the loop:
 *
 *   • EMPTY completion → try the next candidate model on the SAME provider.
 *     A live call that returned nothing is model/parameter-shaped, not a
 *     dead provider — reasoning models can spend the whole maxTokens budget
 *     on hidden reasoning and emit no visible content, while the provider's
 *     next model answers immediately. (Treating this as provider-level was a
 *     real production bug: it skipped the provider's own fallback models and
 *     silently killed all synthesis — caught by /selftest on the live API.)
 *   • Retired/renamed model → try the next candidate model.
 *   • Anything else (credentials, quota, network, 5xx) → move to the next
 *     PROVIDER; the key/quota applies to every model on this provider, so
 *     retrying siblings would just burn latency.
 */
export function decideAfterFailedAttempt(
  lastError: string,
  emptyCompletion: boolean,
): AttemptDecision {
  if (emptyCompletion) return "next_candidate";
  return isModelSpecific(lastError) ? "next_candidate" : "next_provider";
}

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
    case "deepseek":
      return (model, req) =>
        openAiCompatibleCompletion(
          DEEPSEEK_URL,
          process.env.DEEPSEEK_API_KEY as string,
          model,
          req,
          `DeepSeek(${model})`,
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

  // Skip providers whose circuit is open. A provider that just failed with a
  // credential/quota error is not retried on every request — without this,
  // every single AI call paid a doomed round-trip to a misconfigured gateway
  // before the working provider answered (observed on the live deployment:
  // the workspace gateway rejects its key, so each call waited on `vly`
  // before falling through to Groq).
  const circuits = providers.filter((p) => breakerAllow(`ai:${p.id}`));
  // Never let the breaker be worse than no breaker: if every provider is
  // cooled down, ignore the circuits and try them all anyway.
  const ordered = circuits.length > 0 ? circuits : providers;

  for (const p of ordered) {
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
          breakerRecord(`ai:${p.id}`, true);
          return { ok: true, content, provider: p.id, model, attempts };
        }
        // Empty output from a call that otherwise succeeded is a
        // CANDIDATE-level failure, not a provider-level one. Reasoning models
        // can spend the whole maxTokens budget on hidden reasoning and return
        // no visible content, and the next model on the SAME provider usually
        // answers fine. Breaking out here (the previous behaviour) silently
        // skipped this provider's own fallback models and lost synthesis
        // entirely — verified against the live deployment by /selftest.
        lastError = `${p.id} (${model}) returned an empty completion`;
        attempts.push({ provider: p.id, model, error: lastError.slice(0, 200) });
        if (decideAfterFailedAttempt(lastError, true) === "next_provider") break;
        continue;
      }

      lastError = result.error ?? `${p.id} failed`;
      attempts.push({ provider: p.id, model, error: lastError.slice(0, 200) });

      if (decideAfterFailedAttempt(lastError, false) === "next_provider") break;
    }

    // Reached only when no candidate produced content → provider-level failure.
    breakerRecord(`ai:${p.id}`, false);
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
