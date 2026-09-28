# SearXNG, timeout and freshness fixes — measured run (2026-09-28)

Everything below was measured against the deployed Convex runtime
(`resolute-ptarmigan-187`), not reasoned from documentation. Where a number is a
proxy or a limitation, it says so.

The brief listed seven problems. Six had a real cause in our code; one is an
upstream outage. Each is recorded with the fix and the evidence.

---

## 1. The invalid environment-variable name

**Claim:** the benchmark used `SEARCH_TIMEOUT_MS_WIKIPEDIA-CURRENT-EVENTS`.
**Finding:** that literal appeared in exactly one place — a comment in
`universalSearch.ts` documenting an earlier outage. The lookup itself was
already sanitised, so there was no live throw. But the *rule* was untestable
(it lived inside a `"use node"` action that pulls in the generated Convex API),
which is how the invalid spelling got written in the first place.

**Fix.** The rule now lives in `src/convex/searchEngine/providerTimeouts.ts`:

```
timeoutEnvVarName("wikipedia-current-events")
  === "SEARCH_TIMEOUT_MS_WIKIPEDIA_CURRENT_EVENTS"   // not a hyphen anywhere
```

`CURATED_TIMEOUT_ENV_NAMES` spells the canonical names explicitly so nobody has
to re-derive the rule, and a test asserts the map matches the function.

**Evidence.** 7 tests: the exact hyphenated id, every registered provider id
yields a legal name, illegal characters beyond hyphens, the curated map, a
garbage override is ignored, a numeric override is honoured.

---

## 2. SearXNG latency — root cause and fix

**The 46 s was ours, and it had two parts.**

1. **No total ceiling.** The adapter looped
   `for base { for attempt(2) { for range(ladder, up to 5) { fetch(30 s) } } }`.
   The worst case was 2 × 5 × 30 s of *sequential* waiting; the fan-out's own
   30 s ceiling then cut the call off mid-flight, so a provider that had already
   produced results was recorded as a timeout.
2. **Retrying a host that never answered.** A repeat request re-runs the same
   engine mix and re-waits the same timeout.

**Fix (`searchProviders/searxng.ts`)**

- A single **total budget** (`SEARXNG_TOTAL_BUDGET_MS`, default 20 s), with each
  attempt bounded by *whatever is left of it*.
- **At most two passes.** One is the common case; the second exists so a single
  transient failure on a shared instance is survivable.
- **Widening the date filter only happens after an EMPTY answer, never after a
  timeout.** A host that did not reply will not reply for `month` either.
- **`SEARXNG_TIMEOUT_MS` keeps its per-request meaning**, and the total is a
  separate knob (`SEARXNG_TOTAL_BUDGET_MS`). This mattered: re-using the old name
  as the total would have silently reinterpreted a value a deployment had
  already set.

**Measured.** A dead instance now costs a bounded **20 s**, down from an
unbounded path that the fan-out killed at 30 s. The fan-out also opens its
breaker after three failures, so later searches in the same isolate skip the
provider entirely (`SearXNG: circuit open (cooling down)` — observed).

**Still true, and not fixable in code:** `search.lumy.live` never answers.
`/selftest` reports `searxng reachability: unreachable: timeout of 15000ms
exceeded`, and the benchmark reports it as *configured but PROBED UNREACHABLE —
an outage, not a setup gap*. Self-hosting is the fix
(`docs/SEARXNG_SELF_HOST_PLAN.md`); until then the general-web floor is a
community instance that is currently down.

---

## 3. Individual engine timeouts (DuckDuckGo suspended)

SearXNG is a front for a dozen upstream engines and reports which of them failed
in every response:

```json
{ "results": [...], "unresponsive_engines": [["duckduckgo", "timeout"]] }
```

**Finding:** the adapter ignored that field, so every later request re-asked the
same suspended engine and re-waited its timeout — a latency tax with no upside.

**Fix.** `searchProviders/searxngEngineHealth.ts` records the instance's own
report per call. After two reports an engine is suspended for a cooldown, and
the next request is **scoped to the engines observed answering**, using
SearXNG's documented `!engine` search syntax. It is **fail-open**: a scoped query
that returns nothing falls through to the unscoped one, so scoping can never
turn into an empty result. Malformed payloads are ignored, never thrown on —
telemetry must not be able to fail a search.

**Evidence.** 6 tests, including a local HTTP server that answers with
`unresponsive_engines`, a third request asserted to carry the `!yandex` prefix,
cooldown expiry, a responsive engine clearing its history, and malformed
payloads.

---

## 4. GDELT — disabled cleanly

**Finding:** measured 0% availability from the Convex runtime across three
sessions. DNS resolves (7 ms) and TCP 443 is accepted (35 ms), but HTTPS never
completes — `diagnoseGdeltTls` localises it to the origin accepting the socket
and then dropping the handshake. Not DNS, not our parameters, not fixable in
code.

