# HUMAN QA REPORT — Omi Universal AI

**Date:** 2026-09-27 · **Build audited:** `243bc53` + this session's changes
**Method:** every row is either a **measured** result (a live run I executed and can reproduce) or **NOT RUN** (a human action this environment cannot perform). No row is a guess.

---

## ⚠️ HEADLINE: HUMAN VERIFICATION IS 0/22

**Not one flow below has been performed by a human in a browser or on a device.** Everything marked `NOT RUN` requires a person, a browser, or a physical Android device — none of which exist in this environment. I have not simulated them, inferred them, or counted them.

| Verification class | Count | Meaning |
|---|---|---|
| ✅ **MEASURED** | automated / live-API | I executed it and can reproduce the evidence |
| 👤 **NOT RUN** | human-only | Requires a person, browser or device |
| 🛑 **BLOCKED** | impossible here | Requires a physical device or a human judgement |

---

## 1. HUMAN SEARCH QA (§5) — 0/11 run by a human

Run these in a browser. Expected behaviour is stated so a human can judge, not just click.

| # | Query | What a correct answer must do | Status | Evidence |
|---|---|---|---|---|
| 1 | Indian contingent medals tally, Asian Games 2026 | Search live; give a date; say plainly if unverified; **never invent a tally** | ✅ **MEASURED (API)** | Live pipeline: `raw=8 kept=4 domains=4 verdict=answer-caveated`; 4 real dated 2026 sources (economictimes 24h, indiatvnews/khelnow/vajiramandravi yesterday); 4 undated dropped; caveat "No primary or reputable source was found" |
| 2 | latest India cricket score | Scoreline from a scoreboard, not a news sentence | ✅ **MEASURED (API)** | routed `sports`, `strict=true`, live score provider |
| 3 | current gold price India | Live rate, dated, or an honest refusal | ✅ **MEASURED (API)** | routed `markets`, `strict=true` |
| 4 | latest election results | Routed to an election feed/news; dated; never from memory | ✅ **MEASURED (API)** | routed `election`, `strict=false`, providers `gdelt, wikipedia-current-events, searxng, duckduckgo` |
| 5 | today's weather | **Ask which location** rather than guessing; then a live observation | ✅ **MEASURED (API)** | `/currentinfo` scenario 6 PASS — "Omi correctly asks for the missing input" |
| 6 | latest Apple stock price | Live quote with a timestamp, or honest refusal | ✅ **MEASURED (API)** | routed `markets` |
| 7 | current USD INR rate | A **real** rate from the rate feed, dated | ✅ **MEASURED (API)** | routed `markets`, `market-rates` provider, `maxAgeDays=7` |
| 8 | latest AI news | Fresh, dated news; never model memory | ✅ **MEASURED (API)** | `/currentinfo` 10/10 |
| 9 | current IPL standings | Real standings — **not** unrelated match listings | ✅ **MEASURED (API)** | Gate now **REFUSES** when no source names the IPL (a real defect found and fixed — see §7) |
| 10 | latest flight status | Live status, or honest "no structured flight feed" | ✅ **MEASURED (API)** | routed `travel`; ⚠️ **no structured provider exists yet** — see §8 |
| 11 | Who won the 2016 Olympics 100m? (**control**) | Must **NOT** be treated as a live question | ✅ **MEASURED** | `classifyCurrentIntent` → `requiresFreshness=false, historical=true` |
| — | *the same 11, judged by a human in a browser* | — | 👤 **NOT RUN** | no browser in this environment |

## 2. HUMAN UX QA (§6) — 0/9 observed by a human

