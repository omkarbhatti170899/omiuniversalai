/**
 * GATE — deployment identity must describe THIS commit and the approved backend.
 * =============================================================================
 *
 * Used twice:
 *   - before deploy, against the freshly built `dist/deployment-info.json`;
 *   - after deploy, against the LIVE `/omiuniversalai/deployment-info.json`,
 *     which is how "the published site is this build" is actually proven.
 *
 * A mismatch is a hard failure: the whole point of the file is that the live
 * frontend, the GitHub commit and the expected backend can be compared.
 *
 * Usage: bun scripts/prodGates/checkDeploymentInfo.ts <file> <commit> <backend> <basePath>
 */

import { readFileSync } from "node:fs";

const [path, expectedCommit, expectedBackend, expectedBasePath] =
  process.argv.slice(2);

if (!path || !expectedCommit || !expectedBackend || !expectedBasePath) {
  console.error(
    "usage: checkDeploymentInfo.ts <file> <commit> <backend> <basePath>",
  );
  process.exit(2);
}

let parsed: Record<string, unknown>;
try {
  const raw = readFileSync(path, "utf8");
  parsed = JSON.parse(raw) as Record<string, unknown>;
} catch (error) {
  // A SPA fallback page served in place of the JSON is the classic symptom of a
  // deployment that predates this file, so say so rather than dumping HTML.
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`::error::could not read ${path} as JSON: ${detail}`);
  process.exit(1);
}

const checks: Array<[field: string, actual: unknown, expected: string]> = [
  ["commit", parsed.commit, expectedCommit],
  ["backend", parsed.backend, expectedBackend],
  ["basePath", parsed.basePath, expectedBasePath],
];

const problems = checks
  .filter(([, actual, expected]) => actual !== expected)
  .map(
    ([field, actual, expected]) =>
      `${field}=${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`,
  );

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`::error::deployment-info.json ${problem}`);
  }
  process.exit(1);
}

console.log("ok deployment-info.json:", JSON.stringify(parsed));
