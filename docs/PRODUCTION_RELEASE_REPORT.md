# OMI 1.0 — PRODUCTION RELEASE REPORT

**Date:** 2026-09-30 · **Cost: ₹0/month (hard requirement, maintained)**
**Status: NOT READY — 2 blocking items, both owner-side, both ₹0**

Nothing in this report is a development task. No architecture changed, no
provider added, no search-layer change: the 178-row matrix remains the frozen
regression gate.

---

## 0. The single blocking discovery

There are **two Convex deployments**, and the deployed frontend points at the
wrong one:

| Deployment | State | Who uses it |
|---|---|---|
| `striped-salmon-879.convex.cloud` | **LIVE** | This dev environment — the CLI (`bunx convex run`) and every piece of evidence in this session |
| `resolute-ptarmigan-187.convex.cloud` | **PAUSED** | **The live GitHub Pages frontend** |

Evidence:

- The shipped entry chunk contains the constant
  `const NT="https://resolute-ptarmigan-187.convex.cloud"` — the backend URL is
  baked in at build time from `VITE_CONVEX_URL` (`src/main.tsx:90`).
- `.github/workflows/deploy-pages.yml` falls back to the **same paused URL** when
  no repo variable is set.
- Every call to the paused deployment returns:
  `"Cannot run functions while this deployment is paused. Resume the deployment
  in the dashboard settings to allow functions to run."` (verified on
  `/selftest`, `/currentinfo` and `/api/query`).

**User-visible effect right now: the app shell loads from GitHub Pages, and
every action inside it fails.** This is infrastructure, not an application bug.

### Fix (owner, ~30 seconds, ₹0)

Dashboard → project `omkar-bhatti / omiuniversalai` → deployment
`resolute-ptarmigan-187` → **Resume**. The Convex CLI has no resume command
(verified), so this is dashboard-only.

**No frontend rebuild is needed afterwards** — the deployed bundle is current
(built 30 Sep 03:44 UTC; all four UI markers verified present in the live
chunks, §3). After the resume, run `bunx convex deploy` so the production
deployment carries the same function code as dev, then re-run §2 against it.

*Alternative if the paused deployment is unrecoverable:* set the repository
variable `VITE_CONVEX_URL = https://striped-salmon-879.convex.cloud`
(Settings → Secrets and variables → Actions → Variables) and re-run the
`Deploy to GitHub Pages` workflow. Free, but it points "production" at the dev
deployment — not recommended.

---

## 1. Second blocking item: image generation is failing for real users

Measured on the **live** deployment (`/selftest`, 04:17 UTC): `status: degraded`,
**19 pass / 3 fail / 5 configured**.

| Subsystem | Result | Detail |
|---|---|---|
| image generation | **FAIL** | `pollinations: 402` · `gemini: free-tier quota is exhausted` · `openai: no remaining credits` — all three providers exhausted |
| image variation | **FAIL** | same three-provider exhaustion |
| current information | **FAIL** | 9/10 first-pass scenarios; the chat path escalates and rescues it (rescue rate measured 7/8) |
| image upload / storage / retrieval, file processing, deep research | configured | require a signed-in session → human QA |

The image failure is **not a code defect**: the router, source-byte
verification and honest 402 mapping are unit-pinned, and the same paths passed
byte-verified on 27 Sep. The free Pollinations balance was consumed during
verification. **Fix (owner, ₹0 possible):** earn free Pollen via Pollinations
Quests, or accept degraded image features for 1.0. Editing inherits the same
condition; small-input edits passed before the balance ran out.

---

## 2. Verification actually executed (live, unpaused deployment)

| Check | Result |
|---|---|
| `bun test` | **1,439 pass / 0 fail**, 76 files, 5,018 assertions |
| `bunx tsc -b --noEmit` | **0 errors** |
| `bunx eslint src/` | **0 errors** (5 pre-existing warnings) |
| `bunx convex dev --once` | functions ready, 16.8 s |
| F1 2026 championship — real chat path | **answered + cited**: "Kimi Antonelli … 302 points … leads ahead of Russell", `[1]` present, dated 2026 sources |
| 12-scenario real-world audit | **10 answers + 2 correct refusals, 0 fabrications**, 1.9–8.0 s |
| `/selftest` on live deployment | 19 pass / 3 fail / 5 configured (§1) |
| Search matrix (frozen gate) | 172/178 (97%), 0 off-topic, 0 wrong-year, 0 duplicate URLs, 178/178 citations resolve |
| SearXNG reachability | PASS but **12.3 s** — opportunistic only, never blocking |
| Dependency audit (`bun audit`) | **first time ever run** — see §4 |
| Live frontend markers | **4/4 present** in the deployed chunks (§3) |

Per the owner's instruction, results from the paused deployment are **not**
counted as final evidence. The verification above is against the live
deployment and must be re-run against the resumed production deployment.

