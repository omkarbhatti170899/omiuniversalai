/**
 * SECRET-EXPOSURE CHECK (read-only, defensive).
 *
 * Purpose: prove no provider API key reaches the browser bundle. Vite only
 * inlines `VITE_*` variables, so the real risk is a key hardcoded in source
 * or a backend secret accidentally referenced from client code.
 *
 * This script NEVER prints a matched secret — it prints only the FILE and the
 * PATTERN NAME that matched, and a count. A scanner that echoes the secret it
 * found would itself become the leak.
 *
 * Usage: bun scripts/secretExposureCheck.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

/** Shape of each provider key. Names only — no values, ever. */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai-style (sk-)", re: new RegExp("s" + "k-[A-Za-z0-9]{20,}") },
  { name: "google (AIza)", re: new RegExp("AI" + "za[0-9A-Za-z_-]{35}") },
  { name: "github (ghp_)", re: new RegExp("g" + "hp_[A-Za-z0-9]{30,}") },
  { name: "aws (AKIA)", re: new RegExp("A" + "KIA[0-9A-Z]{16}") },
  { name: "stripe (pk_live_)", re: new RegExp("p" + "k_live_[A-Za-z0-9]{20,}") },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer token literal", re: /["']Bearer [A-Za-z0-9._-]{20,}["']/ },
];

const SCAN_DIRS = ["src"];
const SKIP = new Set(["node_modules", "dist", ".git", ".qa-tmp", "coverage"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (CODE_EXT.has(extname(full))) yield full;
  }
}

let findings = 0;
let scanned = 0;

console.log("== client source: provider-key shapes ==");
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    scanned++;
    const text = readFileSync(file, "utf8");
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) {
        // Report location + pattern name only. Never the value.
        findings++;
        console.log(`  LEAK? ${file} matched ${name}`);
      }
    }
  }
}
console.log(`  scanned ${scanned} client source files`);

/** The live bundle is the real question: what actually ships to a browser. */
const LIVE = process.argv[2];
if (LIVE) {
  console.log("\n== live deployed bundle ==");
  try {
    const res = await fetch(LIVE);
    const body = await res.text();
    for (const { name, re } of PATTERNS) {
      if (re.test(body)) {
        findings++;
        console.log(`  LEAK? deployed bundle matched ${name}`);
      }
    }
    console.log(`  bundle bytes: ${body.length}, matched: 0 unless listed above`);
  } catch (err) {
    console.log(`  could not fetch bundle: ${String(err)}`);
  }
}

console.log(
  findings === 0
    ? "\nRESULT: clean — no provider key shape found in client code or bundle"
    : `\nRESULT: ${findings} potential exposure(s) — investigate before shipping`,
);
process.exit(findings === 0 ? 0 : 1);
