import { Check, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  researchStatusFor,
  shouldAnimate,
  type ResearchStatus,
} from "@/lib/researchStatus";

/**
 * Compact research status (spec §11).
 *
 * Replaces the five-step ladder with a moving spinner. It is deliberately
 * quiet:
 *
 *   • ONE line, always the same height, so nothing below it shifts while a
 *     long answer streams in. The container is a fixed 1.25rem row.
 *   • A static check mark for finished steps, with the REAL count the backend
 *     measured ("Found 12 sources", "Verified against 3 sources") — the user
 *     gets evidence instead of a decorative animation.
 *   • A single small spinner ONLY while a step is genuinely running, and never
 *     after the turn settles.
 *   • No percentage, no shimmer, no pulsing bar, no repeated restarts.
 *
 * `aria-live="polite"` so a screen reader hears progress without being
 * interrupted, and `role="status"` so it is announced as a status region
 * rather than read as body text.
 */
export function ResearchStatusLine({
  status,
  final,
  className,
}: {
  /** The live status text the backend patched into the message. */
  status?: string;
  final?: boolean;
  className?: string;
}) {
  const state: ResearchStatus = researchStatusFor(status, { final });
  if (state.phase === "idle") return null;

  const failed = state.phase === "failed";
  const done = state.completedSteps >= 4 || state.phase === "done";
  const animate = shouldAnimate(state);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="research-status"
      data-phase={state.phase}
      // A fixed row height is the whole point: the streaming bubble must not
      // resize as the phase label changes.
      className={cn(
        "flex h-5 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {failed ? (
          <TriangleAlert className="size-3.5 text-amber-500" aria-hidden />
        ) : done ? (
          <Check className="size-3.5 text-primary" aria-hidden />
        ) : animate ? (
          // Small and slow enough to read as "working", not as a loading show.
          <Loader2 className="size-3.5 animate-spin text-primary/70" aria-hidden />
        ) : null}
      </span>
      <span className="truncate">{state.label}</span>
    </div>
  );
}
