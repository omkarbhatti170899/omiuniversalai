/**
 * VisionProvider adapter (master plan §3/§25) — image understanding through
 * the provider chain. Provider-neutral: call sites declare the vision TASK,
 * never a vendor or model.
 *
 * Transport: OpenAI-compatible chat-completions with multimodal content
 * parts — the protocol Groq and OpenAI both speak. The workspace gateway is
 * deliberately NOT a vision provider: its transport is string-content only
 * (verified in vly-integrations.ts), and pretending otherwise would produce
 * runtime failures masquerading as a feature (§35).
 *
 * Cost: optional only. With no vision-capable key configured, describeImage
 * returns ok:false with an actionable message — Omi never fakes "seeing".
 */

import {
  VISION_LIMITS,
  buildImageMessageParts,
  getConfiguredVisionProviders,
  visionModelFor,
  type VisionTask,
} from "./visionCatalog";
import { GROQ_URL, OPENAI_URL } from "./catalog";
import { isModelSpecific } from "./openaiCompat";
import { filterToAvailableModels } from "./modelDiscovery";
import type { ProviderId } from "./catalog";

export type VisionResult = {
  ok: boolean;
  description: string;
  /** Which provider/model actually served the request (null when all failed). */
  provider: string | null;
  model: string | null;
  attempts: Array<{ provider: string; model: string; error?: string }>;
  error?: string;
};

const VISION_TIMEOUT_MS = 45_000;

/**
 * Endpoint for vision-capable providers (both speak the compatible protocol).
 * Returns null for any provider without a vision endpoint so describeImage
 * can skip it instead of throwing (the adapter never throws).
 */
function endpointFor(id: ProviderId): string | null {
  switch (id) {
    case "groq":
      return GROQ_URL;
    case "openai":
      return OPENAI_URL;
    default:
      // e.g. the workspace gateway — string-content transport, not vision-capable.
      return null;
  }
}

async function visionCompletion(
  url: string,
  apiKey: string,
  model: string,
  parts: ReturnType<typeof buildImageMessageParts>,
  label: string,
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: parts }],
        // Kept small on purpose — an upstream provider sizes the request as
        // prompt + max_tokens against a per-minute tier cap, so a generous
        // budget here turns into intermittent 429s on a free tier.
        max_tokens: Math.max(
          64,
          Number(
            process.env.VISION_MAX_TOKENS ?? VISION_LIMITS.maxOutputTokens,
          ) || VISION_LIMITS.maxOutputTokens,
        ),
      }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return {
        success: false,
        error: `${label} error ${res.status}: ${bodyText.slice(0, 160)}`,
      };
    }
    const parsed = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = (parsed.choices?.[0]?.message?.content ?? "").trim();
    if (content.length === 0) {
      return { success: false, error: `${label} returned an empty description` };
    }
    return { success: true, content };
  } catch (e) {
    return {
      success: false,
      error: `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Understand one image via the vision provider chain. Never throws.
 * `prompt` says what to do with the image; `task` picks the model tier.
 */
export async function describeImage(
  dataUrl: string,
  prompt: string,
  task: VisionTask = "describe",
): Promise<VisionResult> {
  const attempts: VisionResult["attempts"] = [];
  const providers = getConfiguredVisionProviders();
  if (providers.length === 0) {
    return {
      ok: false,
      description: "",
      provider: null,
      model: null,
      attempts,
      error:
        "Vision is unavailable: add a free GROQ_API_KEY (or optional OPENAI_API_KEY) in the project's API Keys tab.",
    };
  }

  const parts = buildImageMessageParts(dataUrl, prompt);

  for (const p of providers) {
    const url = endpointFor(p.id);
    if (url === null) {
      attempts.push({ provider: p.id, model: "—", error: "provider has no vision endpoint" });
      continue;
    }
    const primary = visionModelFor(p, task);
    const preferred = [primary, ...p.fallbackModels.filter((m) => m !== primary)];
    const apiKey = process.env[p.envKeys[0]] ?? "";

    // Never send an image request for a model the provider no longer serves.
    // The retired-Llama-4 incident was precisely this: a configured-but-dead
    // model ID 404'd on every upload while the capability still reported
    // "available". Discovery fails open, so it can only remove models the
    // provider has confirmed are gone.
    const candidates = await filterToAvailableModels(
      p.id,
      url,
      apiKey,
      preferred,
    );
    let lastError = "";

    for (const model of candidates) {
      const result = await visionCompletion(
        url,
        apiKey,
        model,
        parts,
        `${p.label}(${model})`,
      );
      if (result.success && result.content) {
        return {
          ok: true,
          description: result.content.slice(0, VISION_LIMITS.maxAnswerChars),
          provider: p.id,
          model,
          attempts,
        };
      }
      lastError = result.error ?? `${p.id} failed`;
      attempts.push({ provider: p.id, model, error: lastError.slice(0, 200) });
      if (!isModelSpecific(lastError)) break;
    }
  }

  return {
    ok: false,
    description: "",
    provider: null,
    model: null,
    attempts,
    error:
      attempts
        .map((a) => `${a.provider}: ${a.error}`)
        .join(" | ")
        .slice(0, 400) || "all vision providers failed",
  };
}
