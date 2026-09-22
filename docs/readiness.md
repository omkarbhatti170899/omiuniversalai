# Omi Universal AI — Production Readiness

**Last verified:** 2026-09-22
**Live app:** https://omkarbhatti170899.github.io/omiuniversalai/
**Live backend:** https://resolute-ptarmigan-187.convex.site
**Approach note:** "the build passed" and "the deploy went green" are *not*
proof the product works, so nothing below is marked PASS on build success
alone. Every claim names its evidence, and anything only verifiable by a
signed-in human session is marked so rather than assumed.

## Evidence classes

| Class | Meaning |
|---|---|
| **LIVE** | Observed against the deployed system just now (HTTP probe / real API call) |
| **UNIT** | Covered by the automated suite (286 tests / 25 files) |
| **CODE** | Verified by reading the enforced code path; no independent runtime check |
| **PENDING** | Requires a signed-in browser session — not yet performed |

## Matrix

| Area | Status | Evidence |
|---|---|---|
| TypeScript build | **PASS** | `tsc -b --noEmit` clean |
| Test suite | **PASS** | 286 pass / 0 fail / 867 assertions |
| Production bundle (CI conditions) | **PASS** | `vite build` under `VITE_BASE_PATH=/omiuniversalai/` |
| Backend URL compiled into bundle | **PASS** | workflow tripwire step passes locally |
| GitHub Pages deployment | **PASS** | Actions run #7 success; `llms.txt` live (proves new artifact, not cache) |
| Health / status endpoints | **PASS** | `/`, `/health`, `/status` → 200 |
| Andromeda retrieval | **PASS** | LIVE `/selftest`: real Wikipedia query → 2 results |
| Andromeda sources | **PASS** | LIVE: 13/13 ready (all keyless, $0/query) |
| AI synthesis | **PASS** | LIVE `/selftest`: real completion returned via Groq |
| Image understanding (VISION) | **CONFIG-ONLY** | Groq vision configured; not exercised with a real image |
| Image upload (JPG/PNG/WEBP/GIF) | **PASS*** | CODE path + `omiVision.test.ts` (9); live click-through PENDING |
| PDF | **PASS*** | CODE path (`pdf.js` + OCR fallback); **no unit test** — see gaps |
| DOC/DOCX | **PASS** | UNIT `docExtract.test.ts` (paragraph order, honest failure) |
| XLSX | **PASS** | UNIT `docExtract.test.ts` (shared strings, multi-sheet) |
| TXT | **PASS** | CODE — server-side text path |
| CSV | **PASS** | CODE — text path |
| Multiple attachments | **PASS*** | CODE (`MAX_ATTACHMENTS = 5`); live click-through PENDING |
| File storage | **PASS** | CODE — Convex file storage + server-side ownership |
| File retrieval | **PASS** | UNIT `omiCorpus.test.ts` (3) + `omiRetrieval.test.ts` (14) |
| AI answers grounded in files | **PASS*** | CODE (`attachmentBlock` → chat); live click-through PENDING |
| Internal corpus in Andromeda | **PASS** | UNIT — searched first, `internal://`, highest trust |
| Human Emotions AI | **PASS** | UNIT (`omiVision`, `omiOrchestration`); provider live-verified via `/selftest` |
| Prompt-injection defence | **PASS** | UNIT `omiInjectionEvals` (4), `omiSecurity` (9), expansion (8) |
| SSRF protection | **PASS** | UNIT (`hardening pass — SSRF regression`, public/loopback cases) |
| Auth + per-user isolation | **PASS** | CODE — `getAuthUserId` guards on every user-scoped function |
| Secrets hygiene | **PASS** | `.env*` gitignored; only booleans/public metadata exposed publicly |
| Rate limiting | **PASS** | CODE — `rateLimit` (chat, research, search); `/selftest` cached 5 min |
| Retrieval engine | **PASS** | UNIT `omiRetrieval.test.ts` — hybrid BM25 + field weight + typo + proximity |
| Mobile / responsive | **PENDING** | Responsive layout shipped; needs a real device check |

`PASS*` = the code path is enforced and (where noted) unit-tested, but the
full user journey has not been clicked through on the deployed site.

## What this verification found (and fixed)

**1. AI synthesis was completely broken in production.** The new live
self-test returned `degraded`, with *every* provider failing:

```
vly:    Unauthorized
groq:   returned an empty completion
openai: 429 — "You have no credits remaining"
```

Root cause was a logic bug, not a credentials problem. In the provider
router, an **empty completion** was classified the same way as a credential
error, which *broke out of the candidate loop* and skipped the provider's own
fallback models — so Groq's healthy `llama-3.3-70b-versatile` fallback was
never tried, and OpenAI's exhausted quota ended the chain. Every AI feature
(chat reasoning, Andromeda synthesis, deep research, emotions) was silently
running in degraded/extractive mode while `/status` still reported AI as
available.

Fixed by extracting the decision into a pure, unit-tested rule
(`decideAfterFailedAttempt`): an empty completion is a *candidate-level*
failure and tries the next model on the same provider. `/selftest` now
reports `4/4 passed, status: ok`.

**2. The phrase bonus swamped BM25 on single-word queries.** A flat +4 bonus
fired whenever the query string appeared verbatim in a passage — including
single-term queries over 8 characters, where it simply re-awarded the term
match and flattened IDF weighting. A document *titled* with the query term
lost to one that mentioned it in passing. The bonus is now gated on genuine
multi-word phrases.

**3. `/status` conflated configured with working.** It claimed AI "available"
purely from env-var presence — misleading during the outage above. It now
reports `configured` separately and points to `/selftest`, which makes a real
call and is the only endpoint that reports *verified* availability.

**4. CI did not run the tests.** 286 tests existed but nothing gated the
deploy on them. `bun run test` / `bun run verify` added; the Pages workflow
now runs typecheck and the suite before building.

## Open risks

1. **Groq's free tier is a single point of failure.** With the workspace
   gateway rejecting its key and the OpenAI account out of credits, Groq is
   currently the *only* working AI provider. The router degrades honestly
   (extractive floor) rather than erroring, but full synthesis depends on one
   free tier. Mitigation: add a working key for a second provider.
2. **No PDF extraction unit test.** DOCX/XLSX have real coverage; the PDF
   path (including the on-device OCR fallback) does not.
3. **No live click-through.** Uploading a file and asking a question in a
   signed-in session is the one thing that cannot be verified from here.
4. **Vector/semantic search is deliberately not shipped.** No embedding
   provider is available on this deployment; building an embedding path that
   could never execute would violate the project's no-fake-features rule
   (§35). See `docs/andromeda.md` §8.
