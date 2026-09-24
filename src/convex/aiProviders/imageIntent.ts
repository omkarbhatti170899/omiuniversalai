/**
 * Image intent classification — pure, testable, zero network.
 *
 * The user should be able to simply say "Generate…", "Edit this…",
 * "Remove the background", "Make it brighter", "Combine these two", "Upscale
 * this", "Now add rain" and Omi decides which image operation (and therefore
 * which provider capability) the request needs — without the user naming an
 * op.
 *
 * Classes (the Image Engine's intent layer):
 *   generate · edit · remove-background · replace-background · style-transfer
 *   · upscale · enhance · variation · combine · outpaint · image-understanding
 *
 * The rule is deliberately conservative: image verbs must co-occur with
 * either an attached/generated image context or an image OBJECT noun
 * ("picture", "logo", "wallpaper"…). "Draw conclusions" and "generate a
 * report" must never reach the image engine — false positives here would
 * hijack ordinary chat turns.
 *
 * Honest edge: an edit-flavoured request ("remove the background") with NO
 * image in context classifies as an edit that needs an image — the chat
 * layer then asks for the file instead of silently generating something the
 * user never asked for (never fake the thing that wasn't provided).
 *
 * IMAGE UNDERSTANDING is classified explicitly so it is never mistaken for an
 * edit: "what is in this picture" belongs to vision, not to the paint engine.
 */

import { IMAGE_OP_META, ASPECT_RATIOS, type AspectRatio, type ImageOp } from "./imageCatalog";

/** Which image the user means. Resolved against the images in context. */
export type ImageReference =
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "ordinal"; index: number } // 0-based
  | { kind: "all" }
  | { kind: "context" }; // the attached/previous image, or the latest result

export type ImageIntent =
  | { kind: "none" }
  | {
      kind: "generate";
      prompt: string;
      aspectRatio?: AspectRatio;
      transparent: boolean;
      references: ImageReference[];
    }
  | {
      kind: "image-edit";
      op: ImageOp;
      prompt: string;
      /** true → an edit was requested but no image exists in context. */
      needsImage: boolean;
      /** True when the op inherently needs two or more images. */
      needsMultiple: boolean;
      references: ImageReference[];
    }
  | { kind: "image-understanding"; prompt: string };

/** Verbs that plausibly ask for a NEW image (must pair with an image noun). */
const GENERATE_VERBS =
  /\b(generate|create|draw|paint|render|design|imagine|make|produce|give)\b/i;

/** Nouns that mark the OUTPUT as an image (not a report, summary, graph…). */
const IMAGE_NOUNS =
  /\b(picture|photo|photograph|image|img|logo|icon|illustration|artwork|art|drawing|painting|poster|wallpaper|banner|avatar|portrait|sketch|render|scene|thumbnail|sticker|background image|concept art)\b/i;

