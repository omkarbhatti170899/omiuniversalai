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
  GEMINI_URL,
  OPENAI_URL,
  DEEPSEEK_URL,
  getConfiguredAiProviders,
  type AiTask,
  type ProviderDescriptor,
} from "./catalog";
import {
  isModelSpecific,
  openAiCompatibleCompletion,
  openAiCompatibleStream,
} from "./openaiCompat";
import { vlyCompletion } from "./vly";
import { filterToAvailableModels } from "./modelDiscovery";
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

export type StreamArgs = CompleteArgs & {
  /** Called for every token delta with (delta, fullTextSoFar). */
  onToken: (delta: string, full: string) => void | Promise<void>;
  /** Cooperative cancel — aborts the in-flight provider request. */
  signal?: AbortSignal;
};

export type AiStreamResult = AiCompletionResult & {
  /** True when the caller's Stop signal ended the stream (partial kept). */
  stopped?: boolean;
  /** True when a provider failed AFTER emitting tokens (partial kept). */
  partial?: boolean;
};

export type CompleteArgs = CompletionRequest & {
  task?: AiTask;
  /**
   * Pin the request to ONE provider — deliberately bypassing the routing
   * order so a health check can verify a specific provider (a self-test
   * proving the SECONDARY provider is genuinely working, not just
   * configured). Server-side callers only; never wired to user input, which
   * could otherwise be used to probe a provider the router would not pick.
   */
  onlyProvider?: ProviderDescriptor["id"];
  /**
   * §12 Settings — the user's provider preference ("auto" = router order).
   * Order-only, never a filter: the preference moves a CONFIGURED provider to
   * the front of the chain, and every other configured provider still follows
   * as fallback, so a preference can never take Omi's AI offline. Because it
   * only reorders what the environment already allows, it exposes nothing a
   * user could not already learn from the routing status in Settings.
   */
  preferProvider?: ProviderPreference;
};

/** "auto" means: leave the catalog's free-first order untouched. */
export type ProviderPreference = string;

/**
 * Move the preferred provider to the front of the chain (pure + unit-tested).
 * An unknown, unconfigured or already-first preference is a no-op — the
 * preference is a hint, never a precondition, and it can never remove a
 * fallback.
 */
