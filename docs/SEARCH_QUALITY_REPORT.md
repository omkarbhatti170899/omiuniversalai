# Search Quality + UX Overhaul — Fix Report

**Date:** 2026-09-27 · **Trigger:** real user testing found that live/current questions could still return old or irrelevant information.
**Verdict:** treated as a **real bug**, reproduced exactly, root-caused, fixed at the orchestration layer, and locked out with regression tests.

**Omi is still NOT 100% production-ready.** The search core is materially better and measured, but the two quality gates at the end of this document are **not** fully green, and human/browser/device QA is still outstanding.

---

## 1. The reproduction (before any change)

Driven through the exact production call in `omiChat` — `decideSearch(query)` → `freshnessPolicyFor(query, decision.intent)`:

```
query                                          intent      requiresFreshness  vertical
"What is the Indian contingent medals tally
 in Asian Games 2026?"                         knowledge   FALSE              general
"What is India's medal tally in
 Asian Games 2026?"                            knowledge   FALSE              general
```

`requiresFreshness: false` means the turn **may be answered from model memory**. Two words caused it:

1. **"tally" / "medal"** is a live-data noun, but nothing in the detector knew that, so a live question looked like a static one.
2. **The year "2026"** was never read as a freshness signal. A question scoped to the current year is asking about the present, whatever verb it uses.

A second, independent defect was found later by running the real pipeline (see §5): the raw question was being sent to the engines verbatim.

---

## 2. What was changed (the fix, not a patch on the symptom)

| # | Defect | Fix | New/changed file |
|---|---|---|---|
| 1 | `requiresFreshness` missed "latest", "recent", "tally", "medal", "standings", "election results", "flight status" | A dedicated **query-intent classifier** with an explicit/implicit freshness model, live-data nouns, event + year extraction, and a past-year opt-out | `src/convex/searchEngine/intent.ts` **(new)** |
| 2 | Year detection was hardcoded `2025\|2026` and rotted | Years are extracted dynamically, and a year ≥ the current year is itself a freshness signal | `intent.ts` |
| 3 | Two lists of vertical/freshness words could drift apart | `freshness.ts` now **delegates** to the classifier; the duplicated regexes were deleted | `searchEngine/freshness.ts` |
| 4 | No election / travel routing | Added `election` and `travel` verticals with honest, non-strict providers | `intent.ts`, `freshness.ts` |
| 5 | Ranking had no notion of **which year or event** a result was about | **Event/year matching**; a confidently-wrong-year source is driven to the ranking floor, not merely down-ranked | `searchEngine/temporal.ts` **(new)**, `searchEngine/quality.ts` |
| 6 | Ranking ignored whether a source *answers* vs merely *mentions* | Added `directnessScore` (entity coverage + a concrete value) and wired it into `scoreSource` | `searchEngine/quality.ts` |
| 7 | No cross-source agreement; the model silently picked one number | **Cross-check** extracts comparable claims per source, groups them by metric, and requires ≥2 independent domains before declaring a conflict | `searchEngine/crossCheck.ts` **(new)** |
| 8 | No pre-answer validation | **Seven-check validation gate** with a conservative verdict: `answer` / `answer-caveated` / `refuse` | `searchEngine/validation.ts` **(new)** |
| 9 | No way to debug search quality | **Search debug mode** records intent, freshness reasons, every source and its fate, latency, conflicts and the verdict — with a hard no-leak contract | `searchEngine/debugTrace.ts` **(new)**, `src/convex/searchDebug.ts` **(new)** |
| 10 | The raw question was sent to the engines verbatim | **Keyword-shaped retrieval query**; the original text is still what gets validated and synthesized | `intent.ts` (`retrievalQuery`), `omiChat.ts` |
| 11 | The current search lived entirely on one flaky community instance | `duckduckgo` (already a registered, configured, keyless provider that appeared in **no** preferred list) added to the current verticals | `searchEngine/freshness.ts` |

### The freshness-first pipeline now actually in force

```
QUERY
  ↓  classifyCurrentIntent()        — is this current? why? which vertical? which year/event?
  ↓  freshnessPolicyFor()           — vertical, window, max age, providers, strictness
  ↓  retrievalQuery()               — keyword-shaped string for the indexes
  ↓  LIVE SEARCH                    — cache bypassed, year/event-aware ranking
  ↓  FRESHNESS FILTER               — undated/stale removed
  ↓  YEAR/EVENT GATE                — a source about another year is a WRONG answer, dropped
  ↓  DIRECTNESS + AUTHORITY RANK    — not "take the first result"
  ↓  CROSS-CHECK                    — independent-domain agreement; conflicts surfaced
  ↓  VALIDATION (7 checks)          — answer / answer-caveated / refuse
  ↓  ANSWER                         — grounded, dated, cites sources
```

