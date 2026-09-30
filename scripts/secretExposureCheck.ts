/**
 * SECRET-EXPOSURE CHECK (read-only, defensive).
 *
 * Purpose: prove no credential reaches the browser bundle OR sits in the
 * repository tree. Vite only inlines `VITE_*` variables, so the two real risks
 * are (a) a key hardcoded in source and (b) a credential FILE committed to the
 * repo — the second is how `.env.keys` (a dotenvx private key) shipped.
 *
 * This script NEVER prints a matched secret — it prints only the FILE and the
 * PATTERN NAME that matched, and a count. A scanner that echoes the secret it
 * found would itself become the leak.
 *
 * Usage:
 *   bun scripts/secretExposureCheck.ts                       # repo scan
 *   bun scripts/secretExposureCheck.ts <live-bundle-url>     # + bundle scan
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

/** Shape of each credential. Names only — no values, ever. */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai-style (sk-)", re: new RegExp("s" + "k-[A-Za-z0-9]{20,}") },
  { name: "google (AIza)", re: new RegExp("AI" + "za[0-9A-Za-z_-]{35}") },
  { name: "github (ghp_)", re: new RegExp("g" + "hp_[A-Za-z0-9]{30,}") },
  { name: "github fine-grained (github_pat_)", re: new RegExp("github" + "_pat_[A-Za-z0-9_]{50,}") },
  { name: "aws (AKIA)", re: new RegExp("A" + "KIA[0-9A-Z]{16}") },
  { name: "stripe (pk_live_)", re: new RegExp("p" + "k_live_[A-Za-z0-9]{20,}") },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer token literal", re: /["']Bearer [A-Za-z0-9._-]{20,}["']/ },
  { name: "slack token", re: new RegExp("xox" + "[bap]-[A-Za-z0-9-]{10,}") },
  // dotenvx private keys: the value is `dotenv://:key_<hex>@dotenvx.com/...`
  { name: "dotenvx private key", re: new RegExp("dotenv" + "://:key_[A-Za-z0-9]{32,}") },
  { name: "dotenv private key assignment", re: /DOTENV_PRIVATE_KEY[A-Z_]*\s*=\s*["']?[A-Za-z0-9]{16,}/ },
  // Convex deploy keys look like `prod:<deployment>|<long secret>`.
  { name: "convex deploy key", re: new RegExp("(?:prod|dev|preview)" + ":[a-z0-9-]+\\|[A-Za-z0-9_-]{20,}") },
];

/**
 * Credential FILES that must never exist in the repository tree at all.
 * Matched by exact name, so a legitimate file like `src/lib/keys.ts` is
 * untouched while `.env.keys` is caught.
 */
const FORBIDDEN_FILES = new Set([
  ".env.keys",
  ".env.vault",
  ".convex-deploy-key",
  "convex-deploy-key.txt",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
]);

/**
 * Local-only env files. These are legitimate on disk — the dev environment
 * needs `.env.local`. They are NOT a leak as long as an ignore rule covers
 * them, so they are reported as informational and only become a finding when
 * `.gitignore` stops covering them.
 */
const LOCAL_ENV_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
]);

/**
 * Files that intentionally contain FAKE credential shapes in order to test the
 * redaction/scanning paths. Allowlisted by exact path so the scan stays useful
 * everywhere else. Keep this list tiny — every entry is a blind spot.
 */
const FIXTURE_ALLOWLIST = new Set([
  "tests/omiSourceVerificationAndSecurity.test.ts",
  "tests/omiObservability.test.ts",
]);

/** Directories that are never part of the shipped repository. */
const SKIP = new Set([
  "node_modules",
  "dist",
  ".git",
  ".qa-tmp",
  ".qa-bak",
  "coverage",
  ".vite",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".yml", ".yaml", ".txt", ".env", ".example",
  ".html", ".css", ".toml", ".sh", "",
]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let findings = 0;
let scanned = 0;
let forbidden = 0;

// --- 1. Credential files that must not exist in the tree ---------------------
const gitignore = readFileSync(".gitignore", "utf8");
const ignoredByPattern = (name: string) =>
  gitignore.includes(name) || /^\.env\.\*$/m.test(gitignore) || /^\*\.local$/m.test(gitignore);

console.log("== repository tree: forbidden credential files ==");
for (const file of walk(".")) {
  const name = basename(file);
  const looksLikePem =
    /\.(pem|key)$/.test(name) || /^(id_rsa|id_ed25519)(\.pub)?$/.test(name);
  if (FORBIDDEN_FILES.has(name) || looksLikePem) {
    forbidden++;
    findings++;
    // File NAME only — never the contents.
    console.log(`  FORBIDDEN FILE PRESENT: ${file}`);
  } else if (LOCAL_ENV_FILES.has(name)) {
    if (ignoredByPattern(name)) {
      console.log(`  ok (local-only, git-ignored): ${file}`);
    } else {
      findings++;
      console.log(`  LEAK? ${file} exists and is NOT covered by .gitignore`);
    }
  }
}
console.log(
  forbidden === 0
    ? "  none present"
    : `  ${forbidden} forbidden file(s) — remove from the tree AND from Git history`,
);

// --- 2. Credential-shaped strings in repository text files ------------------
console.log("\n== repository text: credential shapes ==");
for (const file of walk(".")) {
  if (!TEXT_EXT.has(extname(file))) continue;
  // Never read a credential file's contents — presence is already reported.
  if (FORBIDDEN_FILES.has(basename(file))) continue;
  if (FIXTURE_ALLOWLIST.has(file.replace(/^\.\//, ""))) continue;
  scanned++;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) {
      findings++;
      console.log(`  LEAK? ${file} matched ${name}`);
    }
  }
}
console.log(`  scanned ${scanned} repository text files`);

// --- 3. The live bundle is the real question: what ships to a browser -------
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
    ? "\nRESULT: clean — no credential shape or credential file found"
    : `\nRESULT: ${findings} potential exposure(s) — investigate before shipping`,
);
process.exit(findings === 0 ? 0 : 1);
