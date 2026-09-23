/**
 * VisionProvider catalog — pure metadata + validation. No SDK imports, no
 * fetch: safe to import from actions and tests alike (mirrors aiProviders/
 * catalog.ts conventions for the vision capability, master plan §3/§25).
 *
 * Scope (master plan §25): image UNDERSTANDING through permitted providers.
 * Image generation is deliberately absent — no permitted zero-cost provider
 * exists yet, and faking one would violate §35.
 *
 * Cost honesty: vision is optional and OFF unless a key exists (Groq free
 * tier / OpenAI metered). With no key, Omi reports "vision unavailable"
 * instead of pretending to see.
 */

import type { ProviderId } from "./catalog";
import { isProviderDisabled } from "./catalog";

/** Tasks vision is for: describing, extracting, answering about an image. */
export type VisionTask = "describe" | "extract" | "answer";

export type VisionProviderDescriptor = {
  id: Extract<ProviderId, "groq" | "gemini" | "openai">;
  label: string;
  /** Every env var here must be set for the provider to activate. */
  envKeys: string[];
  cost: string;
  /** Vision-capable models per task (env-overridable via VISION_<ID>_MODEL). */
  taskModels: Record<VisionTask, string>;
  /** Ordered fallbacks if the primary model is retired/rejected. */
  fallbackModels: string[];
  hint: string;
};

/**
 * The multimodal model Groq currently serves on its free tier.
 *
 * Groq shut down the Llama 4 vision family on 2026-07-17, and this app kept
 * requesting those retired IDs, so every image upload 404'd in production
 * while /status still called vision "available". The fix is threefold:
 *   1. a model Groq actually serves today (Qwen3.8 27B — its only listed
 *      multimodal model, and the only one with a documented file-size cap),
 *   2. discovery (aiProviders/modelDiscovery.ts) validates this ID against
 *      Groq's live /models list before it is ever sent a request, and
 *   3. VISION_GROQ_MODEL overrides it with no code change.
 * Any future retirement is therefore detected and reported, not discovered by
 * a user whose image quietly fails.
 */
export const GROQ_VISION_MODEL = "qwen/qwen3.8-27b";

export const VISION_PROVIDERS: VisionProviderDescriptor[] = [
  {
    id: "groq",
    label: "Groq Vision (free tier)",
    envKeys: ["GROQ_API_KEY"],
    cost: "free tier, rate-limited",
    taskModels: {
      describe: GROQ_VISION_MODEL,
      extract: GROQ_VISION_MODEL,
      answer: GROQ_VISION_MODEL,
    },
    // Empty on purpose: no other free-tier multimodal model is served, and a
    // guessed fallback would just add a doomed round-trip to every request.
    // Discovery + VISION_GROQ_MODEL cover replacement, honestly.
    fallbackModels: [],
    hint: "Add a free GROQ_API_KEY (console.groq.com → API Keys) in the project's API Keys tab.",
  },
  {
    // Second, INDEPENDENT vision provider: Groq's tier cap (429 "Request too
    // large ... tokens per minute") can no longer leave image understanding
    // unavailable, because Gemini speaks the same multimodal message shape
    // (text + image_url parts) on its own OpenAI-compatible endpoint and its
    // own free quota.
    id: "gemini",
    label: "Google Gemini Vision (free tier)",
    envKeys: ["GEMINI_API_KEY"],
    cost: "free tier, rate-limited",
    // Same 2026-09-23 probe as the text catalog: gemini-2.5-flash is listed
    // but 404s for new accounts, while the `-latest` alias and gemini-3.8-flash
    // answered. A vision fallback that 404s is worse than none, because it
    // hides the real failure behind a second round-trip.
    taskModels: {
      describe: "gemini-flash-latest",
      extract: "gemini-flash-latest",
      answer: "gemini-flash-latest",
    },
    fallbackModels: ["gemini-3.8-flash", "gemini-flash-lite-latest"],
    hint: "Add a free GEMINI_API_KEY (aistudio.google.com → Get API key) in the project's API Keys tab.",
  },
  {
    id: "openai",
    label: "OpenAI Vision",
    envKeys: ["OPENAI_API_KEY"],
    cost: "metered (optional adapter)",
    taskModels: {
      describe: "gpt-4o-mini",
      extract: "gpt-4o-mini",
      answer: "gpt-4o",
    },
    fallbackModels: ["gpt-4o-mini"],
    hint: "Optional paid adapter — add OPENAI_API_KEY only if you want it.",
  },
];

