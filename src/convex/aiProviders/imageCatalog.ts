/**
 * ImageProvider catalog — pure metadata + capability map. No fetch, no SDK:
 * mirrors aiProviders/catalog.ts conventions for the image GENERATION /
 * EDITING capability (master plan §10 — image generation / multimedia).
 *
 * Why a separate catalog from vision: vision (understanding) and image
 * synthesis are different capabilities with different providers. Pollinations
 * does generation but not understanding; Groq does understanding but not
 * generation. A shared catalog would blur the capability routing that the
 * Image Engine depends on.
 *
 * Cost honesty: the primary generation provider is keyless and free.
 * Provider flags declare what each adapter ACTUALLY supports — the router
 * consults these flags rather than a hardcoded op→vendor mapping, so adding
 * a provider is one descriptor + one adapter, no call-site changes. Nothing
 * here claims a capability a provider cannot perform (the Pollinations
 * incident: text-to-image only, so it advertises generate + variation only).
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
  | "enhance"
  | "variation"
  | "combine"
  | "outpaint";

export const IMAGE_OPS: ImageOp[] = [
  "generate",
  "edit",
  "remove",
  "replace",
  "background",
  "style",
  "upscale",
  "enhance",
  "variation",
  "combine",
  "outpaint",
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

/**
 * What each operation genuinely requires. This is the single source of truth
 * the router, the UI, the normalizer and the self-test all consult, so an
 * operation can never be advertised in one place and refused in another.
 */
export type ImageOpMeta = {
  /** Human capability name, e.g. "image editing". */
  capability: string;
  /** Must receive at least one input image to be a real execution. */
  needsImageInput: boolean;
  /** Needs two or more input images (combine). */
  needsMultipleInputs: boolean;
  /** Accepts an input image to guide the result (variation: optional). */
  optionalImageInput: boolean;
};

export const IMAGE_OP_META: Record<ImageOp, ImageOpMeta> = {
  generate: { capability: "image generation", needsImageInput: false, needsMultipleInputs: false, optionalImageInput: false },
  variation: { capability: "image variation", needsImageInput: false, needsMultipleInputs: false, optionalImageInput: true },
  edit: { capability: "image editing", needsImageInput: true, needsMultipleInputs: false, optionalImageInput: false },
  remove: { capability: "background removal", needsImageInput: true, needsMultipleInputs: false, optionalImageInput: false },
  replace: { capability: "background replacement", needsImageInput: true, needsMultipleInputs: false, optionalImageInput: false },
  background: { capability: "background editing", needsImageInput: true, needsMultipleInputs: false, optionalImageInput: false },
  style: { capability: "style transfer", needsImageInput: true, needsMultipleInputs: false, optionalImageInput: false },
  upscale: { capability: "upscaling", needsImageInput: true, needsMultipleInputs: false, optionalImageInput: false },
  enhance: { capability: "image enhancement", needsImageInput: true, needsMultipleInputs: false, optionalImageInput: false },
  combine: { capability: "image combination", needsImageInput: true, needsMultipleInputs: true, optionalImageInput: false },
  outpaint: { capability: "outpainting", needsImageInput: true, needsMultipleInputs: false, optionalImageInput: false },
};

/** Does this op necessarily require an input image? */
export function opNeedsImage(op: ImageOp): boolean {
  return IMAGE_OP_META[op].needsImageInput;
}

/** Does this op require two or more input images? */
export function opNeedsMultiple(op: ImageOp): boolean {
  return IMAGE_OP_META[op].needsMultipleInputs;
}

/** Human capability name for an op (used for honest unavailability errors). */
export function capabilityForOp(op: ImageOp): string {
  return IMAGE_OP_META[op].capability;
}

/**
 * Provider capability declaration. `ops` is the authoritative list; these
 * booleans make the intent explicit for the router and the status endpoint
 * without the caller having to re-derive them from `ops`.
 */
export type ImageCapabilityFlags = {
  generation: boolean;
  imageInput: boolean;
  editing: boolean;
  backgroundRemoval: boolean;
  backgroundReplacement: boolean;
  styleTransfer: boolean;
  upscale: boolean;
  variation: boolean;
  combine: boolean;
  transparency: boolean;
  /**
   * Whether a credential is required. Pollinations is keyless (false); every
   * key-bearing adapter is true. Auth status is a health input, never a
   * capability claim.
   */
  authRequired: boolean;
};

export type ImageProviderDescriptor = {
  id: Extract<ProviderId, "gemini" | "openai"> | "pollinations";
  label: string;
  /** Every env var here must be set for the provider to activate ([] = keyless). */
  envKeys: string[];
  cost: string;
  /** Which operations this provider genuinely implements (router consults this). */
  ops: ImageOp[];
  capabilities: ImageCapabilityFlags;
  /** Edit/remove/replace/combine accept input image(s). */
  supportsImageInput: boolean;
  /** Can return alpha-channel PNGs ("transparent background"). */
  supportsTransparency: boolean;
  /** Honors width/height (else the adapter crops/pads via aspect hints). */
  supportsSizeControl: boolean;
  /** Pixel dimensions the provider documents, informational for the UI. */
  resolutions: number[];
  hint: string;
};

