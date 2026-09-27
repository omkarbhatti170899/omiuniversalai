# POST-ENABLEMENT RUN — LangSearch is ON (2026-09-27)

Companion to `PROVIDER_BENCHMARK_RESULTS.md`, which records the candidate
evaluation. This file records what happened after the owner enabled it.

## 1. What "enabled" had to mean

The instruction was to enable LangSearch for the Andromeda provider pipeline
using the existing server-side credential, without exposing it. That turned out
to be three separate facts, and the first pass delivered only the first.

### 1.1 The flag is on

`LANGSEARCH_ENABLED = true` in versioned code (`searchProviders/langsearch.ts`).

The enable flag is a **product decision, not a secret**, so it lives in code
where it is reviewable and cannot be flipped by a deploy that merely happens to
have the credential present. The `ENABLE_LANGSEARCH` environment variable
survives only as a **kill switch**, and acts *only* when set to exactly
`"false"`.

The credential itself stays server-side: the adapter reads the key from the
server environment and never from the Vite bundling path
(`import.meta.env`), so the value is never present in a browser bundle. No
value, length or prefix is logged, and it never reaches the registry, the
provider status, the health snapshot, hint text or any citation.

### 1.2 It is routed — this is where the first pass FAILED

This is the most important finding in this document.

`freshnessPolicyFor()` is what chooses engines for a freshness-gated question,
and LangSearch appeared in **no** `preferred` list. With the provider enabled,
reporting `ready: true` on `/status`, and the key present, the live query

> `Indian contingent medals tally in Asian Games 2026`

still never called it. The trace read:

```
providersSearched: ["gdelt", "wikipedia-current-events", "searxng"]
engineError: "All search engines failed for this query."
verdict: refuse
```

**An enabled provider that is routed to nowhere is worse than a disabled one**,
because the status page cheerfully reports it as ready and an operator has no
way to tell the difference. The enable flag was true, the provider was
configured, and the product was no better off.

Fixed by adding `langsearch` to the general-web backstop of every
freshness-gated vertical (news, sports, markets, election, travel, general) and
to `GENERAL_WEB_PROVIDERS`, so it also receives the rewritten retrieval
variants. It is ordered **ahead of** SearXNG in the dated lists, because it is
the one that dates its results. A question that demands an actual *score* is
still scoreboard-only: enabling a general-web index must not let a medal tally
be answered by a fixture list.

### 1.3 Its failure is harmless

See §5.

## 2. Status surface — `configured` / `enabled` / `ready` separated

`/status` previously collapsed these three into a single `ready` boolean, which
is exactly the ambiguity the provider code warns about: a provider switched OFF
becomes indistinguishable from one that is ON but missing credentials. All
three are now reported separately, alongside `requiresKey`.

```json
{ "id": "langsearch",
  "label": "LangSearch (temporary, feature-gated)",
  "enabled": true, "configured": true, "ready": true, "requiresKey": true }
```

Deployment totals at the time of writing: 18 providers registered, 18 enabled,
17 configured, 17 ready.

## 3. Benchmark, measured through the PRODUCTION path

The benchmark previously used the evaluation-only factory whenever a credential
was present, so every run reported `evaluationOnly: true` and measured an
adapter the product never actually calls. It now measures the production
adapter, and falls back to the bypass only when the production adapter genuinely
reports itself unconfigured — labelling that case honestly.

22 queries, executed in the deployed runtime:

| provider | evalOnly | avail | p50 | p95 | avg res | freshness (dated) | rel(proxy) |
|---|---|---|---|---|---|---|---|
| **langsearch** | **false** | 0.82 | 768 ms | 1095 ms | 3.8 | **100%** | 0.266 |
| mwmbl | false | 0.82 | 134 ms | 12004 ms | 4.0 | 0% | 0.506 |
| duckduckgo-instant | false | 0.23 | 43 ms | 107 ms | 0.8 | 0% | 0.192 |
| wikipedia-current-events | false | 1.00 | 0 ms | 107 ms | 3.7 | 100% | 0.195 |
| gdelt | false | 0.00 | 2042 ms | 14690 ms | 0.0 | — | 0.000 |
| hackernews | false | 1.00 | 211 ms | 211 ms | 5.0 | 100% | 1.000 |
| searxng | — | NOT MEASURED | | | | | |

**The headline number is unchanged, and is the entire reason for enabling this
provider: LangSearch publishes a date on 100% of its results.** SearXNG, at
roughly 63 results per query, dated 5% of them. The freshness gate therefore
rejects about 95% of the main general-web provider's output. The gate is
working correctly — dated source *supply* is the binding constraint.