export function orderByPreference<T extends { id: string }>(
  providers: T[],
  prefer?: ProviderPreference,
): T[] {
  if (!prefer || prefer === "auto") return providers;
  const index = providers.findIndex((p) => p.id === prefer);
  if (index <= 0) return providers;
  return [providers[index], ...providers.filter((_, i) => i !== index)];
}

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
    case "gemini":
      return (model, req) =>
        openAiCompatibleCompletion(
          GEMINI_URL,
          process.env.GEMINI_API_KEY as string,
          model,
          req,
          `Gemini(${model})`,
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
 * Endpoint + key for providers that speak the OpenAI-compatible protocol.
 * Returns null for the workspace gateway, which has a different transport and
 * no /models catalogue to consult.
 */
function transportFor(
  p: ProviderDescriptor,
): { url: string; key: string } | null {
  switch (p.id) {
    case "groq":
      return { url: GROQ_URL, key: process.env.GROQ_API_KEY ?? "" };
    case "gemini":
      return { url: GEMINI_URL, key: process.env.GEMINI_API_KEY ?? "" };
    case "openai":
      return { url: OPENAI_URL, key: process.env.OPENAI_API_KEY ?? "" };
    case "deepseek":
      return { url: DEEPSEEK_URL, key: process.env.DEEPSEEK_API_KEY ?? "" };
    default:
      // The workspace gateway — different transport, no /models catalogue.
      return null;
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

  const configured = orderByPreference(getConfiguredAiProviders(), args.preferProvider);
  // `onlyProvider` narrows the chain to a single provider (self-test probe).
  // Filtering BEFORE the circuit check keeps the call path otherwise identical.
  const providers = args.onlyProvider
    ? configured.filter((p) => p.id === args.onlyProvider)
    : configured;
  if (providers.length === 0) {
    return {
      ok: false,
      content: "",
      provider: null,
      model: null,
      attempts,
      error: args.onlyProvider
        ? `provider ${args.onlyProvider} is not configured`
        : "no AI provider is configured: add GROQ_API_KEY (free) or OPENAI_API_KEY in the project's API Keys tab",
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
    const preferred = [primary, ...p.fallbackModels.filter((m) => m !== primary)];

    // Drop models the provider no longer serves, so a retirement costs zero
    // round-trips instead of a 404 on every request (the failure mode that
    // silently broke vision in production). An explicit model override is
    // honoured as-is — the caller asked for that exact model — and discovery
    // fails open, so this can only ever remove models we know are gone.
    const transport = transportFor(p);
    const candidates =
      override || transport === null
        ? preferred
        : await filterToAvailableModels(
            p.id,
            transport.url,
            transport.key,
            preferred,
          );
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

/**
 * Streaming twin of `complete`. Same provider ordering, model discovery,
 * preference handling and circuit breaking — the ONLY difference is that
 * tokens are handed to `onToken` as they arrive instead of being returned
 * whole.
 *
 * Fallback semantics (the part that must be right):
 *   • A provider that fails BEFORE emitting any token is transparently
 *     skipped — the next model/provider answers, and the user never sees the
 *     failed attempt.
 *   • A provider that emits tokens and then dies or is Stopped is COMMITTED:
 *     we keep its partial text and stop. Silently restarting the answer on a
 *     different provider would splice two different responses together, which
 *     is worse than honest partial output.
 *   • Zero tokens after a successful stream is an empty completion and is
 *     treated as a candidate-level failure (same as the non-streaming path).
 */
export async function completeStream(
  args: StreamArgs,
): Promise<AiStreamResult> {
  const task: AiTask = args.task ?? "conversational";
  const req: CompletionRequest = {
    messages: args.messages,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
  };
  const attempts: AiAttempt[] = [];

  const configured = orderByPreference(
    getConfiguredAiProviders(),
    args.preferProvider,
  );
  const providers = args.onlyProvider
    ? configured.filter((p) => p.id === args.onlyProvider)
    : configured;
  if (providers.length === 0) {
    return {
      ok: false,
      content: "",
      provider: null,
      model: null,
      attempts,
      error: args.onlyProvider
        ? `provider ${args.onlyProvider} is not configured`
        : "no AI provider is configured: add GROQ_API_KEY (free) or OPENAI_API_KEY in the project's API Keys tab",
    };
  }

  const override = args.model?.trim();
  const circuits = providers.filter((p) => breakerAllow(`ai:${p.id}`));
  const ordered = circuits.length > 0 ? circuits : providers;

  for (const p of ordered) {
    const primary =
      override || p.taskModels[task] || p.taskModels.conversational;
    const preferred = [primary, ...p.fallbackModels.filter((m) => m !== primary)];
    const transport = transportFor(p);
    const candidates =
      override || transport === null
        ? preferred
        : await filterToAvailableModels(
            p.id,
            transport.url,
            transport.key,
            preferred,
          );
    let lastError = "";

    for (const model of candidates) {
      if (args.signal?.aborted) {
        // Stopped before this candidate started — nothing was shown.
        return {
          ok: false,
          content: "",
          provider: null,
          model: null,
          attempts,
          stopped: true,
        };
      }

      if (transport === null) {
        // Non-streaming transport (workspace gateway): run it whole, then
        // emit the finished text as a single token so the caller's contract
        // ("onToken is called with content") holds for every provider.
        const result = await adapterFor(p)(model, req);
        if (result.success && result.data) {
          const content = (
            result.data.choices?.[0]?.message?.content ?? ""
          ).trim();
          if (content.length > 0) {
            breakerRecord(`ai:${p.id}`, true);
            await args.onToken(content, content);
            return { ok: true, content, provider: p.id, model, attempts };
          }
          lastError = `${p.id} (${model}) returned an empty completion`;
          attempts.push({ provider: p.id, model, error: lastError.slice(0, 200) });
          if (decideAfterFailedAttempt(lastError, true) === "next_provider") break;
          continue;
        }
        lastError = result.error ?? `${p.id} failed`;
        attempts.push({ provider: p.id, model, error: lastError.slice(0, 200) });
        if (decideAfterFailedAttempt(lastError, false) === "next_provider") break;
        continue;
      }

      const outcome = await openAiCompatibleStream(
        transport.url,
        transport.key,
        model,
        req,
        `${p.label}(${model})`,
        args.onToken,
        args.signal,
      );

      if (outcome.emitted) {
        // Committed: tokens are already visible. Keep the partial answer.
        breakerRecord(`ai:${p.id}`, true);
        return {
          ok: true,
          content: outcome.content,
          provider: p.id,
          model,
          attempts,
          ...(outcome.aborted ? { stopped: true } : {}),
          ...(outcome.success ? {} : { partial: true, error: outcome.error }),
        };
      }

      if (outcome.success) {
        lastError = `${p.id} (${model}) returned an empty completion`;
        attempts.push({ provider: p.id, model, error: lastError.slice(0, 200) });
        if (decideAfterFailedAttempt(lastError, true) === "next_provider") break;
        continue;
      }

      lastError = outcome.error ?? `${p.id} failed`;
      attempts.push({ provider: p.id, model, error: lastError.slice(0, 200) });
      if (decideAfterFailedAttempt(lastError, false) === "next_provider") break;
    }

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
