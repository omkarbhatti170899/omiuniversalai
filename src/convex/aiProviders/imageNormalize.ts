/**
 * Image prompt/intent normalizer — pure, zero network, unit-tested.
 *
 * The user speaks naturally; a diffusion model needs structure. This layer
 * sits between them and does two jobs:
 *
 *  1. STRUCTURE — pull the subject, environment, style, lighting, camera,
 *     aspect ratio, required objects and forbidden objects out of the raw
 *     sentence into an explicit record that the router and the prompt builder
 *     can reason about (rather than forwarding one unstructured blob).
 *
 *  2. PRESERVATION — for any EDIT, state exactly what must NOT change:
 *     identity, pose, composition, lighting, non-target objects and
 *     "everything the user did not ask to change". This is the difference
 *     between "change the shirt to black" and "generate a new person wearing
 *     a black shirt". The background is only preserved when the requested op
 *     is not itself about the background.
 *
 * The extraction is deliberately conservative and explainable: it never
 * invents a subject the user did not mention, and for plain generation it
 * leaves the user's own wording intact ("don't unnecessarily rewrite the
 * user's intent").
 */

import {
  IMAGE_OP_META,
  type AspectRatio,
  type ImageOp,
} from "./imageCatalog";

export type NormalizedImageRequest = {
  op: ImageOp;
  /** The user's own words, trimmed. */
  raw: string;
  /** Provider-ready prompt (built by composeImagePrompt). */
  prompt: string;
  subject: string;
  action: string;
  environment: string;
  style: string;
  lighting: string;
  camera: string;
  aspectRatio?: AspectRatio;
  /** Concrete things that must appear. */
  required: string[];
  /** Concrete things that must NOT change (edit ops). */
  preserve: string[];
  /** Things to avoid entirely. */
  negative: string[];
  /** Whether this op is an edit that carries preservation constraints. */
  preservation: boolean;
};

/** Keyword banks — small, explicit and testable. */
const STYLE_WORDS =
  /\b(cinematic|photorealistic|photoreal|realistic|anime|manga|cartoon|watercolor|oil painting|pixel art|3d render|digital art|cyberpunk|steampunk|minimalist|impressionist|vaporwave|noir|comic|sketch|line art|low poly|claymation|studio ghibli|k-?drama|film still|movie still)\b/i;

const LIGHTING_WORDS =
  /\b(golden hour|blue hour|sunset|sunrise|dusk|dawn|night|midnight|neon|backlit|rim light|soft light|hard light|studio light|dramatic lighting|candlelit|moonlit|overcast|harsh shadows|volumetric|god rays)\b/i;

