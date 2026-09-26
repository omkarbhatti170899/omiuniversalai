/**
 * RATE LIMITING — the limiter must actually limit.
 *
 * Regression guard for a measured P0, found twice:
 *
 *  1. The original limiter kept counters in a module-level `Map`. Convex
 *     function instances are ephemeral and independently scheduled, so that
 *     counter reset on every cold start and could be sidestepped by being
 *     routed to a different instance. It looked like a rate limit and was not.
 *
 *  2. The obvious replacement, `ctx.storage`, also does not work — verified on
 *     the deployed backend, not assumed:
 *       "Invalid argument `storageId` for `storage.getMetadata`: Invalid
 *        storage ID: \"rl:public-diagnostic\". Storage ID should be an Id of
 *        '_storage' table, or a UUID string."
 *     Convex file storage only accepts real storage IDs, so it cannot serve as
 *     a general key-value counter.
 *
 * The fix is a real TABLE (`rateLimitWindows`) written through an internal
 * mutation, so every instance shares one counter. The window arithmetic is
 * pure and lives in `planLimit`, which is what these tests cover.
 */
import { describe, expect, it } from "bun:test";
import { planLimit, type WindowRow } from "../src/convex/rateLimits";
import { clientKeyFrom } from "../src/convex/searchEngine/limits";

/** Drive the limiter the way the mutation does: read plan, persist `next`. */
function run(
  state: { row: WindowRow | null },
  now: number,
  max: number,
  windowMs = 60_000,
) {
  const plan = planLimit(state.row, now, max, windowMs);
  state.row = plan.next;
  return plan;
}

describe("fixed-window rate limiting", () => {
  it("allows exactly `max` hits, then refuses", () => {
    const s: { row: WindowRow | null } = { row: null };
    const t0 = 1_000_000;
    const oks = [0, 1, 2, 3, 4].map((i) => run(s, t0 + i, 3).ok);
    expect(oks).toEqual([true, true, true, false, false]);
  });

  it("counts down `remaining` as quota is consumed", () => {
    const s: { row: WindowRow | null } = { row: null };
    expect(run(s, 1000, 3).remaining).toBe(2);
    expect(run(s, 1001, 3).remaining).toBe(1);
    expect(run(s, 1002, 3).remaining).toBe(0);
  });

  it("starts a fresh window once the old one expires", () => {
    const s: { row: WindowRow | null } = { row: null };
    const t0 = 1_000_000;
    run(s, t0, 1);
    expect(run(s, t0 + 1, 1).ok).toBe(false);
    // Just inside the window is still refused...
    expect(run(s, t0 + 59_999, 1).ok).toBe(false);
    // ...and at the boundary it resets.
    expect(run(s, t0 + 60_000, 1).ok).toBe(true);
  });

  it("reuses the row on rollover so the table cannot grow without bound", () => {
    const s: { row: WindowRow | null } = { row: null };
    run(s, 0, 1);
    const afterFirst = s.row!;
    run(s, 60_000, 1);
    // Same logical row, new window — not an additional row.
    expect(s.row!.startedAt).toBe(60_000);
    expect(s.row!.count).toBe(1);
    expect(afterFirst.startedAt).toBe(0);
  });

  it("tells the caller how long to wait", () => {
    const s: { row: WindowRow | null } = { row: null };
    const t0 = 1_000_000;
    run(s, t0, 1);
    const blocked = run(s, t0 + 5_000, 1);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBe(55_000);
  });

  it("never reports a negative wait, even for a corrupt future timestamp", () => {
    // A clock that jumped backwards must not produce retryAfterMs <= 0.
    const s: { row: WindowRow | null } = { row: null };
    run(s, 1_000_000, 1);
    const blocked = run(s, 500_000, 1);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("treats a missing or malformed row as a fresh window rather than crashing", () => {
    for (const bad of [null, undefined, { startedAt: "x", count: "y" } as unknown as WindowRow]) {
      const plan = planLimit(bad, 1_000, 2, 60_000);
      expect(plan.ok).toBe(true);
      expect(plan.next).toEqual({ startedAt: 1_000, count: 1 });
    }
  });

  it("a blocked hit does not consume extra quota", () => {
    const s: { row: WindowRow | null } = { row: null };
    run(s, 0, 1);
    run(s, 1, 1);
    const before = s.row!.count;
    run(s, 2, 1);
    expect(s.row!.count).toBe(before);
  });
});

describe("clientKeyFrom", () => {
  const req = (headers: Record<string, string>) => new Request("https://x.test/", { headers });

  it("uses the first x-forwarded-for hop", () => {
    expect(clientKeyFrom(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
  });

  it("normalises the IPv4-mapped IPv6 form so one client cannot cycle spellings", () => {
    expect(clientKeyFrom(req({ "x-forwarded-for": "::ffff:203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientKeyFrom(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back rather than producing an empty bucket key", () => {
    expect(clientKeyFrom(req({}))).toBe("unknown");
  });

  it("bounds the key length so a hostile header cannot bloat the row", () => {
    const long = clientKeyFrom(req({ "x-forwarded-for": "a".repeat(5_000) }));
    expect(long.length).toBeLessThanOrEqual(64);
  });
});
