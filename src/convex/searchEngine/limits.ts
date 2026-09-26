/**
 * RATE-LIMIT CALLER IDENTITY.
 *
 * The counting itself lives in `src/convex/rateLimits.ts`, backed by a real
 * Convex table. That move was necessary, not cosmetic: an in-process `Map` is
 * per-instance and resets on every cold start, and Convex file storage rejects
 * arbitrary string keys (it demands a `_storage` Id or a UUID). Only a table is
 * shared by every instance.
 *
 * What remains here is the one piece that is pure and worth isolating: turning
 * an HTTP request into a bucket key.
 */

/**
 * Best-effort caller identity for an unauthenticated HTTP request.
 *
 * NEVER used for authorization — only to shape a rate-limit bucket. An
 * attacker who spoofs this header can only ever consume their own quota, never
 * borrow someone else's, so a spoofed value is not privilege escalation.
 */
export function clientKeyFrom(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  const ip = (fwd?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "unknown").trim();
  // Normalise the IPv4-mapped IPv6 form so one client cannot trivially cycle
  // through equivalent-looking addresses.
  const normalized = ip.replace(/^::ffff:/i, "").slice(0, 64);
  return normalized || "unknown";
}
