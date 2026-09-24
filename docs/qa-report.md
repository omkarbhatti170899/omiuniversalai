# Omi Universal AI — Production QA & Bug-Fix Report

**Date:** 2026-09-24
**Live app:** https://omkarbhatti170899.github.io/omiuniversalai/
**Backend:** https://resolute-ptarmigan-187.convex.site
**Machine-readable health:** `/health` · `/status` · `/selftest`
**Scope:** full production QA and bug-fix pass ahead of PWA/Android packaging. No new features were added.

## Verdict vocabulary

| Mark | Means |
|---|---|
| **PASS** | An end-to-end check actually succeeded against the live system |
| **PASS (unit)** | Pinned by the automated suite; a live signed-in click-through has not been done |
| **FIXED** | A real defect was found in this pass, repaired, and re-verified |
| **BLOCKED** | Cannot pass without an external quota, credential, or asset — not a code defect |
| **PENDING** | Needs a signed-in human session on a real device; not claimed as working |

The distinction matters: a deployed module is not a feature, a green build is not
a working product, and "configured" is not "working".

## Headline result

```
bun convex dev --once    → functions deployed to resolute-ptarmigan-187
bun tsc -b --noEmit      → clean (0 errors)
bun test tests/          → 437 pass / 0 fail (34 files, 1,359 assertions)
bun run lint             → 0 errors (18 non-blocking generated/shadcn warnings)
bun run build            → production build green
GET /selftest            → status: ok · 12 pass · 0 fail · 2 configured · 1 unverified
```

## 1–28: the requested test matrix

| # | Area | Verdict | Evidence |
|---|---|---|---|
| 1 | Production build | **PASS** | `bun run build` clean; CI also gates typecheck + 437 tests before Pages deploy |
| 2 | Frontend errors | **PASS** | Live shell served (HTTP 200, Omi marker present); root + toolbar error boundaries in `main.tsx` so a crash renders a message, never a blank page |
| 3 | Backend / API errors | **PASS** | 12 live subsystem probes green; adapters report every attempt and never throw into a user path |
| 4 | Environment variables | **PASS** | `VITE_CONVEX_URL` is the only client var and fails loudly if unset; no provider key is read outside `src/convex/` |
| 5 | Authentication | **PASS** | Live: auth guard resolves (unauthenticated → `authenticated=false`), so sessions are enforced rather than bypassed. Every chat/file/image/memory/project entry point calls `getAuthUserId` |
| 6 | AI chat | **PASS (unit)** | Provider chain live-verified; the signed-in multi-turn path needs a session, so it is not claimed as PASS live |
| 7 | Provider switching | **PASS** | `/selftest` pins a specific provider (`onlyProvider`) and gets an answer — real routing, not a config read |
| 8 | Gemini | **PASS** | Live: `gemini-flash-lite-latest` answered a forced call on its own quota |
| 9 | Provider fallback | **PASS** | Live: independent fallback answered — chain `groq → gemini → openai` |
| 10 | Andromeda search | **PASS** | Live: planner produced kind/angles/freshness; 13 sources ready; real retrieval returned 2 results |
| 11 | Webpage reading | **PASS (unit)** | `pageFetcher` caps bytes/redirects; SSRF regressions pinned in `omiSecurityExpansion.test.ts` |
| 12 | Citations | **PASS (unit)** | Provider→citation mapping with provenance (license, dates, stars) pinned per source |
| 13 | Image generation | **PASS** | **Live, this pass:** generated a real image via `pollinations` (`sana`), 32,970 bytes at 1024×1024 |
| 14 | Image editing | **BLOCKED** | Every edit-capable provider refused: Gemini image models `429` (quota/billing), OpenAI `429` (no credits). The router surfaces the true error; the Studio never fakes an image |
| 15 | File uploads | **PASS (unit)** | Upload path validated for type/size; ownership-filtered resolution; per-user rate limit. Live upload needs a session |
| 16 | PDF / DOCX / TXT / CSV / XLSX | **PASS (unit)** | `docExtract.test.ts` builds real ZIP/OOXML fixtures: paragraph order, shared strings, cell refs, multi-sheet order, honest rejection of a fake `.docx` |
| 17 | Voice | **PASS (unit)** | On-device Web Speech API (free, no key); degrades to hidden controls when unsupported. Not verifiable headless |
| 18 | Human Emotion | **PASS** | See the dedicated section below |
| 19 | Conversation history | **PASS (unit)** | Conversation ownership checked before every turn; foreign conversation IDs throw |
| 20 | Memory | **PASS (unit)** | User-owned, user-editable; emotion reads are **not** persisted unless the user opts in |
| 21 | Settings | **PASS (unit)** | Per-user settings drive emotion-awareness and provider preferences |
| 22 | Error handling | **PASS** | Honest messages over silent failure — e.g. no-provider and not-your-conversation paths throw actionable text |
| 23 | Loading states | **PASS (unit)** | Skeleton/spinner states on async panels; route-level Suspense fallback |
| 24 | Mobile responsiveness | **PASS (unit)** | Mobile navigation exists (the sidebar was previously desktop-only, so phones could not leave Home — fixed in the redesign) |
| 25 | Dark theme | **PASS** | Dark-first: `class="dark"` on `<html>`, `color-scheme: dark`, near-black canvas; manifest and offline shell match |
| 26 | Security / API-key exposure | **PASS** | See the dedicated section below |
| 27 | Rate limiting | **FIXED** | Chat was the only expensive surface without one. Now 20/min per user, matching the existing per-surface pattern |
| 28 | Production deployment config | **PASS** | Live artifact verified by the deployment probe; Convex codegen runs with no committed credentials |

