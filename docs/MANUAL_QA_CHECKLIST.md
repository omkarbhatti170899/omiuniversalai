# Omi Universal AI — Manual QA Checklist (22 flows)

**Date:** 2026-09-27 · **Target:** `https://omkarbhatti170899.github.io/omiuniversalai/` (backend `resolute-ptarmigan-187`)
**Status: API-VERIFIED ONLY. MANUALLY VERIFIED = 0 of 22 (2026-09-27).** A real guest (anonymous) session was created against the live deployment and the no-browser flows were driven end-to-end through the production API: **15 PASS / 1 FAIL** (the one FAIL is image editing on a full-size input — free-tier balance; small edits pass live). **Not one flow below has been verified by a human in a browser or on a device.** Rows marked ✅ API were executed and measured from the production backend; they prove behaviour, not rendered interaction.

Legend: ✅ API = executed end-to-end from a real authenticated session · 👤 = still requires a human/browser/device (**all of section B is 👤**).

**Verdict buckets used in the final report:** VERIFIED (measured here) · **MANUAL VERIFIED (currently empty — 0 items)** · PARTIAL (code done, condition outstanding) · BLOCKED (cannot be executed here at all).

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

1. **Flow 17 (image editing)** — the free Pollinations balance covers small-input edits (which pass live) but returned `402 no remaining credits or balance` for full 1024×1024-input edits during QA. **This is a billing condition, not a code fault; the editing code was deliberately not changed.** The key already has image-model permissions (`kontext`, `flux`, `sana`, `z-image`, `gptimage`) — only credits are missing. To make full-size editing reliable, top up the balance: free Pollen via Pollinations **Quests**, or a small budget for sustained volume. The same requests start succeeding immediately once balance exists; `/selftest` already proves the full edit path.
2. **Flow 22 (PWA)** and the **Android device test** — require a real device; not executed here.
3. **Browser-rendered checks** (streaming feel, keyboard, touch, install, offline bar) require a human.
4. **Search quality — now a human judgement, not a code check.** The reported live-information bug was fixed and regression-tested (81 new cases), but whether the *answers* read as genuinely current and correctly dated can only be confirmed by a person. Run these in a browser and confirm the answer is current, carries dates, cites sources, and that Omi says so plainly when it cannot verify:
   - "What is the Indian contingent medals tally in Asian Games 2026?"
   - "What is India's medal tally in Asian Games 2026?"
   - "latest India cricket score" · "current gold price in India" · "latest election results"
   - "today's weather" · "latest Apple stock price" · "current USD INR rate" · "latest AI news"
   - "current IPL standings" · "latest flight status"
   - Control: "Who won the 2016 Olympics men's 100m?" must **not** be treated as a live question.

   While you are there, watch the research status: it must stay calm, must not restart repeatedly, and must never leave a spinner running.

Nothing in section B is claimed as done until a human records a PASS. **Section B is currently 0/22.**