/** Per-call caps so one image can't flood storage or context (§12). */
export const VISION_LIMITS = {
  /** Base64 data URL size cap (~3.5 MB raw ≈ 4.7 MB encoded). */
  maxDataUrlChars: 4_700_000,
  maxImageBytes: 3_500_000,
  maxPromptChars: 2000,
  maxAnswerChars: 4000,
  /**
   * Completion budget for a vision answer — deliberately modest.
   *
   * Groq's free tier sizes a request by `prompt + max_tokens` and rejects an
   * oversized one with `429 "Request too large ... service tier on_demand on
   * tokens per minute (TPM)"`. Asking for 1024 tokens to describe one image
   * made every vision call hover at that ceiling, so requests intermittently
   * failed even though the model was fine. 512 tokens is ~380 words — far
   * more than any image description needs — while leaving real headroom on a
   * shared per-minute budget. Override with VISION_MAX_TOKENS if needed.
   */
  maxOutputTokens: 512,
} as const;

/**
 * Synthetic probe image for the PUBLIC self-test: a 64×64 solid-red PNG
 * (137 bytes), generated locally and pinned here as a constant.
 *
 * This lets the unauthenticated /selftest exercise the REAL vision path
 * end-to-end — provider, model, transport — without storing, fetching or
 * exposing anybody's upload. It is why vision can report a true PASS instead
 * of hiding behind "configured".
 */
export const VISION_PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsEvi2/55DGME38JgBZapfi0CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApcFEWchD98r0aIAAAAASUVORK5CYII=";

/** Asks for one word, so a non-empty answer proves the image was truly read. */
export const VISION_PROBE_PROMPT =
  "What single colour fills this image? Reply with one word.";

export const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function visionProviderConfigured(p: VisionProviderDescriptor): boolean {
  return (
    p.envKeys.every((k) => Boolean(process.env[k])) &&
    // Honour the deployment-level kill switch, same as the text chain — a
    // provider deliberately removed from routing must not sneak back in here.
    !isProviderDisabled(p.id)
  );
}

export function getConfiguredVisionProviders(): VisionProviderDescriptor[] {
  return VISION_PROVIDERS.filter(visionProviderConfigured);
}

export function hasVisionProvider(): boolean {
  return getConfiguredVisionProviders().length > 0;
}

export function activeVisionProvider(): VisionProviderDescriptor | null {
  return getConfiguredVisionProviders()[0] ?? null;
}

/** Env-overridable model (VISION_<ID>_MODEL) — swap models without code. */
export function visionModelFor(
  p: VisionProviderDescriptor,
  task: VisionTask,
): string {
  const override = process.env[`VISION_${p.id.toUpperCase()}_MODEL`]?.trim();
  return override || p.taskModels[task];
}

/**
 * Status for the UI (spec §3: report what is actually active).
 */
export function getVisionStatus() {
  const active = activeVisionProvider();
  return {
    available: active !== null,
    activeProvider: active?.id ?? null,
    activeLabel: active?.label ?? null,
    taskModels: active
      ? {
          describe: visionModelFor(active, "describe"),
          extract: visionModelFor(active, "extract"),
          answer: visionModelFor(active, "answer"),
        }
      : null,
    providers: VISION_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      configured: visionProviderConfigured(p),
      cost: p.cost,
      hint: p.hint,
    })),
  };
}

// --- Validation (shared by adapter and tests) -------------------------------

export type ValidatedImage =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

/** Validate a data URL is a supported, size-capped image. Never throws. */
export function validateImageDataUrl(dataUrl: string): ValidatedImage {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return { ok: false, error: "No image data received." };
  }
  if (dataUrl.length > VISION_LIMITS.maxDataUrlChars) {
    return { ok: false, error: "Image is too large — keep images under 3.5 MB." };
  }
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return {
      ok: false,
      error: "Unsupported image format — use PNG, JPEG, WebP or GIF.",
    };
  }
  return { ok: true, dataUrl };
}

/** Build an OpenAI-compatible multimodal user message from a data URL. */
export function buildImageMessageParts(
  dataUrl: string,
  prompt: string,
): Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
> {
  const clipped = prompt.trim().slice(0, VISION_LIMITS.maxPromptChars);
  return [
    { type: "text", text: clipped.length > 0 ? clipped : "Describe this image." },
    { type: "image_url", image_url: { url: dataUrl } },
  ];
}
