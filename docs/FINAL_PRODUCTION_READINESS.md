# Omi Universal AI — Final Production Readiness Audit

**Date:** 2026-09-27
**Convex deployment:** `resolute-ptarmigan-187` (`https://resolute-ptarmigan-187.convex.site`)
**Frontend:** `https://omkarbhatti170899.github.io/omiuniversalai/`
**Method:** every verdict below is backed by a *measured* result — a live HTTP probe, a real self-test row, a compiler/linter/test run, or an authorization scan. Nothing is graded "ready" because a key exists.

**Overall: NOT 100%.** Build, tests, security and the backend capability surface are strong and genuinely working. Image **editing** is **BLOCKED** — the Pollinations key is valid but its **model permissions forbid the edit model** (exact fix below); the general-web floor now **works** (a JSON-enabled SearXNG instance was found and verified from the backend); real-account manual QA, mobile/PWA manual QA and the Android device test remain **BLOCKED** by this environment (no browser session, no signed-in account, no device).

Legend: **DONE** · **PARTIAL** · **BLOCKED**

---

## 0. Verification gate (measured this session)

| Gate | Command | Result |
|---|---|---|
| Build | `bun run build` | **DONE** — built in 12.22 s, no errors |
| Typecheck | `bunx tsc -b --noEmit` | **DONE** — 0 errors |
| Lint | `bunx eslint .` | **DONE** — 0 errors / 21 warnings (baseline: react-refresh in `ui/`, unused `eslint-disable` in `_generated/*` + `retrieval.ts`) |
| Unit/integration tests | `bun test tests/` | **DONE** — **822 pass / 0 fail**, 49 files, 3164 assertions |
| Convex codegen | `bunx convex dev --once` | **DONE** — functions ready, schema + crons deployed |
| Authorization audit | `bun scripts/audit-authz.ts` | **DONE** — 109 public functions, **0 with no auth**, 1 authenticated-without-ownership marker (reviewed), 6 reviewed-public |
| Current-information suite | `GET /currentinfo` | **DONE** — **10/10 PASS** |
| Full self-test | `GET /selftest` | **PARTIAL** — 17 pass / 6 fail / 5 configured |

---

## 1. Provider verification (Backend probes)

Verdict vocabulary: **READY** (a live call succeeded) · **NOT CONFIGURED** · **QUOTA EXHAUSTED** · **FAILED** · **OPTIONAL**.
Every row below is from the live `/selftest` at 2026-09-27T02:14Z, not from env presence.

| Provider | Verdict | Evidence (live) |
|---|---|---|
| AI primary — Groq | **READY** | Answered `openai/gpt-oss-20b`; probe replied |
| AI fallback — Gemini (text) | **READY** | `gemini-flash-lite-latest` answered the fallback probe |
| AI fallback — OpenAI (text) | **OPTIONAL** | Configured in chain (`groq → gemini → openai`) but not independently probed for text; image path shows credits exhausted |
| Pollinations — generation | **READY** | Real image returned via `pollinations` (sana) at 1024×1024 (32,970 bytes) |
| Pollinations — **editing** | **FAILED** | Key is **valid** but **model permissions forbid `kontext`** (HTTP **403**): `Model 'kontext' is not allowed for this API key. Manage key permissions`. Not a bad key. |
| Gemini — image | **QUOTA EXHAUSTED** | `free-tier quota is exhausted right now` (429) |
| OpenAI — image | **QUOTA EXHAUSTED** | `the account has no remaining credits` |
| SearXNG | **READY (measured)** | Configured to a JSON-enabled instance; live search returned `enginesWithResults: SearXNG, Wikipedia, arXiv, Hacker News` with real news URLs. `searx.tiekoetter.com` → 403/429 (not JSON). Reliability caveat below. |
| Andromeda sources | **READY** | 16/16 ready; `/currentinfo` 10/10 |
| Vision | **READY** | Read a real probe image via Groq (`qwen/qwen3.8-27b`) → "Red" |
| Image generation | **READY** | Verified real image bytes |
| Image variation | **READY** | 21,286 bytes at 1024×1024 |
| Image transparency | **READY** | 27,547 bytes at 1024×1024 |
| Sports (TheSportsDB) | **READY** | `/currentinfo` live-scoreboard row PASS, keyless |
| News (Wikipedia Current Events) | **READY** | 4 fresh dated results per news scenario |
| Markets (FX, keyless) | **READY** | `open.er-api.com` USD/INR, 1 fresh result |
| Weather (Open-Meteo) | **READY** | Asks for the missing location — the correct behaviour, PASS |

