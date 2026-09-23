/**
 * Image intent classification — pure, testable, zero network.
 *
 * The user should be able to simply say "Generate…", "Edit this…",
 * "Remove…", "Change…", "Make it…", "Combine these…" and Omi decides which
 * image operation (and therefore which provider capability) the request
 * needs — without the user naming an op.
 *
 * The rule is deliberately conservative: image verbs must co-occur with
 * either an attached/generated image context or an image OBJECT noun
 * ("picture", "logo", "wallpaper"…). "Draw conclusions" and "generate a
 * report" must never reach the image engine — false positives here would
 * hijack ordinary chat turns.
 *
 * Honest edge: an edit-flavored request ("remove the background") with NO
 * image in context classifies as an edit that needs an image — the chat
 * layer then asks for the file instead of silently generating something the
 * user never asked for (§35: never fake the thing that wasn't provided).
 */

import { ASPECT_RATIOS, type AspectRatio, type ImageOp } from "./imageCatalog";

export type ImageIntent =
  | { kind: "none" }
  | {
      kind: "generate";
      prompt: string;
      aspectRatio?: AspectRatio;
      transparent: boolean;
    }
  | {
      kind: "image-edit";
      op: ImageOp;
      prompt: string;
      /** true → an edit was requested but no image exists in context. */
      needsImage: boolean;
    };

/** Verbs that plausibly ask for a NEW image (must pair with an image noun). */
const GENERATE_VERBS =
  /\b(generate|create|draw|paint|render|design|imagine|make|produce|give)\b/i;

/** Nouns that mark the OUTPUT as an image (not a report, summary, graph…). */
const IMAGE_NOUNS =
  /\b(picture|photo|photograph|image|img|logo|icon|illustration|artwork|art|drawing|painting|poster|wallpaper|banner|avatar|portrait|sketch|render|scene|thumbnail|sticker|background image|concept art)\b/i;

/** Explicit edit verbs — with image context these never mean "generate". */
const EDIT_WORDS = {
  combine: /\b(combine|merge|blend|put (them|both) together|stitch)\b/i,
  background: /\b(background|backdrop)\b/i,
  remove: /\b(remove|delete|erase|get rid of|take out|clean up)\b/i,
  replace: /\b(replace|swap|change|turn .* into|switch)\b/i,
  upscale: /\b(upscale|up-?rez|enhance|sharpen|higher resolution|hi-?res|4k|hd\b|more detail|clearer|bigger)\b/i,
  style: /\b(style|stylize|cartoon|anime|watercolor|oil painting|pixel art|sketch style|look like|in the style of|make it look)\b/i,
  variation: /\b(variations?|variants?|another version|different version|alternate)\b/i,
  genericEdit: /\b(edit|fix|modify|adjust|retouch|make it|make this|update it)\b/i,
} as const;

/** Anaphora — "it/this/that/the image" binds the request to a context image. */
const ANAPHORA = /\b(it|this|that|the image|this image|the photo|these|them|both)\b/i;

/** Aspect-ratio hints: explicit "16:9" or natural words. */
function extractAspectRatio(message: string): AspectRatio | undefined {
  const explicit = message.match(/\b(1:1|16:9|9:16|4:3|3:4|3:2|2:3)\b/);
  if (explicit && explicit[1] in ASPECT_RATIOS) return explicit[1] as AspectRatio;
  if (/\b(square)\b/i.test(message)) return "1:1";
  if (/\b(portrait|vertical|tall)\b/i.test(message)) return "9:16";
  if (/\b(landscape|wide|cinematic)\b/i.test(message)) return "16:9";
  return undefined;
}

const wantsTransparent = (message: string) =>
  /\btransparent\b/i.test(message);

/**
 * Classify one chat turn against whether an image exists in context
 * (attached this turn OR produced earlier in the conversation).
 */
export function classifyImageIntent(
  message: string,
  hasImageContext: boolean,
): ImageIntent {
  const text = message.trim();
  if (text.length === 0) return { kind: "none" };

  const aspect = extractAspectRatio(text);
  const transparent = wantsTransparent(text);

  // ---- Edit family first: with an image present, edit verbs always win.
  if (hasImageContext) {
    const op = editOpFor(text);
    if (op !== null) {
      return { kind: "image-edit", op, prompt: text, needsImage: false };
    }
    // Image context + image noun + generate verb → new image anyway
    // ("and also generate a logo…"), otherwise treat as plain chat so
    // questions ABOUT the image keep going to vision, not the paint engine.
  }

  // ---- Generate: needs BOTH an image verb and an image object noun.
  if (GENERATE_VERBS.test(text) && IMAGE_NOUNS.test(text)) {
    return { kind: "generate", prompt: text, aspectRatio: aspect, transparent };
  }

  // ---- Edit-shaped request with nothing to edit: ask for the image.
  if (!hasImageContext && editOpFor(text) !== null && ANAPHORA.test(text)) {
    // Only when the phrasing points at "this/it" — bare nouns like
    // "background" appear in ordinary questions and must not hijack.
    const op = editOpFor(text)!;
    return { kind: "image-edit", op, prompt: text, needsImage: true };
  }

  return { kind: "none" };
}

/** Which concrete edit op the phrasing names (checked most-specific first). */
function editOpFor(text: string): ImageOp | null {
  if (EDIT_WORDS.combine.test(text)) return "combine";
  if (EDIT_WORDS.background.test(text)) return "background";
  if (EDIT_WORDS.variation.test(text)) return "variation";
  if (EDIT_WORDS.upscale.test(text)) return "upscale";
  if (EDIT_WORDS.style.test(text)) return "style";
  if (EDIT_WORDS.remove.test(text)) return "remove";
  if (EDIT_WORDS.replace.test(text)) return "replace";
  if (EDIT_WORDS.genericEdit.test(text)) return "edit";
  return null;
}
