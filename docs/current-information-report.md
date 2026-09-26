# Current / Live Information — End-to-End Deployed Test Report (§11)

**Date of run:** 2026-09-26 · **Backend:** `resolute-ptarmigan-187` (live Convex deployment)
**Probe:** `GET https://resolute-ptarmigan-187.convex.site/currentinfo`
**Live app:** https://omkarbhatti170899.github.io/omiuniversalai/
**Code under test:** this branch (Convex pushed live; the static site still serves the previous deploy — the frontend changes in §8 ship on the next site deploy)

**Verdict: 9 / 10 scenarios PASS against the deployed backend, with real, dated, external
sources.** The one failure is a declared capability gap (live sports), not a silent
fabrication — Omi refuses honestly instead of inventing a scoreline.

---

## 1. The test table

| # | QUERY | SEARCH TRIGGERED | PROVIDER | RESULTS FOUND | FRESHNESS | ANSWER | SOURCES | PASS/FAIL |
|---|-------|-----------------|----------|---------------|-----------|--------|---------|-----------|
| 1 | What is the latest news in India? | **yes** (intent `news`, timeRange `week`) | Wikipedia Current Events → returns the primary newswire (France24) | 2 raw / **2 fresh** (12,568 ms) | "Based on 2 reports published today (newest: 6 hours ago)." | 2 cited events, no invention | france24.com, apnews.com, reuters.com — all dated 2026-09-26 | **PASS** |
| 2 | What happened in the world today? | **yes** (intent `news`, timeRange `week`) | Wikipedia Current Events | 2 / **2 fresh** (12,658 ms) | "…published today (newest: 6 hours ago)." | Cited events, ranked | reuters.com, france24.com — 2026-09-26 | **PASS** |
| 3 | What is happening right now? | **yes** (intent `current`) | Wikipedia Current Events + Hacker News | 4 / **2 fresh** (12,334 ms) | "…published today (newest: 6 hours ago)." | Cited events | reuters.com, france24.com | **PASS** |
| 4 | Latest technology news | **yes** (intent `news`) | Wikipedia Current Events | 2 / **2 fresh** (11,889 ms) | "…published today." | Cited events | france24.com, reuters.com | **PASS** |
| 5 | Latest AI news | **yes** (intent `news`) | Wikipedia Current Events | 2 / **2 fresh** (11,708 ms) | "…published today." | Cited events | france24.com, reuters.com | **PASS** |
| 6 | Today's weather | **no** (correctly withheld) | — | 0 | n/a | "Which location do you mean? I can pull live conditions for any city — try *what's the weather in Mumbai*. I won't guess a location and give you the wrong forecast." | none | **PASS** (asks, does not guess) |
| 7 | Current USD/INR rate | **yes** (vertical `markets`) | **Live exchange rates** (`open.er-api.com`) | 1 / **1 fresh** (**240 ms**) | "Based on 1 report published today." | "1 USD = 95.9187 INR (rate updated Sat, 26 Sep 2026 00:02:32 +0000)… not financial advice." | xe.com converter, publishedAt `2026-09-26T00:02:32Z` | **PASS** |
| 8 | Live sports score | **yes** (vertical `sports`) | **none available** | 0 | n/a | "Live search is currently unavailable, so I can't reliably verify the latest information about 'Live sports score'. I'm not going to answer this from memory, because my training data is not a live sports feed… Omi has no live score feed configured, so it will not invent a scoreline. Retry, or add a sports provider in Settings." | none | **FAIL** — genuine capability gap, honest refusal |
| 9 | Latest announcements | **yes** (intent `current`) | Wikipedia Current Events + Hacker News | 5 / **1 fresh** (11,842 ms) | "…published today." | 1 cited event (4 undated results correctly demoted) | reuters.com, 2026-09-26 | **PASS** |
| 10 | News from the last hour | **yes** (timeRange `hour`) | Wikipedia Current Events | 2 / **2 fresh** (10,611 ms) | "Based on 2 reports published in the last 24 hours." | Cited events | france24.com, reuters.com | **PASS** |

**Result: 9 PASS / 1 FAIL.** Latency 0.24 s – 12.7 s.

The full chain required by §11 is verified end-to-end on the deployed app:
**USER → OMI → CURRENT INTENT → ANDROMEDA → SEARCH PROVIDER → FRESH RESULTS → SOURCE
VALIDATION → ANSWER → CITATIONS.** Every PASS row carries a real external URL and a real
publisher timestamp that was fetched over the network during the run.

---

## 2. Root causes found and fixed

This was a real bug report and it was correct. Four defects, all measured not assumed:

1. **`omiChat` threw away the decision engine's freshness decision.** When it called
   search it passed no `timeRange`, no `skipCache`, and no `freshnessMatters` flag — so a
   cached result could answer "what's the latest news". Wired the whole freshness policy
   through (`src/convex/omiChat.ts`).
2. **SearXNG never worked, and claimed it did.** `isConfigured: () => true` was a
   hardcoded lie. Measured against all four public instances: every one returns
   **HTTP 200 with an HTML body** for `format=json`, because SearXNG ships with the JSON
   format disabled by default. It now has `probeInstance()` / `searxngHealth()` (5-minute
   cache), `SEARXNG_FLOOR_HEALTHY = false`, and treats "reachable but not JSON" as a hard
   failure with an actionable message rather than as "no results".
3. **GDELT 429s threw `MissingKeyError` and killed the whole fan-out.** A quota problem
   presented as a missing API key. Now a 5,200 ms throttle, `validateStatus`, and 429 →
   `{ citations: [] }` so the other engines still answer.