**Fix.** `GDELT_ENABLED = false` in `searchProviders/gdelt.ts`. It is a feature
flag, not a deletion: the adapter, tests and diagnostics stay, `ENABLE_GDELT=true`
forces it back on, and the status surface says **"Disabled by product decision"**
rather than implying someone forgot a key. An unreachable source no longer costs
every freshness-gated turn its deadline.

**Evidence.** `/status` now shows `gdelt enabled=false configured=false
ready=false`; a test asserts it is absent from `getConfiguredProviders()` and
that it is reported as *disabled*, distinctly from *unconfigured*.

---

## 5. The freshness defect the benchmark actually found

This is the one that answers "why was the answer old?" — and it was **not** a
freshness threshold.

**Measured.** For `latest world news`, the topic floor dropped the **freshest
dated source in the whole set**: a Wikipedia Current Events wire item published
**8.6 hours** earlier. Reason, verbatim from the new diagnostic:

```
dropped: shares no topic word with the question (topic words: latest, news, world)
```

The topic set was `{latest, news, world}` — **none of which is a subject.**
"Latest" says *when*, "news" says *what kind*. No wire headline contains the word
"latest". Keeping the item raises the newest surviving source from **76.6 h to
8.7 h** on that query.

**Fix (`searchEngine/quality.ts`).** `topicKeywords` now removes **aspect words**
as well as bare numbers — the same rule already applied to years ("2026" is a
scoping constraint, not a topic). Possessives are handled, because `keywordSet`
keeps the apostrophe and so `"today's"` never equalled `"today"`.

