/**
 * Research status — the calm, compact progress model (spec §11).
 *
 * WHAT WAS WRONG WITH THE UI
 * --------------------------
 * The old progress display was a five-step ladder with a spinner on the
 * active step, rendered above the streaming answer. That reads as a moving
 * progress bar that keeps restarting, and it caused three concrete problems
 * the user reported: the page resized while streaming, the ladder was noisy
 * and added no information, and the spinner could outlive the work.
 *
 * The rules this encodes:
 *   1. A SMALL, FIXED SET of states — never a percentage. Fake precision is
 *      worse than an honest "searching".
 *   2. Each state is derived from status text the BACKEND actually sent. No
 *      state is invented to keep an animation alive.
 *   3. The label is fixed-width-ish and does not change the container height,
 *      so nothing below it jumps.
 *   4. Once a step is done it shows a real COUNT ("Found 12 sources"), not a
 *      spinner — the user asked for evidence, so give them evidence.
 *   5. There is always a terminal state, so a spinner can never run forever.
 *
 * PURE and unit-tested — the same input always yields the same status.
 */

export type ResearchPhase =
  | "idle"
  | "searching"
  | "reading"
  | "verifying"
  | "answering"
  | "done"
  | "failed";

export type ResearchStatus = {
  phase: ResearchPhase;
  /** One short line. Never longer than a phone can hold without wrapping. */
  label: string;
  /** A real measured number, when the backend reported one. */
  count?: number;
  /** 0..1 — how many of the known steps are finished. NOT a time estimate. */
  completedSteps: number;
  /** True when the phase is finished and no further animation is needed. */
  settled: boolean;
};

/** Total number of steps in the ladder — used only for the step fraction. */
const TOTAL_STEPS = 4;

/** Every phase the status can take. Exported so the UI and tests share it. */
export const RESEARCH_PHASES: ResearchPhase[] = [
  "idle",
  "searching",
  "reading",
  "verifying",
  "answering",
  "done",
  "failed",
];

/**
 * Map a backend status string to a phase.
 *
 * The backend patches real progress text into the live message
 * ("Omi is looking up live news search…", "Reading 12 sources…",
 * "Verified against 3 sources"). Anything unrecognised resolves to
 * "answering" rather than inventing a new stage.
 */
export function researchPhaseFor(status: string | undefined): ResearchPhase {
  const s = (status ?? "").toLowerCase();
  if (!s.trim()) return "idle";
  if (/\bfail|could not|unable|unavailable|no source|error/.test(s)) return "failed";
  if (/verified against|corroborat|cross-check/.test(s)) return "verifying";
  if (/\breading\b|\bsources found\b|\bfound \d+ source/.test(s)) return "reading";
  if (/searching|looking up|search(?:ing)? the web|searching live/.test(s)) return "searching";
  if (/checking approved|checking your|verifying/.test(s)) return "verifying";
  return "answering";
}

/** "Reading 12 sources…" → 12. Returns undefined when no count is present. */
export function parseSourceCount(status: string | undefined): number | undefined {
  const s = status ?? "";
  const reading = /\b(?:reading|found)\s+(\d{1,4})\s+sources?\b/i.exec(s);
  if (reading) return Number(reading[1]);
  const verified = /\bverified against\s+(\d{1,4})\s+sources?\b/i.exec(s);
  if (verified) return Number(verified[1]);
  return undefined;
}

const LABELS: Record<ResearchPhase, string> = {
  idle: "",
  searching: "Searching live sources…",
  reading: "Reading sources…",
  verifying: "Verifying information…",
  answering: "Preparing answer…",
  done: "Answer ready",
  failed: "Could not verify this",
};

/**
 * Build the display status for a live turn.
 *
 * `final` is true once the message is no longer streaming — that guarantees a
 * terminal state, so no indicator can ever be left running.
 */
export function researchStatusFor(
  status: string | undefined,
  opts: { final?: boolean } = {},
): ResearchStatus {
  const phase = researchPhaseFor(status);
  const count = parseSourceCount(status);

  if (opts.final) {
    return { phase: "done", label: LABELS.done, count, completedSteps: TOTAL_STEPS, settled: true };
  }
  if (phase === "failed") {
    return { phase, label: LABELS.failed, count, completedSteps: 0, settled: true };
  }
  if (phase === "idle") {
    return { phase: "idle", label: LABELS.idle, count, completedSteps: 0, settled: true };
  }

  // A completed step is stated as a fact, with its real count, rather than
  // shown as a bar that keeps moving.
  const completedSteps: Record<Exclude<ResearchPhase, "idle" | "done" | "failed">, number> = {
    searching: 1,
    reading: 2,
    verifying: 3,
    answering: 4,
  };

  let label = LABELS[phase];
  if (phase === "reading" && count !== undefined) {
    label = `Found ${count} source${count === 1 ? "" : "s"}`;
  }
  if (phase === "verifying" && count !== undefined) {
    label = `Verified against ${count} source${count === 1 ? "" : "s"}`;
  }

  return {
    phase,
    label,
    count,
    completedSteps: completedSteps[phase as Exclude<ResearchPhase, "idle" | "done" | "failed">],
    settled: false,
  };
}

/**
 * Whether an indicator should animate at all.
 *
 * Deliberately conservative: only the ONE active step gets a slow, subtle
 * pulse, and only while the turn is genuinely running. Everything else is
 * static text. This is the difference between "calm" and "choppy".
 */
export function shouldAnimate(status: ResearchStatus): boolean {
  return !status.settled && status.phase !== "idle";
}