const CAMERA_WORDS =
  /\b(close-?up|wide shot|wide-?angle|portrait shot|full body|full-?body|macro|aerial|bird'?s eye|top-?down|low angle|high angle|over-the-shoulder|bokeh|shallow depth of field|depth of field|fisheye|telephoto|85mm|50mm|35mm|24mm|f\/[0-9.]+)\b/i;

const ENVIRONMENT_WORDS =
  /\b(tokyo|paris|mumbai|pune|delhi|new york|london|beach|forest|desert|mountain|mountains|city|skyline|street|studio|room|office|cafe|kitchen|park|rooftop|space|underwater|snow|rain|japan|india)\b/i;

const CHANGE_VERBS =
  /\b(change|make|turn|recolor|recolour|set|paint|replace|swap|remove|delete|erase|add|put|insert|brighten|darken|lighten|enlarge|shrink|move|rotate|blur|sharpen|extend|outpaint|expand|crop|combine|merge|blend)\b/i;

const ASPECT_RE = /\b(1:1|16:9|9:16|4:3|3:4|3:2|2:3)\b/;

/**
 * Which parts of the image the operation is allowed to touch. Everything else
 * is preserved. This is the list that stops an edit from drifting.
 */
const OP_TARGETS: Record<ImageOp, string[]> = {
  generate: [],
  variation: ["overall composition"],
  edit: ["the explicitly requested change"],
  remove: ["the removed region"],
  replace: ["the background"],
  background: ["the background"],
  style: ["rendering style"],
  upscale: [],
  enhance: [],
  combine: ["the composite layout"],
  outpaint: ["the new extended area"],
};

/** Features that are preserved for every edit-class op unless targeted. */
const ALWAYS_PRESERVE = [
  "the subject's identity and facial features",
  "hair",
  "body shape and pose",
  "clothing (unless explicitly changed)",
  "non-target objects",
  "lighting",
  "camera angle",
  "composition",
];

/**
 * The preservation clause for an op — the human sentence that goes into the
 * prompt AND the structured list the caller can display. For ops that
 * inherently change the whole frame (upscale/enhance keep content; style
 * changes rendering only), the list is narrowed accordingly.
 */
export function preserveDefaults(op: ImageOp): string[] {
  const meta = IMAGE_OP_META[op];
  if (!meta.needsImageInput) return [];
  const targets = OP_TARGETS[op].join(" ").toLowerCase();
  const list = [...ALWAYS_PRESERVE];
  const extra: string[] = [];
  // Background is preserved unless the op itself is about the background.
  if (!targets.includes("background")) extra.push("the background");
  if (op === "upscale" || op === "enhance") {
    extra.push("all content, colours and detail (only clarity/resolution improves)");
  }
  extra.push("everything else the user did not ask to change");
  return [...list, ...extra];
}

function firstMatch(text: string, re: RegExp): string {
  const m = text.match(re);
  return m ? m[1] : "";
}

function extractAspect(text: string): AspectRatio | undefined {
  const explicit = text.match(ASPECT_RE);
  if (explicit) return explicit[1] as AspectRatio;
  if (/\bsquare\b/i.test(text)) return "1:1";
  if (/\b(portrait|vertical|tall)\b/i.test(text)) return "9:16";
  if (/\b(landscape|wide|cinematic)\b/i.test(text)) return "16:9";
  return undefined;
}

/** Crude subject extraction: the noun phrase before an action/change verb. */
function extractSubject(text: string): string {
  const cleaned = text.replace(/^(please\s+)?(can you\s+)?/i, "").trim();
  const m = cleaned.match(/^(.*?)\b(generate|create|draw|paint|render|design|make|produce|remove|replace|change|turn|add|put|combine|merge|upscale|enhance|stylize|make it)\b/i);
  if (m && m[1].trim().length > 1) return m[1].trim().slice(0, 120);
  return "";
}

function extractAction(text: string): string {
  const m = text.match(CHANGE_VERBS);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Normalize a raw request for a given op. `prompt` is filled by
 * composeImagePrompt so call sites cannot forget the preservation clause.
 */
export function normalizeImageRequest(
  op: ImageOp,
  rawText: string,
  aspectRatio?: AspectRatio,
): NormalizedImageRequest {
  const raw = rawText.trim();
  const meta = IMAGE_OP_META[op];
  const preservation = meta.needsImageInput;

  const preserve = preservation ? preserveDefaults(op) : [];
  const negative = preservation
    ? ["do not add objects or people that were not requested", "do not alter anything outside the requested change"]
    : [];

  const request: NormalizedImageRequest = {
    op,
    raw,
    prompt: "",
    subject: extractSubject(raw),
    action: extractAction(raw),
    environment: firstMatch(raw, ENVIRONMENT_WORDS),
    style: firstMatch(raw, STYLE_WORDS),
    lighting: firstMatch(raw, LIGHTING_WORDS),
    camera: firstMatch(raw, CAMERA_WORDS),
    aspectRatio: aspectRatio ?? extractAspect(raw),
    required: [],
    preserve,
    negative,
    preservation,
  };
  request.prompt = composeImagePrompt(request);
  return request;
}

/**
 * Build the provider-ready prompt.
 *
 * Generation: keep the user's own sentence (their intent is the point) and
 * append only negative constraints. Editing: state the requested change, then
 * the explicit preservation list, so the model edits instead of redrawing.
 */
export function composeImagePrompt(req: NormalizedImageRequest): string {
  const base = req.raw.replace(/\s+/g, " ").trim();
  if (!req.preservation) {
    const negatives = req.negative.length > 0 ? ` Avoid: ${req.negative.join("; ")}.` : "";
    return `${base}.${negatives}`.trim();
  }

  const lines: string[] = [];
  lines.push(`Edit the provided image. Requested change: ${base}.`);
  lines.push(
    `Preserve exactly, without altering them: ${req.preserve.join("; ")}.`,
  );
  if (req.negative.length > 0) {
    lines.push(`Do not: ${req.negative.join("; ")}.`);
  }
  lines.push(
    "Make ONLY the requested change and return the edited image — do not generate a new scene or a different subject.",
  );
  return lines.join(" ");
}

/** Structured record stored alongside the result, for provenance/audit. */
export function intentSummary(req: NormalizedImageRequest): {
  op: ImageOp;
  subject: string;
  environment: string;
  style: string;
  lighting: string;
  camera: string;
  preserveCount: number;
  requiredCount: number;
} {
  return {
    op: req.op,
    subject: req.subject,
    environment: req.environment,
    style: req.style,
    lighting: req.lighting,
    camera: req.camera,
    preserveCount: req.preserve.length,
    requiredCount: req.required.length,
  };
}
