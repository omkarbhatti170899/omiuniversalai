/**
 * Presentation copy for the Image Studio's run state (pure, unit-tested).
 *
 * The rule this exists to enforce (UX master plan §8): the running state must
 * name the operation that is actually happening. A single "Omi is rendering…"
 * for every op told a user waiting on an EDIT that Omi was generating — the
 * exact ambiguity that once let a text-to-image provider answer an edit.
 *
 * There is deliberately NO multi-stage ladder here: the backend run is one
 * HTTP call, so inventing Uploading → Analyzing → Editing → Finalizing steps
 * would fake progress the master plan forbids ("only show stages that
 * correspond to real backend work"). What is real and showable instead:
 * the op's true verb, and measured elapsed time once a run is slow enough
 * that a user starts wondering whether anything is happening.
 */

/** Every op the studio can run (mirrors the backend's ImageOp). */
export type RunOp =
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

const VERB_BY_OP: Record<RunOp, string> = {
  generate: "generating your image",
  variation: "generating a variation",
  // Edit family: the source image is being transformed, never "generated".
  edit: "editing your image",
  remove: "removing the background",
  replace: "replacing the background",
  background: "editing the background",
  style: "applying the style",
  upscale: "upscaling your image",
  enhance: "enhancing your image",
  combine: "combining your images",
  outpaint: "extending your image",
};

/**
 * The running-state verb for an op. Edit-family ops NEVER contain
 * "generating" — that word is reserved for text-to-image work.
 */
export function runVerbForOp(op: string | null | undefined): string {
  if (op && op in VERB_BY_OP) return VERB_BY_OP[op as RunOp];
  // Unknown/auto-pending: stay truthful about not knowing yet.
  return "working on your request";
}

/**
 * Elapsed time shown only once a run is genuinely slow (≥ 5 s). Below that a
 * ticking counter is noise; above it, silence is what makes a user think the
 * app froze. The number is measured, never staged.
 */
export function formatElapsed(elapsedMs: number): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 5_000) return null;
  const seconds = Math.floor(elapsedMs / 1_000);
  return `${seconds}s`;
}

/** The full running-state sentence for the Run button / progress row. */
export function runSentenceForOp(op: string | null | undefined, elapsedMs = 0): string {
  const elapsed = formatElapsed(elapsedMs);
  const base = `Omi is ${runVerbForOp(op)}…`;
  return elapsed ? `${base} (${elapsed})` : base;
}
