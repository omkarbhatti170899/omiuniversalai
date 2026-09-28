# Andromeda Stabilize-and-Prove Run — 2026-09-28

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
1. **Convex deployment is PAUSED at the platform level** ("Cannot run functions
   while this deployment is paused"). Blocks: live re-run of weather/sports
   clusters, the Asian Games end-to-end trace, `/selftest`, `/currentinfo`.
   Owner action: Dashboard → deployment → Settings → **Resume**, then:
   ```bash
   bunx convex run searchQualityBenchmark:runSearchQualityBenchmark '{"categories":["weather","sports"]}'
   bunx convex run searchDebug:traceSearch '{"query":"Indian contingent medals tally in Asian Games 2026","limit":10}'
   curl -s https://resolute-ptarmigan-187.convex.site/selftest | head -40
   ```
2. **SearXNG self-host** needs a host the owner controls (plan ready, §1).
3. **Final-answer correctness in a browser** — no browser/device session here;
   retrieval evidence is not a substitute for a human reading the answers.