| # | Watch for | Code-level state | Status |
|---|---|---|---|
| 1 | choppy bars | Five-step ladder **removed**; one fixed-height (`h-5`) line | ✅ MEASURED (code) |
| 2 | layout jumps | `min-h-[3rem]` reserved for streaming content | ✅ MEASURED (code) |
| 3 | streaming jumps | same reservation; reserved space before first token | ✅ MEASURED (code) |
| 4 | moving input | composer untouched by status changes | ✅ MEASURED (code) |
| 5 | source-card movement | fixed card structure; verification badge is static text | ✅ MEASURED (code) |
| 6 | excessive shimmer | `animate-pulse` removed from chat input + image gallery | ✅ MEASURED (code) |
| 7 | repeated animation | only the single active step animates | ✅ MEASURED (code) |
| 8 | stuck spinners | terminal state guaranteed (`final: true` → `settled`) | ✅ MEASURED (code) |
| 9 | scroll jumping | — | 👤 **NOT RUN** |
| — | **whether it actually feels calm** | — | 👤 **NOT RUN** |

> 16 automated UX-contract tests assert these properties. They assert the *code contract*, not the *felt experience*. A test cannot tell you the interface feels calm; only a person can.

## 3. REAL ANDROID / PWA QA (§7) — 0/13

🛑 **BLOCKED — no physical Android device, no JDK/Gradle.** `capacitor.config.ts` and `docs/android-packaging.md` are prepared; **no APK/AAB has been built and no device has been touched.**

| # | Flow | Status |
|---|---|---|
| 1 | Chrome on Android — load app | 🛑 BLOCKED |
| 2 | PWA installation (Add to Home screen) | 🛑 BLOCKED |
| 3 | Keyboard open/close, input not covered | 🛑 BLOCKED |
| 4 | Touch targets one-handed | 🛑 BLOCKED |
| 5 | Scrolling, no horizontal scroll | 🛑 BLOCKED |
| 6 | Offline shell loads | 🛑 BLOCKED |
| 7 | Reconnect → "Back online" | 🛑 BLOCKED |
| 8 | Chat on device | 🛑 BLOCKED |
| 9 | Search on device | 🛑 BLOCKED |
| 10 | Andromeda on device | 🛑 BLOCKED |
| 11 | Files on device | 🛑 BLOCKED |
| 12 | Vision on device | 🛑 BLOCKED |
| 13 | Image generation + editing on device | 🛑 BLOCKED |

## 4. KNOWLEDGE BASE REAL-FILE QA (§8) — PARTIAL

| Item | Status | Evidence |
|---|---|---|
| PDF / DOCX / XLSX / CSV / TXT extraction | ✅ MEASURED (unit) | `tests/docExtract.test.ts`, `pdfExtract`, OCR via tesseract |
| Real file → upload → ingest → index → `[K#]` answer | ✅ MEASURED (API) | Earlier authenticated session: real storage upload → `ingestFile` → document, TXT and PNG |
| **Answer verified against exact source/page evidence** | 👤 **NOT RUN** | needs real files and a human reading the cited page |

⚠️ **Known gap:** a `kb.cites-the-document` eval case failed on the first live run because the runner has no uploaded document. It is reported as **SKIPPED**, not passed.

## 5. IMAGE EDITING (§9) — kept working, 402 handled

| Item | Status | Evidence |
|---|---|---|
| All six edit-family ops | ✅ MEASURED | `/selftest` image editing PASS — 25,800 B @ 1024×1024 via `pollinations-edit (kontext)` |
| Working code untouched | ✅ MEASURED | no edit-path code changed this session |
| 402 handled gracefully | ✅ MEASURED | `"the account has no remaining credits or balance"`; unit-tested in `tests/omiImageErrors.test.ts` |
| Raw provider errors never shown | ✅ MEASURED | `humanizeImageError` maps by status; no raw body reaches the user |
| Full 1024×1024-**input** edits | ⚠️ **PARTIAL** | free Pollinations balance exhausted → 402. Needs a top-up, **not** a code change |

## 6. SECURITY QA (§10) — automated PASS, manual NOT RUN

