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

## 7. Next step this benchmark implies

Add **self-hosted SearXNG** to the harness as a first-class measured provider, re-run, and only then decide the general-web ordering. Until then the comparison is incomplete — and an incomplete comparison is not a basis for choosing a provider.