**Findings (fixes applied this session).**

1. **Readiness is no longer inferred from configuration.** Setting `SEARXNG_BASE_URL` alone used to flip `ready: true` even when the instance served HTML/403 — the "config exists ⇒ READY" trap. The status surface now reports SearXNG readiness from a **measured probe** (`getProviderStatus()` reads `searxngHealthCached()`), while the *search fan-out* treats a configured instance as eligible unless a probe has **proven** it broken (so a cold function instance does not silently drop the general-web floor). A 5-minute `warmWebHealth` cron re-probes.
2. **A JSON-enabled instance was found.** 70 public instances were probed for `/search?q=test&format=json`; only **2** returned JSON, and only `https://search.lumy.live` returned real results (the other, `search.mectov.my.id`, returned JSON with **zero** results — engines suspended). `SEARXNG_BASE_URL` was set to `https://search.lumy.live` on the Convex deployment and verified **from inside the backend**: `searxngHealth` → OK, and a live search returned **SearXNG results** alongside Wikipedia/arXiv/Hacker News. Note: this is a community instance and is intermittently slow (occasional >12 s responses), so a self-hosted instance is still recommended for production reliability — see §3.

**New internal tool:** `src/convex/diagnostics.ts` (`probePollinations`, `sweepPollinationsModels`, `probeSearxng`) — internalActions runnable via `convex run` that settle provider-credential and reachability questions *from inside the Convex runtime* while returning only sanitized metadata (never a secret, never a raw provider body).

---

## 2. Image generation + editing

**Generation: DONE.** Real images are produced, verified by byte inspection, and errors are honest.

**Editing: BLOCKED.**

