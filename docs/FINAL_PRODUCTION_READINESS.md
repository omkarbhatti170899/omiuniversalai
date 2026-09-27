# Omi Universal AI — Final Production Readiness Audit

**Date:** 2026-09-27
**Convex deployment:** `resolute-ptarmigan-187` (`https://resolute-ptarmigan-187.convex.site`)
**Frontend:** `https://omkarbhatti170899.github.io/omiuniversalai/`
**Method:** every verdict below is backed by a *measured* result — a live HTTP probe, a real self-test row, a compiler/linter/test run, or an authorization scan. Nothing is graded "ready" because a key exists.

**Overall: NOT 100%.** Every automated gate is green and the backend capability surface is genuinely working — image **generation and editing are VERIFIED** (all six edit-family ops PASS the live self-test; the earlier blocker was the key's model permissions, now enabled by the owner), Andromeda/current-information return fresh dated sources, security scans are clean, and 833 tests pass. What remains is **not code**: it needs **a human, a browser and a physical device**. This report is therefore split into four buckets, and the second one is deliberately empty:

| Bucket | Meaning | Count |
|---|---|---|
| **VERIFIED** | Executed and measured here — a live probe, a real self-test row, a compiler/linter/test run, or an authorization scan | 9 areas |
| **MANUAL VERIFIED** | Executed **by a human in a browser/on a device** and recorded | **0 — none yet** |
| **PARTIAL** | Code is complete and tested, but a real-world condition (credits, or a human pass) is outstanding | 5 items |
| **BLOCKED** | Cannot be executed in this environment at all: no browser session, no signed-in account, no physical device, no JDK/Gradle | 3 items |

**The honest headline: Omi is not 100% production-ready, and it will not be until the MANUAL VERIFIED bucket is non-empty.** The user asked for a real browser QA pass, a human UX pass, and a real Android/PWA device test. None of those three can be performed from this environment, and none of them is claimed as done. See §10, §12 and §14 for the exact flows to run.

---

## 0. Verification gate (measured this session)

| Gate | Command | Result |
|---|---|---|
| Build | `bun run build` | **PASS** — built in 13.11 s, no errors |
| Typecheck | `bunx tsc -b --noEmit` | **PASS** — 0 errors |
| Lint | `bunx eslint .` | **PASS** — 0 errors / 21 warnings (baseline: react-refresh in `ui/`, unused `eslint-disable` in `_generated/*` + `retrieval.ts`) |
| Unit/integration tests | `bun test tests/` | **PASS** — **833 pass / 0 fail**, 50 files, 3252 assertions |
| Convex codegen | `bunx convex dev --once` | **PASS** — functions ready in 14.16 s, schema + crons deployed |
| Authorization audit | `bun scripts/audit-authz.ts` | **PASS** — 109 public functions, **0 with no auth**, 1 authenticated-without-ownership marker (reviewed), 6 reviewed-public |
| Current-information suite | `GET /currentinfo` | **PASS** — **10/10**, 0 failed |
| Full self-test | `GET /selftest` | **PASS** — status **ok**, **23 pass / 0 fail / 5 configured** (re-confirmed 2026-09-27T04:21Z) |
| Authenticated end-to-end QA (guest session) | 16 flows via the production API | **15 PASS / 1 FAIL** (image editing on a full-size input: free-tier balance) |
| **Real browser QA** | — | **NOT RUN** — no browser in this environment |
| **Human visual UX pass** | — | **NOT RUN** — needs a human looking at the screen |
| **Android / PWA device test** | — | **NOT RUN** — no device, no JDK/Gradle |

The last three rows are empty on purpose. They are the gap that keeps Omi off 100%.

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
| Pollinations — **editing** | **READY** | `kontext` permitted; a real edit returned a verified image via `pollinations-edit (kontext)` (25,800 B at 1024×1024). Intermittent free-tier 402 under heavy bursts |
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

**Editing: DONE — VERIFIED (resolved 2026-09-27).**

- **What is verified (live, through the production router):** image editing, background removal, background replacement, image combination, upscaling and enhancement all **PASS** `/selftest`. Verbatim: *"Edited a real image via pollinations-edit (kontext) — returned 25800 bytes at 1024×1024"*; removal 27,886 B · replacement 69,388 B · combination 20,198 B · upscaling 132,728 B · enhancement 18,258 B — all via `pollinations-edit (kontext)`.
- **What unblocked it:** the key's **image-model permissions were enabled** in the Pollinations dashboard (a user action). `convex run diagnostics:sweepPollinationsModels` now reports `ALLOWED: ["kontext","flux","sana","z-image","gptimage"]`, with `kontext` returning a **200 verified image** (27,749 B). The credential probe reports *"credential WORKS — at least one auth mode returned a real image"*. Gemini image remains quota-exhausted and OpenAI has no credits; editing no longer depends on either.
- **It edits THAT image, not a fresh generation — three independent guarantees:**
  1. **Transport** — the adapter posts the uploaded bytes to `/v1/images/edits` in the multipart `image` field; a source-less request is **refused** (`convex run diagnostics:verifyEditUsesInput` → `http 400`), so a result can never be prompt-only. (The earlier 403 was diagnosed from inside Convex: `Model 'kontext' is not allowed for this API key`.)
  2. **Router** — `providersForOp("edit", hasInput)` only returns providers that declare the op **and** accept image input, so a text-to-image provider can never answer an edit. Enforced by `tests/omiImageRouting.test.ts`: *"an edit request can NEVER be routed to the text-to-image provider"*, *"the keyless text-to-image provider is not eligible for an edit"*, *"an edit with no edit-capable key fails honestly and calls no provider"*.
  3. **Verification** — every returned body is byte-checked by `imageVerify` before acceptance; a non-image body is reported as a failed attempt, never as a result.
- **Error honesty improved:** a 403 model-not-permitted reads *"this API key is valid but is not permitted to use that image model — enable image/model permissions for the key"*, and a 402 reads *"the account has no remaining credits or balance — add credits for this provider"*. Both mappings are unit-tested.
- **Operational note (measured, not a code fault):** under heavy repeated test generation, individual `kontext` calls intermittently returned **HTTP 402 (payment required)** while the deployed self-test's own 1024×1024 edits succeeded in the same period. 512px requests were consistently accepted. This is a free-tier balance/rate condition at Pollinations: if a user sees a credits message, the account balance needs topping up (free Pollen via Quests, or budget).

**Provider balance required for sustained full-size editing (the exact answer to "what does full-size editing need?")**

Measured behaviour of the current key on the current free tier:

| Request shape | Result | Why |
|---|---|---|
| Text-to-image generation (1024×1024 output) | **PASS** | 32,970 B real image |
| Edit with a **small input** (64×64 source) | **PASS** | input upscaling dominates cost, not output size |
| Edit with a **full 1024×1024 input** | **402 — `no remaining credits or balance`** | the account's free Pollen balance is exhausted |

- **The code is correct and was deliberately left unchanged.** The 402 is a billing condition at the provider, not a defect: the router selects an edit-capable provider, the adapter ships the real source bytes, and the failure surfaces honestly as *"the account has no remaining credits or balance — add credits for this provider"* (unit-tested in `tests/omiImageErrors.test.ts`).
- **To make full-size editing reliable, top up the Pollinations balance.** The key already has image-model permissions (`ALLOWED: ["kontext","flux","sana","z-image","gptimage"]`); credits are the only missing piece. Free Pollen can be earned via Pollinations **Quests**; for sustained volume a small budget is required. No code change is needed — the same requests begin succeeding as soon as balance is available, and `/selftest` image editing already proves the full path.
- **Interim behaviour is correct and honest:** small-input edits succeed today, and a 402 is reported as a credits problem with a next step, never as a generic "something went wrong".
- **Requires a key?** Yes — the existing Pollinations key (free tier) with image permissions enabled (done). **Device?** No. **Manual user action?** Remaining only if the balance needs topping up for sustained 1024px volume.

---

## 3. Andromeda universal search — **DONE**

- **Pipeline: DONE.** Query understanding → plan → multi-source fan-out (`Promise.allSettled`, per-provider timeout + circuit breaker) → dedup → ranking → evidence pack → conflict detection → synthesis → `[n]` citations all exist and are covered by tests.
- **Current information: DONE, measured.** `/currentinfo` **10/10**, each row naming engines, freshness and sources; stale results are refused rather than used; weather/markets/sports/news route to the correct vertical and never cross-answer.
- **General-web floor: DONE (with a reliability caveat).** A JSON-enabled instance was found and wired up — see §1 finding 2. `SEARXNG_BASE_URL=https://search.lumy.live` is set on the Convex deployment; `/selftest` reports `searxng reachability: PASS` and a live backend search returned `enginesWithResults: SearXNG, Wikipedia, arXiv, Hacker News`. The originally requested `searx.tiekoetter.com` **does not** serve JSON (403/429) and is not used. DuckDuckGo's keyless floor is also **READY** (HTTP 200, 10 probe results).
  - **Stress test (15 real queries × 5 topics, from inside Convex):** **15/15 succeeded (100%)**, latency min 850 ms / median **1,021 ms** / p95 & max **12,112 ms**, average 97 results per query. The single 12 s outlier is exactly why the health probe can intermittently fail — readiness is measured, so it reports that honestly rather than pretending. Fallback is proven: when SearXNG is slow or absent, results still come from Wikipedia/arXiv/Hacker News/GDELT/etc. (`Promise.allSettled` fan-out isolates every engine).
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

## 7b. Premium UX / micro-interactions — **PARTIAL (code DONE, human visual pass pending)**

Most of the premium-UX spec is **already implemented in the existing code**; it was audited rather than rewritten (rewriting working UI would risk the reliability the spec explicitly protects). Evidence, per spec item:

| Spec item | Code status | Evidence |
|---|---|---|
| §1 loading states | **DONE** | Chat/streaming indicator, research states, image generation/editing progress, button loaders (`Loader2` in `OmiAssistantPanel`, `ImageStudioView`, `Auth`) |
| §2 skeletons | **DONE** | `Skeleton` used in every workspace view (Home, Files, Knowledge, Memory, Emotions, Projects, Agents, Automation, Knowledge Intelligence, both Omi panels) |
| §3 streaming | **DONE** | Real token streaming, stop, regenerate, preserved scroll (`OmiAssistantPanel`; `tests/omiStreaming.test.ts`). No artificial thinking delay |
| §4 button micro-interactions | **DONE** | shadcn/ui button states (hover/press/focus/disabled/loading) + `ui/button` conventions |
| §5 send-message experience | **DONE** | User message renders immediately then resets input as the assistant begins (both panels) |
| §6/§10 file upload + KB states | **DONE** | `ImageStudioView` input `status: "uploading" | "ready" | "failed"`; `FilesView`/`KnowledgeView` per-item states |
| §7 image generation | **DONE** | Generation state, disabled duplicate submit, view/save/regenerate/edit actions, honest failure (no permanent spinner) |
| §8 image-editing stages | **DONE (rebuilt this session)** | The run state names the REAL op via `lib/imageRunLabels.ts` (`runSentenceForOp`): an edit reads "Omi is editing your image…", background removal "removing the background" — never "generating" for an edit-family op (10 unit tests). Elapsed time appears only from 5 s (measured, 1 s tick scoped to the run). No fake Uploading→Analyzing→Editing ladder, because the backend run is ONE call and the spec forbids staging that does not happen |
| §9 Andromeda progress | **DONE** | `lib/answerShape.ts` `PROGRESS_STAGES` (Understanding → Searching → Analyzing → Verifying → Preparing answer) is driven by `stageForStatus` over the REAL backend status text Omi patches into the live message ("Omi is searching the web…", "Reading N sources…", "checking approved knowledge…"); Andromeda surfaces its actual pipeline audit with per-stage ms (`OmiSearchPanel` stages list) |
| §11 error UX | **DONE** | `lib/failureRecovery.ts` — every failure yields WHAT HAPPENED + WHAT TO DO NEXT + `retryable`/`retryAfterMs`; no raw stack traces (`omiErrorRecovery.test.ts`) |
| §12 success feedback | **DONE** | `sonner` toasts used sparingly for upload/index/save/copy |
| §13 page transitions | **DONE** | Framer Motion view transitions harness in `WorkspaceShell` |
| §14 responsive | **PARTIAL** | Safe-area + keyboard handling (`useKeyboardViewport`, `mobileLayout`, `omiMobileLayout.test.ts`); needs a real device/emulator pass |
| §15 accessibility | **DONE** | Keyboard focus + visible focus states via shadcn primitives; `aria-live` on the new connectivity bar; MotionConfig respects reduced motion |
| §16 reduced motion / performance | **DONE** | `<MotionConfig reducedMotion="user">` (`main.tsx`) + `@media (prefers-reduced-motion: reduce)` in `index.css`; lightweight CSS transitions preferred over animation libraries |
| §17 mobile touch targets | **DONE (code)** | 44px+ targets across chat/image/file controls; needs device confirmation |
| §18 online/offline/retrying | **DONE (added this session)** | `hooks/useNetworkStatus.ts` + `components/NetworkStatusBar.tsx` mounted app-wide in `main.tsx`: silent while online, an app-wide bar offline, and a "Back online" confirmation on recovery. Reports only real browser `online`/`offline` events — no fake ping |
| §19 empty states | **DONE** | `ui/empty.tsx` used across Files, Knowledge, Images, Search, Memory, Agents, Projects, Emotions, Automation |
| §20 dark-theme consistency | **DONE** | Dark is the default theme; all new UI uses the existing token system (no light-theme components) |
| §21 motion rule (fast/subtle/purposeful) | **DONE (code)** | Motion communicates state only; `MotionConfig` + reduced-motion CSS bound the cost |
| §22 end-to-end UX test | **BLOCKED** | Requires a human in a browser/device — see §10 |

- **What is missing:** a human visual pass (spacing, smoothness, touch feel).
- **Exact action:** run the manual QA (§10 / `docs/MANUAL_QA_CHECKLIST.md`) and fix anything that looks frozen or jumps. **Key?** No. **Device?** Emulator for UI; real device for the mobile feel. **Manual?** Yes.

---

## 8. Security — **DONE (automated) / PARTIAL (manual)**

- **DONE:** `audit-authz` reports **0 unauthenticated public functions** and every user-owned mutation carries an ownership/user check; 6 public routes are reviewed-public metadata only. API keys live only in the Convex deployment (never the frontend — `capacitor.config.ts` documents the "no keys in the app" rule). Provider calls are server-side. Rate limiting uses a real Convex table and was verified returning **HTTP 429** after the allowed burst. Error messages are humanized, and the status/self-test contract explicitly forbids returning secrets, env names or user data. Injection/security evaluations exist (`omiSecurity*.test.ts`, `omiInjectionEvals.test.ts`).
- **What is missing:** a manual penetration/abuse pass (multi-account isolation with real sessions, file permission checks with real uploads).
- **Exact action:** manual QA with two accounts. **Key?** No. **Device?** No. **Manual?** Yes.

---

## 9. Testing — **DONE**

- Chat, streaming, stop, regenerate, AI fallback, Andromeda, search, citations, knowledge base, file extraction, vision, image generation/editing/routing/errors, emotions, security, authorization, rate limiting, error recovery and PWA service worker all have automated coverage: **833 pass / 0 fail** across 50 files / 3252 assertions. Build, typecheck, lint and Convex codegen all pass (§0). Automated passes are not treated as proof of the manual flows — see §10.

---

## 10. Real-account QA — **PARTIAL (authenticated end-to-end executed from the backend; browser/mobile flows still manual)**

A real **guest (anonymous) session** was created against the live deployment and the no-browser flows were driven end-to-end through the production API (2026-09-27T03:4xZ). Result: **15 PASS / 1 FAIL**:

| Flow | Result | Evidence |
|---|---|---|
| 1/2 Sign up / Login (guest session) | **PASS** | `auth:signIn` anonymous session established; user row created |
| Identity (`users.currentUser`) | **PASS** | user `jx74…` resolved |
| Conversation create | **PASS** | `k971…` |
| Chat turn (real AI) | **PASS** | final reply in 3.0 s — *"Hello, I was created by Mr. Omkar Prakash Bhatti."* |
| History persisted (logout/login continuity) | **PASS** | 2 messages (user, omi) with status `final` |
| Regenerate | **PASS** | old reply replaced by a NEW `final` row (49 chars) |
| Andromeda research + citations | **PASS** | **10 citations**, inline `[n]` present, 7 real pipeline stages, 3.7 s — "Jensen Huang is the CEO of Nvidia…" |
| Knowledge create | **PASS** | doc `ms73…` |
| Knowledge retrieval (`[K#]`) | **PASS** | fixture found by content query |
| File upload + extraction (txt) | **PASS** | real storage upload → `ingestFile` → doc `ms77…` |
| Vision (real image understanding) | **PASS** | described a real uploaded PNG: *"Red"* |
| Image generation (real) | **PASS** | stored image via `pollinations/sana` |
| Image editing (real, on that image) | **FAIL (balance)** | `pollinations-edit: the account has no remaining credits or balance` — the free Pollen balance covers small (64×64-input) edits, which `/selftest` passes live, but not full 1024×1024-input edits during testing |
| Emotion analysis (real) | **PASS** | `emotion=excited confidence=0.9 sentiment=positive` |
| Isolation: unauthenticated image run | **PASS** | correctly rejected |
| Isolation: unauthenticated conversations | **PASS** | 0 rows, fail-closed |

**Still manual-only (need a human, browser or device):** visual UX pass (§7b), PWA install/offline in a real browser, all Android/device flows (§12), and the *browser-rendered* feel of streaming/stop. The runner script was temporary and has been deleted; the QA guest account's conversation remains as evidence.

- **What is missing:** the 22 numbered flows (sign up … login again … mobile/PWA).
- **Why:** this environment has **no browser session, no signed-in account, no email inbox and no device**. Running them here is impossible; claiming them would be dishonest.
- **Exact action:** a human runs the 22 flows against the live app and records failures; any reported failure is fixed and re-tested. The checklist — split into **AUTOMATED VERIFIED** vs **MANUAL USER TEST REQUIRED** — is `docs/MANUAL_QA_CHECKLIST.md`. **No flow in it is claimed as completed.**
- **Requires a key?** No. **Device?** For flow 22, yes. **Manual user action?** Yes.

---

## 11. Deployment parity + smoke tests — **DONE (verified by content, not by hash)**

- **Backend: DONE.** Convex `resolute-ptarmigan-187` was redeployed this session (`convex dev --once`, functions ready), and live smoke tests pass: `/currentinfo` 10/10, `/selftest` **23 pass / 0 fail**, `/status` honest.
- **Frontend: VERIFIED CURRENT.** The live Pages bundle was fetched and inspected: it **contains** the `NetworkStatusBar` copy ("Back online", "reconnect automatically") and the reduced-motion marker, and `sw.js`, `manifest.webmanifest`, `offline.html` and the current `llms.txt` all serve HTTP 200. The live asset hash differs from a fresh local build only because this session's remaining changes were Convex-only (`searchProviders/*`, `imageProviders.ts`, `imageRouter.ts`, `omiHealth.ts`, `crons.ts`, new `diagnostics.ts`) plus copy-level edits — none of which alter that bundle. Verified 2026-09-27T03:2xZ. A production Convex deployment remains a separate user decision.
- **Exact action (optional):** trigger a routine frontend deploy after the next functional frontend change; verify by content as above. **Key?** No. **Device?** No. **Manual?** Yes.

---

## 12. PWA / Android — **PARTIAL**

- **PWA: PARTIAL.** `manifest.webmanifest`, a service worker (`public/sw.js`), an offline shell (`public/offline.html`), mobile layout/safe-area/keyboard handling and tests exist (`pwaServiceWorker.test.ts`). Installability and offline behaviour have **not** been verified in a real browser.
- **Android: BLOCKED.** `capacitor.config.ts` (app id `com.ominnovations.omi`, `webDir: dist`, `androidScheme: https`, no keys in the app) and `docs/android-packaging.md` are prepared, but no APK/AAB was built and **no physical device test** was run — there is no JDK/Gradle/device here.
- **Exact action:** verify PWA install/offline in a browser; then `npx cap add android && npx cap sync && ./gradlew assembleRelease` and test login/chat/upload/image-gen on a real device.
- **Requires a key?** No. **Device?** Yes (for the Android device test). **Manual user action?** Yes.

> Android is **not** claimed complete until a physical-device test succeeds.

---

## 13. Final report — VERIFIED / MANUAL VERIFIED / PARTIAL / BLOCKED

### ✅ VERIFIED — executed and measured in this session

| # | Area | Evidence |
|---|---|---|
| 1 | Build / typecheck / lint | `bun run build` 13.11 s; `tsc -b --noEmit` 0 errors; `eslint .` **0 errors** / 21 warnings (baseline) |
| 2 | Test suite | `bun test tests/` — **833 pass / 0 fail**, 50 files, 3252 assertions |
| 3 | Convex deploy + codegen | `bunx convex dev --once` — functions ready in 14.16 s |
| 4 | Security / authorization | `audit-authz` — 109 public functions, **0 missing auth**; 1 ownership-marker item reviewed (`users.currentUser` returns only the caller's own record); 6 reviewed-public metadata routes; secrets never returned by any status/self-test surface |
| 5 | Image generation | Real bytes via `pollinations (sana)` — 32,970 B @ 1024×1024; variation 21,286 B; transparency 27,547 B |
| 6 | Image editing (all six edit-family ops) | edit 25,800 B · bg-removal 27,886 B · bg-replace 69,388 B · combination 20,198 B · upscale 132,728 B · enhance 18,258 B — all `pollinations-edit (kontext)`, byte-verified |
| 7 | AI + vision + fallback | Groq primary, Gemini fallback (`chain: groq → gemini → openai`), vision read a real image → "Red" |
| 8 | Andromeda / current information | `/currentinfo` **10/10**; `/selftest` reports Andromeda plan + 15 sources ready; 16/16 sources ready; SearXNG measured ready (`https://search.lumy.live`), stress-tested 15/15 |
| 9 | Self-test + deployment parity | `/selftest` **status ok, 23 pass / 0 fail / 5 configured**; live Pages bundle contains the current frontend work; `sw.js`, `manifest.webmanifest`, `offline.html`, `llms.txt` all HTTP 200 |

### 👤 MANUAL VERIFIED — **NONE. This bucket is empty.**

**No flow in this report has been manually verified by a human in a browser or on a device.** Zero. The 15/16 authenticated end-to-end passes in §10 were driven **through the production API from the backend**, not by a person looking at the screen. That is real verification of behaviour, but it is not visual/interaction verification, and it is not presented as such.

### ⚠️ PARTIAL — code complete and tested, real-world condition outstanding

| Item | What is outstanding |
|---|---|
| Full-size image editing (1024×1024 input) | Free Pollinations balance is exhausted → 402. Small-input edits pass live. **Needs a balance top-up, not a code change** (§2). Editing code was deliberately left untouched. |
| Chat / image / search **visual** quality | Streaming smoothness, spacing, scrolling feel and layout responsiveness are implemented and unit-tested but have never been rendered to a human eye |
| Responsive + touch targets | 44px+ targets, safe-area and keyboard-viewport handling are implemented and unit-tested; unconfirmed on a real viewport |
| PWA install + offline behaviour | `manifest.webmanifest`, `public/sw.js`, `public/offline.html`, `NetworkStatusBar` all present and served; install prompt and offline shell never exercised in a real browser |
| Knowledge base end-to-end | Real file upload → extract → index → `[K#]` answer executed via API for TXT and PNG; PDF/DOCX/XLSX/OCR still need a human with real files |

### 🛑 BLOCKED — cannot be executed in this environment

| Item | Why blocked | What unblocks it |
|---|---|---|
| **Real browser QA** (request item 1) | No browser session / no display in this environment | A human opens the deployed URL and runs the 22 flows in `docs/MANUAL_QA_CHECKLIST.md` |
| **Human UX pass** (request item 2) | Needs a person perceiving the rendered UI — streaming smoothness, loading states, Andromeda progress, image states, spacing, scrolling, keyboard, touch targets, source cards, dark theme, errors/retries, success feedback, offline/reconnect | A human on a desktop browser and a phone; checklist in §14 |
| **Android / PWA device test** (request item 4) | No physical device, and no JDK/Gradle to build an APK/AAB | `npx cap add android && npx cap sync && ./gradlew assembleRelease`, then install and test on a real Android phone |

### Requested-by-user items, answered one by one

| Request | Status |
|---|---|
| 1. Real browser QA | **BLOCKED** — not executed; flows specified in §14 |
| 2. Human UX pass | **BLOCKED** — not executed; checklist specified in §14. Note: no *code* changes were made in response, because no real finding was observed — inventing fixes for an unviewed UI would be guessing |
| 3. Image editing — don't break working code, keep honest 402, document the balance | **DONE.** Editing code untouched; honest 402 mapping retained and unit-tested; exact balance requirement documented in §2 |
| 4. Android / PWA on a real device | **BLOCKED** — no device, no JDK/Gradle |
| 5. Fix only real QA findings | **DONE (vacuously)** — no real findings existed to fix, so no speculative changes were made |
| 6. Final regression | **DONE** — all gates re-run green this session (§0) |
| 7. Final report in four buckets | **DONE** — this section |

### The three things that would move Omi to 100%

1. **A human runs the 22-flow manual QA** in a real browser (`docs/MANUAL_QA_CHECKLIST.md`). This alone fills the empty MANUAL VERIFIED bucket and would surface any genuine UI defect.
2. **A human does the UX pass in §14** on desktop *and* a phone, checking streaming, loading, Andromeda progress, image states, dark theme, offline/reconnect and install.
3. **A physical Android device test** of the PWA (and the Capacitor shell if an APK is built).

*(Non-blocking recommendations: self-host SearXNG instead of relying on the community `search.lumy.live` instance, which occasionally exceeds 12 s; top up the Pollinations balance for sustained 1024px image editing.)*

**Omi is not 100% production-ready, and this report does not claim it is.** The backend, the capability surface, the security posture and the automated gates are genuinely strong and now measured end-to-end — including a real authenticated session that completed 15 of 16 flows against production. But **three of the requested QA activities — real browser QA, the human UX pass, and the Android/PWA device test — were not performed**, because this environment has no browser, no human viewer and no device. Those remain genuinely unexecuted, and no part of this document pretends otherwise.

**What an agent could not do (and did not fake):** no browser session, no signed-in human account, no physical device and no JDK/Gradle. The earlier Pollinations model-permission change was a user action, not an agent one. Every remaining item is a human or device action, not a code defect.

---

## 14. Exact flows to run for the BLOCKED items

These are the specific checks that could not be executed here. Each is written so a human can run it and record PASS/FAIL without reading the codebase.

### 14a. Real browser QA (desktop)

Open `https://omkarbhatti170899.github.io/omiuniversalai/`, sign in, then:

1. Sign up with email OTP, **and** with the guest/anonymous option — both must reach the protected workspace, not bounce back to `/auth`.
2. Send a normal question → answer renders as clean markdown; source cards appear where applicable.
3. Send a long question → **tokens stream progressively**; no full-answer freeze, no jump-scroll.
4. Press **Stop** mid-stream → generation halts immediately and the partial text stays on screen.
5. Press **Regenerate** → a new answer replaces the old one; **no duplicate bubble**.
6. Ask "Who is the CEO of Nvidia?" → cited answer; click a source card and confirm the URL is real and opens.
7. Ask a current-information question ("latest news in India", "USD/INR rate", a live score, weather with **no** location) → fresh dated answers; weather must **ask for the location** rather than guessing.
8. Create a project, upload a **PDF, DOCX, XLSX and a CSV** → each extracts and answers with `[K#]` citations; no invented content.
9. Upload a photo and ask "what is in this image?" → accurate description; preview shown.
10. Generate an image → a real image appears in the gallery; view / save / regenerate all work.
11. Edit that image (background removal, replacement, upscale) → confirm the result **derives from the uploaded image**, not a fresh unrelated generation.
12. Log out → protected routes require sign-in again. Log back in → prior conversations still there, correctly scoped.
13. Open a second browser profile / incognito → no trace of the first session's data.

### 14b. Human UX pass (what to actually look at)

| Area | What "good" looks like | Where it lives |
|---|---|---|
| Streaming smoothness | Text grows token-by-token; no flicker, no re-render jank, no scroll hijack | `OmiAssistantPanel` |
| Loading states | A skeleton or spinner on every async surface; **never a permanent spinner** after a failure | all workspace views |
| Andromeda progress | Stage ladder advances **Understanding → Searching → Analyzing → Verifying → Preparing answer** and matches real backend progress (no fake stages) | `answerShape.ts` |
| Image generation / editing states | The run sentence names the **real op** — an edit must never say "generating"; elapsed time appears only after ~5 s | `imageRunLabels.ts` |
| Spacing & scrolling | No cramped panels, no horizontal scroll, no clipped content at any width | global |
| Keyboard | Every interactive element reachable by Tab; visible focus ring; Enter/Send works; no keyboard trap | global |
| Touch targets | ≥44 px on all chat, image and file controls | global |
| Source cards | Titles, domains and dates legible; links open; no overflow on mobile | `SourceCards` |
| Dark theme | No light-theme flash, no unreadable contrast, no white panels in dark mode | `index.css` tokens |
| Errors / retries | Any failure shows **WHAT HAPPENED + WHAT TO DO NEXT**; a retry affordance where retryable; never a raw JSON blob or stack trace | `failureRecovery.ts` |
| Success feedback | A quiet toast on upload / index / save / copy — not modal spam | `sonner` |
| Offline / reconnect | Silent while online; a bar appears when the network drops; a "Back online" confirmation on recovery | `NetworkStatusBar` |
| PWA install | Browser offers install; installed app launches standalone; offline shell loads with cached shell | `public/sw.js` |

### 14c. Android / PWA device test

1. Chrome on Android → open the app URL → **Add to Home screen** → launch from the icon (must be standalone, not a browser tab).
2. With the app foregrounded, switch to Airplane mode → the offline shell must load with a clear message, not a browser error page.
3. Restore connectivity → the **"Back online"** bar must appear and confirm.
4. Sign in, send a chat message, upload a file and generate an image **on the phone** — the keyboard must not cover the input; no horizontal scroll.
5. Check every touch control is comfortably tappable one-handed.
6. *(Optional, if an APK is wanted)* `npx cap add android && npx cap sync && ./gradlew assembleRelease`, install the APK, and repeat 4–5 in the native shell.
