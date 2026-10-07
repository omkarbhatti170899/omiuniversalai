/**
 * Shared helpers for identifying which Convex deployment(s) a text references.
 * =============================================================================
 *
 * Both the artifact gate and the live-bundle gate ask the same question, so the
 * matching rules live here once instead of drifting apart in two copies.
 *
 * Two rules that are easy to get wrong and were both found by testing against
 * real built output:
 *
 *   1. Compare DEPLOYMENT, not hostname. `<slug>.convex.site` is the
 *      HTTP-actions domain of the SAME deployment as `<slug>.convex.cloud`, so
 *      treating them as different backends is a false positive.
 *
 *   2. The `convex` npm package ships an illustrative URL inside its own error
 *      message — "...requires a URL like 'https://<example>.convex.cloud'".
 *      It is inert vendor prose, so it is stripped before matching. Without
 *      this, every build would be reported as naming a foreign backend.
 */

/** The `convex` client's illustrative URL, as it appears in the shipped bundle. */
export const VENDOR_EXAMPLE = /URL like 'https:\/\/[a-z0-9-]+\.convex\.cloud'/g;

const CONVEX_HOST = /https:\/\/([a-z0-9-]+)\.convex\.(?:cloud|site)/g;

/**
 * The deployment slug of an approved backend, e.g.
 * `https://majestic-turtle-372.convex.cloud` -> `majestic-turtle-372`.
 * Returns null when the input is not a Convex backend URL.
 */
export function approvedSlugOf(backend: string): string | null {
  const match = /^https:\/\/([a-z0-9-]+)\.convex\./.exec(backend);
  return match ? match[1] : null;
}

/**
 * Every deployment slug referenced by `text`, ignoring the inert vendor example.
 * `String.prototype.matchAll` clones the regex, so the shared global patterns
 * carry no cross-call `lastIndex` state.
 */
export function findConvexSlugs(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.replace(VENDOR_EXAMPLE, "").matchAll(CONVEX_HOST)) {
    found.add(match[1]);
  }
  return found;
}
