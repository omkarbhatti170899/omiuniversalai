/**
 * GATE — the deployment workflow must be structurally valid before it can be
 * trusted to deploy.
 * =============================================================================
 *
 * WHY THIS EXISTS. The Pages workflow is the only path to production, so a
 * workflow that cannot parse means production silently stops tracking `main` —
 * which is exactly what happened here: the published site kept serving a build
 * compiled against a retired Convex deployment because the workflow that would
 * have replaced it was invalid YAML.
 *
 * The specific trap: `run: |` is a YAML literal block scalar, and its content
 * must be indented deeper than the `run:` key. A single shell or heredoc line
 * that lands at column 0 terminates the scalar early, and the rest of the script
 * is then parsed as YAML — so the file fails with a confusing error far from the
 * real line. This check reports the offending line directly.
 *
 * Usage: bun scripts/prodGates/validateWorkflow.ts [path]
 *        (path defaults to the Pages workflow; the argument exists so the
 *         checker itself can be exercised against a deliberately broken copy)
 */

import { existsSync, readFileSync } from "node:fs";

const WORKFLOW = process.argv[2] ?? ".github/workflows/deploy-pages.yml";

const APPROVED_BACKEND = "https://majestic-turtle-372.convex.cloud";

/** Every script the workflow invokes, so a rename cannot silently break CI. */
const REFERENCED_SCRIPTS = [
  "scripts/prodGates/checkDeploymentInfo.ts",
  "scripts/prodGates/checkConvexDeployments.ts",
  "scripts/prodGates/checkSecretShapes.ts",
  "scripts/prodGates/checkLiveBundle.ts",
  "scripts/prodGates/summarizeSelfTest.ts",
];

/** Ordered gates that must run before anything is deployed. */
const REQUIRED_GATES = [
  "bun install --frozen-lockfile",
  "bun run typecheck",
  "bun run lint",
  "bun run test",
  "bun run build",
];

const problems: string[] = [];

if (!existsSync(WORKFLOW)) {
  console.error(`::error::missing ${WORKFLOW}`);
  process.exit(1);
}

const raw = readFileSync(WORKFLOW, "utf8");
const lines = raw.split("\n");

// ---------------------------------------------------------------------------
// 1. Every column-0 line must be a top-level YAML key or a comment. Anything
//    else is block-scalar content that has escaped its indentation.
// ---------------------------------------------------------------------------
const TOP_LEVEL_KEY = /^[A-Za-z_][A-Za-z0-9_-]*:/;
lines.forEach((line, index) => {
  if (line.trim() === "") return;
  if (line.startsWith("#")) return;
  if (line.startsWith(" ")) return;
  if (TOP_LEVEL_KEY.test(line)) return;
  problems.push(
    `${WORKFLOW}:${index + 1} starts at column 0 but is not a top-level key — ` +
      `this terminates the enclosing \`run: |\` block and makes the workflow unparseable: ${JSON.stringify(line.slice(0, 70))}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Block scalars: every non-blank line after `run: |` must be indented deeper
//    than the key, until the block ends.
// ---------------------------------------------------------------------------
lines.forEach((line, index) => {
  const trimmed = line.trim();
  if (trimmed !== "run: |" && trimmed !== "run: >") return;
  const keyIndent = line.length - line.trimStart().length;
  for (let i = index + 1; i < lines.length; i += 1) {
    const body = lines[i];
    if (body.trim() === "") continue;
    const bodyIndent = body.length - body.trimStart().length;
    if (bodyIndent <= keyIndent) break; // block ended legitimately
    if (bodyIndent <= 0) {
      problems.push(
        `${WORKFLOW}:${i + 1} is not indented inside the \`run: |\` block opened at line ${index + 1}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Triggers: push to main and manual dispatch (Phase 6 / Phase 16).
// ---------------------------------------------------------------------------
if (!/^\s{2}push:\s*$/m.test(raw)) problems.push("missing `push:` trigger");
if (!/^\s{4}branches:\s*\[main\]\s*$/m.test(raw)) {
  problems.push("missing `branches: [main]` under the push trigger");
}
if (!/^\s{2}workflow_dispatch:\s*$/m.test(raw)) {
  problems.push("missing `workflow_dispatch:` trigger");
}

// ---------------------------------------------------------------------------
// 4. A production concurrency group so two Pages deploys cannot race.
// ---------------------------------------------------------------------------
if (!/^\s{2}group:\s*pages\s*$/m.test(raw)) {
  problems.push("missing `concurrency: group: pages`");
}

// ---------------------------------------------------------------------------
// 5. Deterministic backend selection (Phase 2).
// ---------------------------------------------------------------------------
const backendLines = lines.filter((line) =>
  line.trimStart().startsWith("OMI_PRODUCTION_BACKEND:"),
);
if (backendLines.length !== 1) {
  problems.push(
    `expected exactly one OMI_PRODUCTION_BACKEND declaration, found ${backendLines.length}`,
  );
} else if (!backendLines[0].includes(APPROVED_BACKEND)) {
  problems.push(
    `OMI_PRODUCTION_BACKEND is not the approved backend ${APPROVED_BACKEND}`,
  );
}
if (/^\s*(VITE_CONVEX_URL|CONVEX_URL):\s*(?!\s*$)/m.test(raw)) {
  problems.push(
    "the workflow declares VITE_CONVEX_URL/CONVEX_URL directly — the backend must be derived from OMI_PRODUCTION_BACKEND only",
  );
}

// ---------------------------------------------------------------------------
// 6. Build gates present and in order (Phase 4).
// ---------------------------------------------------------------------------
let cursor = 0;
for (const gate of REQUIRED_GATES) {
  const found = raw.indexOf(gate, cursor);
  if (found === -1) {
    problems.push(`missing or out-of-order build gate: \`${gate}\``);
    continue;
  }
  cursor = found + gate.length;
}

// ---------------------------------------------------------------------------
// 7. A post-deploy live verification job (Phase 7 / Phase 16).
// ---------------------------------------------------------------------------
if (!/^\s{2}verify-live:\s*$/m.test(raw)) {
  problems.push("missing `verify-live:` job");
}
if (!/^\s{4}needs:\s*deploy\s*$/m.test(raw)) {
  problems.push("`verify-live` must depend on the deploy job");
}

// ---------------------------------------------------------------------------
// 8. Referenced gate scripts exist.
// ---------------------------------------------------------------------------
for (const script of REFERENCED_SCRIPTS) {
  if (!raw.includes(script)) {
    problems.push(`workflow no longer references ${script}`);
  }
  if (!existsSync(script)) {
    problems.push(`workflow references ${script}, which does not exist`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

console.log(
  `ok ${WORKFLOW} is structurally valid: ${lines.length} lines, all run-block content correctly indented, deterministic backend, ordered gates, post-deploy verification present`,
);
