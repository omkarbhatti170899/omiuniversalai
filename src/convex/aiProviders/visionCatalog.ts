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

/** Tasks vision is for: describing, extracting, answering about an image. */
export type VisionTask = "describe" | "extract" | "answer";

export type VisionProviderDescriptor = {
  id: Extract<ProviderId, "groq" | "openai">;
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

export const VISION_PROVIDERS: VisionProviderDescriptor[] = [
  {
    id: "groq",
    label: "Groq Vision (free tier)",
    envKeys: ["GROQ_API_KEY"],
    cost: "free tier, rate-limited",
    taskModels: {
      describe: "meta-llama/llama-4-scout-17b-16e-instruct",
      extract: "meta-llama/llama-4-scout-17b-16e-instruct",
      answer: "meta-llama/llama-4-scout-17b-16e-instruct",
    },
    // Scout → Maverick: both multimodal; llama-4 name changes are handled
    // without a code change via VISION_GROQ_MODEL.
    fallbackModels: ["meta-llama/llama-4-maverick-17b-128e-instruct"],
    hint: "Add a free GROQ_API_KEY (console.groq.com → API Keys) in the project's API Keys tab.",
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
} as const;

export const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function visionProviderConfigured(p: VisionProviderDescriptor): boolean {
  return p.envKeys.every((k) => Boolean(process.env[k]));
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