/** Questions ABOUT an image → image understanding (vision), not an edit. */
const UNDERSTANDING_Q =
  /\b(what('s| is)? (in|on) (this|the|that)|describe (this|the|that)|what does (this|it) (show|depict)|transcribe|read the text|what text|who is in (this|the)|identify (this|the)|explain (this|the) (image|picture|photo))\b/i;

/** Explicit edit verbs — with image context these never mean "generate". */
const EDIT_WORDS = {
  combine: /\b(combine|merge|blend|put (them|both) together|stitch|composite)\b/i,
  removeBackground:
    /\b(remove|delete|erase|get rid of|take out|cut out|clean up)\b[\s\S]{0,24}?\b(background|backdrop)\b/i,
  transparent: /\b(transparent|no background|without background|alpha)\b/i,
  background: /\b(background|backdrop)\b/i,
  outpaint: /\b(outpaint|extend (the )?(image|canvas|scene)|expand (the )?(image|canvas)|wider (image|frame)|more (scene|sky))\b/i,
  variation:
    /\b(variations?|variants?|another version|different version|another take|re-?roll|alternate (version|take))\b/i,
  upscale: /\b(upscale|up-?rez|higher resolution|hi-?res|4k|hd\b|bigger|enlarge)\b/i,
  enhance:
    /\b(enhance|sharpen|more detail|clearer|cleaner|denoise|reduce noise|better quality|improve (the )?(quality|clarity|lighting|colours?|colors?))\b/i,
  style:
    /\b(style|stylize|stylise|cartoon|anime|watercolor|oil painting|pixel art|sketch style|look like|in the style of|make it look|cinematic|k-?drama)\b/i,
  replace: /\b(replace|swap|turn .* into|switch)\b/i,
  remove: /\b(remove|delete|erase|get rid of|take out|clean up|person on the)\b/i,
  genericEdit: /\b(edit|fix|modify|adjust|retouch|make it|make this|update it|make the|change|turn|brighten|darken|lighten|add|put)\b/i,
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

const wantsTransparent = (message: string) => /\btransparent\b/i.test(message);

const ORDINAL_WORDS: Record<string, number> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  last: -1,
  latest: -1,
  final: -1,
};

/**
 * Which image(s) the user is referring to. Falls back to `context` (the
 * attached image or the latest generated one) when nothing explicit is said.
 */
export function extractReferences(text: string): ImageReference[] {
  const refs: ImageReference[] = [];

  // "combine these two", "both images", "all of them"
  if (/\b(both|these (two|images|photos)|all (of )?(them|these)|the two|them both)\b/i.test(text)) {
    refs.push({ kind: "all" });
  }

  // "image 3" / "3rd image"
  const numbered = text.match(/\b(?:image|photo|picture)\s*#?\s*([1-9])\b/i);
  if (numbered) refs.push({ kind: "ordinal", index: Number(numbered[1]) - 1 });
  const ordWord = text.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\b/i);
  if (ordWord) {
    const idx = ORDINAL_WORDS[ordWord[1].toLowerCase()];
    if (idx !== undefined && idx >= 0) refs.push({ kind: "ordinal", index: idx });
  }

  // "the last image", "the latest one"
  if (/\b(last|latest|most recent|final)\b/i.test(text)) refs.push({ kind: "last" });

  // Deduplicate by kind+index.
  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    const key = r.kind === "ordinal" ? `ordinal:${r.index}` : r.kind;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) unique.push({ kind: "context" });
  return unique;
}

/**
 * Resolve references to concrete 0-based indices into the available images.
 * `count` is how many images are in context (attachments + latest result).
 * Unknown/out-of-range references degrade to [0] — never a crash, never a
 * silent "all" that would surprise the user.
 */
export function resolveReferenceIndices(
  refs: ImageReference[],
  count: number,
): number[] {
  if (count <= 0) return [];
  const out = new Set<number>();
  for (const ref of refs) {
    switch (ref.kind) {
      case "all":
        for (let i = 0; i < count; i++) out.add(i);
        break;
      case "last":
        out.add(count - 1);
        break;
      case "first":
        out.add(0);
        break;
      case "ordinal":
        out.add(ref.index >= 0 && ref.index < count ? ref.index : 0);
        break;
      case "context":
        out.add(0);
        break;
    }
  }
  if (out.size === 0) out.add(0);
  return [...out].sort((a, b) => a - b);
}

/**
 * Classify one chat turn against whether an image exists in context
 * (attached this turn OR produced earlier in the conversation).
 */
export function classifyImageIntent(
  message: string,
  hasImageContext: boolean,
  imageCount = hasImageContext ? 1 : 0,
): ImageIntent {
  const text = message.trim();
  if (text.length === 0) return { kind: "none" };

  const aspect = extractAspectRatio(text);
  const transparent = wantsTransparent(text);
  const references = extractReferences(text);

  // Questions ABOUT an image are understanding, not editing — they go to
  // vision. Classified explicitly so they can never reach the paint engine.
  if (hasImageContext && UNDERSTANDING_Q.test(text) && editOpFor(text) === null) {
    return { kind: "image-understanding", prompt: text };
  }

  // ---- Edit family first: with an image present, edit verbs always win.
  if (hasImageContext) {
    const op = editOpFor(text);
    if (op !== null) {
      return {
        kind: "image-edit",
        op,
        prompt: text,
        needsImage: false,
        needsMultiple: IMAGE_OP_META[op].needsMultipleInputs,
        references,
      };
    }
    // Image context + image noun + generate verb → new image anyway
    // ("and also generate a logo…"), otherwise plain chat so questions ABOUT
    // the image keep going to vision.
  }

  // ---- Generate: needs BOTH an image verb and an image object noun.
  if (GENERATE_VERBS.test(text) && IMAGE_NOUNS.test(text)) {
    return { kind: "generate", prompt: text, aspectRatio: aspect, transparent, references };
  }

  // ---- Edit-shaped request with nothing to edit: ask for the image.
  if (!hasImageContext && editOpFor(text) !== null && ANAPHORA.test(text)) {
    const op = editOpFor(text)!;
    return {
      kind: "image-edit",
      op,
      prompt: text,
      needsImage: true,
      needsMultiple: IMAGE_OP_META[op].needsMultipleInputs,
      references: [{ kind: "context" }],
    };
  }

  return { kind: "none" };
}

/** Which concrete edit op the phrasing names (checked most-specific first). */
export function editOpFor(text: string): ImageOp | null {
  if (EDIT_WORDS.combine.test(text)) return "combine";
  if (EDIT_WORDS.outpaint.test(text)) return "outpaint";
  if (EDIT_WORDS.removeBackground.test(text) || EDIT_WORDS.transparent.test(text)) return "remove";
  // "replace the background" is replacement, not a generic background edit.
  if (EDIT_WORDS.replace.test(text) && EDIT_WORDS.background.test(text)) return "replace";
  if (EDIT_WORDS.variation.test(text)) return "variation";
  if (EDIT_WORDS.upscale.test(text)) return "upscale";
  if (EDIT_WORDS.enhance.test(text)) return "enhance";
  if (EDIT_WORDS.style.test(text)) return "style";
  if (EDIT_WORDS.background.test(text)) return "background";
  if (EDIT_WORDS.remove.test(text)) return "remove";
  // A lone "replace" verb with no background or other specific target is a
  // generic SUBJECT edit ("replace the shirt with a jacket"), not background
  // replacement. "replace" as a dedicated op means the background itself
  // (the replace+background phrasing caught above, and the Studio's
  // Replace-background mode, which sends `op: "replace"` directly). Returning
  // "replace" here made the normalizer tell the model to preserve the very
  // background it had just been asked to change.
  if (EDIT_WORDS.replace.test(text)) return "edit";
  if (EDIT_WORDS.genericEdit.test(text)) return "edit";
  return null;
}
