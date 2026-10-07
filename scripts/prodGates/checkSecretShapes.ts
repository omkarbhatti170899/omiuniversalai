/**
 * GATE — no credential-shaped string may reach a shipped artifact.
 * =============================================================================
 *
 * This is the security half of the pre-deploy gate: whatever ends up in `dist/`
 * is world-readable, so a leaked key there is a live leak. The patterns are
 * deliberately shaped (length + prefix) rather than "anything with 'key' in it",
 * to keep false positives near zero on minified bundles.
 *
 * The scanner reports the PATTERN NAME and the file only — it never echoes the
 * matched value, because a scanner that prints what it finds would itself
 * become the leak.
 *
 * Usage: bun scripts/prodGates/checkSecretShapes.ts <dir>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];

if (!dir) {
  console.error("usage: checkSecretShapes.ts <dir>");
  process.exit(2);
}

/** Kept in sync with scripts/secretExposureCheck.ts — names only. */
const SHAPES: Array<{ name: string; pattern: RegExp }> = [
  { name: "stripe live secret key", pattern: /sk_live_[A-Za-z0-9]{20,}/ },
  { name: "stripe test secret key", pattern: /sk_test_[A-Za-z0-9]{20,}/ },
  { name: "stripe live publishable key", pattern: /pk_live_[A-Za-z0-9]{20,}/ },
  { name: "google api key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "github pat (classic)", pattern: /ghp_[A-Za-z0-9]{36}/ },
  { name: "github pat (fine-grained)", pattern: /github_pat_[A-Za-z0-9_]{30,}/ },
  { name: "aws access key id", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "slack token", pattern: /xox[bpsa]-[A-Za-z0-9-]{10,}/ },
  {
    name: "private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  { name: "dotenv private key", pattern: /dotenv:\/\/:key_[A-Za-z0-9]{32,}@/ },
  { name: "dotenv private key env var", pattern: /DOTENV_PRIVATE_KEY[A-Z_]*["']?[A-Za-z0-9]{16,}/ },
  // OpenAI keys are hyphenated (`sk-proj-`, `sk-svcacct-`), so a bare
  // `sk-[A-Za-z0-9]{32,}` misses the formats actually in use today. The legacy
  // arm keeps a lookbehind so it cannot fire inside a word (a minified
  // `task-` followed by a long Tailwind class string is the false positive
  // this avoids); the hyphenated arm requires the literal `sk-proj-`/
  // `sk-svcacct-` prefix, which cannot occur by accident.
  { name: "openai project key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "openai service-account key", pattern: /sk-svcacct-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-style key", pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{24,}/ },
];

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
]);

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (!stats.isFile()) continue;
    const dot = entry.lastIndexOf(".");
    const ext = dot === -1 ? "" : entry.slice(dot).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;
    out.push(full);
  }
  return out;
}

const findings: string[] = [];
let scanned = 0;

for (const file of walk(dir)) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  scanned += 1;
  for (const { name, pattern } of SHAPES) {
    if (pattern.test(text)) findings.push(`${name} in ${file}`);
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`::error::credential-shaped value (${finding}) — do not deploy`);
  }
  process.exit(1);
}

console.log(`ok no credential-shaped value in ${dir}/ (${scanned} text files scanned)`);
