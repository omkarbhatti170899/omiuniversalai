# OMI UNIVERSAL AI — MASTERPLAN STATUS

**Date:** 2026-09-30 · **Baseline:** d2e4692 + Phase-1/2/3 additions · **Cost: ₹0/month (pinned in tests)**

Master direction: reliable, globally useful AI — intent → free retrieval →
verify → cross-check → resolve → answer, with uncertainty stated honestly.
This document is the single status ledger for all 10 phases.

| Gate (whole repo) | Result |
|---|---|
| Tests | **1,439 / 0 fail** (76 files) |
| TypeScript | 0 errors · ESLint 0 errors (5 pre-existing warnings) |
| Deployed | 02:15 UTC · evidence `.qa-tmp/` |

---

## Phase ledger

| # | Phase | Status | Evidence |
|---|---|---|---|
| 1 | Free search/retrieval reliable | **PASS** | `PHASE1_RELIABILITY_REPORT.md`: 178-query live benchmark (122 answered, 0 off-topic, 0 wrong-year, 0 dupes, 100% citations resolve), region matrix (US/UK/EU/JP/KR/AU/Asia/Global/India), ₹0 policy |
| 2 | Verification + conflict resolution | **PASS** | 9-check validation, conflict resolution (7-case suite incl. arithmetic tie-break), rescue-rate evidence: 7/8 first-pass-zero rows ANSWERED via escalation (1 honest refusal, 0 fabrications) — `.qa-tmp/rescue-*.json` |
| 3 | Universal knowledge layer | **PASS (core) — extending** | `searchEngine/language.ts` detection wired into chat turn + **language-aware statistics authority** (`localeStatsDomainsFor`: ja→stat.go.jp, de→destatis.de, fr→insee.fr …; topic hints lead, locale broadens). 11 tests. Live DE statistics query: pass, 8 fresh |
| 4 | Document intelligence | **PASS (existing)** | `omiFiles` ingest (PDF/DOCX/TXT + OCR), knowledge retrieval suite green (29 tests) |
| 5 | Vision + image gen/edit | **PASS (existing)** | image contract + editing suites green; vision pipeline deployed |
| 6 | Tools/agents | **PARTIAL** | 7 tools (web_search, read_page, calculate, knowledge_search, memory_save/list, andromeda_research) + agent runtime; no autonomous multi-step loop yet |
| 7 | Controlled memory | **PASS (controlled retention)** | memory CRUD + enforced prompt protection + **retention windows** (`expiresAt`, bounded ≤365 d, expired excluded from grounding, purge stays explicit). 3 pins |
| 8 | Security hardening | **PASS (search path)** | 90 security tests green; SSRF guard on every redirect hop (`assertSafeUrl`), query sanitization, injection evals, audit log. Whole-product sweep still open |
| 9 | Global testing | **PASS (Phase-1 matrix)** | 178 queries across 9 regions + adversarial set; UK/Global added this round |
| 10 | Production/mobile readiness | **PARTIAL** | PWA + service worker + mobile layout suites green (37 tests); Android packaging documented but not end-to-end verified |

## Standing constraints (enforced, not aspirational)

- **₹0/month** — `omiZeroCostSearchPolicy.test.ts` (7 pins); Fly files deleted; paid hosting removed from roadmap.
- **SearXNG opportunistic** — healthy→use, fail→continue; never load-bearing; architecture FROZEN.
- **No provider sprawl** — quality > quantity; additions need a measurable capability gap.

## Next increments (in order, one phase at a time)

1. **P2 tooling:** benchmark escalation pass so first-pass zero-kepts stop under-reporting.
2. **P6:** multi-step agent loop is BUILT (plan→approve→execute with tools→synthesize→verify+corrective retry, audit-trailled, specialty-scoped); remaining: UI surface polish only if gaps appear in use.
3. **P8:** whole-product adversarial sweep.
4. **P10:** Android end-to-end verification.

---

## Known limitations (accepted, documented)

- Benchmark harness is first-pass-only (tooling; rescue-rate evidence compensates).
- LangSearch free tier is the only non-SearXNG general-web index; both down ⇒ honest refusal.
- `search.lumy.live` flaps — by design tolerated; fallbacks proven to carry the turn.