LangSearch is a **precision complement, not a breadth replacement**. That is why
SearXNG stays registered rather than being displaced.

### 3.1 SearXNG was not measured in this run

`search.lumy.live` timed out at 15 s. The benchmark now distinguishes the two
situations that previously shared a single string:

- "not configured" — a setup task, no measurement taken
- "configured but PROBED UNREACHABLE — an outage, not a setup gap" — an incident

Telling an operator to set an environment variable that is already set is a
wrong instruction, and the earlier wording did exactly that. This instance
measured 0.95 availability in the previous run, so it is **flaky rather than
down** — and it remains a single point of failure for general-web breadth.

## 4. Live query — LangSearch is in the answer

`searchDebug:traceSearch` on the requested query, after the routing fix:

```
summary: [search] "Indian contingent medals tally in Asian Games 2026"
         intent=knowledge fresh=true vertical=sports years=2026
         raw=8 kept=4 stale-rejected=4 domains=4 verdict=answer-caveated

providersSearched  : ["langsearch", "gdelt", "wikipedia-current-events", "searxng"]
contributions      : [{"provider": "langsearch", "retrieved": 8, "kept": 4}]
verdict            : answer-caveated   passRate 0.857
```

Before the routing fix this same query **refused outright**. It now answers
across 4 independent domains, and **LangSearch supplied 100% of the kept
citations** — it was the only provider that returned anything the freshness
gate accepted, precisely because it dates its results.

Attribution was not previously possible, and making it possible was part of the
work:

- The trace recorded only *which engines ran*, never *which ones contributed*.
  A provider can be searched, return nothing usable, and be dropped by the gate.
  The trace now carries per-citation `providers` plus a
  `contributionsByProvider` rollup (retrieved vs kept).
- The fan-out stored each citation's provenance as the engine's display
  **label** rather than its stable **id**. Ids are the key that routing, the
  health store and the rollup all join on; a label is presentation text that can
  be reworded and is not unique.

## 5. Failure isolation

The guarantees are the circuit breaker (`guardedCall`) plus a fan-out that
settles every provider independently.

Pinned by test, for each of: 401 (revoked credential), 429 (daily token
allowance exhausted), 500, 503 —

- the failure is confined to that provider;
- it never resolves to a **silent empty result**, which would be
  indistinguishable from "nothing to report" and would let the pipeline present
  an absence of data as an absence of news;
- three consecutive failures **open the circuit**, so an exhausted allowance
  stops costing latency on every subsequent query, and a later success closes it
  again (recovery, not permanent disablement).

A `Promise.all` in the fan-out would make one exhausted provider fail the entire
turn, so its total absence in `universalSearch.ts` is asserted against the real
source rather than only through unit tests of the breaker.

## 6. Regression tests

`tests/omiLangSearchEnablement.test.ts` (15 tests) pins all three properties,
and each was mutation-tested to confirm it actually fails when the behaviour it
describes is removed:

| mutation | result |
|---|---|
| drop `langsearch` from the `general` provider list | 1 failure |
| drop `langsearch` from `GENERAL_WEB_PROVIDERS` | 1 failure |
| set `LANGSEARCH_ENABLED = false` | 3 failures |
| swap the fan-out's `allSettled` for `all` | 1 failure |

Two of these tests were themselves defective on first write and were fixed:

- The per-vertical routing test built its fixture as
  `latest ${vertical} update right now`; five of those six phrases classify as
  `news`, so four verticals were never actually exercised and the `general`
  mutation survived. The test now asserts the classified vertical *before* the
  membership claim.
- The fan-out test searched a fixed-size slice of the source, so swapping the
  settle for `Promise.all` still passed — the search simply found a later
  `allSettled` further down. It now asserts the total absence of `Promise.all`
  in the file, which is both the stronger claim and the one that cannot be
  satisfied by shifting a window.

## 7. The relevance defect this run exposed — and the fix

The trace in §4 answered the question, but 2 of its 4 kept citations were
off-topic: a "Sri Lanka Maldives Twin Centre Holiday Package 2026/2027" and a
rooftop-solar MoA. Both were **fresh**, which is exactly why they survived.

Two causes, neither of which was the enablement work:

1. On a `now`-tier question the ranker weights freshness **0.40** against
   relevance **0.28**, so a fresh page on the wrong subject outranks a relevant
   older one. That weighting is deliberate and correct — answering with
   yesterday's number is *wrong*, not merely worse — so it was not rebalanced.
2. **Nothing floored relevance.** The wrong-YEAR gate was thorough; the
   topical equivalent was simply missing, so a source could be admitted on
   authority and currency alone.

