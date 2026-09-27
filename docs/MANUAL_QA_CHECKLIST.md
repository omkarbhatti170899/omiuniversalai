# Omi Universal AI — Manual QA Checklist (22 flows)

**Date:** 2026-09-27 · **Target:** `https://omkarbhatti170899.github.io/omiuniversalai/` (backend `resolute-ptarmigan-187`)
**Status: PARTIALLY EXECUTED (2026-09-27).** A real guest (anonymous) session was created against the live deployment and the no-browser flows were driven end-to-end through the production API: **15 PASS / 1 FAIL** (the one FAIL is image editing on a full-size input — free-tier balance; small edits pass live). Rows below marked ✅ API were executed and verified; the browser-rendered feel (streaming visuals, keyboard, touch, install) still requires a human.

Legend: ✅ API = executed end-to-end from a real authenticated session · 👤 = still requires a human/browser/device.

Use one word per row: **PASS / FAIL / BLOCKED** (with the failure text). File every FAIL.

## A. AUTOMATED-VERIFIED (backend / unit level — still re-check in the UI)

| # | Flow | Automated evidence (measured) | Manual still required? |
|---|---|---|---|
| 1,2 | Sign up / Login | ✅ API — guest session created via `auth:signIn`, user row resolved | 👤 visual check |
| 3 | Chat | ✅ API — real AI reply, `status=final`, 3.0 s | 👤 UI rendering |
| 4 | Streaming | `tests/omiStreaming.test.ts` | 👤 visual feel |
| 5 | Stop | `tests/omiStreaming.test.ts` (stop/abort) | 👤 |
| 6 | Regenerate | ✅ API — old reply replaced by a NEW `final` row | 👤 |
| 7 | Web search | ✅ API — Andromeda: 10 citations, inline `[n]`, 7 stages | 👤 |
| 8 | Deep research | Andromeda pipeline executed end-to-end (same engine) | 👤 |
| 9 | Current information | live `/currentinfo` **10/10 PASS** | 👤 |
| 10 | Knowledge Base | ✅ API — create + content retrieval, fixture found | 👤 |
| 11 | PDF | `tests/docExtract.test.ts` | 👤 (real file) |
| 12 | DOCX | `tests/docExtract.test.ts` | 👤 (real file) |
| 13 | XLSX | `tests/docExtract.test.ts` | 👤 (real file) |
| 14 | Image upload | ✅ API — real storage upload + `ingestImage` | 👤 |
| 15 | Vision | ✅ API — described a real uploaded PNG ("Red") | 👤 |
| 16 | Image generation | ✅ API — stored image via `pollinations/sana` | 👤 |
| 17 | Image editing | ⚠️ PARTIAL — small-input edits PASS live (`/selftest`); full 1024-input edit blocked by free-tier balance during QA | 👤 |
| 18 | Emotion responses | ✅ API — `excited`, confidence 0.9, positive | 👤 |
| 19 | Provider failure | ✅ API — editing failure returned the honest per-provider credits message | 👤 |
| 20,21 | Logout / login again | ✅ API — history persisted and ownership re-verified on the new session | 👤 |
| 22 | Mobile/PWA | `tests/pwaServiceWorker.test.ts`, `omiMobileLayout.test.ts` | 👤 real device/browser |

## B. MANUAL USER TEST REQUIRED (the 22 flows)

Sign in with a real account, then run each in order and record the result.

| # | Flow | Steps | Expected |
|---|---|---|---|
| 1 | Sign up | Open app → auth → create account (email OTP / guest) | Account created, redirected to the protected workspace |
| 2 | Login | Sign in with the new account | Session established, lands on dashboard (not lopped back to `/auth`) |
| 3 | Chat | Ask a normal question | Answer renders as clean markdown with source cards where applicable |
| 4 | Streaming | Ask a long question | Tokens stream in; no full-answer freeze |
| 5 | Stop | During streaming, press Stop | Generation halts immediately and the partial answer stays |
| 6 | Regenerate | Press Regenerate | New answer replaces the old one; no duplicate bubble |
| 7 | Web search | Ask something factual requiring the web ("who is the CEO of Nvidia") | Answer cites sources; no fabricated URLs |
| 8 | Deep research | Run a research/comparison question | Multi-source findings; conflicts surfaced, not merged silently |
| 9 | Current information | "What is the latest news in India?" / "USD/INR rate" / "live sports score" | Fresh, dated answers for each vertical; ask-for-location on weather |
| 10 | Knowledge Base | Create a project, add documents | Documents indexed and answerable with `[K#]` citations |
| 11 | PDF | Upload a PDF, ask about it | Correct extraction + `[K#]` citations; no invented content |
| 12 | DOCX | Upload a DOCX, ask about it | Same as PDF |
| 13 | XLSX | Upload an XLSX, ask about a cell/table | Same as PDF |
| 14 | Image upload | Upload a photo | Stored and retrievable; preview shown |
| 15 | Vision | Ask "what is in this image?" | Accurate description via the vision provider |
| 16 | Image generation | Generate an image | Real image returned and stored in the gallery |
| 17 | Image editing | Upload an image and request an edit | Backend edit now PASSES the live self-test (`pollinations-edit (kontext)`, real 1024×1024 edit). Confirm in the UI that the result matches the uploaded image |
| 18 | Emotion responses | Send sad / angry / confused / complex messages | Natural, non-repetitive; never diagnoses; never derails a factual answer |
| 19 | Provider failure | Trigger a provider error (e.g. image edit) | Honest, human error message — no raw JSON, no secrets |
| 20 | Logout | Log out | Session cleared; protected routes require sign-in again |
| 21 | Login again | Sign in again | Prior conversations/history still there, correctly scoped |
| 22 | Mobile / PWA | Install the PWA on a phone; chat, upload, generate | Installable, offline shell loads, inputs not hidden by the keyboard, no horizontal scroll |

## C. Blockers that will show up as FAILs

1. **Flow 17 (image editing)** — the free Pollinations balance covers small-input edits (which pass live) but returned `402` for full 1024×1024-input edits during QA. Top up the balance (free Pollen via Quests, or budget) for sustained full-size editing.
2. **Flow 22 (PWA)** and the **Android device test** — require a real device; not executed here.
3. **Browser-rendered checks** (streaming feel, keyboard, touch, install, offline bar) require a human.

Nothing in section B is claimed as done until a human records a PASS.
