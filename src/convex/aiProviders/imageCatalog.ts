/**
 * ImageProvider catalog — pure metadata + capability map. No fetch, no SDK:
 * mirrors aiProviders/catalog.ts conventions for the image GENERATION/
 * EDITING capability (master plan §10 — image generation / multimedia).
 *
 * Why a separate catalog from vision: vision (understanding) and image
 * synthesis are different capabilities with different providers. Pollinations
 * does generation but not understanding; Groq does understanding but not
 * generation. A shared catalog would blur the capability routing §3 demands.
 *
 * Cost honesty (§13): the primary generation provider is keyless and free.
 * Provider flags declare what each adapter ACTUALLY supports — the router
 * consults these flags rather than a hardcoded op→vendor mapping, so adding
 * a provider is one descriptor + one adapter, no call-site changes.
 */

import type { ProviderId } from "./catalog";

export type ImageOp =
  | "generate"
  | "edit"
  | "remove"
  | "replace"
  | "background"
  | "style"
  | "upscale"
  | "variation"
  | "combine";

export const IMAGE_OPS: ImageOp[] = [
  "generate",
  "edit",
  "remove",
  "replace",
  "background",
  "style",
  "upscale",
  "variation",
  "combine",
];

export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";

/** Pixel dimensions Omi requests per aspect ratio (rounded to /8). */
export const ASPECT_RATIOS: Record<AspectRatio, { w: number; h: number }> = {
  "1:1": { w: 1024, h: 1024 },
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 720, h: 1280 },
  "4:3": { w: 1024, h: 768 },
  "3:4": { w: 768, h: 1024 },
  "3:2": { w: 1344, h: 896 },
  "2:3": { w: 896, h: 1344 },
};

export type ImageProviderDescriptor = {
  id: Extract<ProviderId, "gemini" | "openai"> | "pollinations";
  label: string;
  /** Every env var here must be set for the provider to activate ([] = keyless). */
  envKeys: string[];
  cost: string;
  /** Which operations this provider genuinely implements (router consults this). */
  ops: ImageOp[];
  /** Edit/remove/replace/combine accept input image(s). */
  supportsImageInput: boolean;
  /** Can return alpha-channel PNGs ("transparent background"). */
  supportsTransparency: boolean;
  /** Honors width/height (else the adapter crops/pads via aspect hints). */
  supportsSizeControl: boolean;
  hint: string;
};

/**
 * Registered image providers in router priority order.
 *
 *  1. Pollinations — keyless, free. VERIFIED LIVE: its /models endpoint
 *     serves ["sana"] — text-to-image ONLY, no image input — so it honestly
 *     advertises generate + variation and nothing more. Claiming edit ops
 *     here would produce runtime failures masquerading as features (§35).
 *  2. Gemini (gemini-2.5-flash-image) — the edit/remove/background/style/
 *     combine engine. Activates the moment GEMINI_API_KEY exists; the
 *     router skips it silently until then.
 *  3. OpenAI (gpt-image-1) — optional paid adapter, off unless a key exists.
 *
 * To add a provider (e.g. a self-hosted SDXL endpoint later): add a
 * descriptor here + an adapter in imageProviders.ts. No call-site changes.
 */
export const IMAGE_PROVIDERS: ImageProviderDescriptor[] = [
  {
    id: "pollinations",
    label: "Pollinations (free, keyless)",
    envKeys: [],
    cost: "free, keyless, rate-limited",
    // /models serves ["sana"] (text-to-image only) — verified 2026-09. A
    // variation is a re-roll of the same prompt (new seed), which it does.
    ops: ["generate", "variation"],
    supportsImageInput: false,
    supportsTransparency: false,
    supportsSizeControl: true,
    hint: "Works with no key. Editing needs a key-bearing provider (Gemini).",
  },
  {
    id: "gemini",
    label: "Google Gemini Image",
    envKeys: ["GEMINI_API_KEY"],
    // Measured 2026-09-23 with a real key: TEXT on this provider is free-tier,
    // but every image model (gemini-2.5-flash-image, gemini-3.1-flash-image,
    // gemini-3.1-flash-image-preview, gemini-3.1-flash-lite-image,
    // gemini-3-pro-image) answered 429 "exceeded your current quota". A
    // configured key is therefore NOT a working image editor — the router
    // surfaces that exact error, and /selftest's `image engine` probe is what
    // distinguishes the two.
    cost: "text is free-tier; image generation requires billing enabled on the project",
    ops: [
      "generate",
      "edit",
      "remove",
      "replace",
      "background",
      "style",
      "upscale",
      "variation",
      "combine",
    ],
    supportsImageInput: true,
    supportsTransparency: true,
    supportsSizeControl: false,
    hint: "Add a free GEMINI_API_KEY (aistudio.google.com → Get API key).",
  },
  {
    id: "openai",
    label: "OpenAI Images",
    envKeys: ["OPENAI_API_KEY"],
    cost: "metered (optional adapter)",
    ops: [
      "generate",
      "edit",
      "remove",
      "replace",
      "background",
      "style",
      "upscale",
      "variation",
      "combine",
    ],
    supportsImageInput: true,
    supportsTransparency: true,
    supportsSizeControl: false,
    hint: "Optional paid adapter — add OPENAI_API_KEY only if you want it.",
  },
];

/** Honest capability report for /status (public metadata only — no secrets). */
export function getImageProviderStatus() {
  return IMAGE_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    cost: p.cost,
    configured:
      p.envKeys.length === 0 ||
      p.envKeys.every((k) => (process.env[k] ?? "").length > 0),
    ops: p.ops,
    transparentBackground: p.supportsTransparency,
  }));
}