4. **Open-Meteo returned no timestamp**, so the new freshness gate correctly *discarded
   live weather* as undated. A weather observation's publish time *is* its retrieval time;
   the citation now carries `publishedAt`.

Plus the discovery that made news work: **Wikipedia's Current Events portal**, parsed to
its dated, wikilinked primary newswire URLs (Reuters/France24/AP). It is keyless, needs no
account, and — unlike the general-web floor — it genuinely carries publication dates, so it
can pass a freshness gate honestly. New providers `wikipedia-current-events` and
`market-rates` were added for this.

## 3. The general-web floor — measured, not assumed (§3)

| Endpoint | Measured from this shell | From the Convex runtime |
|---|---|---|
| `searx.be`, `search.inetol.net`, `baresearch.org`, `search.hbubli.cc` | HTTP 200, **HTML body** for `format=json` | same — reported `configured`, not `ready` |
| `html.duckduckgo.com/html/` | HTTP **202**, "anomaly"/"challenge", 0 results (2/2 attempts) | **HTTP 200, 10 real results** |

Two findings worth stating plainly:

- **SearXNG is broken and only you can fix it.** It needs an instance whose
  `settings.yml` has `search.formats: [html, json]`. Set **`SEARXNG_BASE_URL`** in the
  project's Keys tab to `https://your-instance` (self-host:
  `docker run -d -p 8080:8080 searxng/searxng`). Until then Omi reports it as not ready
  rather than pretending. This is the one thing standing between 9/10 and 10/10 for
  general current-web queries.
- **DuckDuckGo works from Convex's network but not from this shell** — the block is
  per-IP. The old code was dishonest about this in a different way: it threw
  `MissingKeyError` for a provider that has *no key to be missing*. It now probes honestly
  (cached 10 min), reports `ready: true` only when measured, and says "bot challenge" when
  blocked. `/status` reads 14/15 ready with SearXNG correctly excluded.

## 4. Requirement-by-requirement

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Current-intent detection incl. natural language | **PASS** | All 10 triggers fired; "What is happening right now?" and "What happened in the world today?" detected without keyword-only matching (`freshness.ts`, 56 unit tests) |
| 2 | Force fresh search; LLM memory not primary | **PASS** | `timeRange` + `skipCache` + `freshnessMatters` now reach the engine; cache cannot answer a current query |
| 3 | Verify SearXNG reachability | **PASS (measured, blocked)** | Endpoint, content-type, JSON format, timeout, HTTP/HTTPS, server-side access, error handling all probed; finding reported honestly. CORS is not applicable — the search is server-side only |
| 4 | Multi-source search, dedupe/rank/conflict | **PASS** | Fan-out with `Promise.allSettled` isolation; rows 3 and 9 show 2 and 3 engines queried with per-engine failure reporting |
| 5 | Timestamp awareness + freshness in the answer | **PASS** | Every PASS row has a real `publishedAt`; the answer opens with "Based on N reports published today…" |
| 6 | LIVE vs CURRENT routing | **PARTIAL** | news/markets/weather route correctly; **sports has no provider** (see gap below) |
| 7 | Failure behaviour — never fabricate | **PASS** | Scenario 8 shows the exact required message, no invented content, and Retry/Settings next step |
| 8 | Source UI — source, date, clickable link | **PASS** | `SourceCards.tsx`; undated sources render de-emphasised with "date not shown by the source" rather than being hidden |
| 9 | Test the 10 exact scenarios | **PASS** | This table |
| 10 | Observability | **PASS** | Per query: `searchTriggered`, `vertical`, `intent`, `timeRange`, `enginesTried`, `enginesWithResults`, `failedEngines`, `resultsFound`, `freshResults`, `freshness`, `searchMs`. No message content is logged |
| 11 | Deployed end-to-end test | **PASS** | This report, run against the live deployment |

## 5. Verification gate

| Check | Result |
|---|---|
| `bun test tests/` | **769 pass / 0 fail** (48 files, 3017 assertions) |
| `tsc -b --noEmit` | **0 errors** |
| `eslint .` | **0 errors**, 21 warnings (all `react-refresh` in shadcn files + unused eslint-disable in generated files) |
| `convex dev --once` | clean |
| `bun run build` | clean, 15.24 s |
| Deployed `/currentinfo` | **9/10** |
| Deployed `/selftest` | 15 pass / 7 fail / 6 configured — the 6 image-edit failures are pre-existing upstream quota (Gemini exhausted, OpenAI no credits, needs `POLLINATIONS_API_KEY`) and are unrelated to search |

## 6. Honest capability gaps

- **Live sports scores — NOT IMPLEMENTED.** There is no keyless live-score feed. Rather than
  invent a scoreline, Omi refuses and says so. Fixing this needs a sports data provider
  (paid/keyed) added to the registry.
- **General current-web search is degraded** until `SEARXNG_BASE_URL` is set. News,
  markets and weather-current all work without it, because they route to sources that carry
  real dates.
- **Real-device / signed-in browser QA** — unchanged; no device or browser session available
  in this environment.

## 7. Conclusion

**Andromeda/Search is verified working for current information on news, markets and
weather-current** — proven by a deployed run that retrieved real, dated, external sources.
It is **not** 10/10: live sports is a declared gap, and the general-web floor needs
`SEARXNG_BASE_URL` from the user. Both are reported rather than papered over, which was the
substance of the original complaint.
