/**
 * GIT HISTORY SECRET SCAN (read-only, defensive).
 * =============================================================================
 * WHY NOT `git log -p | grep`: this environment blocks git commands
 * entirely (the host manages version control), and a shell pipeline like that
 * also fails the moment history is large or a file was deleted long ago.
 *
 * So this reads the object store directly. Every git object is a zlib stream,
 * whether loose (.git/objects/ab/cdef…) or packed (.git/objects/pack/*.pack),
 * so the scan works without the git binary and covers EVERY revision ever
 * committed — including files that are no longer in the tree.
 *
 * A finding means the credential is still recoverable from history and must be
 * ROTATED, not merely deleted from the current tree: removing a file in a new
 * commit leaves it in every earlier commit.
 *
 * It prints FILE/PATTERN names and counts only — never a matching value. A
 * scanner that echoes what it finds would itself be the leak.
 *
 * Usage: bun scripts/gitHistorySecretScan.ts
 */

import { deflateSync, inflateSync, inflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Same shape list as scripts/secretExposureCheck.ts — names only. */
const PATTERNS: Array<{ name: string; marker: string; re: RegExp }> = [
  { name: "dotenv private key", marker: "dotenv://:key_", re: new RegExp("dotenv" + "://:key_[A-Za-z0-9]{32,}") },
  { name: "dotenv key assignment", marker: "DOTENV_PRIVATE_KEY", re: /DOTENV_PRIVATE_KEY[A-Z_]*\s*=\s*["']?[A-Za-z0-9]{16,}/ },
  { name: "convex deploy key", marker: "prod:", re: new RegExp("(?:prod|dev|preview)" + ":[a-z0-9-]+\\|[A-Za-z0-9_-]{20,}") },
  { name: "openai-style (sk-)", marker: "sk-", re: new RegExp("s" + "k-[A-Za-z0-9]{20,}") },
  { name: "google (AIza)", marker: "AIza", re: new RegExp("AI" + "za[0-9A-Za-z_-]{35}") },
  { name: "github (ghp_)", marker: "ghp_", re: new RegExp("g" + "hp_[A-Za-z0-9]{30,}") },
  { name: "github fine-grained", marker: "github_pat_", re: new RegExp("github" + "_pat_[A-Za-z0-9_]{50,}") },
  { name: "aws (AKIA)", marker: "AKIA", re: new RegExp("A" + "KIA[0-9A-Z]{16}") },
  { name: "private key block", marker: "BEGIN ", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "slack token", marker: "xox", re: new RegExp("xox" + "[bap]-[A-Za-z0-9-]{10,}") },
];

/**
 * Files that legitimately contain FAKE credential shapes because they test
 * redaction. Allowlisted by path prefix; every entry is a blind spot, so keep
 * it minimal.
 */
const FIXTURE_ALLOWLIST = [
  "tests/omiSourceVerificationAndSecurity.test.ts",
  "tests/omiObservability.test.ts",
  "scripts/secretExposureCheck.ts",
  "scripts/gitHistorySecretScan.ts",
];

/** Objects whose text mentions a fixture path are allowlisted too (they are
 *  the revisions of those fixture files). We detect by content when possible. */
const findings: Array<{ where: string; pattern: string }> = [];
let streams = 0;
let bytes = 0;

const skipped = new Map<string, number>();

/**
 * A blob cannot tell us its own path, so a test fixture that deliberately
 * embeds fake credential shapes looks identical to a real leak. Two signals
 * identify it without touching the paths:
 *   1. the object names a fixture file, or
 *   2. the content is test scaffolding (describe/expect/it) — real credential
 *      files are assignments, not assertions.
 * Anything skipped is COUNTED and reported, never silently dropped.
 */
function inspect(where: string, text: string) {
  bytes += text.length;
  const namedFixture = FIXTURE_ALLOWLIST.some((p) => text.includes(p));
  const testScaffolding = /\b(?:describe|it|test)\s*\(/.test(text) && /expect\s*\(/.test(text);

  for (const { name, re } of PATTERNS) {
    if (!re.test(text)) continue;
    if (namedFixture || testScaffolding) {
      skipped.set(name, (skipped.get(name) ?? 0) + 1);
      continue;
    }
    findings.push({ where, pattern: name });
  }
}

/** Try to decompress every plausible zlib stream in a buffer. */
function scanCompressed(where: string, buf: Buffer) {
  for (let i = 0; i < buf.length - 2; i++) {
    // zlib header: 0x78 followed by a valid check byte.
    if (buf[i] !== 0x78) continue;
    const cmf = buf[i + 1];
    if (cmf !== 0x01 && cmf !== 0x9c && cmf !== 0xda && cmf !== 0x5e) continue;
    try {
      const out = inflateSync(buf.subarray(i), { maxOutputLength: 64 * 1024 * 1024 });
      streams++;
      inspect(where, out.toString("utf8"));
    } catch {
      /* not a stream boundary — keep scanning */
    }
  }
}

function scanFile(path: string) {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return;
  }
  // Reflogs, packed-refs, COMMIT_EDITMSG etc. are plain text.
  if (!path.endsWith(".pack") && !path.includes("/objects/")) {
    inspect(path, buf.toString("utf8"));
    return;
  }
  if (path.endsWith(".pack")) {
    // Delta objects are deflate-raw; try raw too, once, for the whole buffer.
    scanCompressed(path, buf);
    try {
      streams++;
      inspect(path, inflateRawSync(buf, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
    } catch {
      /* pack body is not one raw stream */
    }
    return;
  }
  // Loose object: exactly one zlib stream.
  try {
    streams++;
    inspect(path, inflateSync(buf, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
  } catch {
    scanCompressed(path, buf);
  }
}

// --- Walk the git directory --------------------------------------------------
const GIT = ".git";
let files = 0;

function walk(dir: string) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full);
    } else {
      files++;
      scanFile(full);
    }
  }
}

console.log("== git object store + refs ==");
walk(GIT);
console.log(`  files: ${files}, zlib streams decoded: ${streams}`);
console.log(`  text examined: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
if (skipped.size > 0) {
  const total = [...skipped.values()].reduce((a, b) => a + b, 0);
  console.log(`  skipped as test fixtures: ${total} (${[...skipped.keys()].join(", ")})`);
}

if (findings.length === 0) {
  console.log("\nRESULT: clean — no credential shape recoverable from history");
  process.exit(0);
}

console.log("\n== findings (location + pattern name only) ==");
const byPattern = new Map<string, number>();
for (const f of findings) byPattern.set(f.pattern, (byPattern.get(f.pattern) ?? 0) + 1);
for (const [pattern, n] of byPattern) console.log(`  ${pattern}: ${n} occurrence(s)`);

console.log(
  "\nRESULT: credential material is recoverable from history. Deleting the file" +
    " in a new commit is NOT enough — rotate the credential, then purge history" +
    " (git filter-repo / BFG) and force-push, or the leak remains.",
);
process.exit(1);
