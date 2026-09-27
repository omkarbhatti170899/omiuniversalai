# Andromeda — Provider Benchmark Results

**Date:** 2026-09-27
**Harness:** `scripts/providerBenchmark.ts` (re-runnable; every number is measured at run time)
**Scale:** 51 queries × 5 providers, across the 11 required categories
**Rule observed:** no provider is declared superior without the evidence below.

---

## 1. Per-provider results (measured)

| provider | n | availability | timeout rate | p50 ms | p95 ms | avg results | **fresh %** | relevance (proxy) | avg snippet |
|---|---|---|---|---|---|---|---|---|---|
| **mwmbl** | 51 | **98%** | 0% | 182 | 606 | 4.6 | **0%** | 0.659 | 118 |
| **duckduckgo-instant** | 51 | 22% | 0% | 74 | 97 | 0.9 | **0%** | 0.158 | 54 |
| **wikipedia-current-events** | 5 | 100% | 0% | 0 | 148 | 2.0 | **100%** | 0.000* | 89 |
| **gdelt** | 15 | **0%** | 13% | — | 12001 | 0.0 | 0% | 0.000 | 0 |
| **hackernews** | 5 | 100% | 0% | 209 | 214 | 5.0 | **100%** | 0.820 | 97 |

\* **The 0.000 relevance for wikipedia-current-events is a proxy artefact, not a quality verdict.** It returns today's dated headlines whose titles are generic ("2026 — Wikipedia"), so lexical overlap with the query is legitimately ~0. The provider is the best *dated* source in the set. This is precisely why the relevance column is labelled a proxy and must not be read as a ranking.

---

## 2. What the numbers actually say

### Mwmbl — the strongest free provider measured, with one disqualifying limit
- **98% availability, 0% timeouts, p50 182 ms, p95 606 ms.** It is the fastest and most reliable free general-web source tested, and it is genuinely independent (own index, AGPL, non-profit, official keyless API — no scraping, no paid tier).
- **BUT: 0% freshness. It returns no dates at all.** Measured on the live API — the payload contains only `url`, `title`, `extract`, `source`.
- **Consequence:** it is registered for breadth and is **excluded from every freshness tier**. An undated source cannot answer "latest". This is now enforced by test, not by convention.

### DuckDuckGo Instant Answers — the official integration is real, and it is not search
- **22% availability across the 51 queries.** It answers entity questions and returns nothing for real search queries. Verified directly: `"climate change"` → Wikipedia abstract; `"best crm software"` → **0 results, empty abstract**.
- It is the **official, documented, keyless** API, so using it is permitted (unlike the consumer-SERP scrape previously removed). It is honest as an encyclopedic supplement and useless as a web index.
- **0% freshness** — Instant Answers carry no date, so it too is excluded from freshness tiers.

### GDELT — **this is an operational problem, and it needs a human**
- **0% availability across 15 queries, 13% timeouts, p95 = 12 001 ms.** Measured twice, separately, ~30 minutes apart.
- GDELT is the **primary open news provider** for current information. It being down means the freshness-critical path is currently leaning on `wikipedia-current-events` and `hackernews` alone.
- **This is a live upstream condition, not a code defect.** The fix (`describeGdeltFailure`) changed only how the failure is *reported*.

### The two providers that carry freshness are both 100% fresh
`wikipedia-current-events` and `hackernews` are the only sources in the set that returned dated results, and both are free/open. This supports the free-only strategy: **the freshness-critical verticals are carried by specialised open-data providers, not by general web search.**

---

## 3. Benchmark-driven bug found

The benchmark surfaced a real defect that the happy-path suite had missed:

**GDELT reported every upstream failure as a missing API key.** A 15-second network timeout surfaced as:
```
MissingKeyError: Search provider "gdelt: timeout of 15000ms exceeded" is not configured.
```
GDELT is keyless. The message told a user to go and add an API key that does not exist, while the actual fault was availability. A wrong diagnosis sends debugging in the wrong direction — and it is the same class of misreporting this codebase had already fixed once for DuckDuckGo.

**Fixed:** failures are now classified as availability problems. Covered by 3 deterministic tests via the exported `describeGdeltFailure` (no network dependency).

---

## 4. Comparison limits — read before quoting any of this

1. **Rows are not directly comparable across differently-scoped providers.** GDELT and Hacker News ran only their scoped categories (15 and 5 queries); Mwmbl and DDG ran all 51. Different query sets, different difficulty.
2. **"Availability" means "returned ≥1 result", not "returned correct results".**
3. **Relevance is a lexical-overlap proxy.** It cannot detect a plausible-but-wrong answer. A high score is **not** evidence a provider is better for current information.
4. **n is small for the scoped providers** (5 and 15). Those rows are directional, not conclusive.
5. **Single run, live network.** Upstream conditions vary — GDELT's 0% is a snapshot of a degraded moment, and SearXNG's community instance flaps by design.
6. **No human judged any result for correctness.** That judgement has not been made and is not claimed.

---

## 5. Conclusions that the evidence supports

| Claim | Evidence |
|---|---|
| Mwmbl is the best *general-web* free provider measured | 98% availability, 0% timeouts, p95 606 ms over 51 queries |
| Mwmbl cannot serve freshness | 0% dated results; no date field in the API payload |
| DDG Instant Answers is not a search provider | 22% availability; 0 results on real search queries |
| Specialised open-data providers carry freshness better than general web | the only 100%-fresh providers are wikipedia-current-events and hackernews |
| GDELT is currently unavailable | 0% availability measured twice, ~30 min apart |

