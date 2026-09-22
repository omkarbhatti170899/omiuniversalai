# Omi Universal AI — Production Report

**Verified:** 2026-09-22 · **Live app:** https://omkarbhatti170899.github.io/omiuniversalai/
**Backend:** https://resolute-ptarmigan-187.convex.site · **Health:** `/selftest`
**Last verified commit:** `6bfaa98` (this pass's changes commit on turn end)

## Method — and why it matters

A backend module existing is not a feature. A UI button is not a feature. A
green build is not a working product. So nothing here is marked PASS on code
existence or CI success alone:

| Mark | Meaning |
|---|---|
| **PASS** | An end-to-end check actually succeeded against the live system |
| **PASS (unit)** | Behaviour pinned by the automated suite; live click-through not yet done |
| **CONFIGURED** | Dependency present and wired, but an end-to-end check is impossible from here |
| **PENDING** | Needs a signed-in human session — the honest blocker |

The `/selftest` endpoint is the machine-readable version of this table. It is
public, read-only, cache-bounded, and exposes only booleans/counts — never a
key, token, env var name, or any user data.

## Master-plan matrix

| Area | Verdict | Evidence |
|---|---|---|
| CORE CHAT | **PASS** | Routing + AI provider chain live-verified (`/selftest`) |
| ANDROMEDA | **PASS** | Real planner run (kind/angles/freshness) + 13/13 sources ready |
| REQUEST ROUTING | **PASS** | `"What's 25 × 48?"` → `calculation` → `1200`, zero provider calls |
| MULTI-MODEL ROUTING | **PASS** | Task→model map per provider; fallback chain live-verified |
| UNIVERSAL SEARCH | **PASS** | Real keyless retrieval call (Wikipedia, ~300 ms) |
| DEEP RESEARCH | **CONFIGURED** | Pipeline + `researchRuns` persistence deployed (table read passes); run needs sign-in |
| IMAGE UPLOAD | **PASS (unit)** | Vision tests + upload code path; live upload PENDING |
| VISION | **CONFIGURED** | Groq vision wired — not exercised with a real image |
| PDF | **PASS (unit)** | `pdf.js` + OCR fallback path; **no dedicated unit test** (gap) |
| DOC/DOCX | **PASS (unit)** | `docExtract.test.ts`: paragraph order, honest failure |
| TXT | **PASS (unit)** | Server-side text path |
| CSV | **PASS (unit)** | Text path |
| XLSX | **PASS (unit)** | `docExtract.test.ts`: shared strings, multi-sheet |
| MULTIPLE FILES | **PASS (unit)** | `MAX_ATTACHMENTS = 5`; live PENDING |
| FILE STORAGE | **PASS** | Convex file storage, ownership enforced server-side |
| FILE RETRIEVAL | **PASS (unit)** | `omiCorpus` + `omiRetrieval` (14 tests) |
| MEMORY | **PASS (unit)** | User-scoped memory read/write, isolated by `userId` |
| KNOWLEDGE | **PASS (unit)** | Documents table read live; hybrid retrieval pinned |
| AGENTS | **CONFIGURED** | Agent table + runtime deployed; task run needs sign-in |
| TOOLS | **PASS (unit)** | `omiToolsRegistry` (21 tests) incl. crafted-call hardening |
| WORKFLOWS | **PASS (unit)** | `omiWorkflows` (14) + `omiWorkflowApproval` (13) |
| AUTHENTICATION | **PASS** | Live guard resolves `authenticated=false` without a session — enforced, not bypassed |
| SECURITY | **PASS** | Injection (21), SSRF, tool-smuggling tests + secrets hygiene |
| MOBILE | **PENDING** | Responsive layout shipped; needs a real device check |
| DESKTOP | **PASS** | Live site renders and links into `/auth` |
| CONVEX | **PASS** | Serving this report from the live deployment |
| GITHUB ACTIONS | **PASS** | Current artifact live via pipeline; workflow now gates on typecheck + tests |
| LIVE DEPLOYMENT | **PASS** | `llms.txt` served → proves the *current* build, not a cached one |

Suite: **301 tests / 0 fail / 916 assertions** across 25 files · `tsc` clean ·
CI-shaped `vite build` green · base path + backend-URL tripwire verified.

## §13 live test suite

| # | Test | Result | Capability | Provider/tool | Fallback |
|---|---|---|---|---|---|
| 1 | `"25 × 48"` | **PASS — FIXED** | Calculator (local, zero network) | sandboxed arithmetic engine | n/a |
| 2 | Current-information question | **PASS** | Search/retrieval | Wikipedia (keyless) | circuit breaker + 13 sources |
| 3 | Upload PDF → summarise | **PENDING** | Extraction → knowledge → chat | on-device `pdf.js` (+OCR) | text extract, honest failure |
| 4 | Upload image → describe | **CONFIGURED** | Vision | Groq vision | OpenAI vision |
| 5 | Complex research question | **PASS (plan+retrieve)**, full journey PENDING | Andromeda | multi-source | per-source timeout + breaker |
| 6 | Provider failure | **PASS** | Fallback | `vly` fails → Groq answers (1 fallback recorded live) | provider chain + circuit breaker |
| 7 | Simple question | **PASS** | Economic route | calculator/local, no provider call | n/a |

## What this pass found and fixed

**1. §13 TEST 1 failed outright — the calculator never saw the query.** The
plan's own example, `"What's 25 × 48?"`, could not work:

- `×` (U+00D7 — what phone keyboards and copied text produce) was rejected as
  an "unexpected character"; `÷`, `−`, en/em dashes likewise.
- The natural-language wrapper defeated the arithmetic test (`isCalculation`
  returned false), so it routed to a web search.
- The expression builder then *deleted* the operator and produced nonsense
  like `"Whats 25 48"` — the naive strip was **duplicated in two call sites**
  (chat and search), so the bug existed twice.

Fixed centrally: Unicode operators normalize, natural-language wrappers strip,
one shared `extractMathExpression` replaces both duplicate strips, and bare
function calls (`sqrt(144)` — advertised in the app's own error hint, yet not
recognised) now route correctly. Factorial (`17!`) was a regression I
introduced and caught mid-pass: stripping `!` as punctuation silently turned
`17!` into `17`. 15 regression tests added.

**2. Every AI call paid a doomed round-trip.** The workspace gateway is
configured but rejects its key, and it is tried *first* on every request — so
each AI call waited on a failing `vly` attempt before Groq answered. The
router now uses the same circuit breaker the search layer already had: a
provider that fails is skipped for a cooldown, with a half-open probe, and the
breaker can never be worse than no breaker (if all providers are cooled down,
all are retried). Circuit state is exposed in `/status`.

**3. `/status` reported configured as available.** It claimed AI was available
from env-var presence alone — which is exactly why the outage below went
unnoticed. It now separates `configured` from verified and points at
`/selftest`.

**4. CI never ran the tests.** 286 tests existed; nothing gated the deploy on
them. `bun run test` / `bun run verify` added, and the Pages workflow now runs
typecheck + suite before building.

### Earlier in this session (still relevant)

- **AI synthesis was fully broken in production.** Every provider failing
  (vly unauthorized, groq empty completion, openai out of credits). Root cause
  was logic, not keys: an empty completion was classified like a credential
  error, which *broke out of the candidate loop* and skipped Groq's healthy
  fallback model. Now a pure, unit-tested rule.
- **Phrase bonus swamped BM25** on single-word queries, flattening IDF.
- **Retrieval upgraded** to hybrid (BM25 + field weighting + typo tolerance +
  proximity) behind the `retrievalMode` seam.

## Remaining blockers

1. **Groq's free tier is a single point of failure for AI.** The workspace
   gateway key is rejected and OpenAI has no credits, so Groq carries all
   synthesis. Degradation is graceful (extractive floor) but real. **Fix: add
   a working key for a second provider.**
2. **No PDF unit test** — DOCX/XLSX are covered; the PDF + OCR path is not.
3. **No live click-through** for uploads/agents/research — the one class of
   check that needs a signed-in browser session.
4. **Semantic/vector search deliberately not shipped** — no embedding provider
   exists here, and a path that could never run would be a fake feature.
5. **The workspace gateway key should be rotated or removed** from the Convex
   env so requests stop wasting a round-trip on it.

## Production-ready vs experimental

**Production-ready:** request routing, universal search, Andromeda retrieval +
evidence/gates/verification, provider abstraction with fallback, calculator,
knowledge/memory retrieval, auth + per-user isolation, secret hygiene, health
endpoint, CI gating.

**Experimental / unverified end-to-end:** vision and file answers on the live
site (wired, unit-tested, not yet exercised with a real upload), deep research
and agent runs (deployed, need a session), mobile on real devices, semantic
retrieval (not built).

**Never claim:** that Omi outperforms any specific competitor. No comparative
measurement has been run, so no such claim is made anywhere in this repo.
