# Andromeda Stabilize-and-Prove Run — 2026-09-28

## Addendum 8 — GLOBAL DEADLINE + FAST-FAIL + EXPLICIT CONFIG + PERSISTED ENGINE HEALTH (a1a7da8 review, 2026-09-29)

Owner status: SearXNG returning production results (F1 2.3 s, 7 fresh, no failed
engines) — but NOT production-ready. Five issues. All addressed this round.

### Issue 1 — latency: root-caused, then fixed at three levels

**Investigation first:** every 12–15 s telemetry row was 63–66 h OLD — they
predate round 7's tightening; the cited 9/12/13 s rows were the OLD pipeline.
Post-round-7 rows: F1 2.3 s, worst 10.8 s. But the round-8 matrix still caught
ONE 12.5 s path (IPL), which decoded to: lumy times out at 5 s → the adapter's
second pass RE-DIALS the same host (+5 s) → the freshness escalation's recovery
dial pays the SAME timeout a third time (+2.5 s of budget). Three stacked
attempts against one flaky host.

Fixes (no timeout increased anywhere):
1. **Global search deadline** (`omiChat.ts` → `runUniversalSearch`):
   `OMI_SEARCH_DEADLINE_MS` (16 s) shared by pass 1 AND the escalation pass —
   escalation inherits the remaining slice, never a fresh budget. Every
   provider timeout is capped by `min(perProvider, remaining)` inside the
   fan-out, so `guardedCall`'s timer CUTS OFF a slow engine at the wall clock
   (real cancellation, not politeness).
2. **In-call fast-fail** (`searxng.ts`): a base that failed during THIS call is
   never re-dialed by pass 2 (`failedThisCall`); cross-call recovery stays with
   health memory + probe TTL.
3. **Recovery-dial rate limit**: when every base is known-dead, the one
   recovery attempt fires at most once per 30 s — the escalation fails through
   immediately instead of re-paying the timeout.

Measured: **IPL 12.5 s → 3.0 s**. Matrix mean ~2.9 s. Even in a mid-flap window
the F1 worst case was **6.3 s with an honest refusal** (was 12.5 s+), passing at
2.75 s one minute later. A slow engine can no longer hold the answer hostage:
parallel fan-out (allSettled) + per-provider timeouts + global deadline +
cancellation + health-based ordering + fast-return were all already present or
are now added — and are regression-pinned.

### Issue 2 — configuration inconsistency: root cause + fix

`searxEngines: []` / `searxVerifiedInstances: []` was REAL, not a display bug:
both are ISOLATE-LOCAL memory, and the diagnostic action runs in a different
isolate than the searches. Meanwhile production config was never hidden:
`SEARXNG_BASE_URL=https://search.lumy.live` (confirmed via env list).

Fixes:
- **`describeSearxSelection()`** — explicit answer to all six questions: which
  instance (configuredBase), public vs self-hosted (`KNOWN_PUBLIC_HOSTS` →
  lumy = public), how selected (configured first, measured fallbacks after),
  health-check state (lastProbe), verified set, and what happens if it
  disappears (fallback chain + honest refusal — unchanged).
- **`searxInstanceConfig` table** — the selection is PERSISTED on every
  snapshot, so the audit survives restarts: currently `base=search.lumy.live,
  origin=public, configured=true`.
- **`searxEnginesPersisted`** — see Issue 4.

### Issue 3 — self-hosting: unchanged status (owner-side)
Package complete and pinned; no Docker daemon in the sandbox; no VPS provider
provisionable from here. The switch is one env var:
`bunx convex env set SEARXNG_BASE_URL https://<your-host>` + shared secret.
Full steps: `deploy/searxng/README.md`.

### Issue 4 — engine health: now PERSISTED

New `searxEngineStats` table + delta pipeline: the engine registry records
DELTAS per event → `runUniversalSearch` flushes them fire-and-forget after each
search (in the isolate that actually saw the traffic) → the snapshot MERGES and
reads. Live-verified this round from one real F1 search through SearXNG:

```
yandex      ok 1.00 | timeouts 0.00 | p50 765ms | avgResults 15 | dated 0.50 | lastOk ✓
duckduckgo  ok 0.00 | timeouts 1.00 (1 strike, suspended at 2)
mwmbl       ok 0.00 | timeouts 1.00
seznam      unresponsive ×1
```

All eight contract metrics (latency, success rate, timeout rate, result count,
freshness share, last success, last failure, + suspended action) now survive
isolate restarts; suspension/auto-reduction unchanged (2 strikes → 10-min
cooldown → first success clears).

### Issue 5 — the 8-query matrix (round 8, live)

| # | Query | Status | Latency | Found/Fresh | Failed | Notes |
|---|---|---|---|---|---|---|
| 1 | F1 leader | pass | 2.1–2.5 s (×3 runs) | 5/7–8 | 0 | formula1.com kept; authority gate live |
| 2 | F1 standings | pass | 2.9 s | 5/9 | 0 | wrong-competition rejected |
| 3 | Latest IPL news | pass | 12.5 s → **3.0 s after fix** | 5/2 | 0→0 | the fast-fail proof |
| 4 | Live football scores | pass | 1.6 s | 2/2 | 0 | structured feed |
| 5 | EPL standings | pass | 1.6 s | 1/7 | 0 | |
| 6 | NBA standings | pass | 3.7 s | 5/8 | 0 | |
| 7 | Latest India news | pass | 2.1 s | 5/3 | 0 | |
| 8 | Latest world news | pass | 1.7–6.6 s | 5/2 | 0–1 | 6.6 s = flap window, still passed |

Plus the flap-window control: F1 refused honestly at 6.3 s, passed at 2.75 s on
retry. Rejections, freshness, relevance, authority and answerability verified
per row (same gates as rounds 6–7). Evidence: `.qa-tmp/m8-*.json`.

### Gates

1,412 tests / 0 fail (+4 round-8: deadline wiring, selection record, delta
drain checkpoint, fail-fast contract) · tsc 0 errors · eslint 0 errors ·
deployed 22:47 UTC.

---

## Addendum 7 — LATENCY DISCIPLINE + PER-ENGINE HEALTH METRICS + 8-QUERY ACCEPTANCE MATRIX (round 7, 2026-09-29)

Owner verdict on round 6: the reliability layer behaves (sports/entity/year/ranking
detection, stale rejection, off-topic rejection, refusal all confirmed). The
remaining blocker is SearXNG itself: search.lumy.live times out at ~5 s and
searches were taking 12–13 s. Direction: SELF-HOST, do not raise timeouts, do
not make the public instance the production foundation.

### 1. The 12–15 s rows, decoded from telemetry

`searchTelemetry:recent` (34 rows): p50 **3.97 s**, **11 rows > 12 s**, max
**15.24 s** — all successful. Root cause is NOT a hung call: lumy.live answers
JSON in **~4.4–5.0 s per request** (measured repeatedly this round), and the
date-filter ladder walks 2–3 rungs per call, so a normal successful search paid
three slow round-trips. Meanwhile the fan-out gave SearXNG a **30 s slot**, so
it held a pipeline slot long after faster providers finished.

### 2. Latency discipline (tightened, never raised)

| Knob | Before | After | Why |
|---|---|---|---|
| `SEARXNG_PER_TRY_TIMEOUT_MS` | 15 s | **5 s** | one measured round-trip at the flaky host's latency |
| `SEARXNG_TOTAL_BUDGET_MS` | 20 s | **10 s** | two rungs, or a hung host plus one fallback attempt |
| fan-out slot (`PROVIDER_TIMEOUT_MS.searxng`) | 30 s | **12 s** | stop holding a pipeline slot while faster providers finish |
| `SEARXNG_TIMEOUT_MS` meaning | unchanged | unchanged | per-request, deployments keep their override |

Plus **slow-base demotion**: per-base latency memory (`SLOW_BASE_MS = 4 s`,
median over the last 6 answered calls) re-orders the dial list so a chronically
slow base is tried AFTER fast fallbacks — and its leverage is ORDER, never
starvation: a slow-but-real source still gets its full per-try slice (pinned by
a live-server test). Demotion decays the moment faster answers arrive.

Measured result on the real chat path (same round, same public instance):
F1 leader 20–23 s → **2.3 s** · F1 standings **2.7 s** · football scores
**0.6 s** · worst case 10.8 s (a search where lumy timed out at 5 s and the
fallbacks still passed) · **zero rows over the 12 s slot**.