## Special test — Human Emotion

Passages tested for frustration, sadness, anger, excitement, confusion and
neutral wording, through the shared `emotionsEngine` (`emotionAware.test.ts`).

| Requirement | Verdict | Evidence |
|---|---|---|
| Emotion awareness changes response *style* | **PASS** | Tone guidance is chosen per emotion family (anger → answer first, no chirpiness; anxiety → facts and sequence; excitement → warm then substance) |
| Never claims certainty about inner state | **PASS** | The contract is enforced in one place: the prompt says "report signals, not certainties", and the chat tone block instructs hedging ("this sounds frustrating") and one short clause maximum |
| Never overrides the actual request | **PASS** | Rule (1) of the tone block: answer the user's real request in full and first; the signal may never change *what* is answered |
| Droppable when wrong | **PASS** | Rule (3): if the read is wrong, drop it and follow the user's words |
| Weak signals don't over-steer | **PASS** | Below 0.5 confidence the block explicitly says do not lean on it |
| Offline fallback | **PASS** | Local lexicon read when no provider answers; confidence capped at 0.75 and labelled as an approximation |
| Stored only with consent | **PASS** | Chat reads are ephemeral; only the explicit Emotions-screen analysis is persisted |

One deliberate tuning note, already pinned by a test: a bare "fixed" is **not**
treated as relief, because "I need this fixed" is an urgent request, not a
happy resolution.

## Security test — API keys

| Check | Verdict | Evidence |
|---|---|---|
| No key value in frontend source | **PASS** | Every provider key is read from `process.env` inside `src/convex/` only |
| No key value in the built bundle | **PASS** | Scanned `dist/` for `gsk_…`, `sk-…`, `sk-proj-…`, `AIza…` patterns → **zero matches** |
| No key value in browser network responses | **PASS** | Public endpoints publish only booleans, labels and cost strings. Env var *names* are never returned; the only names in the bundle are inside Settings setup hints, which are values-free and user-facing by design |
| No key in logs / public health endpoints | **PASS** | `/`, `/health`, `/status`, `/selftest` are unauthenticated by contract and disclose counts/booleans only |
| No key in the repository | **PASS** | No credentials committed; CI codegen uses deployment configuration, not a committed deploy key |
| Failures handled safely | **PASS** | Uploads and provider calls fail closed with actionable errors |

Rate limiting is now per-user on every expensive surface:
chat 20/min · search 20 · URL reading 30 · deep research 5 · images 12 · file
ingest 20 · projects 10 · agent tools 20 · workflows 6 — with
`RATE_LIMIT_PER_MIN` as the deployment-wide override.

## End-to-end flow

New user → chat → Andromeda research → open source → upload PDF → ask about the
PDF → generate image → edit image → voice → Human Emotion → save conversation →
new conversation → return to the previous one.

| Stage | Verdict |
|---|---|
| Live backend capabilities (search, routing, AI, fallback, vision, generation) | **PASS** — live-probed |
| Sign-in, upload (PDF/DOCX/CSV/TXT/image), grounded answers, conversation save/switch | **PENDING** — requires a signed-in session; not claimed |

The unauthenticated self-test deliberately refuses to upgrade these to PASS on
the strength of deployed code alone.

## Defects found and fixed in this pass

**1. A working capability was hidden behind a blocked one.** The `image engine`
probe graded generation and editing as a single verdict, so the report showed a
lone "unverified" while image generation was in fact working the whole time.
*Fixed:* split into two independently probed subsystems. Live result — **image
generation PASS**, **image editing unverified/BLOCKED** with the upstream quota
error quoted.

**2. Chat had no per-user rate limit.** Every other costly surface was limited;
chat — which can cost a search fan-out, a vision call, an emotion classification
and a synthesis call in a single turn — was not, so one account could burn the
shared free-tier quota. *Fixed:* 20/min per user via the shared limiter.

**3. The rate limiter had no test.** The one primitive standing between an
account and the shared quota was untested, so a change could silently remove it.
*Fixed:* `tests/omiRateLimit.test.ts` — 8 tests pinning allowance accuracy,
retry-hint bounds, refusal persistence, and per-key/per-surface isolation
(the property that makes `chat:${userId}` per-user rather than global).

## Blocked, and why

| Item | Blocker | Unblocked by |
|---|---|---|
| Image editing / background / enhance / upscale / combine | All edit-capable providers refuse: Gemini image models `429` (project without billing), OpenAI `429` (no credits) | A Gemini project with billing enabled, or an OpenAI credit balance. Free text and free generation are unaffected |
| Android store packaging | Manifest ships an SVG icon only; Play and maskable icons need 512×512 / 192×192 **PNG**. No rasterizer is installed and it is not worth a build dependency for two static files | Exporting the PNGs from `public/logo.svg` — step-by-step in `docs/android-packaging.md` |

## What is genuinely ready, and what is not

**Ready:** the deployment, the provider-neutral AI chain with an independent
verifiable fallback, Andromeda search, vision, image generation, the emotion
layer, the dark theme, the security posture, and PWA installability on the web.

**Not ready — and not claimed:** signed-in end-to-end flows on a real device,
image *editing* (external quota), and store packaging (missing PNG icons).

## Recommended next steps, in order

1. Enable billing on the Gemini project (or add an OpenAI credit balance) — this
   is the only thing standing between Omi and full image editing.
2. Export the PNG icons and follow `docs/android-packaging.md` — the remaining
   store-packaging blocker.
3. Run the signed-in end-to-end flow on a real Android device and record the
   result, closing the PENDING rows above.