Model knowledge can still provide **context**, but it is never the current factual source, and when verification fails Omi says so rather than filling the gap.

---

## 3. Regression tests (so this cannot come back)

`tests/omiSearchQualityRegression.test.ts` — **65 cases**, written against the **real production entry point**, not a simplified helper, because a test against a helper keeps passing while the app stays broken.

- The exact reported query: detected as current, named reasons, cache bypassed, wrong-year source rejected, correct 2026 source outranks a recent 2018 article, and **"could not verify" instead of an invented tally**.
- All 10 reported live queries require freshness.
- Implicit freshness with no time word; history (`Who won the 2016 Olympics?`) still answered from stable knowledge.
- Year/event extraction, wrong-year and wrong-event verdicts, and that an unlabelled source is left alone.
- Ranking: directness beats a passing mention; a primary source beats a content farm.
- Cross-check: conflict detected across independent domains; one domain echoing itself is **not** a conflict; no claims ≠ agreement.
- All seven validation checks, and that a critical failure refuses.
- Debug mode records everything and leaks nothing.
- The retrieval-query and `duckduckgo` fixes.

`tests/omiResearchStatusUx.test.ts` — **16 cases** for the calm UI.

**Suite: 833 → 914 pass, 0 fail** (52 files, 3467 assertions).

---

## 4. The UX overhaul (calm, fast, purposeful, stable)

| Complaint | Change |
|---|---|
| "constant moving progress bars" | The five-step ladder with a spinner is **gone**. Replaced by one fixed-height (`h-5`) line |
| "animations that restart repeatedly" | Only the **single active** step animates; everything else is a static ✓ or · |
| "no fake percentage progress" | There is no percentage and no ETA anywhere. Progress is stated as **measured facts**: "Found 12 sources", "Verified against 3 sources" |
| "layout jumping / changing heights during streaming" | Fixed-height status row + `min-h-[3rem]` reserved for streaming content |
| "jumping message bubbles" | Streaming bubble reserves its first-token height |
| "unnecessary pulsing" | Mic pulse → steady colour change. Image gallery `animate-pulse` → static placeholder |
| "spinners running indefinitely" | `final: true` always resolves to a terminal state, so nothing can spin forever |

New: `src/lib/researchStatus.ts` (pure, testable) and `src/components/workspace/ResearchStatus.tsx` (`role="status"`, `aria-live="polite"`). The backend now sends a real "Verified against N sources" patch so the UI shows a measured number, not a decoration.

---

## 5. Two further defects found by *running* the pipeline (not by reading code)

These were not in the report; they surfaced only when the real search was executed, and both would have silently produced wrong answers.

**(a) A live provider answering a different question entirely.**
`current IPL standings` routed to the sports feed, which returned *"England Cricket vs Sri Lanka Cricket"*. Those results are stamped "just now", so recency, recency-weighted ranking and the year check **all passed**. The only signal that caught it was that no source mentioned the IPL — and at the time that check was recorded but not enforced.
→ The event check is now **critical**, and the live scoreboard is excluded when no score is asked for (a medal tally is not a fixture list).

**(b) The raw question was sent to the engines.**
Measured on the same deployment, same minute:

| sent to the engines | result |
|---|---|
| `What is the Indian contingent medals tally in Asian Games 2026?` | **0 results after a 12 s timeout** |
| `Indian contingent medals tally in Asian Games 2026` | **8 results, 4 usable, 4 independent domains, 10.3 s** |

A user typing a sentence is the *normal* case, so this was silently degrading the quality of almost every current answer. It is very likely a large part of why users saw irrelevant information.

---

## 6. Verification — measured, live

**All 10 reported live queries now require freshness** (via `convex run searchDebug:classifyReported`), and the history control `Who won the 2016 Olympics men's 100m?` correctly does **not**.

The headline query, end to end on the live deployment:

