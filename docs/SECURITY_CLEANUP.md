# SECURITY CLEANUP — leaked dotenv key + production deploy gate

**Date:** 2026-09-30 · **Status: CONTAINMENT DONE · ROTATION + PURGE OWNER-SIDE**

---

## 1. What leaked

A **`.env.keys`** file (a dotenvx private key, `DOTENV_PRIVATE_KEY_LOCAL`) was
tracked in the published branch. Reported by the owner; independently confirmed
here by scanning the git object store directly.

**The value was never read, printed, or copied by any tooling in this pass.**
Every new scanner reports *location + pattern name + count* only. A scanner that
echoes what it finds becomes the leak.

### Confirmed in history (independent of the git binary)

```
== git object store + refs ==
  files: 2539, zlib streams decoded: 2516
  text examined: 25.8 MB
  skipped as test fixtures: 7 (openai-style (sk-), google (AIza), github (ghp_),
                                        aws (AKIA), private key block)

== findings (location + pattern name only) ==
  dotenv key assignment: 1 occurrence(s)
```

Exactly **one** real finding: the dotenv private-key assignment. The seven
provider-key-shaped hits are fake patterns inside redaction **test fixtures**;
they are detected by test scaffolding (`describe`/`expect`) and reported as
skipped rather than silently dropped.

## 2. Why deletion alone is not enough

An ignore rule cannot untrack an already-committed file, and deleting a file in
a **new commit leaves it in every earlier commit**. So:

- Removing it from the working tree stops *new* commits carrying it (containment).
- The credential is still recoverable from history ⇒ it must be **rotated**.
- Optional hardening: purge history (`git filter-repo` / BFG) and force-push.

## 3. What was done in-repo

| Action | Where |
|---|---|
| Explicit `.env.keys` ignore rule + `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, deploy-key filenames | `.gitignore` |
| Scanner extended: forbidden credential **files** in the tree, dotenv/Convex-deploy key shapes, fine-grained PATs, slack tokens | `scripts/secretExposureCheck.ts` |
| **New**: git-history scanner that decodes the object store with `zlib` (works without the git binary) | `scripts/gitHistorySecretScan.ts` |
| **New** regression gate — fails while the key file exists, and pins ignore coverage, deploy-key exclusion, and the scanners' no-echo guarantee | `tests/omiSecretHygiene.test.ts` |

The hygiene test is wired into the existing `bun run test` step of
`.github/workflows/deploy-pages.yml`, so **a leaked credential file now blocks
the frontend deploy** instead of shipping.

Current suite: **1,486 tests, 1 failure — and it is that gate**
(`credential files are not in the repository tree > .env.keys is absent`). It
turns green the moment the file is gone. That is the machine-checked definition
of done.

## 4. Owner actions (in order)

1. **Remove the file from the tree and from tracking** (the agent's file tools are
   blocked from env files by platform policy):
   ```bash
   git rm --cached .env.keys      # untrack
   rm .env.keys                   # remove locally
   git commit -m "Remove leaked dotenv key file"
   ```
2. **Rotate the dotenv private key.** The value in that file is public now.
   With dotenvx: `npx dotenvx rotate` (then re-encrypt any vault it protects), or
   delete the key and regenerate it in whatever store produced it.
3. **Purge history** (choose one) and force-push:
   ```bash
   git filter-repo --path .env.keys --invert-paths
   # or: bfg --delete-files .env.keys
   git push --force-with-lease
   ```
   Rotating (step 2) is what actually protects you; the purge is hygiene.
4. **Re-run the two scanners** to prove containment:
   ```bash
   bun scripts/secretExposureCheck.ts          # expect: clean
   bun scripts/gitHistorySecretScan.ts         # expect: clean AFTER the purge
   bun test tests/omiSecretHygiene.test.ts     # expect: 16 pass / 0 fail
   ```

## 5. Credentials that must never enter the repository

Pinned by test, not by convention:

- `CONVEX_DEPLOY_KEY` — belongs in the host's secret store / environment only.
  The Pages workflow builds the frontend and **never** runs `convex deploy`, so
  CI needs no Convex credential at all.
- Provider keys (`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`,
  `DEEPSEEK_API_KEY`, `POLLINATIONS_API_KEY`, `LANGSEARCH_API_KEY`,
  `SEARXNG_SHARED_SECRET`) — server-side in the **Convex dashboard**, per the
  production deployment. Only the public `VITE_CONVEX_URL` connection string is
  ever compiled into the frontend.
- `.env.example` is the only tracked env file and holds **names with empty
  values** — asserted by test.

## 6. Deployed bundle re-verified clean

`index-C5_zbKv7.js` (478,788 bytes, the live Pages entry chunk) scanned against
all credential patterns: **0 matches**.

## 7. Why CI (GitHub Actions / Vercel) is red while `.env.keys` is tracked

These are **one** failure, not three, so they are fixed by one change.

The security gate is deliberately wired into the build, not left as a local
convenience:

- `.github/workflows/deploy-pages.yml` runs `bun run typecheck` and
  `bun run test` (`bun test tests/`) **before** it builds or deploys anything.
- `tests/omiSecretHygiene.test.ts` fails whenever a credential file is present
  in the tree, and `.env.keys` is present in the tree.
- So the suite exits non-zero, the build step never runs, and the commit shows
  a red status. Any host that runs the same verify step (GitHub Actions, the
  platform's Vercel build) reports FAILURE for the same reason.

The gate must not be relaxed to get green. A green build that ignores a
tracked private key is worse than a red one, because it looks like a release.

**Untracking the file is what turns CI green** — no other change is required:

```bash
git rm --cached .env.keys
rm .env.keys
git commit -m "chore(security): untrack leaked dotenvx private key"
```

`tests/omiSecretHygiene.test.ts` then reports 16 pass / 0 fail, the Pages
workflow proceeds to `bun run build`, and the red status clears on the next
commit. Rotation (§4 step 2) and the history purge (§4 step 3) remain
required and are **independent** of the CI fix: untracking stops the leak from
continuing, it does not un-leak what is already in history.
