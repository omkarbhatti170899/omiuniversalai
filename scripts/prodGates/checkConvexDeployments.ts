/**
 * GATE — exactly one Convex deployment may be referenced in an artifact.
 * =============================================================================
 *
 * This is the check that would have caught the historical production failure:
 * a published bundle compiled against a retired deployment
 * (`resolute-ptarmigan-187`) while the approved production deployment sat
 * unused. Shipping a bundle that names two different backends is never correct,
 * so it fails the build rather than being reported as a warning.
 *
 * Usage: bun scripts/prodGates/checkConvexDeployments.ts <dir> <approvedBackend>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { approvedSlugOf, findConvexSlugs } from "./convexSlugs";

const [dir, approvedBackend] = process.argv.slice(2);

if (!dir || !approvedBackend) {
  console.error("usage: checkConvexDeployments.ts <dir> <approvedBackend>");
  process.exit(2);
}

const approvedSlug = approvedSlugOf(approvedBackend);
if (!approvedSlug) {
  console.error(
    `::error::could not derive a Convex deployment slug from ${JSON.stringify(approvedBackend)}`,
  );
  process.exit(2);
}

/** Binary formats that can never carry a backend URL we care about. */
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".map",
  ".pdf",
  ".zip",
]);

function isSkipped(name: string): boolean {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (stats.isFile() && !isSkipped(entry)) out.push(full);
  }
  return out;
}

const offenders = new Map<string, Set<string>>();
let scanned = 0;

for (const file of walk(dir)) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  scanned += 1;
  for (const slug of findConvexSlugs(text)) {
    if (slug === approvedSlug) continue;
    const bucket = offenders.get(slug) ?? new Set<string>();
    bucket.add(file);
    offenders.set(slug, bucket);
  }
}

if (offenders.size > 0) {
  for (const [slug, files] of [...offenders].sort()) {
    console.error(
      `::error::non-production Convex deployment ${JSON.stringify(slug)} referenced in ${[...files].sort().join(", ")}`,
    );
  }
  process.exit(1);
}

console.log(
  `ok no Convex deployment other than '${approvedSlug}' appears in ${dir}/ (${scanned} text files scanned)`,
);