### 3. Per-engine health — all eight contract metrics

`searxEngineHealthSnapshot()` now reports per upstream SearXNG engine:
successes, failures, **success rate**, **timeout rate**, **latency p50** (window
10), **avg result count**, **freshness share** (dated results / results),
**last successful request**, **last failure** (+ `suspended` — the action taken
on those signals; threshold 2 strikes, 10-min cooldown, first success clears).
Result counts and dated counts are fed per payload from each instance response
(`resultsByEngine`), and rates use lifetime counters so one good call cannot
flip a 0% rate to 100%. Suspension semantics are unchanged: streak counters
clear on success, lifetime counters never do.

Surface: `bunx convex run searchEngineHealth:snapshot '{}'` → `searxEngines[]`
(isolate-local) + `telemetryHealth[]` (persisted, cross-restart). The per-engine
metrics are isolate-local like the engine registry itself; the self-hosted
instance's own Prometheus/logging (deploy package) is the fleet-wide view.

### 4. ACCEPTANCE MATRIX — 8 owner-named queries, real chat path, live

All via `currentInfoProbe:runOne`, 2026-09-29 ~22:0x UTC, evidence
`.qa-tmp/matrix-{1..8}.json`:

| # | Query | Status | Found/Fresh | Engines (kept) | Failed | Latency | Answer |
|---|---|---|---|---|---|---|---|
| 1 | F1 2026 leader | pass | 5/7 | SearXNG + LangSearch | 0 | **2.3 s** | Antonelli leads, 302 pts; **formula1.com itself kept** (site: angle working) |
| 2 | Current F1 standings | pass | 5/10 | SearXNG + LangSearch | 0 | **2.7 s** | standings answered from dated sources |
| 3 | Latest IPL news | pass | 5/2 | Wiki-CE + LangSearch | lumy 5 s timeout | 10.8 s | Khaleej Times + Ary News, dated 2026-09-29/26 — degraded, never blocked |
| 4 | Live football scores | pass | 2/2 | structured feed | 0 | **0.6 s** | live scoreboard |
| 5 | EPL standings | pass | 1/7 | TheSportsDB | 0 | **0.6 s** | dated table coverage (si.com, BBC) |
| 6 | NBA standings | pass | 5/8 | 2 engines | 0 | 6.3 s | dated standings coverage |
| 7 | Latest India news | pass | 5/3 | 3 engines | 0 | 6.8 s | dated news coverage |
| 8 | Latest world news | pass | 5/2 | 3 engines | 0 | 3.1 s | dated wire coverage |

Rejections worked in every row (off-topic / wrong-competition / stale dropped
with reasons — e.g. Azerbaijan-GP race report dropped from the F1 leader query
as off-topic). Refusal path intact where evidence is insufficient.

### 5. Self-host deployment status

- The `deploy/searxng/` package (compose + Caddy + settings + limiter + README)
  is complete and pinned by tests — unchanged this round.
- **No Docker daemon in this sandbox** (`docker: not found`), so the compose
  stack could not be smoke-run here; and **no VPS provider exists in the
  integration catalog** — provisioning requires the owner's account.
- Wiring is one env var away and already implemented: the adapter puts the
  configured base FIRST, fallbacks after it, health-memory and demotion apply
  to both. `bunx convex env set SEARXNG_BASE_URL https://<host>` (+
  `SEARXNG_SHARED_SECRET`) is the entire switch.
- Owner steps: `deploy/searxng/README.md` — provision VPS (1 vCPU/1–2 GB is
  ample) → DNS A/AAAA → `docker compose up -d` → prove JSON
  (`curl -H "X-Omi-Secret: …" https://<host>/search?q=test&format=json`) → set
  the two env vars → `probeSearxngCandidates` shows the instance healthy.

### 6. Acceptance criteria scoring (against the owner's list)

| Criterion | Verdict | Evidence |
|---|---|---|
| respond reliably | PARTIAL — flaky public instance; degraded-but-passing; self-host pending | matrix rows 1–8 |
| not block the whole search | **PASS** | row 3: lumy timed out, turn still passed; allSettled isolation pinned |
| multiple results | **PASS** | 5 kept rows in 6/8 queries |
| valid JSON | **PASS** | JSON contract enforced per response; HTML-only instances rejected loudly |
| preserve publication dates | **PASS** | `freshSplitCounts` dated rows in every pass; per-engine freshness share now measured |
| preserve domains | **PASS** | citations carry URLs/domains; formula1.com kept on F1 |
| survive individual engine failures | **PASS** | suspension + auto-recovery + fail-open scoping, pinned; row 3 live |
| work with Andromeda's relevance system | **PASS** | entity anchors, answerability floor, authority gate all applied on SearXNG rows |
| respond FAST (new, round 7) | **PASS on pipeline discipline** — public instance remains the latency ceiling | p50 3.97 s → rows ≤ 10.8 s; zero > 12 s |

**"Not production-ready" until the self-host is deployed and the matrix re-runs
against it — per the owner's own bar. Current state: pipeline-side acceptance
achieved; instance-side BLOCKED on provisioning (owner account + Docker host).**

### 7. Gates

1,409 tests / 0 fail (+6 round-7 tests: budget discipline, demotion, engine
metrics) · tsc 0 errors · eslint 0 errors · deployed 21:51 UTC.

---

## Addendum 6 — SELF-HOST SEARXNG PACKAGE, ENGINE HEALTH SURFACE, GENERALIZED AUTHORITY, CONFLICT REGRESSIONS (325e8e5/a583591 review, 2026-09-29)

Review round 6 (owner verdict on the prior round: "major improvement"). Scope was
fixed by the owner: SearXNG reliability, engine health, authoritative retrieval,
generalized source-quality rules, conflict-resolution regressions, fallback pin.
No new features beyond that list.

### 1. Self-host SearXNG — package complete, deployment BLOCKED owner-side

`deploy/searxng/` ships the full production instance; every one of the ten owner
requirements is implemented and pinned by `tests/omiSearxngSelfHost.test.ts`:

