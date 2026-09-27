# Omi Universal AI — Manual QA Checklist (22 flows)

**Date:** 2026-09-27 · **Target:** `https://omkarbhatti170899.github.io/omiuniversalai/` (backend `resolute-ptarmigan-187`)
**Status: NOT YET RUN.** No flow below has been executed by a human against a real account in this environment (no browser session, no inbox, no device). Automated evidence is listed only where it genuinely exists — it does **not** replace the manual run.

Use one word per row: **PASS / FAIL / BLOCKED** (with the failure text). File every FAIL.

## A. AUTOMATED-VERIFIED (backend / unit level — still re-check in the UI)

| # | Flow | Automated evidence (measured) | Manual still required? |
|---|---|---|---|
| 3 | Chat | `/selftest` ai providers → answered via Groq; unit tests (`omiStreaming`, `omiAnswerShape`) | Yes — real UI turn |
| 4 | Streaming | `tests/omiStreaming.test.ts` (stream assembly) | Yes — visual feel |
| 5 | Stop | `tests/omiStreaming.test.ts` (stop/abort) | Yes |
| 6 | Regenerate | `tests/omiStreaming.test.ts` (regenerate path) | Yes |
| 7 | Web search | live: ad-hoc search `enginesTried=15`, `enginesWithResults=SearXNG,Wikipedia,arXiv,Hacker News` | Yes |
| 9 | Current information | live `/currentinfo` **10/10 PASS** | Yes |
| 15 | Vision | `/selftest` vision → Groq answered "Red" on a real image | Yes (own upload) |
| 16 | Image generation | `/selftest` image generation → real 1024×1024 image | Yes |
| 18 | Emotion responses | `tests/emotionAware.test.ts` | Yes |
| 19 | Provider failure | `/selftest` image editing row reports the honest per-provider reason; `omiErrorRecovery` tests | Yes |
| 11 | PDF | `tests/docExtract.test.ts` | Yes (real file) |
| 12 | DOCX | `tests/docExtract.test.ts` | Yes (real file) |
| 13 | XLSX | `tests/docExtract.test.ts` | Yes (real file) |
| 10 | Knowledge Base | `tests/omiKnowledgeRetrieval.test.ts`, `omiProjects.test.ts` (isolation) | Yes |
| 22 | Mobile/PWA | `tests/pwaServiceWorker.test.ts`, `omiMobileLayout.test.ts` | Yes — real device/browser |
| 1,2,20,21 | Sign up / login / logout / login again | `/selftest` authentication resolves the guard; `audit-authz` 0 unauthenticated public fns | Yes — real account |
| 8 | Deep research | `/selftest` deep research = `configured` (needs a signed-in session) | Yes |
| 14 | Image upload | `/selftest` image upload = `configured` | Yes |
| 17 | Image editing | live: `/selftest` **image editing PASS** via `pollinations-edit (kontext)` (real 1024×1024 edit) | Yes — confirm the UI result |

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

1. **Flow 17 (image editing)** — the backend is **verified working** (`/selftest` image editing PASS via `pollinations-edit (kontext)`); what remains is confirming the rendered result in the UI.
2. **Flow 22 (PWA)** and the **Android device test** — blocked by the absence of a real device in this environment.
3. **Intermittent `402`** — under heavy bursts the free Pollinations balance can return a credits message; a balance top-up resolves it (`FINAL_PRODUCTION_READINESS.md` §2).

Nothing in section B is claimed as done until a human records a PASS.