function flagsFromOps(
  ops: ImageOp[],
  over: Partial<ImageCapabilityFlags> = {},
): ImageCapabilityFlags {
  return {
    generation: ops.includes("generate"),
    imageInput: false,
    editing: ops.includes("edit"),
    backgroundRemoval: ops.includes("remove"),
    backgroundReplacement: ops.includes("replace") || ops.includes("background"),
    styleTransfer: ops.includes("style"),
    upscale: ops.includes("upscale") || ops.includes("enhance"),
    variation: ops.includes("variation"),
    combine: ops.includes("combine"),
    transparency: false,
    authRequired: false,
    ...over,
  };
}

/**
 * Registered image providers in router priority order.
 *
 *  1. Pollinations — keyless, free. VERIFIED LIVE: its /models endpoint
 *     serves ["sana"] — text-to-image ONLY, no image input — so it honestly
 *     advertises generate + variation and nothing more. Claiming edit ops
 *     here would produce runtime failures masquerading as features.
 *     (Seen in production: an edit request silently became a new random
 *     image because a text-only provider answered it. The router no longer
 *     lets an edit reach a text-only provider at all.)
 *  2. Gemini (gemini-2.5-flash-image) — the edit/remove/background/style/
 *     combine engine. Activates the moment GEMINI_API_KEY exists; the
 *     router skips it silently until then. A configured key that returns
 *     429 is NOT a working editor — the router surfaces that exact reason.
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
    // /models serves ["sana"] (text-to-image only). A variation is a re-roll
    // of the same prompt (new seed), which it does.
    ops: ["generate", "variation"],
    capabilities: flagsFromOps(["generate", "variation"], {
      imageInput: false,
      transparency: false,
      authRequired: false,
    }),
    supportsImageInput: false,
    supportsTransparency: false,
    supportsSizeControl: true,
    resolutions: [1024, 1280, 1344],
    hint: "Works with no key. Editing needs a key-bearing provider (Gemini or OpenAI).",
  },
  {
    id: "gemini",
    label: "Google Gemini Image",
    envKeys: ["GEMINI_API_KEY"],
    // Measured with a real key: TEXT on this provider is free-tier, but every
    // image model answered 429 "exceeded your current quota". A configured
    // key is therefore NOT a working image editor — the router surfaces that
    // exact error, and /selftest distinguishes the two.
    cost: "text is free-tier; image generation requires billing enabled on the project",
    ops: [
      "generate",
      "edit",
      "remove",
      "replace",
      "background",
      "style",
      "upscale",
      "enhance",
      "variation",
      "combine",
      "outpaint",
    ],
    capabilities: flagsFromOps(
      ["generate", "edit", "remove", "replace", "background", "style", "upscale", "enhance", "variation", "combine", "outpaint"],
      { imageInput: true, transparency: true, authRequired: true },
    ),
    supportsImageInput: true,
    supportsTransparency: true,
    supportsSizeControl: false,
    resolutions: [1024],
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
      "enhance",
      "variation",
      "combine",
      "outpaint",
    ],
    capabilities: flagsFromOps(
      ["generate", "edit", "remove", "replace", "background", "style", "upscale", "enhance", "variation", "combine", "outpaint"],
      { imageInput: true, transparency: true, authRequired: true },
    ),
    supportsImageInput: true,
    supportsTransparency: true,
    supportsSizeControl: false,
    resolutions: [1024, 1536],
    hint: "Optional paid adapter — add OPENAI_API_KEY only if you want it.",
  },
];

/** Is this provider's credential present? Keyless providers are always true. */
export function providerConfigured(p: ImageProviderDescriptor): boolean {
  return p.envKeys.length === 0 || p.envKeys.every((k) => (process.env[k] ?? "").length > 0);
}

/**
 * Honest capability report for /status (public metadata only — no secrets, no
 * env names). `configured` means a key exists, NOT that the capability works;
 * the self-test proves which capabilities actually run.
 */
export function getImageProviderStatus() {
  return IMAGE_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    cost: p.cost,
    configured: providerConfigured(p),
    ops: p.ops,
    capabilities: p.capabilities,
    supportsImageInput: p.supportsImageInput,
    transparentBackground: p.supportsTransparency,
    resolutions: p.resolutions,
  }));
}

/**
 * Static, honest capability availability: for every op, is there a configured
 * provider that genuinely declares it (and can accept image input when the op
 * demands it)? This is what the UI shows BEFORE a run — configuration truth,
 * not a fake "available" claim that only a live call can settle.
 */
export function getImageCapabilityReport() {
  const configured = IMAGE_PROVIDERS.filter(providerConfigured);
  return IMAGE_OPS.map((op) => {
    const meta = IMAGE_OP_META[op];
    const capable = configured.filter(
      (p) =>
        p.ops.includes(op) &&
        (!meta.needsImageInput || p.supportsImageInput) &&
        (!meta.needsMultipleInputs || p.supportsImageInput),
    );
    return {
      op,
      capability: meta.capability,
      needsImageInput: meta.needsImageInput,
      needsMultipleInputs: meta.needsMultipleInputs,
      // "available" here = a configured provider declares it; a live run may
      // still fail, which the caller reports separately.
      available: capable.length > 0,
      providers: capable.map((p) => p.id),
    };
  });
}
