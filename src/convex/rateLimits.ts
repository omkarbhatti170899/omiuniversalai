/**
 * RATE LIMITING — a limit that is actually shared.
 *
 * Why this file exists (a measured P0, twice).
 *
 * 1. `resilience.rateLimit()` kept its buckets in a module-level `Map`. Convex
 *    function instances are ephemeral and independently scheduled, so that
 *    counter resets on every cold start and is sidestepped by being routed to a
 *    different instance. It stopped double-clicks; it did not limit anything.
 *
 * 2. The obvious replacement — `ctx.storage` — does not work either. Verified
 *    against the deployed backend, not assumed:
 *
 *      Invalid argument `storageId` for `storage.getMetadata`:
 *      Invalid storage ID: "rl:public-diagnostic". Storage ID should be an
 *      Id of '_storage' table, or a UUID string.
 *
 *    Convex file storage only accepts real storage IDs, so it cannot be used
 *    as a general key-value counter.
 *
 * What actually works is a TABLE. Counters live in `rateLimitWindows`, written
 * through this internal mutation, so every instance reads and writes the same
 * row. Measured working from the deployed backend.
 *
 * Scope, stated honestly: this is a *cooldown* protecting shared free-tier
 * upstream quota (GDELT, TheSportsDB, Open-Meteo) and public diagnostic routes
 * from a hot loop. It is not a distributed anti-abuse system. Account quotas
 * and upstream limits remain the real backstop, and a determined distributed
 * attacker is not stopped here.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { GenericActionCtx } from "convex/server";
import { clientKeyFrom } from "./searchEngine/limits";

/** The result shape every caller gets back. */
export type LimitResult = {
  ok: boolean;
  retryAfterMs: number;
  remaining: number;
  /**
   * True when the counter could not be reached and the limiter deliberately
   * failed OPEN. Reported rather than swallowed, because a limiter that
   * silently no-ops is indistinguishable from one that is working.
   */
  degraded: boolean;
};

/** The persisted shape of one caller's window. */
export type WindowRow = { startedAt: number; count: number };

/** What the caller should do next, plus the row to persist. */
export type LimitPlan = LimitResult & { next: WindowRow };

/**
 * Pure fixed-window accounting.
 *
 * Split out from the mutation so the window arithmetic — the part that is easy
 * to get subtly wrong — is unit-testable without a Convex runtime.
 */
export function planLimit(
  existing: WindowRow | null | undefined,
  now: number,
  max: number,
  windowMs: number,
): LimitPlan {
  if (!existing || typeof existing.startedAt !== "number" || typeof existing.count !== "number") {
    return {
      ok: true,
      retryAfterMs: 0,
      remaining: Math.max(0, max - 1),
      degraded: false,
      next: { startedAt: now, count: 1 },
    };
  }
  const age = now - existing.startedAt;
  if (age >= windowMs) {
    // Window expired: start fresh, reusing the same row so the table does not
    // grow by one row per caller per window forever.
    return {
      ok: true,
      retryAfterMs: 0,
      remaining: Math.max(0, max - 1),
      degraded: false,
      next: { startedAt: now, count: 1 },
    };
  }
  if (existing.count >= max) {
    return {
      ok: false,
      retryAfterMs: Math.max(1_000, windowMs - age),
      remaining: 0,
      degraded: false,
      next: existing,
    };
  }
  return {
    ok: true,
    retryAfterMs: 0,
    remaining: Math.max(0, max - existing.count - 1),
    degraded: false,
    next: { startedAt: existing.startedAt, count: existing.count + 1 },
  };
}

/**
 * Consume one unit of quota for `key` under the named limiter.
 *
 * One indexed read and one write per call, which is enough to stop a hot loop
 * without putting a write in front of every other request path.
 */
export const consumeInternal = internalMutation({
  args: {
    name: v.string(),
    key: v.string(),
    max: v.number(),
    windowMs: v.number(),
  },
  handler: async (ctx, args): Promise<LimitResult> => {
    const now = Date.now();
    const row = await ctx.db
      .query("rateLimitWindows")
      .withIndex("by_name_key", (q) => q.eq("name", args.name).eq("key", args.key))
      .unique();

    const plan = planLimit(row, now, args.max, args.windowMs);
    if (row) {
      await ctx.db.patch(row._id, plan.next);
    } else {
      await ctx.db.insert("rateLimitWindows", { name: args.name, key: args.key, ...plan.next });
    }
    return { ok: plan.ok, retryAfterMs: plan.retryAfterMs, remaining: plan.remaining, degraded: plan.degraded };
  },
});

/**
 * Consume quota from an action or HTTP-action context.
 *
 * Always succeeds: if the counter itself fails, this reports `degraded: true`
 * and allows the request, because a metrics problem must not become an outage.
 */
export async function consumeFromCtx(
  // `any` here is the Convex Api type parameter, not an unconstrained value:
  // this codegen version (1.42) does not export an `AnyApi` alias, and the two
  // call sites (a Convex `ActionCtx` and an HTTP action's `GenericActionCtx`)
  // are otherwise not nameable in one signature. The value is never inspected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: ActionCtx | GenericActionCtx<any>,
  name: string,
  key: string,
  max: number,
  windowMs: number,
): Promise<LimitResult> {
  try {
    return await ctx.runMutation(internal.rateLimits.consumeInternal, {
      name,
      key,
      max,
      windowMs,
    });
  } catch {
    return { ok: true, retryAfterMs: 0, remaining: 0, degraded: true };
  }
}

/**
 * Best-effort caller identity for an unauthenticated HTTP request.
 *
 * NEVER used for authorization — only to shape a rate-limit bucket. An
 * attacker who spoofs this header can only ever consume their own quota, never
 * borrow someone else's, so a spoofed value is not privilege escalation.
 */
export { clientKeyFrom };