| Requirement | Where |
|---|---|
| HTTPS | `Caddyfile` auto-TLS (Let's Encrypt) on 80/443; SearXNG not port-published |
| JSON API | `settings.yml` `formats: [html, json]`; JSON endpoint gated on `X-Omi-Secret` |
| Health check | container `healthcheck` + unauthenticated `/healthz` in Caddy |
| Configurable engine pool | curated ~11 keyless engines in `settings.yml`; licensed engines (google/bing/ddg/startpage/qwant) documented as disabled |
| Per-engine timeout | per-engine `timeout: 2–3.0` + `outgoing.request_timeout 3.0 / max_request_timeout 6.0` |
| Engine failure suspension | client side: `searxngEngineHealth.ts` — threshold 2 strikes → suspension, scoped `!engine` queries to healthy engines only |
| Automatic recovery | 10-minute cooldown expiry re-admits; first success clears the failure record |
| Logging | Caddy access log, 10 MiB × 5 rotated |
| Latency monitoring | per-provider p50/p95 + per-engine snapshot (`searchEngineHealth:snapshot`) |
| Rate limiting | `limiter.toml` (real_ip + ip_limit) with `X-Omi-Secret` exemption |
| Production URL server-side | `SEARXNG_BASE_URL` + `SEARXNG_SHARED_SECRET` via `bunx convex env set` — never in client code |

**Repro (owner-side, needs a VPS + DNS):** `deploy/searxng/README.md` —
provision → DNS A/AAAA → set secrets → `docker compose up -d` → prove JSON
(`curl -H "X-Omi-Secret: …" https://<host>/search?q=test&format=json`) →
`bunx convex env set SEARXNG_BASE_URL https://<host>` (+ shared secret) →
verify with `bunx convex run diagnosticsSearxngDeep:probeSearxngCandidates '{}'`.

**Why it matters (measured this round):** search.lumy.live is FLAPPING, not dead —
the 20:31 probe saw `timeout of 4988ms exceeded`; the 21:0x candidate probe saw
`JSON API reachable (38 probe results, 3.7 s)`. A configured public instance
someone else runs is not infrastructure. Until the self-host is deployed, the
pipeline degrades honestly: SearXNG timeouts are per-base, health-memorized,
and LangSearch + structured feeds carry general-web breadth (see the 21:0x
F1 pass below).

### 2. Engine health — two real gaps found and fixed this round

The approved design already had: per-provider runtime windows (calls, availability,
timeout rate, error rate, p50/p95, avg results, freshness share, duplicate rate,
relevance), per-SearXNG-engine suspension with auto-recovery, and fail-open
scoping. `bunx convex run searchEngineHealth:snapshot '{}'` is the operator
surface. Two measured defects were found by actually running it:

1. **Cold-isolate blindness.** The snapshot returned `{providers: [], searxEngines:
   []}` from a fresh action isolate — in-memory windows cannot see another
   isolate's traffic, so the health surface was empty exactly when an operator
   dialed in after a quiet period. **Fix:** `searchTelemetry.healthByEngine`
   (new internalQuery) aggregates the PERSISTED `searchTelemetry` rows — calls,
   failures, error rate, avg latency, avg results, last error, last-ok — per
   engine over the latest 300 real chat-path rows. Survives isolate restarts.
2. **No single engine blocks Andromeda (pinned).** Fan-out isolation
   (`Promise.allSettled`), per-provider budgets, strict-vertical backstop and the
   NO single-instance SearXNG dependence are now regression-pinned in
   `tests/omiConflictResolutionRegressions.test.ts` ("SearXNG fallback" block).

### 3. Authoritative retrieval — generalized, and a dispatch bug found live

The per-vertical authority policy (`searchEngine/authority.ts`) stands:
`AUTHORITATIVE_MIN_WEIGHT` (0.85 sports/markets/weather/election/news, 0.6
travel/general), structured-feed fast-paths, `OFFICIAL_DOMAIN_HINTS`
(formula1.com/fia.com, iplt20/bcci, premierleague.com, nba.com, olympics,
rbi/sebi/mospi/imf/worldbank, imd/weather.gov, who/mohfw/cdc),
`authoritativeFloorApplies`, `isAuthoritativeFor` enforced in the omiChat usable
filter with the weak-only refusal. Official-domain rules now cover sports,
finance, science, weather, government, technology, health, education and
products through the hints table + sourceTier floors.

**Measured dispatch defect (found via traceSearch this round):** the
official-source `site:` variant was pushed LAST in `planRetrieval`, after the
recency angles — and the variant list is capped at three, so the authority
angle was silently dropped from the F1 plan (`variants: [latest, today, date]`,
no `site:formula1.com` anywhere). The gates rejected weak evidence but the
retrieval side never went looking for strong evidence. **Fix:** the authority
angle is now pushed FIRST, before recency angles. **Live verification:** the
re-run trace shows `"leading the F1 2026 drivers championship site:formula1.com"`
as the first dispatched variant. Pinned in `tests/omiQueryRewriting.test.ts`
("the OFFICIAL-SOURCE angle always survives the three-variant cap"); the IPL
noise test now exempts `site:` operators from the token-repeat rule.

### 4. Conflict-resolution regressions — all seven review cases pinned

`tests/omiConflictResolutionRegressions.test.ts` (15 tests) + the existing
`omiGoldenSearchSuite` pins cover the review's seven named cases:

| Case | Pinned by |
|---|---|
| two sources agree | golden suite (3 independent domains, 45 medals, no conflict) |
| two sources disagree | golden suite (45/37/39 with per-claim evidence) |
| authoritative vs weak | golden suite + this file (basis `authoritative-newest`, set-aside reasons) |
| old authoritative vs new weak | this file (older official 45 beats newer weak 46; PLUS newest-of-two-authoritative resolves with "older than the selected authoritative reading" set-aside) |
| arithmetic contradiction | **new** — gold 12 + silver 18 + bronze 16 = 46 contradicts a claimed 48 total; contradicted reading demoted below a consistent older rival, in every input order |
| missing figures | golden suite (numeric question, zero extractable figures → CLAIM-VERIFICATION fails) |
| 3+ conflicting values | **new** — 3-way and 4-way splits, authority beats two weak rivals, ALL SIX input permutations resolve identically, every value tracked |

### 5. SearXNG fallback pin

Multi-base fallthrough with health-memory skip + one recovery dial, fan-out
continuation on `Promise.allSettled`, honest readiness reporting, and the
refusal contract (`NO_VERIFIED_RESULTS` + `searchBlock = ""` + memory protection
— never fabricate) are pinned in the new regression file. Combined with the
resilience/self-host/strict-vertical suites, the fallback chain is
machine-checked end to end.

### 6. Live verification (this round, real chat path)

- **F1 full turn (`currentInfoProbe:runOne`)**: **pass** — Antonelli leads the
  2026 drivers' championship, 302 pts, ahead of Russell; authoritative set
  (destinationformula1.com, thespread.com, formulaonehistory.com), 7 fresh
  results, SearXNG **and** LangSearch contributed, zero failed engines.
  Evidence: `.qa-tmp/f1-probe-phase6b.json`. The earlier run in the same round
  (`.qa-tmp/f1-probe-phase6.json`) was a correct REFUSAL while lumy.live was
  timing out — fresh pool had no F1 content (badminton/NASCAR rejected by the
  wrong-competition/off-topic gates), and per the review contract, unverifiable
  ⇒ refuse, never fabricate.
- **Retrieval plan**: official-source angle first (`f1-trace-phase6b.json`).
- **Candidate probe**: 12 public instances probed; 1 serves JSON (flapping);
  the rest HTML-only/403/429 — `.qa-tmp/searxng-candidates-phase6.json`.
- **Health snapshot**: persisted per-engine aggregation live
  (`.qa-tmp/engine-health-snapshot2.json`).

### 7. Gates

1,403 tests / 0 fail (72 files, +16 this round) · tsc 0 errors · eslint 0 errors
(5 pre-existing warnings) · deployed 20:55 UTC.

**Final verdict for this phase: see FINAL VERDICT at end of file.**

---

## Addendum 5 — ANSWERABILITY FLOOR + question-type engine (a504ac2 review, 2026-09-29)

**Measured failure:** "Who is leading the F1 2026 drivers championship?" still
selected "Kim Kardashian's F1 Dream Gets Lewis Hamilton's Approval"
(realitytea.com) at the SELECTION layer — fresh (yesterday), dated,
entity-matching (F1 + Hamilton in snippet), and utterly incapable of answering
a standings question. Root cause: no dimension of the 8-dimension score asked
"can this page actually support the answer?" — only "is it about the topic?"

### The engine change (production pipeline, not benchmark)

1. **Question-type extraction** (`questionTypeFor`): ranking / result /
   live-score / value / schedule / explanation / procedure / news / general,
   read from the USER's interrogative frame (not the rewritten retrieval
   string, which strips it).
2. **Per-type evidence vocabulary** (`ANSWERABILITY_RE`): a page must carry
   the KIND of content that can answer the question — leader/standings/points
   evidence for a ranking question, result vocabulary for a "who won" question,
   price/rate tokens for a value question. Measured subtlety: bare "ahead"
   matched "ahead of the 2026 season" — the ranking rule now requires
   STRUCTURAL standings evidence.
3. **Domain-tier floor per type**: live-fact types (ranking/result/live-score/
   value) require tier ≥0.6. **Entertainment/gossip domains are floored
   REGARDLESS of text** — a gossip page can never be the trustworthy carrier of
   a current leader/score/price, even when its snippet repeats a standings
   word (measured second rerun).
4. **Hard floor in the ranking loop** (`runUniversalSearch`): answerability
   penalty ≥0.45 ⇒ rejected at selection, same mechanical shape as the noise
   floor, feed citations exempt. Freshness participates multiplicatively —
   **it can never buy answerability back**.
5. **Trace**: `questionType` published on every trace; `answerability` in every
   scoreBreakdown; `answerability` rejectionKind bucket.
6. **Wiring**: `userQuestion` plumbed to ALL production call sites — chat first
   pass + escalation, probe first pass + escalation, chat search surface, and
   BOTH traceSearch call sites (the diagnostic now exercises the real path —
   the first rerun "still kept realitytea" precisely because traceSearch was
   not wired; that gap is itself fixed).

### LIVE before/after — same query, deployed runtime (2026-09-29 ~18:30 UTC)

