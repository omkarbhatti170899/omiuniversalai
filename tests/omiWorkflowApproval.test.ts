/**
 * Phase 14 tests — Phase 10 approval gates. These pin the security-relevant
 * behavior of the human-decision state machine: no resume without an explicit
 * decision, no resume after expiry, no double-deciding, and the report the
 * user approved is the report that gets saved (§11, §35).
 */
import { describe, test, expect } from "bun:test";
import {
  buildGate,
  decide,
  isExpired,
  timeLeftLabel,
  APPROVAL_TTL_MS,
  APPROVAL_STEP_INDEX,
  PAUSE_REASON,
  type ApprovalGate,
} from "../src/convex/workflows/approval";

const REPORT = "# Research report\n\nBody with [1] citations.\n";
const NOW = 1_700_000_000_000;

function freshGate(): ApprovalGate {
  return buildGate(REPORT, NOW).gate;
}

describe("gate construction", () => {
  test("builds a 24h gate bound to the mutating step", () => {
    const r = buildGate(REPORT, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.gate.stepIndex).toBe(APPROVAL_STEP_INDEX);
    expect(r.gate.reason).toBe(PAUSE_REASON);
    expect(r.gate.expiresAt - r.gate.requestedAt).toBe(APPROVAL_TTL_MS);
    expect(r.gate.decision).toBeUndefined();
  });

  test("the previewed report IS the approved artifact (capped at 60k)", () => {
    const r = buildGate(REPORT, NOW);
    expect(r.ok && r.report).toBe(REPORT);
    const huge = "x".repeat(70_000);
    const capped = buildGate(huge, NOW);
    expect(capped.ok && capped.report.length).toBe(60_000);
  });

  test("refuses to request approval for an empty report", () => {
    const r = buildGate("   \n  ", NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("empty");
    expect(r.message).toMatch(/empty/i);
  });

  test("custom TTL is honored (used by tests/ops)", () => {
    const r = buildGate(REPORT, NOW, { ttlMs: 1000 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.gate.expiresAt - r.gate.requestedAt).toBe(1000);
  });
});

describe("decisions", () => {
  test("approve records decision + timestamp, keeping the artifact", () => {
    const out = decide(freshGate(), "approved", NOW + 1000, "looks good");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.gate.decision).toBe("approved");
    expect(out.gate.decidedAt).toBe(NOW + 1000);
    expect(out.gate.decisionNote).toBe("looks good");
  });

  test("reject records decision; nothing implies a save", () => {
    const out = decide(freshGate(), "rejected", NOW + 1000);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.gate.decision).toBe("rejected");
  });

  test("a decision is FINAL — no double-deciding", () => {
    const gate = decide(freshGate(), "approved", NOW + 1000);
    if (!gate.ok) throw new Error("expected ok");
    const second = decide(gate.gate, "rejected", NOW + 2000);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("already_decided");
  });

  test("expired gates refuse BOTH decisions — never silently resume", () => {
    const gate = freshGate();
    const late = NOW + APPROVAL_TTL_MS + 1;
    for (const d of ["approved", "rejected"] as const) {
      const out = decide(gate, d, late);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe("expired");
    }
  });

  test("missing gate is refused, not created", () => {
    const out = decide(undefined, "approved", NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("not_awaiting");
  });

  test("expiry is a pure boundary check (ms-precise)", () => {
    const gate = freshGate();
    expect(isExpired(gate, gate.expiresAt)).toBe(false);
    expect(isExpired(gate, gate.expiresAt + 1)).toBe(true);
  });

  test("decision notes are bounded (no unbounded storage)", () => {
    const out = decide(freshGate(), "approved", NOW, "n".repeat(5000));
    if (!out.ok) throw new Error("expected ok");
    expect((out.gate.decisionNote ?? "").length).toBeLessThanOrEqual(300);
  });
});

describe("honesty properties", () => {
  test("time-left label is plain language and monotone", () => {
    const gate = freshGate();
    expect(timeLeftLabel(gate, NOW)).toBe("24h left");
    expect(timeLeftLabel(gate, gate.expiresAt - 30_000)).toBe("1m left");
    expect(timeLeftLabel(gate, gate.expiresAt + 1)).toBe("expired");
  });

  test("gate derivation never mutates the original (read-only contract)", () => {
    const original = freshGate();
    const snapshot = JSON.stringify(original);
    decide(original, "approved", NOW + 5);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