| Item | Status | Evidence |
|---|---|---|
| No public Convex function without auth | ✅ MEASURED | `auditAuthz()` — 109 public, **0 NO_AUTH** |
| Cross-user KB/tenant isolation | ✅ MEASURED | `omiSourceVerificationAndSecurity.test.ts` — tenant filter, namespaced personal ids, membership checked |
| Cross-user conversation isolation | ✅ MEASURED (earlier live session) | unauthenticated conversation list returned **0 rows** (fail-closed) |
| ID manipulation | ✅ MEASURED | `sanitizeUntrustedText` + ownership markers on every user-scoped function |
| Prompt injection in documents | ✅ MEASURED | injection suite + eval `safety.document-injection` PASS |
| **Credential leakage** | ✅ **FIXED THIS SESSION** | the sanitizer did **not** redact credentials — a real gap found and closed (`sk_`, `pk_`, `AIza`, `ghp_`, `AKIA`, `Bearer`, PEM blocks) |
| **Multi-account live isolation, real sessions** | 👤 **NOT RUN** | needs two real accounts |

> The authz scan now runs as a **test on every change**, not as a script someone must remember to run. A gate that only runs on demand is not a gate.

## 7. DEFECTS FOUND AND FIXED DURING THIS QA

| # | Defect | Found by | Status |
|---|---|---|---|
| 1 | Live provider answering a **different question** (`current IPL standings` → cricket matches, all stamped "just now") | running the real pipeline | **FIXED** — event check made critical; live scoreboard excluded when no score is asked |
| 2 | **Raw question sent verbatim** to search engines (0 results / 12 s timeout vs 8 results) | running the real pipeline | **FIXED** — `retrievalQuery` + anchored multi-angle fan-out |
| 3 | Vertical terms added to queries that already said it ("India cricket score **result report**") | reviewing my own first rewrite | **FIXED** — suppressed when the wording already expresses the need |
| 4 | Event anchor adding redundancy ("Indian Premier League … **ipl**") | a test I wrote | **FIXED** — `namesEvent` checks synonyms |
| 5 | **Credentials not redacted** from untrusted document text | writing the security test | **FIXED** |
| 6 | Authz audit was a manual script | design review | **FIXED** — now a test |

## 8. KNOWN GAPS (not fixed — recorded honestly)

| Gap | Why not fixed here |
|---|---|
| **No structured flight-status provider** | Requires a commercial API + key the owner has not provisioned. Routed to `travel` with news + web fallback and `strict=false`; the answer is honest about its source but is not a live flight feed. |
| **No structured election-results provider** | Same. Routed to `election` with news fallback. |
| **IPL standings answered by a match-listing feed** | The gate now **refuses** rather than mis-answering, but the underlying provider still cannot supply standings. A real fix needs a cricket-specific data source. |
| **Single community search instance** | `search.lumy.live` is a third-party community instance. It timed out under probing and briefly dropped `/selftest` to 21/1 before recovering. A second keyless provider was added; **self-hosting is still the real fix.** |
| **Groq rate limiting under eval load** | Free tier. Observed as 429 during benchmarking; the eval correctly reported it as SKIPPED, not failed. |

---

## 9. FINAL VERDICT — NOT PRODUCTION-MATURE

| Gate | Result |
|---|---|
| Automated gates | ✅ **GREEN** — build, typecheck, lint (0 errors), **986 tests / 0 fail**, authz 0 NO_AUTH, `/currentinfo` 10/10, `/selftest` 23/0/5 |
| Search quality gate (§16) | ⚠️ **PARTIAL** — relevance is enforced *downstream* of a provider that still guesses |
| UX quality gate (§17) | ⚠️ **PARTIAL** — code contract tested; never felt by a human |
| **Human QA** | ❌ **0/22 — not started** |
| **Android/PWA** | ❌ **0/13 — blocked, no device** |

**Omi is not production-mature.** The engineering is strong and the reported bug is genuinely fixed and regression-tested, but the three things a QA reviewer actually asks for — a person confirming the answers, a person confirming the interface feels calm, and a physical Android device — have **not been done**. I am not going to convert "986 automated tests pass" into that.
