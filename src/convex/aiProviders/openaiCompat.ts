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

/**
 * Combine a caller's cancel signal with the provider deadline, without
 * depending on `AbortSignal.any` (not available on every runtime we target).
 * Aborting the returned controller aborts the underlying fetch.
 */
function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return { signal: timeout, timeout };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (external.aborted || timeout.aborted) {
    controller.abort();
  } else {
    external.addEventListener("abort", onAbort, { once: true });
    timeout.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: controller.signal, timeout };
}

/** Outcome of one streaming attempt. Never throws. */
export type StreamOutcome = {
  success: boolean;
  /** Text accumulated so far (partial text is preserved on abort/failure). */
  content: string;
  /** True when at least one token reached the caller. */
  emitted: boolean;
  /** True when the caller's cancel signal stopped the stream. */
  aborted: boolean;
  error?: string;
};

/**
 * Streaming variant of the OpenAI-compatible transport: reads the SSE body
 * token by token and hands each delta to `onToken`. Partial text survives a
 * mid-stream failure or a user Stop, which is what lets the chat layer show
 * honest progressive output instead of discarding work or hanging.
 */
export async function openAiCompatibleStream(
  url: string,
  apiKey: string,
  model: string,
  req: CompletionRequest,
  label: string,
  onToken: (delta: string, full: string) => void | Promise<void>,
  external?: AbortSignal,
): Promise<StreamOutcome> {
  const timeoutMs = Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 45_000);
  const { signal } = combineSignals(external, timeoutMs);
  let full = "";
  let emitted = false;

  const finish = (over: Partial<StreamOutcome>): StreamOutcome => ({
    success: over.success ?? false,
    content: full,
    emitted,
    aborted: over.aborted ?? false,
    ...(over.error ? { error: over.error } : {}),
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        stream: true,
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      const bodyText = await res.text().catch(() => "");
      return finish({
        error: `${label} error ${res.status}: ${bodyText.slice(0, 160)}`,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    stream: for (;;) {
      if (external?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line for the next chunk.
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // A Stop must not wait for buffered tokens to drain.
        if (external?.aborted) break stream;
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data.length === 0 || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            full += delta;
            emitted = true;
            await onToken(delta, full);
            if (external?.aborted) break stream;
          }
        } catch {
          // A malformed / keep-alive SSE line is not a stream failure.
        }
      }
    }

    if (external?.aborted) return finish({ success: true, aborted: true });
    return finish({ success: true });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // A user Stop surfaces as an AbortError — report it as a clean stop, not
    // a provider failure, and keep whatever was already streamed.
    if (external?.aborted) return finish({ success: true, aborted: true });
    const msg = /abort|timeout|timed out/i.test(raw)
      ? `${label} timed out after ${Math.round(timeoutMs / 1000)}s`
      : `${label} failed: ${raw}`;
    return finish({ error: msg });
  }
}

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

/**
 * True when the failure is an upstream rate/tier limit — retryable, and NOT
 * evidence that the capability is broken.
 *
 * Groq answers an oversized request with `429 "Request too large ... service
 * tier on_demand on tokens per minute (TPM): Limit N, Requested M"`; the
 * capability may be perfectly healthy. Distinguishing this from a genuinely
 * broken provider is what keeps a transient limit from being reported as a
 * hard failure (or, worse, from looking like the retired-model bug).
 */
export function isRateLimited(error?: string): boolean {
  const msg = (error ?? "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("too many requests") ||
    msg.includes("tokens per minute") ||
    msg.includes("request too large")
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

/** `unverified` means "could not be checked right now", not "broken". */
export type ProviderFailureVerdict = "fail" | "unverified";

/**
 * Decide whether failed provider attempts mean the capability is BROKEN, or
 * whether it simply could not be exercised right now.
 *
 * Pure and shared, because the distinction is the difference between an
 * honest health report and a misleading one:
 *
 *   • retired/missing model → `fail`. A provider shutting a model down is the
 *     exact bug class that silently broke vision in production, so it must
 *     never be softened into "couldn't check".
 *   • upstream rate/tier limit → `unverified`. The capability may be perfectly
 *     healthy and merely out of budget this minute; reporting FAIL there is
 *     the false signal this logic exists to prevent.
 *   • anything else → `fail`.
 */
export function classifyProviderFailure(
  attempts: Array<{ error?: string }>,
): ProviderFailureVerdict {
  if (attempts.some((a) => isModelSpecific(a.error))) return "fail";
  if (attempts.some((a) => isRateLimited(a.error))) return "unverified";
  return "fail";
}