## 6. What the evidence does NOT support

- That Mwmbl is "better than" SearXNG — **SearXNG was not in this benchmark.** It is category-scoped out of the harness because it needs a configured instance. **That is a real gap: the production general-web provider is unmeasured here.** It should be added before any provider is chosen.
- That any provider is "superior" overall. Two free providers are not a ranking.
- Any claim about answer correctness.

---

## 7. LangSearch — investigated, adapter built, NOT yet benchmarked

**Status: adapter built and feature-gated. No performance claim is made, because none has been measured.**

### What LangSearch is (verified against its own docs, 2026-09-27)

| Question | Finding |
|---|---|
| Official API? | ✅ `POST https://api.langsearch.com/v1/web-search`, bearer auth. Verified live: a bad key returns a structured `{"code":"401",...}` in ~770 ms |
| Free quota | ✅ Free plan, **$0/month**; input and output tokens both **$0 per million**. Bounded by **RPS / TPM / TPD** (a daily token allowance resetting at 00:00 UTC) |
| RPS / TPM | ✅ **5 RPS** for new accounts; TPM is a rolling 60-second window; no separate requests-per-minute/day quota — the binding constraint is **tokens** |
| API stability | ✅ Good first impression: structured JSON errors, `log_id` on every failure, documented `Retry-After` behaviour |
| Freshness behaviour | ✅ **The strongest of any candidate.** Returns `datePublished` per result, and `freshness` accepts `oneDay`/`oneWeek`/`oneMonth`/`oneYear`, a **single UTC date**, or an **inclusive date range** |
| Multilingual | ⚠️ Not stated. Unverified |
| Full page extraction | ✅ `contents.text` — 5 000 chars default, configurable per result |
| Source URLs | ✅ Real source URLs per result, explicitly documented as the thing to retain for citations |
| Date filtering | ✅ Yes, including exact dates/ranges. Docs correctly warn it "uses source metadata, not a guarantee that a page was crawled during that window" |

### The material caveat — it is a reseller, not an index

**Its pricing page publishes the upstream rates it resells**: Tavily basic search at **$8/1k**, plus its own "advanced" multipliers, with references to Exa and Brave. Paid monthly plans exist ($30 / 4 000 credits upward).

Two consequences, and they point in opposite directions:

1. **It is not the same compliance problem as scraping.** Reselling a *licensed* upstream API is legitimate — categorically different from the DuckDuckGo consumer-SERP scrape that was removed. Its own docs also tell integrators not to expose the key in a browser bundle.
2. **It IS a paid API in the supply chain.** The free tier is real today at $0, but it is a promotional allowance on a commercial aggregator, bounded by a daily token cap. Full-text extraction spends output tokens, so the allowance is finite. **This is a bounded trial, not a foundation** — and it does not satisfy the "no paid API in the core path" decision.

### Why it is still worth evaluating

Mwmbl and DuckDuckGo Instant both measured **0% dated results**. The only 100%-fresh providers are `wikipedia-current-events` and `hackernews`, which are narrowly scoped. LangSearch returning `datePublished` **and** accepting an exact-date filter is precisely what the freshness escalation pass needs — it currently appends a `YYYY-MM-DD` date to the query string as a crude proxy. If it measures well, that crude proxy could become a real filter.

### Implementation state

- `src/convex/searchProviders/langsearch.ts` — behind the existing `SearchProvider` interface.
- **Feature-gated OFF by default:** requires `ENABLE_LANGSEARCH=true` **and** `LANGSEARCH_API_KEY`. A key alone does not enable it, so a stray secret in production cannot switch on a metered provider.
- **Never a sole provider:** SearXNG, GDELT, `wikipedia-current-events` and Mwmbl all remain registered.
- **Key containment asserted by test:** the adapter never reads `import.meta.env` (the only Vite bundling path), reads the key only from the server environment, and the key never appears in the registry, provider status, health snapshot, hint text or any citation.
- Added to `scripts/providerBenchmark.ts`, which **refuses to report a number for it** while unconfigured.

### Why it is not yet benchmarked

`LANGSEARCH_API_KEY` and `ENABLE_LANGSEARCH` are not set, and this environment cannot set them. The benchmark prints:

```
# SKIPPED langsearch: needs ENABLE_LANGSEARCH=true and LANGSEARCH_API_KEY.
#   No number is reported for it rather than a fabricated one.
```

**No accuracy, latency, freshness or source-quality number for LangSearch exists yet.** The brief said to keep it if it materially improves current-information retrieval — that judgement requires a measurement that has not been made.

## 8. Benchmark honesty fix (found in this run)

The first run of this harness reported **SearXNG at 0% availability across 51 queries**, which would have implied the production general-web provider was dead. It was not — SearXNG simply had no `SEARXNG_BASE_URL` in that shell, so every call threw `MissingKeyError`. The harness was counting "not configured" as "failed", which is a **fabricated finding**.

Fixed: an unconfigured provider is now printed as `NOT CONFIGURED — not measured` and excluded from the table entirely. The run above shows the corrected behaviour.

**Consequence for the comparison:** SearXNG remains unmeasured. It must be run from a shell where `SEARXNG_BASE_URL` is set, or from the deployed environment, before any provider ordering is decided.