| Run | Selected evidence for the F1 standings query | Verdict |
|---|---|---|
| a504ac2 (before) | realitytea.com ONLY (Kim K), final 0.76 | answer-caveated over gossip |
| rerun #1 (floor live, trace unwired) | realitytea still kept (diagnostic gap) | — (wiring fixed immediately) |
| **rerun #2 (final, trace wired)** | **realitytea REJECTED at selection; 0 kept from a garbage-free candidate set of 10 F1 standings sources (motorsport.com, formula1.com, bbc.com, sillyseason…); validation verdict = refuse** | **honest refusal — no weak-source answer** |
| **probe (full chat turn + escalation)** | destinationformula1.com / formula1.com / tsn.ca / thespread.com — championship-leader coverage, all dated 09-28/29; zero entertainment/motoGP/Asian-Games sources | **pass — leader (Antonelli, 302 pts, +66 over Russell) with citations [1][2][4]** |

The trace vs probe difference is expected and honest: the trace records the
first pass (its best sources are undated standings pages the freshness window
drops ⇒ refuse), the probe runs the full turn including the escalation pass,
which finds dated leader coverage from reputable outlets.

### SearXNG (search.lumy.live) — re-measured from the runtime, not ignored

`diagnosticsSearxngDeep:probeSearxngCandidates` (12 candidates):
- `search.lumy.live` (configured): **timeout at 8 s** — instance-side outage,
  consistent with the 2026-09-27/28 measurements (DNS+TCP fine, HTTP never
  answers). Its per-base health memory keeps skipping it until TTL, so no
  other provider pays its latency; it is preferred, never required.
- 4 instances answer 200 + HTML (JSON format disabled by their operators),
  4 answer 429 (rate-limited), 1 bad certificate, **0 of 12 serve JSON**.
- Consequence: general-web breadth currently rides on LangSearch + the
  structured feeds + Wikipedia-current-events; no single-provider dependence
  exists (fan-out + per-base skip + vertical backstops + noise/answerability
  floors). Self-hosting remains the real fix (`deploy/searxng/`), owner-side.

### Gates

1,387 tests / 0 fail (49 new: question-type extraction, freshness-never-
overrides, 7 golden queries × poison articles, wiring pins) · tsc 0 ·
eslint 0 errors · deployed 18:38 UTC · evidence:
`.qa-tmp/f1-trace-final2.json`, `.qa-tmp/f1-probe-final.json`,
`.qa-tmp/searxng-probe.json`, `.qa-tmp/medal-probe-final.json`.

Remaining BLOCKED (owner-side, unchanged): human browser read; SearXNG host.

---

## Addendum 4 — conflict RESOLUTION + sports source-quality gate (2026-09-29)

Per the live-review instruction: the two exposed failures (contradictory medal
totals presented without resolution; F1 championship answered solely from
realitytea.com) fixed in the PRODUCTION pipeline — not in the benchmark — and
re-proven on the deployed runtime.

### 1. Pipeline order is now RETRIEVE → FILTER → VERIFY → CROSS-CHECK → RESOLVE → SYNTHESIZE → CITE

- **CROSS-CHECK** was already first-class (`crossCheckClaims`).
- **RESOLVE is new in the answer path**: for every conflict the pipeline now
  picks ONE figure — precedence authoritative (sourceTier ≥0.85 or the
  structured sports feed) → newest → arithmetic tie-break (a reading whose own
  gold+silver+bronze breakdown sums to its total beats one without; a reading
  contradicted by its own breakdown is demoted) — each with a directly-attached
  citation, and reports every set-aside value with its reason. Two authoritative
  sources, same freshness, different values ⇒ `stillContested`, and the answer
  says explicitly that sources disagree. Contradictory numbers are never
  presented as simultaneously correct.
- **Source-quality gate (sports standings/leader/tally)**: entertainment
  domains rejected outright; AND (measured live this phase) a source that never
  names the asked competition is rejected even when it is si.com — a NASCAR
  article must not answer an F1 question. No trustworthy source survives ⇒
  `NO_VERIFIED_RESULTS` refusal, never a weak-source answer.
- **Separate checks, not "fresh+dated=correct"**: validation now runs NINE
  checks — relevance, year, event, recency, authority, corroboration,
  timestamp + NEW **consistency** (independent sources disagree ⇒ check fails,
  verdict caveated) + NEW **claim-verification** (numeric question with zero
  extractable verbatim figures ⇒ check fails). Not assessed (never failed)
  when claim extraction was not run.

### 2. Two measured defects fixed during this phase

1. **Inconsistent comparator in `resolveConflict`** — the arithmetic branch
   depended on sort-argument order, so V8 could silently ignore the arithmetic
   signal depending on array position (caught by the new unit tests before
   deploy). Fixed with an order-independent rank key
   (confirmed < unknown < contradicted, then newest).
2. **Wrong-sport carry-through** — after the entertainment gate, si.com NASCAR
   coverage was the sole survivor for the F1 question (probe `pass` with a
   wrong-sport answer). Closed with the entity requirement for non-feed sports
   sources, mirrored in the probe. Live result: honest refusal with named drop
   reasons.

### 3. LIVE before/after (deployed runtime, 2026-09-29 ~17:20 UTC)

| Check | BEFORE (aa15e55 run) | AFTER (this phase, measured) |
|---|---|---|
| F1 2026 leader — sources kept | realitytea.com ONLY | realitytea dropped (low-authority) + si.com NASCAR dropped (wrong competition); no trustworthy source ⇒ **explicit refusal, zero weak-source answers** |
| F1 2026 leader — trace | kept=1 (realitytea, final 0.76) | kept=1 first-pass; probe escalates and gates; refusal branch proven |
| Medal tally — conflict | 45/37/39 listed side by side, answer caveated, no winner | **RESOLVED: one figure — 45 cited to news.abplive.com (authoritative-newest); 37 + others set aside with reasons** (live readings 45/37/4/38/205/157 from the deployed trace) |
| Medal tally — validation | 7 checks, conflict only an unverifiable note | **9 checks: consistency=FAIL (sources disagree), claim-verification=PASS (40 verbatim figures), verdict answer-caveated** |
| New golden rows | — | F1 leader: bbc/guardian/independent/rtl/rnz (2026-09-25..29) · cricket standings: 7 kept · football standings: 8 kept · gold price: 4 kept (blockonomi/hansindia/HT) · inflation figure: 5 kept (livemint/indiatoday) — all with citation markers, 0 wrong-year, 0 dupes |
| Benchmark answer contract | citations resolve 40/40, 0 dupes, 0 wrong-year | unchanged: 40/40 resolve, 0 dupes, 0 wrong-year; offTopicKept 0→3 is the harness's SUBSTRING metric flagging borderline legitimate coverage (Guardian/RFI F1, ToI cricket) — product's semantic gate accepted them, recorded as a harness note, not a pipeline change |
| Zero-kept rows | EPL standings (first-pass-only harness limitation, user told; chat escalates and passes) | same 2 rows (EPL, ICC T20 rankings) — unchanged, still the harness first-pass limitation |

### 4. Gates

- 1,338 tests / 0 fail (suite grew: 15 resolveConflict/notice/consistency pins
  + 5 benchmark-row pins + nine-check contract updated)
- tsc 0 errors · eslint 0 errors (2 pre-existing unused imports removed)
- Deployed 17:45 UTC · evidence pack: `.qa-tmp/f1-trace-after.json`,
  `.qa-tmp/f1-probe-after2.json`, `.qa-tmp/medal-probe-after.json`,
  `.qa-tmp/medal-trace-after.json`, `.qa-tmp/bench-after.json`

### 5. Verdict delta

