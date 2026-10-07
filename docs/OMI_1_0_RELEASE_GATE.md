# OMI 1.0 — RELEASE GATE (20-phase masterplan)

**Date:** 2026-09-30 · **Mode: release candidate — no development started**
**Cost: ₹0/month** · Search architecture **frozen** · 178-row matrix = standing regression gate

**CORRECTION (2026-09-30, from the owner's Convex dashboard):** production is
**`majestic-turtle-372`** and it has **never been deployed** — it is not paused.
The earlier "paused production" finding referred to `resolute-ptarmigan-187`, a
retired deployment that the built frontend still points at.

**STATUS (2026-10-07, measured):** production **is now deployed** — every HTTP
route answers 200 and the deployed functions are current — but it has **no
environment variables at all**, so it is deployed and still unusable:

| Probe | Production `majestic-turtle-372` | Dev `striped-salmon-879` |
|---|---|---|
| `/.well-known/jwks.json` | **HTTP 500** → no sign-in | HTTP 200 (1 signing key) |
| `/status` → `ai.configured` | `false` (0/4 providers) | `true` (`groq`) |
| `/status` → `vision.available` | `false` | `true` |
| keyed search sources configured | **0/2** | 2/2 |

The credentials live only on the dev deployment, so `process.env` on production
finds nothing (Convex reads env at request time — a redeploy cannot fix this).
Configuration is now machine-checked by `scripts/prodGates/checkBackendConfig.ts`
(report in the build job, `--strict` in `verify-live`); the exact env vars and
verification commands are in `docs/PRODUCTION_BACKEND_CONFIGURATION.md`.

Still not shipped: the pinned backend. Pages runs **have** succeeded historically
(81 of the last 100; last green run `868c353` at 2026-10-07 03:45), but **every
run since the backend pin was introduced failed the "reject legacy CONVEX_URL"
gate**, because a repository *variable* named `CONVEX_URL` held a different value
— the owner deleted it on 2026-10-07, so the next push is the first run that can
reach the deploy job. The live site therefore still serves the bundle published
at 03:45 — compiled against the retired `resolute-ptarmigan-187` — and does not
publish `deployment-info.json` at all (fetching it returns the SPA 404 fallback),
which is how "this deployment predates the identity gates" is observed rather
than assumed.

**Verdict: NOT READY.** Two blockers, both owner-gated: production has no
environment variables (auth first — nothing else matters if sign-in 500s), and
the live frontend is still compiled against the retired deployment until a Pages
run goes green. Human QA follows. Image generation is explicitly **non-blocking**
per the masterplan.

---

## Phase-by-phase status (evidence, not intent)

| Phase | Status | Evidence |
|---|---|---|
| **1 — Core AI / chat** | 🟢 | Chain `groq → gemini → openai` verified live (`aiStatus:status` → Groq free tier). Streaming / stop / regenerate / error-recovery / fallback unit-pinned. Provider architecture replaceable (no hard dependency). |
| **2 — Andromeda retrieval** | 🟢 | Full pipeline live: intent → entity → temporal → plan → route → parallel → normalize → dedup → relevance → freshness → authority → corroboration → conflict → verified evidence. **SearXNG not mandatory** — verified live this hour: rows show `SearXNG: circuit open` while the turn still answers from other free providers. |
| **3 — Free knowledge network** | 🟢 | 17 free providers, no engine added this cycle. Wikipedia/Wikimedia, arXiv, OpenAlex, GitHub, Open Library, Openverse, Open-Meteo, sports-scores, market-rates, GDELT, HN, CommonCrawl, Mwmbl, DDG-instant, Wikidata, LangSearch, SearXNG(opportunistic). |
| **4 — Search quality / verification** | 🟢 | 178-row matrix: **172/178 (97%)**, 0 off-topic kept, 0 wrong-year kept, 0 duplicate URLs. Correct refusals preserved, not chased. |
| **5 — Current information** | 🟢 **closed this pass** | The one outstanding scenario (`"What happened in the world today?"`) was investigated, not assumed. Harness first-pass reported *fail*; the **real chat path passes**: `status=pass`, 2 fresh dated sources (NYT 19 h, The Neuron), 1 **off-topic result dropped**, 3.5 s, 0 failed engines. The `/currentinfo` harness is first-pass-only and cannot escalate — documented tooling limit, not a product defect. |
| **6 — Source management** | 🟢 | Per-engine telemetry persisted and healthy: `successRate`, `timeoutRate` (duckduckgo 0.76), `latencyP50Ms` (seznam 4192 ms), `successes/failures`, `lastOkAt/lastFailAt`, `lastError`, suspension state. Circuit breaker + auto-recovery observed live. |
| **7 — Citations** | 🟢 | 178/178 citations resolve; inline `[n]` verified in live answers; duplicates never counted as independent corroboration. |
| **8 — Document intelligence** | 🟡 | PDF/DOCX/XLSX/CSV/TXT + OCR extraction, `[K#]` grounding, project isolation — all unit-tested and TXT/PNG verified via the production API. Signed-in browser upload is owner QA. |
| **9 — Vision** | 🟢 | Real image read live; graceful-failure path pinned. |
| **10 — Image features** | 🟡 **non-blocking** | All three providers currently exhausted (Pollinations 402, Gemini quota, OpenAI no credits) → `/selftest` degraded. Router/verification correct and unit-pinned; code untouched per masterplan. Clear for ₹0 via Pollinations Quests, or ship 1.0 with images degraded. |
| **11 — Security** | 🟢 / 🟡 | Server-side secrets only (0 keys in client bundle or app shell), authn/authz (0 missing-authz), SSRF guard per redirect hop, injection evals, rate limiting, safe URLs, dependency audit **run for the first time** (`bun audit`: node-tar + brace-expansion = build-time, absent from the shipped bundle; hono ships inside Convex's function runtime, `toSSG()` unused). 🟡 CSP needs a browser to validate — deliberately not applied blind. |
| **12 — Error / failure resilience** | 🟢 | provider failure → fallback, timeout → fallback, empty → alternate, conflict → detected + resolved or declared, no evidence → honest refusal. Failure-isolation suite 6/6 (one / several / all engines down). Never a fake success. |
| **13 — Performance** | 🟢 | Parallel retrieval, per-provider timeouts, early-continue gate. Live this pass: 0.75–4.2 s typical, worst 8.0 s; one 12.3 s SearXNG probe isolated without delaying the answer. |
| **14 — Search regression gate** | 🟢 frozen | **No source file has changed since the 178-row run** (verified by mtime against the run artifact) — the gate result still stands. Any future search change must re-run it. |
| **15 — Production QA** | 🔴 **owner** | Automated tests are explicitly not sufficient. `docs/HUMAN_QA_CHECKLIST.md` gate was **fixed this pass** (see below). Desktop + mobile browser pass outstanding. |
| **16 — Deployment** | 🔴 **owner** | Production `majestic-turtle-372` **is deployed** (HTTP routes 200, functions current as of 2026-10-07) but has **no environment variables**, so sign-in 500s and AI / vision / keyed search are off — `scripts/prodGates/checkBackendConfig.ts` reports 1 blocker + 4 warnings against it. The live frontend is still compiled against `resolute-ptarmigan-187` (retired) and publishes no `deployment-info.json`, because every Pages run failed the `CONVEX_URL` repository-variable gate; the owner deleted that variable on 2026-10-07. `striped-salmon-879` (dev) is fully configured and is where all evidence comes from. Env vars + verification: `docs/PRODUCTION_BACKEND_CONFIGURATION.md`. |
| **17 — Android / P10** | 🟡 owner-side | Config, manifest, service worker, offline shell, permissions, TWA + assetlinks instructions all committed. Icons need a rasterizer (no system rights here); native build needs a JDK (absent). **Does not block the web release.** |
| **18 — Release gate** | ⛔ not met | 2 RED items open. |
| **19 — Freeze** | ✅ in effect | No provider added, no SearXNG work, no retrieval rewrite, no paid dependency, no benchmark chasing. |
| **20 — Post-1.0** | queued | Order: reliability → search quality → verification → current info → reasoning → documents → vision → images → memory → agents → Android → perf/UI. Every change: reason → expected benefit → regression test → production verification. |

---

## What changed this pass (QA tooling only — no product code)

`docs/HUMAN_QA_CHECKLIST.md` instructed the human reviewer to grep the **entry
bundle** for four UI markers. Those markers live in **lazily-loaded view
chunks**, and chunk imports nest two levels deep, so the check returned 0 and
would have declared *"you are testing a stale build — STOP"* — falsely blocking
the entire human QA pass.

Replaced with a verified graph-walking check (entry → views → panels; 25 chunks,
1.7 MB) returning **4/4 markers** on the current live build, plus a new
**Step 0** that confirms the backend deployment answers before the reviewer
starts, so a paused deployment is diagnosed as infrastructure rather than an
app bug.

---

## The two RED items — exact owner actions (₹0)

**R1 — production deployment paused** (~30 seconds)
1. Convex Dashboard → team `omkar-bhatti` → project `omiuniversalai` → deployment `resolute-ptarmigan-187` → **Resume**.
   (The Convex CLI has no resume command — verified. Dashboard only.)
2. Tell me it's resumed. I then run `bunx convex deploy` so production carries
   the same function code as dev, and re-run the whole §Verification set against
   the **resumed production** deployment.
3. **No frontend rebuild needed** — the deployed bundle is current (30 Sep
   03:44 UTC) and already points at that deployment.

*If that deployment is unrecoverable:* set repo variable
`VITE_CONVEX_URL = https://striped-salmon-879.convex.cloud`
(Settings → Secrets and variables → Actions → Variables) and re-run
`Deploy to GitHub Pages`. Free, but it points production at the dev deployment —
not recommended.

**R2 — human QA** (owner, browser + phone)
Run `docs/HUMAN_QA_CHECKLIST.md` end to end and record PASS/FAIL: UI rendering,
chat, current information, search, citations, streaming, regenerate, provider
fallback, errors, document upload, vision, image features, mobile UI.
Automated passes do not count (§"How to record each flow").

**Optional / non-blocking:** Pollinations Quests for image balance (₹0);
CSP browser test; `bun update` for the two build-time advisories.

---

## Verification executed this pass (live, unpaused deployment)

| Check | Result |
|---|---|
| `bun test` | **1,439 pass / 0 fail**, 76 files, 5,018 assertions |
| `bunx tsc -b --noEmit` | **0 errors** |
| `bunx eslint src/` | **0 errors** (5 pre-existing warnings) |
| `bunx convex dev --once` | functions ready |
| `/currentinfo` (live HTTP) | **9/10 pass**, 1 harness-only fail → closed via chat path (§Phase 5) |
| Chat path, same query | **pass** — 2 fresh dated sources, off-topic dropped, 3.5 s |
| Chat path, F1 2026 championship | **answered + cited** — Antonelli, 302 pts, `[1]` |
| 12-scenario real-world audit | 10 answers + 2 correct refusals, **0 fabrications**, 0.75–8.0 s |
| Provider / engine health | per-engine success + timeout rates, p50 latency, last ok/fail, suspension — all persisting |
| Frontend markers (live chunks) | **4/4** |
| Production deployment | 🔴 paused — re-check after resume |
| ₹0/month | 🟢 maintained |

**Per the masterplan, none of the above is final evidence of the *production*
release until R1 is closed and the set is re-run against the resumed
deployment.**