- **What is missing:** image editing, background removal/replacement, combination, upscaling, enhancement (and outpaint). All six self-test rows **FAIL**.
- **Why it is missing:** the production edit router tries `pollinations-edit (kontext) → gemini → openai`. Right now **all three fail**: Pollinations answers **HTTP 403** (`Model 'kontext' is not allowed for this API key`), Gemini image is **quota-exhausted (429)**, OpenAI image has **no remaining credits**. Editing cannot run without at least one working image-input provider.
- **Verification that the code is correct (not the blocker):** the live Pollinations contract was checked directly against `https://gen.pollinations.ai/openapi.json`:
  - endpoint `/v1/images/edits` accepts **`multipart/form-data`** (Omi's transport) and JSON;
  - multipart field name is **`image`** (or `image[]`) — matches Omi's adapter;
  - auth is **`Authorization: Bearer <key>`** with a `pk_`/`sk_` key from `enter.pollinations.ai/keys` — matches Omi's adapter;
  - the model alias **`kontext` → `black-forest-labs/flux.1-kontext-pro`** (text+image) is valid and accepts an image input.
  So the transport, field name, auth scheme and model are **correct** — the code is not the blocker.
- **Root cause (measured from inside Convex, `convex run diagnostics:probePollinations`):** the `POLLINATIONS_API_KEY` in the **Convex deployment environment** is **present and well-formed** (`sk_` prefix, 35 chars, no whitespace/quotes), and `/account/profile` returns **200** — so the credential is **valid**. Every call returns **403**, and the provider's verbatim reason is:

  > `Model 'kontext' is not allowed for this API key. Manage key permissions at https://enter.pollinations.ai/edit-key?id=…`

  A sweep of 15 edit-capable models (`kontext`, `flux`, `flux.2-klein-4b`, `pruna-edit`, `qwen-image-edit`, `gptimage`, `nanobanana`, `seedream-5`, …) returned **403 for all** — this key has **no image-model permissions at all**. `/account/balance` and `/account/usage` also return 403, consistent with a **scoped key**.
- **Exact action required:** open **`https://enter.pollinations.ai/edit-key?id=…`** (from the key list at `enter.pollinations.ai/keys`) and **enable image-model permissions** for this key — at minimum allow **`kontext`** (`black-forest-labs/flux.1-kontext-pro`), or grant the key the full image scope. Save, then re-run `GET /selftest`. No new key is required, and no code change is required.
- **Requires a key?** Yes — the **existing** Pollinations key, with image-model permissions enabled (free). Alternative: enable billing on the Gemini project, or add OpenAI credits.
- **Requires a device?** No. **Manual user action?** Yes (edit the key's permissions in the Pollinations dashboard, then re-run the self-test).
- **Error honesty improved:** a 403 model-not-permitted now reads *"this API key is valid but is not permitted to use that image model — enable image/model permissions for the key"* (previously it said "the provider rejected the configured credential", which would have sent you to replace a perfectly good key). Verified live in `/selftest`: the `image editing` row now prints exactly that.

---

## 3. Andromeda universal search — **PARTIAL**

- **Pipeline: DONE.** Query understanding → plan → multi-source fan-out (`Promise.allSettled`, per-provider timeout + circuit breaker) → dedup → ranking → evidence pack → conflict detection → synthesis → `[n]` citations all exist and are covered by tests.
- **Current information: DONE, measured.** `/currentinfo` **10/10**, each row naming engines, freshness and sources; stale results are refused rather than used; weather/markets/sports/news route to the correct vertical and never cross-answer.
- **General-web floor: DONE (with a reliability caveat).** A JSON-enabled instance was found and wired up — see §1 finding 2. `SEARXNG_BASE_URL=https://search.lumy.live` is set on the Convex deployment; `/selftest` reports `searxng reachability: PASS` and a live backend search returned `enginesWithResults: SearXNG, Wikipedia, arXiv, Hacker News`. The originally requested `searx.tiekoetter.com` **does not** serve JSON (403/429) and is not used. DuckDuckGo's keyless floor is also **READY** (HTTP 200, 10 probe results).
  - **Caveat:** `search.lumy.live` is a **community** instance; occasional responses exceed 12 s and the probe can intermittently fail. This is reported honestly (readiness is measured), and keyless sources cover the gap — but a self-hosted instance is recommended for production reliability.
  - **Exact action (recommended, not required):** self-host (`docker run -d -p 8080:8080 searxng/searxng`, set `settings.yml → search.formats: [html, json]`) and set `SEARXNG_BASE_URL` to it in the Convex deployment env. Readiness is measured, so it will re-verify automatically within one probe cycle.
  - **Requires a key?** No. **Device?** No. **Manual?** Yes (only if you want to replace the community instance).
- Difficult real-world queries: exercised by the 10-scenario suite and the sports/news/markets/weather/calculator probes — **PASS**.

---

## 4. Knowledge base — **PARTIAL**

- **Extraction + indexing + retrieval code: DONE.** On-device extractors for PDF (`pdfjs-dist`), DOCX/XLSX/CSV/TXT (`docExtract`), and OCR (`tesseract.js`) exist with unit coverage (`tests/docExtract.test.ts`, `omiKnowledgeRetrieval.test.ts`, `omiKnowledgeSecurity.test.ts`, `omiCorpus.test.ts`). Project/personal scoping and user/project isolation are unit-tested (`omiProjects.test.ts` — "a project sees ONLY its own documents", "different projects never see each other's documents"). `[K#]` citation handling is implemented and tested.
- **What is missing:** a **signed-in, end-to-end** upload→extract→index→retrieve→answer run with real files. `/selftest` reports `file processing: configured`, which is honest — the unauthenticated HTTP surface cannot supply an upload.
- **Why:** this environment has no browser session and no test account.
- **Exact action:** run the Phase 10 manual flows (upload a real PDF, DOCX, XLSX, CSV, TXT, and an image for OCR) and confirm `[K#]` citations and isolation.
- **Requires a key?** No. **Device?** No. **Manual user action?** Yes.

---

## 5. Chat experience — **DONE (code) / PARTIAL (visual)**

- Real streaming, stop, regenerate, conversation history, error recovery, provider fallback (groq→gemini→openai), attachments, vision, KB and web research are implemented; streaming/stop/regenerate are unit-tested (`tests/omiStreaming.test.ts`, `omiErrorRecovery.test.ts`). Answers render through a markdown/source-card pipeline (`MarkdownMessage`, `AnswerRenderer`, `SourceCards`) — no raw-pasted look.
- **What is missing:** a human visual pass in a browser.
- **Exact action:** manual QA flow (§10). **Key?** No. **Device?** No. **Manual?** Yes.

---

## 6. Human emotion intelligence — **DONE (code/test)**

- Emotional context detection, non-repetitive replies, and a hard separation from factual answers are implemented and tested (`tests/emotionAware.test.ts`). The system does not diagnose and makes no medical claims. No factual regression was observed in the live suite.

---

## 7. UI / UX — **PARTIAL**

- Dark theme is the default; premium dark tokens, source cards, file/image previews, loading and error states, 44px+ touch targets, safe-area and keyboard-viewport handling (`useKeyboardViewport`, `mobileLayout`) are implemented and unit-tested (`omiMobileLayout.test.ts`, `pwaServiceWorker.test.ts`).
- **What is missing:** a rendered visual review (spacing, responsiveness, streaming smoothness) on desktop and mobile.
- **Exact action:** manual QA flow (§10) in a browser/device emulator. **Key?** No. **Device?** No (emulator suffices for UI). **Manual?** Yes.

---

## 8. Security — **DONE (automated) / PARTIAL (manual)**

- **DONE:** `audit-authz` reports **0 unauthenticated public functions** and every user-owned mutation carries an ownership/user check; 6 public routes are reviewed-public metadata only. API keys live only in the Convex deployment (never the frontend — `capacitor.config.ts` documents the "no keys in the app" rule). Provider calls are server-side. Rate limiting uses a real Convex table and was verified returning **HTTP 429** after the allowed burst. Error messages are humanized, and the status/self-test contract explicitly forbids returning secrets, env names or user data. Injection/security evaluations exist (`omiSecurity*.test.ts`, `omiInjectionEvals.test.ts`).
- **What is missing:** a manual penetration/abuse pass (multi-account isolation with real sessions, file permission checks with real uploads).
- **Exact action:** manual QA with two accounts. **Key?** No. **Device?** No. **Manual?** Yes.

---

## 9. Testing — **DONE**

- Chat, streaming, stop, regenerate, AI fallback, Andromeda, search, citations, knowledge base, file extraction, vision, image generation/editing/routing/errors, emotions, security, authorization, rate limiting, error recovery and PWA service worker all have automated coverage: **822 pass / 0 fail** across 49 files (one new test added this session: the scoped-key 403 must read as "valid key, not permitted", never "credential rejected"). Build, typecheck, lint and Convex codegen all pass (§0). Automated passes are not treated as proof of the manual flows — see §10.

---

## 10. Real-account manual QA (22 flows) — **BLOCKED**

- **What is missing:** the 22 numbered flows (sign up … login again … mobile/PWA).
- **Why:** this environment has **no browser session, no signed-in account, no email inbox and no device**. Running them here is impossible; claiming them would be dishonest.
- **Exact action:** a human runs the 22 flows against the live app and records failures; any reported failure is fixed and re-tested. The checklist — split into **AUTOMATED VERIFIED** vs **MANUAL USER TEST REQUIRED** — is `docs/MANUAL_QA_CHECKLIST.md`. **No flow in it is claimed as completed.**
- **Requires a key?** No. **Device?** For flow 22, yes. **Manual user action?** Yes.

---

## 11. Deployment parity + smoke tests — **PARTIAL**

- **Backend: DONE.** Convex `resolute-ptarmigan-187` was redeployed this session (`convex dev --once`, functions ready), and live smoke tests pass: `/currentinfo` 10/10, `/selftest` reachable, `/status` honest.
- **Frontend: PARTIAL.** The static site serves the previous Pages build. This session changed **Convex-only** files (`searchProviders/searxng.ts`, `searchProviders/index.ts`, `imageProviders.ts`, `imageRouter.ts`, `omiHealth.ts`, `crons.ts`, new `diagnostics.ts`) plus a test file, so the deployed frontend is not stale *for these changes* — but the Pages artifact has not been rebuilt/redeployed as part of this audit. A production promotion of the frontend and (if desired) a Convex production deployment remain user decisions.
- **Exact action:** trigger the frontend deploy and run the smoke checks after it lands. **Key?** No. **Device?** No. **Manual?** Yes.

---

## 12. PWA / Android — **PARTIAL**

- **PWA: PARTIAL.** `manifest.webmanifest`, a service worker (`public/sw.js`), an offline shell (`public/offline.html`), mobile layout/safe-area/keyboard handling and tests exist (`pwaServiceWorker.test.ts`). Installability and offline behaviour have **not** been verified in a real browser.
- **Android: BLOCKED.** `capacitor.config.ts` (app id `com.ominnovations.omi`, `webDir: dist`, `androidScheme: https`, no keys in the app) and `docs/android-packaging.md` are prepared, but no APK/AAB was built and **no physical device test** was run — there is no JDK/Gradle/device here.
- **Exact action:** verify PWA install/offline in a browser; then `npx cap add android && npx cap sync && ./gradlew assembleRelease` and test login/chat/upload/image-gen on a real device.
- **Requires a key?** No. **Device?** Yes (for the Android device test). **Manual user action?** Yes.

> Android is **not** claimed complete until a physical-device test succeeds.

---

## 13. Summary

| Phase | Verdict |
|---|---|
| 1 Provider verification | **PARTIAL** — probes run; image editing FAILED (key model permissions), SearXNG measured READY |
| 2 Image generation + editing | **PARTIAL** — generation DONE, editing **BLOCKED** (key's model permissions) |
| 3 Andromeda universal search | **DONE** — pipeline + current info 10/10; general-web floor returns SearXNG results |
| 4 Knowledge base | **PARTIAL** — code/tests DONE, end-to-end needs a signed-in session |
| 5 Chat experience | **DONE** (code) / PARTIAL (visual) |
| 6 Emotion intelligence | **DONE** |
| 7 UI / UX | **PARTIAL** — no rendered visual review |
| 8 Security | **DONE** (automated) / PARTIAL (manual) |
| 9 Testing | **DONE** — 821 tests, all gates green |
| 10 Real-account manual QA | **BLOCKED** — no browser/account |
| 11 Deployment parity | **PARTIAL** — backend live & smoke-tested; frontend needs a deploy |
| 12 PWA / Android | **PARTIAL** / Android **BLOCKED** — no device test |
| 13 This report | **DONE** |

### Top three actions to move the needle

1. **Enable image-model permissions on the existing Pollinations key** at `enter.pollinations.ai/edit-key` (allow at least `kontext`) → unblocks image editing and the five edit-family capabilities with no code change. *(existing key, manual)*
2. **Run the 22-flow manual QA** (`docs/MANUAL_QA_CHECKLIST.md`) → completes §10 and surfaces any UI-level failures. *(manual)*
3. **Build and test the Android app on a physical device** → completes §12. *(device required, manual)*

*(Recommended, not blocking: replace the community SearXNG instance with a self-hosted one for reliability.)*

**Omi is not 100% production-ready.** The backend capability surface, security posture, automated tests, the current-information pipeline and the general-web floor are genuinely working and measured; image editing is blocked solely on the existing key's **model permissions** (not a bad key), and the manual/device QA that a "100%" claim requires has not been performed here.