- Medal-conflict behaviour: **FAIL → PASS** (resolves or says "sources
  disagree"; never lists contradictions as truth; every figure cited).
- F1-from-gossip behaviour: **FAIL → PASS** (gate rejects; honest refusal when
  nothing authoritative survives; wrong-sport carry-through also closed).
- "Fresh+dated+correct" conflation: **closed** — consistency and claim
  verification are separate, individually falsifiable checks.
- Remaining BLOCKED (unchanged, owner-side): human browser read of rendered
  answers; self-hosted SearXNG host. Benchmark harness escalation mirror
  remains optional (noted in Addendum 3).

---

## RELEVANCE + SOURCE-QUALITY LAYER (2026-09-29) — freshness no longer dominates

**Final measured state (138 queries, fully-hardened pipeline):** kept 121/138
(88%) · freshnessMet 104 (75%) · kept sources 932, **77% dated** ·
**noise in kept sets: 2** (both finance, topic-relevant, final ≥0.81) ·
**non-sequiturs dropped by the broad-news floor: 14** · citations resolve
138/138 · duplicate URLs 0 · contract untouched (cache bypass, memory
protection, year/event gate, strict-vertical fallback).

Trigger: freshness was passing, but broad-news kept sets contained weak or
unrelated material — a YouTube result and evergreen "Make in India" content
for "latest news in India", an unrelated actors-workshop page for "what
happened in the world today".

The layer (`searchEngine/quality.ts`):

- **`usefulnessPenalty`** — video/social platforms, clickbait titles, and
  tag/category pages are noise. Bounded, and applied **multiplicatively**, so
  freshness cannot buy it back.
- **`sourceQualityScore`** — the authority tier discounted by that noise.
- **`scoreSourceDetailed`** — the published final score: relevance +
  freshness + authority + sourceQuality + directness (+ corroboration), ×
  temporalPenalty × (1 − usefulnessPenalty). Freshness weight is **capped at
  parity with relevance (0.32)** even for `now`-tier questions; the old
  fresh-beats-relevant inversion is gone by construction.
- **Noise floor** in the ranker: a source with usefulness penalty ≥ 0.45
  never enters the final set regardless of timestamp.
- **Breakdown persisted** on every kept citation (`scoreBreakdown`) and
  recorded by the quality benchmark (`scores` per final source), so PASS can
  be audited per component.

Measured on the full 138-query benchmark (production path, post-layer):

| Metric | Before layer | After layer |
|---|---|---|
| kept>0 | 119/138 (83–86%) | 118/138 (86%) |
| freshnessMet | 92/138 (64%) | **104/138 (75%)** |
| kept sources | 822 | 949 |
| kept sources with dates | 578 (70%) | **740 (78%)** |
| noise in kept sets (YouTube/tag/…) | 71 | **3** (all finance/science topic-relevant, scored ≥0.81) |

Contract untouched: cache bypass, enforced memory protection, future-date
protection, year/event gating, strict-vertical fallback, SearXNG + optional
LangSearch — all pinned by their suites and re-pinned by
`tests/omiRelevanceQualityLayer.test.ts` (13 tests, mutation-checked: the
noise-floor removal is caught; the additive-penalty mutation preserved all
pinned orderings and correctly passed).

## CURRENT-INFO SUITE THROUGH THE REAL PIPELINE (2026-09-29, 10/10 PASS)

`currentInfoProbe:runSuite` (the /currentinfo suite, executed via internal
action while the HTTP router flapped): **10/10 PASS**, including the Asian
Games query run through `probeCurrentInfo` — status pass, 5 raw / 4 fresh,
SearXNG **and** LangSearch both contributing, and a real cited answer:
"India now have 37 medals – 4 gold, 16 silver and 17 bronze … [1]" with
4 sources dated 2026-09-24 … 2026-09-28. Three consecutive traces of the
Asian Games query showed the fallback matrix live:

| Run | SearXNG | LangSearch | newest |
|---|---|---|---|
| 1 | timed out (0/9) | **9/9 carried it** | 24.3h |
| 2 | 9 retrieved, 2 kept | 1 kept | ~2 days |
| probe (suite) | contributed | contributed | yesterday |

## LIVE VALIDATION (2026-09-29, deployment resumed) — real chat path

Ten queries through `searchDebug:traceSearch`, which mirrors the chat turn
exactly (decide → policy → rewrite → fan-out → freshness → year/event →
validation):

| Query | raw→kept | SearXNG kept | LangSearch kept | verdict | newest |
|---|---|---|---|---|---|
| Asian Games 2026 medals (India) | 9→5 | 0 (timed out) | **9/9 carried it** | answer-caveated | 24.3h |
| latest world news | 10→7 | **6** | 1 | answer-caveated | **4.4h** |
| latest India news | 10→7 | **5** | 2 | answer-caveated | 22:59 today |
| today's technology news | 10→9 | **8** | 0 | **answer** | 14:03 today |
| current market information | 10→4 | 2 | 2 | **answer** | 20:08 today |
| latest science news | 10→5 | 2 | 3 | answer-caveated | 00:00 today |
| latest sports result | 10→5 | 2 | 3 | answer-caveated | 20:08 today |
| latest Japan news | 10→7 | **7** | 1 | answer-caveated | 19:18 today |
| latest South Korea news | 10→6 | **5** | 1 | answer-caveated | 11:24 today |
| current weather | 0→0 | — | — | **refuse (correct: no city)** | — |

Key proofs:
- **SearXNG is live in production** and carried 5–8 sources on every
  general-news query (the user's "DO NOT replace SearXNG" is honoured).
- **Fallback proven in BOTH directions with production data**: on the Asian
  Games query SearXNG timed out and LangSearch carried 9/9; on tech news
  LangSearch contributed 0 and SearXNG carried 8/9.
- **Year/event gate fired live**: an en.wikipedia.org source was dropped with
  reason `"about a different year than asked"` for the 2026 query; all 5
  kept sources are 2026-dated.
- **Dates survive normalization**: every kept source carries its publishedAt.
- **Cache bypass proven live**: two consecutive Asian Games traces returned
  different raw sets (9 then 10) — the second re-searched.
- **Benchmark (22 queries, production path)**: searxng avail 1.00, p50 583ms,
  dated 16% · langsearch avail 1.00, p50 877ms, dated 100% · mwmbl 0.91 ·
  wikipedia-current-events 0.83, dated 100%.
- Honest caveats: the Asian Games answer is `answer-caveated` (sources
  disagree on medal counts across days; no official-results authority kept) —
  the verification layer REPORTS the conflict instead of picking a winner.
  `/selftest` and `/currentinfo` over HTTP stayed gated by the flapping
  deployment router while CLI actions ran; they remain the outstanding live
  gate.

Scope: the 13-point "stabilize and prove" instruction. Everything below is
**measured**, not assumed. Where a claim could not be verified live, it says so
under **BLOCKED** — nothing is marked PASS on faith.

---

## 1. SearXNG — outage classified, NOT fixed

`diagnosticsSearxngDeep:probeSearxngCandidates` from the deployed Convex runtime
(12 instances, one 8 s probe each):

| Instance | Result |
|---|---|
| search.lumy.live (configured) | DNS resolves, TCP 443 accepts, **no HTTP response ever** — dead at client timeout |
| searx.work | broken TLS chain (`unable to get local issuer certificate`) |
| searx.be, search.inetol.net, baresearch.org, search.hbubli.cc | 200 but `text/html` — `search.formats` JSON disabled |
| searxng.site | 403 |
| search.rhscz.eu, paulgo.io, priv.au, opnxng.com | 429 (rate-limited) |
| **healthy** | **0 of 12** |

A control instance answered 200 + JSON in ~276 ms from the same runtime in the
same window, so production egress is fine. Verdict: **instance-side**, and there
is **no public JSON-enabled fallback reachable from this runtime**. The
self-host plan (`docs/SEARXNG_SELF_HOST_PLAN.md` §2) is now the only path to a
reliable breadth layer; §3 of that doc records this classification.

Reproduce:
```bash
bunx convex run diagnosticsSearxngDeep:probeSearxngCandidates '{}'
```

## 2. SearXNG resilience work retained

Total budget, circuit breaker, engine-health tracking, per-engine suspension,
partial results, timeout-does-not-widen-date-filter — all kept, all pinned by
`tests/omiSearxngResilienceRegression.test.ts`.

## 3. NEW defect found and fixed: strict-vertical dead end

The 138-query benchmark (below) exposed a structural failure the earlier
per-provider work could not see:

- A strict vertical (weather, an explicitly requested scoreline) routes to
  exactly ONE provider.
- When that provider failed — Open-Meteo 429ing, TheSportsDB empty, breaker
  open — `runUniversalSearch` threw `All search engines failed for this query`
  with **no second attempt**.
- Measured: **7 of 8 weather queries hard-failed** this way, and 6 sports
  queries too, while a direct probe had measured Open-Meteo answering
  correctly moments before. A single rate-limited feed was a total outage for
  the vertical.

Fix (`src/convex/searchEngine/resilience.ts` + `universalSearch.ts`):
- `strictVerticalFallbackFor(vertical)` returns a dated general-web backstop
  (`langsearch → wikipedia-current-events → searxng`) for weather/sports/markets.
- On the empty-merge path the orchestrator degrades **once** (guarded by
  `attemptedBackstop`) to that backstop. The answer is still never faked and
  never taken from an unrelated vertical — the backstop can only return real
  reporting about the thing asked, or nothing.
- Chat and self-test pass `verticalName` through.

Second misroute fixed in the same pass: **"history of the World Cup final" was
routed to the live scoreboard and hard-failed**, because `scoreDemanded`
matched "final" and nothing cancelled it for historical framing. Historical
framing words (`history`, `past`, `origin`, `all-time`, …) now suppress strict
score routing.

## 4. The 138-query search-quality benchmark (measured live)

`searchQualityBenchmark:runSearchQualityBenchmark` — retrieval AND answer
contract measured per query (raw → normalized → dated → kept → freshness →
relevance → answer → citations resolve):

| Category | n | kept>0 | freshnessMet | p50 ms |
|---|---|---|---|---|
| current-news | 24 | 24 | 21 | 2,984 |
| sports | 14 | 4 | 2 | 528 |
| india | 12 | 12 | 9 | 1,744 |
| finance | 12 | 11 | 8 | 2,711 |
| technology | 12 | 11 | 9 | 1,685 |
| science | 10 | 10 | 5 | 2,210 |
| multilingual | 9 | 5 | 5 | 2,545 |
| weather | 8 | 1 | 1 | 212 |
| current-events | 6 | 5 | 5 | 2,121 |
| obscure | 6 | 6 | 3 | 3,545 |
| historical | 6 | 5 | 5 | 2,197 |
| usa/europe/asia/australia/japan/south-korea | 25 | 25 | 19 | — |
| **TOTAL** | **144 rows** | **119 (83%)** | **92 (64%)** | — |

Answer-contract gates, all queries: citations resolve **144/144** ·
duplicate URLs **0** · off-topic kept **0** · wrong-year kept **0** ·
fabricated refusals **0**.

Note: the sports/weather rows were measured BEFORE the §3 fix deployed; the
re-run is pending (see §7). The fix is covered by unit + mutation-verified
regression tests in the meantime — that is stated as what it is.

## 5. Tests, suite, gates

- New suite `tests/omiStrictVerticalFallback.test.ts` (12 tests): backstop map,
  one-hop wiring, strictness preserved, historical suppression, github
  misdiagnosis pin.
- Mutation-verified: 3 mutations (drop historical guard, wrong backstop
  contents, remove one-shot guard) → all caught, files restored clean.
- Full suite: **1,230 pass / 0 fail** (65 files). Typecheck 0 errors. Lint
  **0 errors / 21 warnings** (baseline; 2 new unused-symbol errors fixed).

## 6. UI (calm-loading pass)

- `OmiSearchPanel`: live-search status line ("Searching the live web — …",
  `role=status`, one slow spinner, no bars), skeleton cards while searching so
  history does not pop, per-history timestamps (`formatDistanceToNowStrict`,
  UTC tooltip, `<time dateTime>`).
- `MarkdownMessage`: memoised — during streaming each token re-rendered the
  whole list and re-parsed every completed message's markdown; long threads
  were getting visibly choppier as the answer grew.
- Kept: fixed-height research status line, no percentage/shimmer/ladder,
  reduced-motion honoured.

## 7. Security

No provider key name is read in any frontend file (they appear only in
user-facing setup hints), no `import.meta.env` key access exists, and all key
reads live in Convex `"use node"` actions. `scripts/secretExposureCheck.ts`
remains in the suite.

---

## Verdict

**PASS**
- Env-var name rule + canonical names (tested).
- SearXNG bounded budgets, breaker, engine suspension, partial results.
- GDELT cleanly disabled by flag.
- Strict-vertical dead end fixed with honest one-hop degradation.
- Historical framing no longer routes to the live scoreboard.
- 138-query benchmark executed; answer-contract gates clean (0 dupes, 0
  off-topic, 0 wrong-year, citations resolve 100%).
- Provider-fallback matrix at unit level: SearXNG down, LangSearch
  quota/401, Mwmbl empty, HN empty, Wikipedia empty — each degrades, none
  breaks the turn.
- Keys server-side only.
- Suite 1,230/0; lint 0 errors; typecheck clean.
- Regression tests for every defect found this phase, mutation-verified.

**FAIL** (real, open)
- *Sports retrieval 4/14 kept and weather 1/8 at measurement time* — root cause
  identified and fixed in code (§3), but the re-run must prove it live before
  the numbers move. This stays a FAIL until measured green.

**BLOCKED** (cannot be done from this environment)
1. **SearXNG self-host** needs a host the owner controls (plan ready, §1).
2. **Final-answer correctness in a browser** — no browser/device session here;
   retrieval evidence is not a substitute for a human reading the answers.

---

## Addendum 3 — GOLDEN SUITE + CRITICAL QUERY (2026-09-29)

Scope per the live-validation instruction: no rebuild, no new search layer — the
deployed path was exercised and recorded. Suite extended with the missing
categories (government, statistics, tech-updates, conflict, stale-prone); 34
queries run through `searchQualityBenchmark:runSearchQualityBenchmark` against
the deployed runtime, plus the critical query through the chat turn.

### CRITICAL TEST — "What is India's Asian Games 2026 medal tally right now?"

NOT answered from memory — retrieval-first proven:
- **Fresh sources first**: 10 raw → 10 kept, 10/10 dated, 10 independent
  domains, newest 0.0 days; vertical=sports, askedEvent="asian games",
  askedYears=[2026]; searchMs 5,110.
- **Claims extracted + cross-checked**: metric "medals", readings from 3
  independent domains — 45 (rediff.com, 21h) / 37 (khelnow.com, yesterday) /
  39 (edayfm.com, ~1h).
- **Disagreement exposed, not hidden**: conflictNotice emitted verbatim ("Sources
currently report different values… Omi is not picking one") and verdict
= **answer-caveated** — the honest behaviour under a live changing tally.
- Answer cites [1]–[4] incl. Day-8 tally and 12th place; sources: rediff,
  khelnow, ndtv, timesofindia, jagranjosh, freepressjournal, india.com, edayfm.

### Golden suite — per-category results (all garbage-free)

| Category | Queries | Kept/fresh | Notable measured behaviour |
|---|---|---|---|
| Government | 5 | 35 kept, 5/5 fresh-query sets | RBI/SEBI/budget: all dated, drops explained (window×4–9) |
| Statistics | 5 | 33 kept | USD/INR routed to **market-rates provider**; gold/petrol/btc dated |
| Tech updates | 4 | 23 kept | iOS/Node/Chrome: stale-doc pages dropped by window; kept sets dated |
| Conflict | 3 | 13 kept, 3/3 fresh | medals + inflation + F1 championship: caveated, multi-domain |
| Stale-prone | 3 | 16 kept, 3/3 fresh | T20 rankings / vax schedule / COVID variant: stale sets dropped (×5–9) |
| Sports results | 15 | 77 kept | live football via feed; Asian Games ×3 variants dated; "history of the World Cup" correctly NOT freshness-gated (12 kept) |

Per-test records include: sources + domains + publishedAt + finalScores,
latency (totalMs), dropReasons with counts, provider contributions, citation
markers, refusal flag. Answer correctness is honestly marked
`NOT-MACHINE-VERIFIABLE` by the harness for prose answers.

One known limitation recorded: `current Premier League standings` returned 0
kept in this benchmark slice (single stale feed row, before escalation — the
chat turn escalates and passes; the benchmark records the first-pass view).

**Pinned by `tests/omiGoldenSearchSuite.test.ts` (14 tests):** categories exist;
critical query routes freshness-required + event/year-scoped + sports (the
anti-memory precondition); cross-check separates readings by INDEPENDENT
domain (3×same value = corroboration, 3 different = conflict with evidence,
same-domain repeat = noise); drop-reason vocabulary complete.

**Gates:** 1,320 tests / 0 fail · tsc 0 errors · eslint 0 errors · deployed
14:21. Evidence pack: `.qa-tmp/bench-*.json`, `.qa-tmp/critical-*.json`,
`.qa-tmp/golden-summary.txt`.

---

## Addendum 2 — relevance-engine PROOF (2026-09-29, post-7511c3e)

Per the "prove it, don't add features" instruction: 7 queries run through the
REAL production path — `searchDebug:traceSearch` (per-source decisions, full
score breakdowns, rejection reasons) × `currentInfoProbe:runOne` (the chat
turn). Full evidence pack: `.qa-tmp/prove/REPORT.txt`.

**All 7 PASS with zero garbage citations.** Repro: `bunx convex run
searchDebug:traceSearch '{"query":"<q>","limit":10}'` and
`bunx convex run currentInfoProbe:runOne '{"query":"<q>"}'`.

| Query | Chat | Trace kept | Notes (measured) |
|---|---|---|---|
| latest IPL news | pass | cricket/ILT20 sources only | B.Arch/NEET/gaming-hub rejected — entity anchor holds live |
| live football scores | pass | 2 live feed rows, in-play | AFCON/U21 rows survive WITHOUT literal "football" — semantic override + feed provenance |
| current Premier League standings | pass | EPL coverage, 09-28/29 | stale feed table rejected (temporal); escalation widened to general web |
| Formula 1 2026 season results | pass | GP coverage only | merch, esports, ticket-upsell pages all floored live |
| NBA standings | pass | NBA.com + NBA coverage | full fan-out fallback after dataless structured feed |
| latest India news | pass | 5 dated, 5 domains | searxng 4/5 + langsearch 2/5 contributions |
| latest world news | pass | 2 dated | mixed-provider; stale 7.4d items rejected |

**Additional defects found and fixed DURING the proof (each now pinned):**
1. `keywordSet` drops bare digits ⇒ `detectSportDomain("formula 2026 season…")`
   returned null — the semantic layer was silently OFF for F1. Motorsport query
   rule now accepts bare "formula"/"f1".
2. Roundup/listings titles ("Things To Do This Week…") — snippet entity mention
   ≠ subject. NEW `ROUNDUP_TITLE_RE` (+0.45).
3. Cross-sport title mismatch (MLB World Series for an F1 question) — demoted
   ×0.2 when the title belongs to another sport.
4. Title-entity mismatch (esports page for F1 via snippet) — demoted ×0.2.
5. Structured-feed provenance: live AFCON row has zero football vocabulary;
   `isOffTopic` now accepts `sports-scores` citations by construction (and ONLY
   those — the same text from a web engine is still content-judged).
6. Escalation merge recombination bypassed the noise floor (merch page cited
   after the fact) — both merge sites now re-apply `usefulnessPenalty ≥ 0.45`.
7. ePaper index pages, product/merch titles, commerce/ticketing upsell titles —
   floored (0.3–0.45).
8. Trace honesty: rejection reasons now distinguish wrong-year / off-topic /
   non-sequitur / freshness-promise; per-source `scoreBreakdown` +
   `rejectionKind` published on every decision; probe row carries
   `freshSplitCounts` + `droppedFresh` (proves WHICH gate refused).

**Edge-case matrix (unit-pinned, `tests/omiSportRelevanceRegressions.test.ts`):**
provider timeout & unavailability (fan-out + backstop, live-proven), stale-only
(refusal contract, live-proven), irrelevant-fresh (FINAL 0 anchor), conflicting
sources (answer-caveated verdicts live), duplicate/syndication
(`dedupeSyndication`), missing date (freshness-promise drop), malformed URL &
shorteners & spam TLDs (floored 0.55).

**Thresholds were NOT relaxed** — every fix is a new decision rule or a widened
escalation; the floors/anchors from the prior phase are untouched and
re-verified. Two additional mutation checks: semantic override disabled → tests
fail; F1-detection fix disabled → tests fail.

**Gates:** 1,306 tests / 0 fail · tsc 0 errors · eslint 0 errors · deployed 14:01.

---

## Addendum — the five f190e36 failures: root-caused, fixed, live-verified
### (2026-09-29, `tests/omiSportRelevanceRegressions.test.ts`)

| FAIL | Root cause (measured) | Fix | Live re-run |
|---|---|---|---|
| 1 — "latest IPL news" kept B.Arch/NEET/panferov-art.ru | Nothing required a source to be about the IPL; any page carrying "2026" passed the year gate. `panferov-art.ru` scored 0 noise. | **Entity anchor** in `scoreSourceDetailed`: a question naming a competition scores every source that never mentions it at FINAL 0. **Anti-garbage**: spam TLDs (`.ru`/`.top`/…), URL shorteners, malformed URLs ⇒ +0.45 penalty (noise floor). | pass — cricket sources only, all dated 2026-09-26..29 |
| 2 — "live football scores" dropped real score data | Chat-path `isOffTopic` required literal word overlap; a Premier League table page and a TheSportsDB event row never contain "football". | **Sport-domain semantic override** inside `isOffTopic`: when the question is about a sport, a source speaking that sport's result vocabulary is on-topic; unrelated pages still fail. | pass — live scoreboard with in-play scores from the structured feed |
| 3 — EPL standings answered from a 112h source | (a) chat path now drops sources older than the freshness promise; (b) refusal contract enforced; (c) escalation re-dialed the SAME narrow feed, so widening was impossible. | (a) `age <= preferFreshHours` usable filter (prior turn); (b) `shouldEscalateForFreshness` refuses stale turns; (c) **escalation widens with the vertical backstop** (`omiChat.ts` + probe mirror). | pass — general-web escalation found 3h-old standings coverage |
| 4/5 — Formula 1 / NBA: "All search engines failed ... Tried: sports-scores" | A DATALESS vertical result (`merged.length === 0` with a non-empty provider list) threw — the full fan-out retry only existed in the `providers.length === 0` guard. | New retry in the zero-merge branch: a narrowed vertical with no results re-enters the full fan-out ONCE (`attemptedBackstop`), then fails honestly if the web is silent too. | pass — F1: 5 dated sources via SearXNG+LangSearch; NBA: 5 dated sources |

**Named-query matrix (10/10 pass, `currentInfoProbe:runOne`, 2026-09-29):** latest IPL
news ✓ (2 cricket sources, dated) · live football scores ✓ (live scoreboard, in-play)
· current Premier League standings ✓ (3h-old) · Formula 1 2026 season results ✓ ·
NBA standings ✓ · latest cricket news ✓ · current IPL standings ✓ (IPL 2026 points
table) · latest Champions League results ✓ (live feed) · current NBA scores ✓ ·
latest F1 results ✓ (Azerbaijan GP results). Zero garbage sources in any set.

**Mutation checks:** disabling the entity anchor → 9 tests fail; disabling the
semantic `isOffTopic` override → 2 tests fail. Both restored clean.

**Gates:** 1,302 tests / 0 fail (26 new) · tsc 0 errors · eslint 0 errors ·
deployed 12:32.

---

## FINAL VERDICT — review round 6 (SearXNG reliability + authoritative retrieval), 2026-09-29

### PASS

1. **Authoritative retrieval, generalized (priority 3 + 4)** — F1 question routes
   through official-domain-aware retrieval (`site:formula1.com` variant dispatched
   FIRST), rejects entertainment/wrong-competition sources, prefers official and
   major-outlet evidence, and refuses clearly when only weak evidence exists.
   Full chat turn passes with authoritative leader coverage; the same machinery
   enforces per-vertical floors (0.85 sports/markets/weather/election/news) with
   official-domain hints across nine verticals.
   **Repro:** `bunx convex run currentInfoProbe:runOne '{"query":"Who is leading the F1 2026 drivers championship?"}'`
   → `status: "pass"`, leader + points + citation in `answer`.
2. **Conflict resolution (priority 5)** — architecture unchanged; all seven named
   regression cases pinned (agree, disagree, auth-vs-weak, old-auth-vs-new-weak,
   arithmetic contradiction, missing figures, 3+ values incl. 6-permutation
   order-independence).
   **Repro:** `bun test tests/omiConflictResolutionRegressions.test.ts tests/omiGoldenSearchSuite.test.ts`.
3. **Fallback + never-fabricate (priority 6)** — multi-base SearXNG fallthrough,
   health-memorized dead-instance skip with recovery dial, fan-out error
   isolation, and `NO_VERIFIED_RESULTS` refusal with memory protection when
   nothing trustworthy exists. Live-proven this round: while lumy.live timed
   out, the F1 turn REFUSED correctly rather than answering from a stale pool.
   **Repro:** `bun test tests/omiConflictResolutionRegressions.test.ts` ("SearXNG
   fallback" block) + `.qa-tmp/f1-probe-phase6.json` (live refusal evidence).
4. **Engine health (priority 2)** — all eight tracked dimensions per provider
   (engine, status, latency p50/p95, timeout rate, error rate, result count,
   relevance, freshness) + per-SearXNG-engine suspension/auto-recovery. Two
   measured gaps fixed: cold-isolate blindness (persisted telemetry aggregation)
   and the variant-cap dispatch bug. No single engine can block Andromeda
   (pinned). **Repro:** `bunx convex run searchEngineHealth:snapshot '{}'`.

### BLOCKED (owner-side, with exact steps)

1. **Self-hosted SearXNG deployment (priority 1)** — package + wiring are DONE
   and pinned; the deployment itself needs a VPS + DNS record, which only the
   owner can provision.
   **Repro to unblock:** follow `deploy/searxng/README.md` §Deploy (compose up →
   prove JSON endpoint → `bunx convex env set SEARXNG_BASE_URL <https://host>`
   and `SEARXNG_SHARED_SECRET <value>`) → then
   `bunx convex run diagnosticsSearxngDeep:probeSearxngCandidates '{}'` must
   show your instance healthy and `f1-probe` should hold the pass verdict
   independent of lumy.live's flap cycle.
   **Interim state:** public candidate pool measured (1/12 serves JSON, and it
   flaps); fallbacks + refusal path verified. Not counted as FAIL because the
   review's requirement list is implemented and regression-pinned end to end;
   only the physical deployment is outside this environment.
2. **Human QA of the Omi interface (priority 7)** — no browser/device session
   here. Checklist: `docs/HUMAN_QA_CHECKLIST.md` — results render; citations
   open; answer matches evidence; refusal messages display (test with a query
   while `SEARXNG_BASE_URL` points at a dead host); streaming works; no broken
   UI; no stale answer presented as current (check `publishedAt` on citations).

### Known, measured, accepted

- **search.lumy.live flaps** (4.9 s timeout at 20:31 → 38-result JSON at 21:0x).
  Mitigated by per-base health memory + fallbacks; permanently fixed only by
  BLOCKED item 1.
- **Benchmark-harness first-pass limitation** (EPL/ICC-T20 zero-kept rows;
  chat escalates and passes) — unchanged from Addendum 3; harness-only.
- eslint: 5 pre-existing warnings (unused eslint-disable directives), 0 errors.

### Gates at verdict time

**1,403 tests / 0 fail** (72 files) · **tsc 0 errors** · **eslint 0 errors** ·
deployed 20:55 UTC · evidence in `.qa-tmp/*phase6*`.

---

## FINAL VERDICT — round 7 (SearXNG latency + per-engine health + acceptance matrix), 2026-09-29

### PASS (pipeline-side, live-verified)

1. **Latency discipline** — ceilings TIGHTENED (15→5 s per rung, 20→10 s total,
   30→12 s fan-out slot), slow-base demotion added. Same-round live matrix:
   F1 leader 2.3 s, F1 standings 2.7 s, football 0.6 s, worst 10.8 s, zero rows
   over the slot. No global timeout was raised anywhere.
   **Repro:** `.qa-tmp/matrix-{1..8}.json` + `bun test tests/omiSearxngResilienceRegression.test.ts`.
2. **Per-engine health, all 8 contract metrics** — success rate, timeout rate,
   latency p50, avg results, freshness share, last-ok, last-fail, suspended;
   lifetime counters so rates cannot flip on one good call; suspension +
   auto-recovery unchanged and pinned.
   **Repro:** `bunx convex run searchEngineHealth:snapshot '{}'`.
3. **8-query acceptance matrix** — 8/8 pass on the real chat path, including one
   row where SearXNG itself timed out and the turn still passed (never blocks).
   Rejections, freshness, domains, dates, and answerability all verified per row.
   **Repro:** Addendum 7 §4 table + `.qa-tmp/matrix-*.json`.
4. **Refusal behavior** — unchanged and still correct (owner-confirmed).

### BLOCKED (owner-side)

1. **Self-hosted SearXNG instance** — the entire remaining blocker. Package,
   wiring, health memory, demotion and fallbacks are done and pinned; what is
   missing is a Docker host with a public DNS record, which does not exist in
   this sandbox (`docker: not found`) and has no provisionable provider in the
   integration catalog.
   **Steps to unblock (owner):** `deploy/searxng/README.md` → VPS + DNS →
   `docker compose up -d` → prove the JSON endpoint → `bunx convex env set
   SEARXNG_BASE_URL https://<host>` + `SEARXNG_SHARED_SECRET <value>` →
   `bunx convex run diagnosticsSearxngDeep:probeSearxngCandidates '{}'` →
   re-run the 8-query matrix (Addendum 7 §4) against the new instance.
   Acceptance bar: same matrix, all rows pass, SearXNG p50 < 1 s.
2. **Human QA of the Omi interface** — unchanged from round 6; checklist at
   `docs/HUMAN_QA_CHECKLIST.md`.

### Gates at verdict time

**1,409 tests / 0 fail** (72 files) · **tsc 0 errors** · **eslint 0 errors** ·
deployed 21:51 UTC · evidence `.qa-tmp/matrix-*.json`, `engine-health-snapshot3.json`,
`telemetry-recent.json`.

---

## FINAL VERDICT — round 8 (latency, config visibility, persisted engine health), 2026-09-29

### PASS

1. **Latency (Issue 1)** — global deadline (16 s, shared across escalation),
   per-provider caps, real cancellation via guardedCall timers, in-call
   fast-fail, recovery-dial rate limit. Measured: the one remaining 12.5 s
   path → 3.0 s; flap-window worst case 6.3 s with honest refusal; matrix mean
   ~2.9 s. NO timeout was increased; ceilings are unchanged from round 7.
   **Repro:** `.qa-tmp/m8-*.json` + `bun test tests/omiSearxngResilienceRegression.test.ts`
   ("global search deadline", "fail-fast" pins).
2. **Config visibility (Issue 2)** — `describeSearxSelection()` +
   persisted `searxInstanceConfig` answer exactly: which instance
   (search.lumy.live), public (not self-hosted), selected how (configured
   first, measured fallbacks after), health-checked (probe + per-base memory),
   verified (probeSearxngCandidates), and what happens when it disappears
   (fallback chain → honest refusal, pinned).
   **Repro:** `bunx convex run searchEngineHealth:snapshot '{}'` →
   `searxSelection` + `searxInstanceConfig`.
3. **Engine health (Issue 4)** — all 8 metrics per underlying engine, now
   PERSISTED across isolates/restarts and live-populated from real traffic
   (yandex ok 1.0 / p50 765 ms / dated 0.5; ddg+mwmbl timeout strikes).
   Suspension + auto-reduction unchanged.
   **Repro:** `searchEngineHealth:snapshot` → `searxEnginesPersisted`.
4. **Regression matrix (Issue 5)** — 8/8 pass with per-query
   provider/latency/results/rejected/kept/freshness/relevance/authority/
   answerability recorded (Addendum 8 §Issue-5 table + `.qa-tmp/m8-*.json`).

### BLOCKED (owner-side, unchanged)

1. **Self-hosted instance (Issue 3)** — package + wiring complete and pinned;
   needs a VPS + DNS outside this sandbox. `deploy/searxng/README.md` →
   `docker compose up -d` → prove JSON → `bunx convex env set SEARXNG_BASE_URL
   https://<host>` + `SEARXNG_SHARED_SECRET` → re-run the 8-query matrix.
   Until then production REMAINS explicitly flagged as dependent on a PUBLIC
   instance by the new config surface — the dependency is now visible, which
   is the honest interim state.
2. **Human QA** — checklist `docs/HUMAN_QA_CHECKLIST.md`.

### Known, measured, accepted

- **lumy.live flaps** (2.3 s passes interleaved with 5 s timeouts). Pipeline
  behavior in both windows is verified: pass with fresh results, or honest
  refusal ≤ 6.3 s. Permanent fix = BLOCKED item 1.
- **searchTelemetry logs 12–15 s rows from 63–66 h ago** — old pipeline, kept
  for audit; post-round-7 rows are all ≤ 10.8 s and post-round-8 ≤ 6.6 s.

### Gates at verdict time

**1,412 tests / 0 fail** (72 files) · **tsc 0 errors** · **eslint 0 errors** ·
deployed 22:47 UTC · evidence `.qa-tmp/m8-*.json`, `engine-health-r8*.json`.
