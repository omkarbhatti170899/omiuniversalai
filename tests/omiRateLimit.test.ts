/**
 * Rate-limit contract tests (master plan §28 — abuse/cost control).
 *
 * `rateLimit` is the single gate in front of every expensive surface in the
 * product: chat turns, search fan-outs, deep research, file/image ingest,
 * agent tools and workflow runs. Until this file existed it was the one
 * resilience primitive with no test, which meant a change to it could silently
 * remove the only thing standing between one account and the shared free-tier
 * quota.
 *
 * The properties that actually matter:
 *   • a bucket allows exactly `maxPerMinute` calls, then refuses
 *   • refusal carries a usable retry hint (never 0, never longer than a window)
 *   • buckets are per-key, so one user cannot spend another user's allowance
 *     (every call site keys on `surface:${userId}`)
 *   • once full, a bucket does not quietly start allowing calls again
 *
 * Keys are unique per test: bucket state is per-process, so sharing a key
 * across tests would couple them.
 */
import { describe, expect, test } from "bun:test";
import { rateLimit } from "../src/convex/searchEngine/resilience";

/** Fresh key per assertion — never share bucket state between tests. */
function freshKey(label: string): string {
  return `test:${label}:${Math.random().toString(36).slice(2)}`;
}

describe("rateLimit — allowance", () => {
  test("allows exactly maxPerMinute calls, then refuses", () => {
    const key = freshKey("allowance");
    for (let i = 0; i < 5; i++) {
      expect(rateLimit(key, 5).ok).toBe(true);
    }
    expect(rateLimit(key, 5).ok).toBe(false);
  });

  test("a limit of 1 allows one call and refuses the second", () => {
    const key = freshKey("single");
    expect(rateLimit(key, 1).ok).toBe(true);
    expect(rateLimit(key, 1).ok).toBe(false);
  });

  test("stays refused while the bucket is full — no allowance leak", () => {
    const key = freshKey("sustained");
    for (let i = 0; i < 3; i++) rateLimit(key, 3);
    // Repeated hammering must not earn extra calls.
    for (let i = 0; i < 10; i++) {
      expect(rateLimit(key, 3).ok).toBe(false);
    }
  });
});

describe("rateLimit — retry hint", () => {
  test("a refusal reports a retry delay inside the one-minute window", () => {
    const key = freshKey("hint");
    rateLimit(key, 1);
    const blocked = rateLimit(key, 1);
    expect(blocked.ok).toBe(false);
    // Callers render this as "retry in Ns" — 0 would read as "retry now",
    // and anything over the window would be a lie.
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  test("an allowed call reports no pending delay", () => {
    const key = freshKey("nodelay");
    expect(rateLimit(key, 2).retryAfterMs).toBe(0);
  });
});

describe("rateLimit — isolation between keys", () => {
  test("one key's usage never consumes another key's allowance", () => {
    const a = freshKey("user-a");
    const b = freshKey("user-b");
    for (let i = 0; i < 3; i++) rateLimit(a, 3);

    expect(rateLimit(a, 3).ok).toBe(false);
    // Same limit, different key: untouched — this is what makes
    // `chat:${userId}` a per-user limit rather than a global one.
    expect(rateLimit(b, 3).ok).toBe(true);
  });

  test("different surfaces for the same user are independent buckets", () => {
    const who = Math.random().toString(36).slice(2);
    const chat = `chat:${who}`;
    const search = `search:${who}`;
    rateLimit(chat, 2);
    rateLimit(chat, 2);

    expect(rateLimit(chat, 2).ok).toBe(false);
    // The user spent their chat allowance, not their search allowance.
    expect(rateLimit(search, 2).ok).toBe(true);
  });

  test("a higher limit on the same key admits more calls", () => {
    const key = freshKey("widen");
    for (let i = 0; i < 4; i++) rateLimit(key, 4);
    expect(rateLimit(key, 4).ok).toBe(false);
    // Raising the ceiling reflects the extra calls already recorded.
    expect(rateLimit(key, 10).ok).toBe(true);
  });
});
