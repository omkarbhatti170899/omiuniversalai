/**
 * Phase 10 depth — Approval gates for workflow chains (master plan §10/§11).
 *
 * The Automation Engine's flagship workflow ends in a MUTATING step: saving
 * the report into the user's knowledge base. Master plan §11 requires
 * PROPOSE → TEST → VERIFY → **APPROVE** → DEPLOY — so the runner now PAUSES
 * before that step, shows the user what would be saved, and resumes only on
 * an explicit human decision.
 *
 * This module is the PURE state machine (no Convex, no clock reads, no
 * network): the runner supplies `now`. Everything decision-relevant is
 * decided here so unit tests pin the exact behavior:
 *
 *   pause  → awaiting_approval (with a 24h honest expiry)
 *   decide → approved  → resume (caller completes the tail steps)
 *            rejected → terminal, report NOT saved
 *   late   → expired   → terminal, honest failure (never silently resume)
 */

/** How long an approval request stays valid before it expires. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Index of the mutating step ("Save report to knowledge") the gate guards. */
export const APPROVAL_STEP_INDEX = 5;

export const PAUSE_REASON =
  "This workflow saves its report to your knowledge base. Approve to file it, or reject to discard it.";

export type ApprovalDecision = "approved" | "rejected";

export type ApprovalGate = {
  stepIndex: number;
  reason: string;
  requestedAt: number;
  expiresAt: number;
  decision?: ApprovalDecision;
  decidedAt?: number;
  decisionNote?: string;
};

export type GateResult =
  | { ok: true; gate: ApprovalGate; report: string }
  | { ok: false; code: "empty"; gate: ApprovalGate; message: string };

/**
 * Build the gate persisted on the run when it pauses. `reportContent` must be
 * the fully-composed report (the user is approving THAT artifact, not a
 * promise to compose one later). Caps the stored copy at 60k chars — the same
 * cap the report document insert enforces — so approval can never write more
 * than was previewed.
 */
export function buildGate(
  reportContent: string,
  now: number,
  opts?: { ttlMs?: number },
): GateResult {
  const content = reportContent ?? "";
  if (content.trim().length === 0) {
    return {
      ok: false,
      code: "empty",
      gate: {
        stepIndex: APPROVAL_STEP_INDEX,
        reason: PAUSE_REASON,
        requestedAt: now,
        expiresAt: now + (opts?.ttlMs ?? APPROVAL_TTL_MS),
      },
      message: "Refusing to request approval for an empty report.",
    };
  }
  const gate: ApprovalGate = {
    stepIndex: APPROVAL_STEP_INDEX,
    reason: PAUSE_REASON,
    requestedAt: now,
    expiresAt: now + (opts?.ttlMs ?? APPROVAL_TTL_MS),
  };
  // The stored preview copy is capped at the same 60k the report insert
  // enforces, so approval can never write more than was previewed.
  return { ok: true, gate, report: content.slice(0, 60_000) };
}

/** Is the gate past its expiry? Pure. */
export function isExpired(gate: ApprovalGate, now: number): boolean {
  return now > gate.expiresAt;
}

export type DecisionOutcome =
  | { ok: true; gate: ApprovalGate }
  | { ok: false; code: "expired" | "already_decided" | "not_awaiting"; message: string };

/**
 * Record a decision on a gate. Pure — returns the updated gate or an honest
 * refusal. Idempotence is refused (never re-decide), expiry is refused (never
 * resume stale work silently — the user reruns instead).
 */
export function decide(
  gate: ApprovalGate | undefined,
  decision: ApprovalDecision,
  now: number,
  note?: string,
): DecisionOutcome {
  if (!gate) {
    return { ok: false, code: "not_awaiting", message: "This run is not awaiting approval." };
  }
  if (gate.decision !== undefined) {
    return {
      ok: false,
      code: "already_decided",
      message: `Already ${gate.decision} — a decision is recorded and cannot be changed.`,
    };
  }
  if (isExpired(gate, now)) {
    return {
      ok: false,
      code: "expired",
      message: "The approval window (24h) expired. Run the workflow again — Omi will not resume stale work.",
    };
  }
  return {
    ok: true,
    gate: {
      ...gate,
      decision,
      decidedAt: now,
      decisionNote: note?.slice(0, 300),
    },
  };
}

/** UI hint: how long the user still has, in plain language. */
export function timeLeftLabel(gate: ApprovalGate, now: number): string {
  const left = gate.expiresAt - now;
  if (left <= 0) return "expired";
  const hours = Math.floor(left / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h left`;
  const minutes = Math.ceil(left / (60 * 1000));
  return `${minutes}m left`;
}