```
sent to engines: 'Indian contingent medals tally in Asian Games 2026'
raw=8  kept=4  dropped(undated)=4  independent domains=4  conflicts=0  verdict=answer-caveated

 KEPT  economictimes…  24 hours ago  Asian Games 2026 Medal Tally: Full Country-wise Standings
 KEPT  indiatvnews.com  yesterday     Asian Games 2026, Day 7 LIVE: India look to add to…
 KEPT  khelnow.com      yesterday     Asian Games 2026: India's medal tally after Day 6…
 KEPT  vajiramandravi…  yesterday     Asian Games 2026 Day 7, India Medal Tally, Results
 DROP  sports.ndtv.com  undated       Asian Games 2026 Medal Tally
 DROP  firstpost.com    undated       India's medals tally at Asian Games 2026
 DROP  tribuneindia.com undated       Asian Games 2026: Poor outings for Indian contingent
 DROP  newsonair.gov.in undated       Indian Contingent for Asian Games 2026 Receives…

relevance PASS · year PASS (4 sources cover 2026) · event PASS (4 cover "asian games")
recency PASS · authority FAIL · corroboration PASS (4 domains) · timestamp PASS
caveat: "No primary or reputable source was found."
```

Real, dated, 2026, correct-event sources. No 2018 data. No invented tally. The one failure is surfaced to the user as a caveat rather than hidden.

**Gates:** build ✓ · typecheck ✓ (0 errors) · lint ✓ (0 errors, 21 warnings = baseline) · `bun test` **914 pass / 0 fail** · `convex dev --once` ✓ · authz audit **0 functions without auth** · `/currentinfo` **10/10** · `/selftest` **status ok, 23 pass / 0 fail / 5 configured** · image gen + all six edit-family ops PASS.

*Note on a transient dip:* during heavy probing the shared SearXNG instance saturated and `/selftest` briefly read 21/1. After letting it rest, the same probe returned **23/0/5**. That is a shared third-party instance, not a code regression — and it is also the honest reason a self-hosted instance is still recommended.

---

## 7. SEARCH QUALITY GATE (§16) — **PARTIAL**

| Requirement | State |
|---|---|
| current queries detect freshness | ✅ **VERIFIED** — including implicit cases, all 10 reported queries |
| current queries search live sources | ✅ **VERIFIED** — live pipeline returns real dated sources |
| stale results rejected / down-ranked | ✅ **VERIFIED** — wrong-year source driven to the floor and dropped |
| sources are relevant | ⚠️ **PARTIAL** — the gates now *detect* irrelevance and refuse, but the underlying engines still return off-topic results (sports feed answering an IPL-standings question) |
| dates are shown | ✅ **VERIFIED** — undated sources dropped, ages surfaced |
| important claims cross-checked | ✅ **VERIFIED** — conflict detection live |
| conflicting sources detected | ✅ **VERIFIED** — surfaced with source, date and figure, never silently resolved |
| historical info not presented as current | ✅ **VERIFIED** — past-year opt-out, plus wrong-year rejection |
| failures honestly reported | ✅ **VERIFIED** — explicit refusal that refuses to fall back to memory |
| search UI stable and smooth | ⚠️ **PARTIAL** — code-level contract tested; **never rendered to a human** |

**Not green, and honestly so:** (1) source *relevance* is enforced downstream of a provider that still guesses; (2) a shared community search instance is a single point of failure; (3) the UI has not been seen by a person.

## 8. UX QUALITY GATE (§17) — **PARTIAL**

| Requirement | State |
|---|---|
| no unnecessary moving bars | ✅ code-verified (ladder removed, single fixed-height line) |
| no layout jumping | ✅ code-verified (fixed height + reserved min-height) |
| no choppy transitions | ✅ code-verified |
| no stuck loaders | ✅ code-verified (terminal state guaranteed) |
| smooth streaming | ✅ code-verified (reserved space) |
| stable scrolling | ⚠️ **not verified by a human** |
| stable mobile keyboard behaviour | ❌ **BLOCKED** — no device |
| consistent dark theme | ⚠️ **not verified by a human** |
| fast button feedback / clear loading / clear errors / clear success | ✅ existing components, **not verified by a human** |
| reduced-motion support | ✅ `MotionConfig reducedMotion="user"` + CSS media query, code-verified |

**Not green:** everything marked "not verified by a human" or BLOCKED. Automated tests cannot certify how an interface *feels*; that is the whole point of the instruction not to treat a green suite as 100%.

---

## 9. What a human still has to do

1. Run the reported queries in a real browser and confirm the answers are current and correctly dated.
2. Watch the research status: it must stay calm, not restart, and never spin forever.
3. Confirm the source cards show dates and open correctly.
4. Test on a real Android device (keyboard, scroll, bottom input, source cards, search status).
5. Install the PWA and check offline + reconnect.

**Recommended, non-blocking:** self-host SearXNG (`docker run -d -p 8080:8080 searxng/searxng`, `settings.yml → search.formats: [html, json]`) and point `SEARXNG_BASE_URL` at it. The current community instance is measurably the single biggest reliability risk in the search path.