---

## 3. Fix made this pass (QA tooling, not a feature)

`docs/HUMAN_QA_CHECKLIST.md` told the human reviewer to grep the **entry bundle**
for four UI markers. Those markers live in **lazily-loaded view chunks**
(`Dashboard`, `OmiAssistantPanel`), and chunk imports nest two levels deep — so
the check returned 0 and would have told the reviewer *"you are testing a stale
build — STOP"*, falsely blocking the entire human QA pass.

Replaced with a verified graph-walking check (entry → views → panels, 25 chunks,
1.7 MB) that returns **4/4 markers ≥ 1** on the current live build. Added
**Step 0**: confirm the backend deployment answers before starting, so a paused
deployment is diagnosed as infrastructure rather than an app bug.

---

## 4. Non-blocking cleanup (YELLOW, documented)

| Item | Finding | Cost | Fix |
|---|---|---|---|
| **CSP / security headers** | Live site serves only `strict-transport-security`. GitHub Pages cannot set headers, so the only lever is a `<meta>` CSP. Deliberately not applied blind — an over-strict policy blanks the app and **no browser exists here to catch that** | ₹0 | Browser-test a CSP, then ship it |
| **Dependency audit** | `bun audit` (never run before): `node-tar` (high, transitive **build-time**, absent from the shipped bundle), `brace-expansion` (high, build-time), `hono` (moderate, ships inside the Convex **function** runtime; advisory is `toSSG()`, which Omi does not use). **None of the three appear in the browser bundle** (grep = 0) | ₹0 | `bun update` on a normal deploy day |
| **SearXNG** | Frozen: opportunistic free provider. 12.3 s reachability today, occasionally slow; 17 other free providers + structured feeds carry the turn. Never a single point of failure | ₹0 | None — do **not** force it to mandatory |
| **Search matrix** | Frozen as the regression gate for any future search-layer change | ₹0 | — |

---

## 5. Android — owner-side, categorised (from `docs/android-packaging.md`)

**A. On your phone / PC**
1. PWA device test: Android Chrome → open the site → *Add to Home screen* →
   launch standalone → Airplane mode → offline shell loads → reconnect → "Back
   online" bar → sign in, chat, upload a file, generate an image on the phone.
2. Check keyboard never covers the input; no horizontal scroll; touch targets
   comfortable one-handed.

**B. What Freebuff (me) does**
Nothing remains that is automatable in this environment — verified, not assumed:
- **App icons** (192/512/maskable PNG): needs a rasterizer. `cairosvg` installs
  but there is no system `libcairo` and no package-install rights here; no
  ImageMagick/`rsvg`/PIL either. **Environment-blocked.**
- **Native build checks**: no JDK/Gradle/Android SDK in this sandbox (verified).
- Everything else is already committed: `capacitor.config.ts`, manifest,
  service worker, offline shell, permissions table, TWA/Bubblewrap steps,
  assetlinks instructions.

**C. Requires a Google Play Console account** (only for store distribution)
1. Play developer account (**one-time US$25 fee** — the only money in this plan).
2. Play App Signing key → SHA-256 fingerprint.
3. TWA build via PWABuilder or Bubblewrap.
4. `assetlinks.json` published at the **domain root** — Pages serves this repo
   under `/omiuniversalai/`, so it must go in a separate
   `omkarbhatti170899.github.io` repo (or a root custom domain), using the Play
   App Signing fingerprint, not the upload key.
5. AAB upload + store listing.

**D. Completely free** — everything in A and B, plus the Capacitor path
(`npx cap add android` → sync → Gradle) on a machine you already own. Free
Pollinations Quests for image balance. Self-hosting SearXNG on your own machine.

**E. Optional** — Play Console / TWA / store listing entirely. The PWA is
already installable and is the free distribution channel. **Android does not
block web QA** and does not block Omi 1.0 as a web release.

---

## 6. Final gate

| Gate | Status |
|---|---|
| Production deployment active | 🔴 **owner action** (resume in dashboard) |
| Live frontend working | 🔴 blocked by the above |
| Human QA completed | 🔴 **owner action** (`docs/HUMAN_QA_CHECKLIST.md`, gate now fixed) |
| Production verification passed | 🟡 passed against the live deployment; **re-run required** against the resumed one |
| ₹0/month | 🟢 maintained |
| Search architecture frozen | 🟢 unchanged |
| YELLOW cleanup documented | 🟢 §4 |
| RED unresolved | **2** — paused production deployment, image providers 402 |

**Omi 1.0 is declared READY when:** the deployment is resumed, `bunx convex
deploy` has run, the human QA checklist is recorded PASS/FAIL, and §2 has been
re-run green against the resumed production deployment. The Pollinations 402 is
a provider-credit condition, not a code defect — it may be accepted for 1.0
with image features marked degraded, or cleared for ₹0 via Quests.