The fix is the principle those cases both turn on: **freshness is evidence of
currency, never of subject.** A page about the wrong subject is not a fresher
answer, it is a different answer.

- `topicKeywords()` — the query's keywords minus bare numbers. A year is a
  *scoping constraint*, not a topic: "2026" appears on holiday packages and
  tender notices, and matching on it is precisely how the Maldives page
  qualified.
- `isOffTopic()` — a source sharing **no** topic word is dropped outright,
  alongside the existing wrong-year drop. Matching is over title *and* snippet,
  so a generically-titled page with a relevant body still counts as evidence.

The floor is deliberately the weakest one that fixes the observed defect. A
stricter threshold was rejected: inflection and paraphrase ("medal"/"medals",
"tally"/"medal count") are routine in real headlines, and a threshold tuned on
one query silently drops legitimate evidence on the next. It is also a no-op
when a question has no topic words, because a question we cannot characterise
is not evidence that a source is off-topic.

The chat path matches on the **user's** words rather than the rewritten
retrieval string — the rewriter appends "today"/"latest", which describe *when*
rather than *what*, and matching on those would let any fresh page through and
reintroduce the same defect in a subtler form. The diagnostic applies the
identical filter, because a trace that disagrees with production is worse than
no trace.

### Live result after the fix

Same query, same run shape: `kept=5 domains=5 verdict=answer-caveated`, and
every kept citation is now on-topic — "India's medal tally after Day 6",
"India Medal Tally, Results & Highlights", "India look to add to medal tally".
The 5 dropped results are all **undated** highly-relevant pages (NDTV, India
Today, Indian Express medal-tally pages), correctly rejected by the freshness
gate — which is the dated-supply constraint of §3 showing up again, not a
ranking fault.

`tests/omiOffTopicRelevanceRegression.test.ts` (11 tests) pins this, each
mutation-tested:

| mutation | result |
|---|---|
| `isOffTopic` always returns false | 2 failures |
| `topicKeywords` keeps bare numbers | 4 failures |
| chat matches on the rewritten `retrieval` | 1 failure |
| chat stops calling the floor | 1 failure |
| diagnostic stops calling the floor | 1 failure |

The fourth of these initially **survived**: the test asserted the helper was
*imported*, and replacing the call with `true &&` left the import intact. It now
asserts the call.

## 8. Honest limits of this run

- **Answer correctness is still unverified by a human.** Every number in this
  document is retrieval and gating evidence. Nobody has read the answer in a
  browser and confirmed the medal tally is actually right. That remains the
  outstanding QA gap, and it is the binding constraint on calling Omi
  production-ready.
- **LangSearch's measured `relevanceProxy` is 0.266** — still low as a provider
  statistic. The §7 floor stops non-answers reaching the answer, but it does
  not make the provider's retrieval precise; the statistic reflects lexical
  overlap only and is not a quality verdict either way.
- **Dated evidence remains scarce.** Five on-topic medal-tally pages were
  dropped purely for lacking a publication date. The engine is choosing
  correctly; the open-web supply of *dated* reporting is the constraint.
- **The free tier is a bounded trial, not a foundation**: a daily token
  allowance resetting at 00:00 UTC, on a paid reseller whose upstream is
  Tavily / Exa / Brave, with paid plans from $30 per 4,000 credits. Keep it
  behind the kill switch and re-evaluate if usage grows.
- **Multilingual coverage is unverified** — not measured either way.
- **gdelt remains at 0% availability** from the Convex runtime across three
  separate sessions. Operational, not a code defect.
- **The secondary AI provider (Gemini) began timing out** at 20 s on
  `/selftest` late in this run, taking the suite to `degraded` / 1 fail. The
  primary provider (Groq) answers in ~380 ms. No AI provider code was touched
  by this work, so this is external degradation of that upstream rather than a
  regression here — but it is real, it recurred across repeated probes, and it
  means the AI fallback path is currently unverified.

## 9. Gate status at the time of writing

- `/status` — 18 enabled, 18 configured, 18 ready; LangSearch true on all three.
- `/currentinfo` — 10/10 scenarios pass, with LangSearch appearing in
  `enginesWithResults` for the news scenario.
- `/selftest` — `degraded`: 20–21 pass, 1 fail, 5–6 configured. The single
  failure is the secondary AI provider timeout described in §8, not a search
  defect; SearXNG is reported as unreachable rather than silently counted as
  working.
- Unit suite — 1182 pass, 0 fail across 63 files.
- Lint — 0 errors.
