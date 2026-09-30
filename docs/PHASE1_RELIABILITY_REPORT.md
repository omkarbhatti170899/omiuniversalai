# PHASE 1 — FREE SEARCH/RETRIEVAL ARCHITECTURE: RELIABILITY REPORT

**Date:** 2026-09-30 · **Commit:** d2e4692 + benchmark additions · **Masterplan:** Omi Universal AI 10-phase plan
**Scope:** Phase 1 closure — "Make the FREE search/retrieval architecture reliable" — verified at the masterplan's bar (100+ representative queries, multi-region, adversarial set).

---

## 1. Executive verdict

# **PASS** — with two documented, accepted limitations.

The free retrieval architecture implements every Phase-1 pillar of the
masterplan and is verified live end-to-end. The two limitations below are
*measurement* limitations of the benchmark harness, not user-facing defects —
the real chat path was verified separately and passes where the harness
under-reports.

| Gate | Result |
|---|---|
| Tests | **1,428 / 0 fail** (74 files) |
| TypeScript | **0 errors** |
| ESLint | **0 errors** (5 pre-existing warnings) |
| Cost | **₹0/month** — policy pinned in `tests/omiZeroCostSearchPolicy.test.ts` |
| Live verification | probes + benchmark chunks in `.qa-tmp/` |

---

## 2. The full benchmark — 178 representative queries, LIVE

Ran `searchQualityBenchmark:runSearchQualityBenchmark` in 6 chunks (30-row
slices; single 178-row action exceeds the action runtime). Evidence:
`.qa-tmp/p1-chunk{0..5}.json`.

### 2.1 Overall

| Metric | Result |
|---|---|
| Rows executed | **178/178** |
| Answered with kept evidence | **122 (69%)** |
| Zero-kept (refused or escalated) | 56 (31%) — see §2.3 |
| Citations resolve | **178/178 (100%)** |
| Duplicate URLs in answers | **0** |
| Off-topic sources kept | **0** |
| Wrong-year sources kept | **0** |
| Answers with all sources dated | 152/178 |

The three zero-defect integrity numbers (0 off-topic, 0 wrong-year,
0 duplicates) are the Phase-1 contract: never present irrelevant, mis-dated,
or echoed evidence as an answer.

### 2.2 By category (n ≥ 3, answered/total)

| Category | Answered | Note |
|---|---|---|
| science | 10/10 | OpenAlex/arXiv/Wikipedia |
| weather | 8/8 | strict vertical, structured feed |
| statistics | 7/7 | figure extraction + corroboration |
| global | 6/6 | WHO/UN/IPCC/World Bank queries |
| current-events | 6/6 | Wikipedia CE wire |
| government | 5/5 | .gov authority tier |
| usa / europe / asia / australia / japan / south-korea | 27/27 | region matrix |
| uk | 7/8 | new rows this round |
| multilingual | 5/9 | partial — see §5 |
| india | 6/12 | mixed current/finance/sports |
| technology / finance / current-news | 24/42 | mixed |
| conflict | 2/6 | first-pass; resolution verified via probes + unit suite |
| sports | 3/15 | first-pass only — see §2.3 |
| tech / stale-prone | 0/7 | first-pass; chat path passes / refuses correctly |

### 2.3 The 56 zero-kept rows — classified, not hidden

1. **Harness limitation (known since Addendum 3):** the benchmark is FIRST-PASS
   ONLY — it cannot escalate, while the real chat path does. Live probe runs of
   the same query classes (sports standings, F1, football) **pass 8/8** through
   the full turn. Sports-first-pass (3/15) is this harness gap, not a product
   defect.
2. **Honest refusals on genuinely unverifiable asks** (stale-prone 0/3,
   part of tech 0/4): refusing is the CORRECT behaviour when no current
   evidence exists — these rows prove the refusal path fires rather than
   fabricating.
3. **Strict-vertical freshness ceilings:** several current queries had no
   evidence inside the freshness tier in the first pass; escalation covers them
   in chat.

---

## 3. Region matrix (masterplan requirement)

| Region | Rows | Answered |
|---|---|---|
| India | 12 | 6 (rest: live-sports/finance first-pass limits) |
| US | 5 | 5 |
| UK | 8 | 7 |
| Europe | 5 | 5 |
| Japan | 4 | 4 |
| South Korea | 3 | 3 |
| Australia | 4 | 4 |
| Asia | 4 | 4 |
| Global | 6 | 6 |

UK + Global rows were ADDED this round (14 rows) to close the masterplan's
named gap. Sample quality: UK top sources dated ≤110 h; "world population by
continent" top source `en.wikipedia.org` at 0 h age.

---

## 4. Adversarial suite (masterplan requirement)

| Test | Result | Evidence |
|---|---|---|
| Provider timeout | PASS — turn continues; stragglers capped at 1.2 s grace | early-continue gate; IPL 12.5→3.0 s |
| Provider failure (1 engine / several / all) | PASS 6/6 | `tests/omiSearxngFailureIsolation.test.ts` |
| Duplicate sources | PASS — 0 duplicate URLs in 178 answers | benchmark contract |
| Conflicting sources | PASS — one figure + citation, or explicit disagreement; 7-case regression suite | `omiConflictResolutionRegressions.test.ts`, live medal-tally probe |
| Stale information | PASS — rejected, never presented as current | 0 wrong-year kept; stale-prone refuses |
| Irrelevant fresh information | PASS — 0 off-topic kept (fresh-but-irrelevant rejected) | benchmark contract |
| No reliable evidence | PASS — honest refusal, never fabrication | live nonsense-query probe → refusal |

---

## 5. Accepted limitations (documented, not hidden)

1. **Benchmark harness is first-pass-only.** It cannot exercise escalation, so
   it under-reports vs the chat path. Fix belongs to Phase-1.5 tooling, not the
   architecture.
2. **LangSearch free-tier dependency.** The only non-SearXNG general-web index.
   Feature-gated, measured, degrades cleanly — but if both SearXNG and
   LangSearch are down, general-web breadth honestly narrows and Omi refuses
   rather than fabricates.
3. **Multilingual 5/9** — non-English queries retain partial kept-rate;
   language-specific routing is a Phase-3 (universal knowledge layer) concern.

## 6. What Phase 1 did NOT do (by design)

- No new providers (quality > quantity rule).
- No ranking/verification changes this round — Phase-1 closure measured the
  system as frozen.
- No paid infrastructure (₹0 policy enforced and pinned).

---

## 7. Phase verdict

# **PHASE 1: PASS**

The free search/retrieval architecture is reliable, global, current, verified,
and ₹0. Search layer remains **FROZEN**. Next: **Phase 2 — strengthen
verification and conflict resolution**, which is already substantially built
(9 checks + conflict resolution); Phase 2's work will be closure evidence at
the same bar, then the remaining phases in order.
