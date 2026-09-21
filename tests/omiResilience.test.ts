/**
 * Phase 14 — Search resilience: the composed `guardedCall` used by the
 * universal fan-out. Pins the §7/§30 contract: open circuits skip (a dead
 * provider is not retried on every request), timeouts are enforced, success
 * resets the breaker, and failures accumulate toward an open circuit.
 */
import { describe, test, expect } from "bun:test";
import {
  breakerAllow,
  breakerRecord,
  breakerStatus,
  guardedCall,
  withTimeout,
} from "../src/convex/searchEngine/resilience";

/** Fresh breaker id per test — state is per-process, tests must not couple. */
let seq = 0;
const freshId = () => `test-provider-${++seq}-${Date.now()}`;

describe("guardedCall — circuit breaker", () => {
  test("passes through when healthy, records success", async () => {
    const id = freshId();
    const out = await guardedCall(id, "Test", async () => 42, 1_000);
    expect(out).toBe(42);
    expect(breakerStatus()[id]?.open ?? false).toBe(false);
  });

  test("opens after repeated failures and then skips the call entirely", async () => {
    const id = freshId();
    let calls = 0;
    for (let i = 0; i < 3; i++) {
      await guardedCall(id, "Test", async () => {
        calls++;
        throw new Error("dead provider");
      }, 1_000).catch(() => {});
    }
    expect(calls).toBe(3);
    expect(breakerStatus()[id]?.open).toBe(true);

    // Circuit open: the fn must NOT be invoked at all.
    let skipped = 0;
    await expect(
      guardedCall(id, "Test", async () => {
        skipped++;
        return 1;
      }, 1_000),
    ).rejects.toThrow(/circuit open/);
    expect(skipped).toBe(0);

    // The cooldown path (half-open probe after COOLDOWN_MS) is time-based;
    // reset-by-success is pinned separately below.
  });

  test("a success resets accumulated failures", async () => {
    const id = freshId();
    for (let i = 0; i < 2; i++) {
      await guardedCall(id, "Test", async () => {
        throw new Error("flake");
      }, 1_000).catch(() => {});
    }
    expect(breakerStatus()[id]?.failures).toBe(2);
    await guardedCall(id, "Test", async () => "recovered", 1_000);
    expect(breakerStatus()[id]?.failures).toBe(0);
    expect(breakerStatus()[id]?.open).toBe(false);
  });
});

describe("guardedCall — timeout", () => {
  test("a hung provider is cut off at the timeout", async () => {
    const id = freshId();
    const start = Date.now();
    await expect(
      guardedCall(
        id,
        "Hung",
        () => new Promise<string>(() => {}), // never resolves
        50,
      ),
    ).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(breakerStatus()[id]?.failures).toBe(1);
  });

  test("fast providers are unaffected by the timeout wrapper", async () => {
    const id = freshId();
    const out = await guardedCall(id, "Fast", async () => "swift", 5_000);
    expect(out).toBe("swift");
  });
});

describe("withTimeout", () => {
  test("carries the provider label in the error", async () => {
    await expect(
      withTimeout(new Promise<string>(() => {}), 30, "Wikipedia"),
    ).rejects.toThrow(/Wikipedia timed out/);
  });
});
