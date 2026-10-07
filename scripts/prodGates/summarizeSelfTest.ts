/**
 * The production backend must answer /status, /health and /selftest before the
 * frontend is pointed at it. This summarises the /selftest payload into the
 * workflow log so a degraded backend is visible in CI rather than only on the
 * live site.
 *
 * Deliberately non-fatal: an unconfigured provider or a degraded search layer
 * is an owner-side configuration state, not a reason to block a frontend
 * deploy. What must be fatal — the endpoint being unreachable — is enforced by
 * the HTTP status checks in the workflow itself.
 *
 * Usage: bun scripts/prodGates/summarizeSelfTest.ts <selftest.json>
 */

import { readFileSync } from "node:fs";

const path = process.argv[2];

if (!path) {
  console.error("usage: summarizeSelfTest.ts <selftest.json>");
  process.exit(2);
}

let payload: Record<string, unknown>;
try {
  payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`::warning::could not read ${path}: ${detail}`);
  process.exit(0);
}

const summary = payload.summary;
console.log("selftest summary:", JSON.stringify(summary ?? payload.status ?? "unknown"));

const subsystems = payload.subsystems;
if (!Array.isArray(subsystems)) {
  process.exit(0);
}

const failing = subsystems.filter((row) => {
  if (typeof row !== "object" || row === null) return false;
  const status = (row as { status?: unknown }).status;
  return status !== "pass";
});

for (const row of failing) {
  const entry = row as { subsystem?: unknown; status?: unknown; detail?: unknown };
  const name = typeof entry.subsystem === "string" ? entry.subsystem : "unknown";
  const status = typeof entry.status === "string" ? entry.status : "unknown";
  const detail = typeof entry.detail === "string" ? entry.detail : "";
  // ::warning:: keeps the deploy unblocked while making the gap unmissable.
  console.log(`::warning::subsystem not passing: ${name} [${status}] ${detail}`);
}

console.log(
  `subsystems passing: ${subsystems.length - failing.length}/${subsystems.length}`,
);