The subject words are untouched. `topicKeywords("Indian contingent medals tally
in Asian Games 2026")` still yields `indian, contingent, medals, tally, asian,
games`, so the floor still drops the page it was written for (a *"Sri Lanka
Maldives Twin Centre Holiday Package 2026/2027"*), and it turns itself **off**
when a question has no subject words left — a question we cannot characterise is
not evidence that a source is off-topic.

**Evidence.** 5 tests, including the contrast case that proves the floor still
bites.

---

## 6. A provider misdiagnosis (found by the benchmark)

`hackernews` threw a **missing-key error** when a query simply matched nothing,
so a French-language query surfaced as:

```
Search provider "hackernews" is not configured.
```

Hacker News is keyless. An empty result is an empty result — the same
misreporting already fixed once for GDELT, and a wrong diagnosis sends whoever
is debugging in the wrong direction. It now returns `{ citations: [] }`.

---

## 7. The full freshness benchmark — 10 queries, deployed runtime

Produced by the new `searchDebug:runFreshnessBenchmark`, which records raw
supply per provider, normalisation, **the reason every source was dropped**, the
kept set with each citation's own date and score, and latency.

| query | normalized | kept | newest (h) | prefer (h) | relevance (proxy) |
|---|---|---|---|---|---|
| Indian contingent medals tally in Asian Games 2026 | 10 | 5 | 33.9 | 48 | 0.92 |
| latest India news | 12 | 5 | 74.9 | 48 | 0.744 |
| latest world news | 12 | 5 | **8.7** | 48 | 0.70 |
| today's technology news | 3 | 1 | 32.7 | 30 | 0.68 |
| latest sports result | 12 | 4 | **8.9** | 48 | 0.753 |
| current market information | 12 | 7 | **8.9** | 48 | 0.757 |
| latest science news | 12 | 1 | 97.3 | 48 | 0.55 |
| current weather | 0 | 0 | — | 6 | 0 |
| dernières nouvelles France | 11 | 4 | 46.6 | 48 | 0.638 |
| Kerguelen Islands current research station status | 7 | 2 | **8.9** | 48 | 0.485 |

Per-provider supply across those runs:

| provider | runs | returned | p50 ms | raw | dated | % dated |
|---|---|---|---|---|---|---|
| langsearch | 9 | 8 | 1910 | 36 | 36 | **100%** |
| wikipedia-current-events | 9 | 7 | 3 | 28 | 28 | **100%** |
| wikipedia | 2 | 2 | 559 | 10 | 0 | 0% |
| hackernews | 6 | 1 | 0 | 5 | 5 | 100% |
| searxng | 9 | **0** | 20005 | 0 | 0 | — |
| openmeteo | 1 | 0 | 1 | 0 | 0 | — |

Single-provider benchmark (22 cases, production path, `evaluationOnly: false`):

| provider | availability | p50 | p95 | avg results | dated | relevance (proxy) |
|---|---|---|---|---|---|---|
| langsearch | 0.955 | 849 | 1348 | 4.1 | **100%** | 0.243 |
| mwmbl | 0.864 | 125 | 12004 | 4.1 | 0% | 0.526 |
| duckduckgo-instant | 0.227 | 42 | 57 | 0.8 | 0% | 0.192 |
| wikipedia-current-events | 1.000 | 0 | 219 | 4.5 | **100%** | 0.195 |
| hackernews | 1.000 | 197 | 197 | 5.0 | 100% | 1.000 |
| searxng | *unmeasured* | — | — | — | — | — |

SearXNG is reported as **"configured but PROBED UNREACHABLE — an outage, not a
setup gap"**. That distinction is the point: the previous wording sent an
operator to set an environment variable that was already set.

Two rows are correct-but-explainable, not defects:

- **`current weather` returns nothing.** The question names no location, so the
  weather provider has no coordinates to resolve. In a chat turn Omi asks for
  the city; the benchmark calls the search layer directly.
- **`wikipedia` dates 0% of results.** It is an encyclopedia, not a news feed.
  It is registered for knowledge breadth and excluded from freshness tiers.

---

## 8. End-to-end trace — the Asian Games query

`searchDebug:traceSearch`, deployed runtime:

```
Indian contingent medals tally in Asian Games 2026
  intent=knowledge  vertical=sports  years=[2026]  event="asian games"
  providersSearched = [searxng, wikipedia-current-events, langsearch]
  providersFailed   = []
  raw=10  kept=5  independentDomains=5
  contributionsByProvider = [{ langsearch: retrieved 10, kept 5 }]
  verdict=answer-caveated  passRate=0.857  failed=[authority]  searchMs=21445
```

The chain, with what each stage actually did:

| stage | what happened |
|---|---|
| RAW | LangSearch returned 10 dated results (33.9 h – 55 d). SearXNG returned **0** — it never answered. Wikipedia Current Events returned 0 for this query. |
| ADAPTER | `extractSearxDate` reads `publishedDate`, `pubdate` and `metadata[]`, and validates each by round-tripping it to a real ISO instant. A present-but-unparseable date reads as **undated**, never as a trusted date. |
| NORMALISED | 10 citations, all dated, deduped by URL with per-provider provenance (`providers: [...]` carries stable provider **ids**). |
| FRESHNESS | tier `recent` → 5-day window, escalate if the newest source is older than 48 h. |
| RANKING | freshness weight 0.22 for `recent` (0.40 for `now`), relevance 0.50; year matching penalises a different Games. |
| GATES | 5 kept, 5 dropped: 3 outside the window, 1 about a different year, 1 undated. |
| FINAL | 5 citations, newest **yesterday**, verdict `answer-caveated` (the `authority` check fails because no kept source is a first-party governing body). |

**"Why was the answer old before?"** Three compounding reasons, in order of
size: (1) on generic news questions the topical floor discarded the freshest
dated source, because the words it compared were aspects rather than subjects —
fixed, newest went 76.6 h → 8.7 h on `latest world news`; (2) the general-web
provider never answered, so supply came from LangSearch and Wikipedia alone; (3)
the retrieved set for an event query is genuinely old — the freshest Asian Games
citation available was 33.9 h, which the gate accepted honestly and the answer
labelled as "yesterday".

**Note on `[authority]`:** the verdict is `answer-caveated`, not `answer`. That
is correct behaviour, not a bug — the evidence is dated and on-topic but no
kept source is an official results body.

---

## 9. Gate status

| gate | result |
|---|---|
| `/selftest` | `ok` — 21 pass / 0 fail / 6 configured |
| `/selftest` → current information | **10/10** scenarios returned fresh, dated evidence |
| `/selftest` → searxng reachability | `configured` — *unreachable: timeout of 15000ms exceeded* |
| `/status` → andromeda | 18 registered, 17 enabled (GDELT off), 16 ready |
| test suite | **1218 pass / 0 fail**, 64 files |
| lint | 0 errors |
| typecheck | 0 errors |

Every regression test added here was **mutation-tested** — reintroducing the bug
it guards must fail it. All 8 mutations were caught (raw-id env names, engine
failures not accumulating, ignoring `unresponsive_engines`, dropping date
parsing, re-enabling GDELT, treating undated as fresh, removing the bounded
retry pass, collapsing the two timeout knobs).

---

## 10. What is still open — the honest list

- **No browser or device QA.** Everything above is retrieval, gating and
  ranking evidence. Whether the medal tally is *correct* is unverified. This is
  still the binding constraint on calling Omi production-ready.
- **The general-web floor is down.** `search.lumy.live` does not answer within
  15 s. Until a self-hosted instance exists, general-web breadth comes from
  community instances that flap. Searching is carried by LangSearch and
  Wikipedia Current Events.
- **A dead provider costs a bounded 20 s.** The fan-out is parallel, so this
  sets the floor of search latency on turns where SearXNG is in the routing
  list. Self-hosting is the real fix.
- **Relevance is still the weakest signal.** `relevanceProxy` 0.243 for
  LangSearch; the Asian Games answer keeps a Maldives holiday page on some runs.
  The topical floor catches only zero-overlap; ranking on a lexical proxy cannot
  tell a good answer from a plausible-looking wrong one.
- **`latest science news` and `today's technology news` do not meet their
  preferred freshness.** Their freshest available evidence was 97 h and 33 h
  against a 48 h/30 h preference. Reported, not hidden.
- **LangSearch is still a reseller on a daily token allowance.** It is enabled
  and it supplied 100% of the kept citations in these runs, which makes it
  load-bearing in practice. It must not become a single point of failure — the
  circuit breaker and the other providers are what hold that line.
