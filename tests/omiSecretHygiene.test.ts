/**
 * SECRET HYGIENE — repository credential containment.
 * =============================================================================
 * Context: a tracked `.env.keys` file (a dotenvx private key) was found on the
 * published branch. An ignore rule cannot untrack an already-committed file, so
 * containment needs two things that CAN be enforced in-repo:
 *
 *   1. the file must not exist in the working tree, and
 *   2. `.gitignore` must keep it out of every future commit.
 *
 * This test fails while (1) is false, which makes the cleanup machine-checkable
 * instead of a promise. It also pins the two other rules the owner stated:
 * deploy keys and provider credentials must never enter the repository.
 *
 * It never reads or asserts on any secret VALUE — only on presence and rules.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const root = (p: string) => new URL(`../${p}`, import.meta.url).pathname;
const read = (p: string) => readFileSync(root(p), "utf-8");

/**
 * Credential files that must NOT exist in the working tree at all.
 *
 * `.env.local` is deliberately NOT in this list: it is the platform-managed
 * local dev file, it is git-ignored, and the dev session needs it. Local-only
 * env files are covered by the ignore-rule test below instead. What must be
 * absent is the class that leaked INTO the published branch — a key file and
 * any deploy/private key material.
 */
const FORBIDDEN = [
  ".env.keys",
  ".env.vault",
  ".convex-deploy-key",
  "convex-deploy-key.txt",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
];

/** Local-only env files that are fine on disk but must stay git-ignored. */
const GITIGNORED = [".env", ".env.local", ".env.production", ".env.keys"];

describe("credential files are not in the repository tree", () => {
  for (const file of FORBIDDEN) {
    test(`${file} is absent`, () => {
      // If this fails, the leak is still present: remove the file from the tree
      // AND from Git history, then rotate the credential — deleting it in a new
      // commit does not remove it from history.
      expect(existsSync(root(file))).toBe(false);
    });
  }

  test("the dotenvx key file that leaked is explicitly ignored", () => {
    const ignore = read(".gitignore");
    // `.env.*` already matches it; the explicit line documents intent and
    // survives if someone later adds an exception like `!.env.*`.
    expect(ignore).toMatch(/^\.env\.keys$/m);
    expect(ignore).toMatch(/^\.env\.\*$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
  });

  test("every local-only env file is covered by an ignore rule", () => {
    const ignore = read(".gitignore");
    for (const file of GITIGNORED) {
      // `.env.*` covers all of them; the explicit `.env.keys` line is asserted
      // separately because that is the file that actually leaked.
      const covered =
        ignore.includes(file) || /^\.env\.\*$/m.test(ignore);
      expect(covered).toBe(true);
    }
  });

  test("the only tracked env file is the placeholder example", () => {
    expect(existsSync(root(".env.example"))).toBe(true);
    // The example must hold names/placeholders, never a real credential.
    const example = read(".env.example");
    expect(example).not.toMatch(/=\s*["']?[A-Za-z0-9_-]{32,}/);
  });
});

describe("deploy keys are kept out of the repository", () => {
  test("gitignore blocks private keys and deploy-key files", () => {
    const ignore = read(".gitignore");
    for (const rule of ["*.pem", "*.key", ".convex-deploy-key"]) {
      expect(ignore).toContain(rule);
    }
  });

  test("CI never embeds a deploy key in the workflow", () => {
    // The Pages workflow builds the frontend only. It must reference secrets by
    // NAME via the Actions secret store, never inline a value.
    const wf = read(".github/workflows/deploy-pages.yml");
    // Match the actual COMMAND, not prose like "no deployment configured".
    expect(wf).not.toMatch(/(?:run:|npx|bunx|npx\s+--yes)\s*[^\n]*convex\s+deploy\b/i);
    expect(wf).not.toMatch(/(?:prod|dev|preview):[a-z0-9-]+\|[A-Za-z0-9_-]{20,}/);
    // If it ever needs a key, it must come from the secret store.
    if (/CONVEX_DEPLOY_KEY/.test(wf)) {
      expect(wf).toContain("${{ secrets.");
    }
  });

  test("the application never reads a deploy key from client code", () => {
    // A deploy key in client code would be inlined into the browser bundle.
    for (const file of ["src/main.tsx", "src/pages/Dashboard.tsx"]) {
      if (!existsSync(root(file))) continue;
      expect(read(file)).not.toContain("CONVEX_DEPLOY_KEY");
    }
  });
});

describe("the scanner cannot become the leak", () => {
  test("secretExposureCheck prints locations and pattern names only", () => {
    const src = read("scripts/secretExposureCheck.ts");
    // No console.log may interpolate a matched value; only file + pattern name.
    const logs = src.match(/console\.log\([^)]*\)/g) ?? [];
    for (const line of logs) {
      expect(line).not.toMatch(/match(?:es)?\[/);
      expect(line).not.toMatch(/\bm\.value\b/);
    }
    // It must know about the file class that actually leaked.
    expect(src).toContain(".env.keys");
    expect(src).toContain("dotenvx private key");
    expect(src).toContain("convex deploy key");
  });

  test("the scanner refuses to read credential file contents", () => {
    const src = read("scripts/secretExposureCheck.ts");
    // Presence is reported; contents are skipped.
    expect(src).toContain("if (FORBIDDEN_FILES.has(basename(file))) continue;");
  });
});
