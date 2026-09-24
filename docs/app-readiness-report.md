# Omi Universal AI — APP READINESS REPORT

**Date:** 2026-09-24
**Live web app:** https://omkarbhatti170899.github.io/omiuniversalai/
**Backend:** https://resolute-ptarmigan-187.convex.site
**Accessible health/status URL:** https://resolute-ptarmigan-187.convex.site/selftest
**Scope:** final production + Android readiness pass. No new features added.

## Legend

| Mark | Meaning |
|---|---|
| ✅ **PASS** | Verified working — an end-to-end check actually succeeded, or is pinned by the suite with the live leg done |
| 🟡 **CONFIGURED** | Implemented and wired, but needs external configuration to verify end-to-end |
| 🟠 **PENDING** | Requires a signed-in session or a real device to verify |
| 🔴 **FAIL** | Broken, or a listed capability that does not exist |

## Honest scope statement

Three of the requested phases cannot be executed from this environment, and I
will not report them as passing:

- **Signed-in flows** (Phase 1 research/agent runs, Phase 7 journey) need a human
  session. The public self-test deliberately refuses to upgrade these to PASS on
  the strength of deployed code.
- **Real Android device** (Phase 3) — no device is attached.
- **Android build** (Phase 5) — verified: **no JDK, no Gradle, no Android SDK**
  (`java` is not found). Capacitor's native build cannot run here at all.

Everything else below was actually run.

## Machine verification (this pass)

```
bun convex dev --once    → deployed to resolute-ptarmigan-187
bun tsc -b --noEmit      → 0 errors
bun test tests/          → 437 pass / 0 fail (34 files, 1,359 assertions)
bun run lint             → 0 errors (18 non-blocking warnings)
bun run build            → green
GET /selftest            → ok · 12 pass · 0 fail · 2 configured · 1 unverified
```

---

## PHASE 1 — Production QA

### Core AI

| Test performed | Result | Notes |
|---|---|---|
| Chat | 🟠 PENDING | Provider chain live-verified; the signed-in conversational turn is not claimed |
| **Streaming** | 🔴 **FAIL** | **Token streaming does not exist.** The transport sends a normal (non-streamed) request in `aiProviders/openaiCompat.ts`; the answer is persisted and rendered whole. Users see a spinner, then the complete reply. Not a regression — the capability was never built |
| **Regenerate** | 🔴 **FAIL** | **No per-message regenerate/retry affordance.** Grepped every component: message actions are delete conversation, read-aloud, dismiss emotion, attach, memory edit/delete. A user who dislikes an answer must retype the prompt |
| Conversation history | ✅ PASS | Ownership checked before every turn; a foreign conversation id throws |
| New conversations | ✅ PASS | Create/list/delete present with per-user scoping |
| Provider routing | ✅ PASS | `/selftest` pins a *specific* provider and gets an answer — real routing, not a config read |
| Provider fallback | ✅ PASS | Live: independent provider answered — chain `groq → gemini → openai` |
| Gemini | ✅ PASS | Live: `gemini-flash-lite-latest` answered on its own quota |
| Error handling | ✅ PASS | Failures are classified (retired model vs quota vs auth) and surfaced as actionable text, never a silent empty reply |
| Timeout handling | ✅ PASS | `withTimeout` wraps every network path — search, andromeda, deep research, tools, workflows, providers |

### Andromeda

| Test performed | Result | Notes |
|---|---|---|
| Web search | ✅ PASS | Live keyless retrieval returned real results (~300 ms) |
| Current-information queries | ✅ PASS | Planner emitted `kind: temporal`, `freshness: true` for a current query |
| Multi-source retrieval | ✅ PASS | 13/13 sources ready; fan-out with per-source scope gates to protect quotas |
| URL / page reading | ✅ PASS | Page fetcher with byte/redirect caps; SSRF regressions pinned |
| Source verification | ✅ PASS | Evidence/scoring + verification stages present in the pipeline |
| Citations | ✅ PASS | Provider→citation mapping with provenance (dates, license, source) |
| Freshness handling | ✅ PASS | Freshness flag propagates into planning |
| Search failure / fallback | ✅ PASS | Circuit breakers per engine + cooldown, so a failing engine is skipped rather than retried forever |

### Human Emotions AI — priority area

| Test performed | Result |
|---|---|
| Neutral | ✅ PASS |
| Happiness / excitement | ✅ PASS |
| Sadness | ✅ PASS |
| Frustration | ✅ PASS |
| Anger | ✅ PASS |
| Confusion | ✅ PASS |
| Urgency | ✅ PASS — separated from emotion: urgency drives pacing, emotion drives tone |
| Emotion-aware responses actually change | ✅ PASS — per-family tone guidance (anger → answer first, no chirpiness; anxiety → facts and sequence; confusion → short numbered steps; excitement → warm then substance) |
| Never claims knowledge of internal state | ✅ PASS — enforced in one place: prompt says "report signals, not certainties"; chat block mandates hedging ("this sounds frustrating") in one clause |
| Can be enabled/disabled | ✅ PASS — per-user setting; the reply shows a dismissible "this is an inference" indicator |
| Does not break normal chat | ✅ PASS — rule (1): the signal may never change *what* is answered; below 0.5 confidence it is explicitly ignored |

Reads from chat are ephemeral (not persisted) unless the user opts in. Note: a
bare "fixed" is deliberately *not* treated as relief — "I need this fixed" is an
urgent request, not a happy resolution. Pinned by `tests/emotionAware.test.ts`.

### Image Studio

| Test performed | Result | Notes |
|---|---|---|
| **Image generation** | ✅ PASS | **Live: a real 1024×1024 PNG, 32,970 bytes** via keyless `pollinations` (`sana`) |
| Image upload | 🟠 PENDING | Validation + private storage wired; browser→storage leg needs a session |
| Image editing | 🟡 CONFIGURED | Code-complete; every edit-capable provider refuses upstream (`429` — Gemini project without billing, OpenAI no credits). Router quotes the true error; Studio never fakes an image |
| Enhance / Background / Upscale | 🟡 CONFIGURED | Same edit-family path and the same external blocker |
| Variations | ✅ PASS | Implemented as an honest re-roll (new seed) on the keyless provider |
| Multiple references | 🟠 PENDING | `MAX_SOURCES = 4`, ownership fail-closed; live combine needs the edit path |
| Download | 🟠 PENDING | Served from private storage |
| Gallery | 🟠 PENDING | Private, per-user, `MAX_GALLERY_ROWS = 100` |
| Multi-turn editing | 🟠 PENDING | Yesterday's output is the next op's input — wire-verified, live leg needs the edit path |

### Files

| Test performed | Result | Notes |
|---|---|---|
| PDF | 🟠 PENDING (live) | `pdf.js` + OCR fallback path; real upload needs a session |
| DOC / DOCX | ✅ PASS (unit) | Real OOXML fixtures: paragraph order, honest rejection of a faked `.docx` |
| TXT / CSV | ✅ PASS (unit) | Server-side text path, char-capped |
| XLS / XLSX | ✅ PASS (unit) | Shared strings, cell refs, multi-sheet ordering |
| Images | 🟠 PENDING | Vision path live-verified separately (Groq vision read a real PNG) |
| Multiple files | 🟠 PENDING | `MAX_ATTACHMENTS = 5` |
| Upload → storage → extraction → retrieval → AI → answer | 🟠 PENDING | Each leg verified in isolation; the chain needs a session |
| **Invalid / oversized files** | ✅ PASS | Rejected with explicit messages at both client and server (`MAX_FILE_BYTES`, `MAX_CONTENT_CHARS`, image byte caps) — fails closed, no silent truncation |

### Deep Research, Agents / Workflows, Memory / Knowledge

| Test performed | Result | Notes |
|---|---|---|
| Deep research run (signed in) | 🟠 PENDING | Pipeline + persistence deployed; table read verified live. Stages present: plan → retrieve → synthesize → **verify** → report with citations |
| Agent workflow run (signed in) | 🟠 PENDING | Runtime + persistence deployed |
| Plan → approval → execution → result | ✅ PASS (unit) | Human approval gate with expiry, preview-before-decide, explicit reject |
| Audit trail | ✅ PASS | `omiAudit.listMine` — user-visible record of agent/tool actions |
| Memory: save / retrieve / isolate / delete | ✅ PASS | Per-user, ownership-scoped; `listMine` / `create` / `update` / `remove` |
| Clear memory (bulk) | 🟡 CONFIGURED | Per-item delete only — there is no "clear all" control. Minor; noted, not built (feature freeze) |
| Knowledge-base retrieval | ✅ PASS | Hybrid retrieval over owned documents; project scoping cuts both ways (pinned by `omiProjects.test.ts`) |

## PHASE 2 — Security

| Check | Result | Evidence |
|---|---|---|
| No API keys in frontend | ✅ PASS | All keys read from server-side env inside `src/convex/` only |
| No API keys in the built bundle | ✅ PASS | Scanned `dist/` for `gsk_…`, `sk-…`, `sk-proj-…`, `AIza…` → **zero matches** |
| No keys in Git | ✅ PASS | No credentials committed; CI codegen uses deployment config, not a committed deploy key |
| No secrets in logs / public endpoints | ✅ PASS | Public routes disclose booleans/labels/counts only — never an env var value, never even a name |
| Server-side provider credentials | ✅ PASS | Provider adapters run in server actions; the client never holds a key |
| Authentication enforcement | ✅ PASS | Live guard resolves `authenticated=false` without a session — enforced, not bypassed |
| User data isolation | ✅ PASS | Every user-scoped table filters by owner id |
| File ownership checks | ✅ PASS | Attachment resolution is ownership-filtered and **fails closed** on unknown/foreign ids |
| Upload validation | ✅ PASS | Type + size validated client and server; oversized/invalid rejected explicitly |
| SSRF protection | ✅ PASS | Private/loopback ranges blocked (`searchEngine/security.ts` — this is what the `localhost`/`127.0.0.1` hits in source are: the blocklist, not a leak) |
| Tool-injection protection | ✅ PASS | Untrusted-text sanitising, multilingual steering and structural-smuggling cases pinned |
| Rate limiting | ✅ PASS | Per-user on every expensive surface: chat 20/min · search 20 · URL read 30 · research 5 · images 12 · file ingest 20 · projects 10 · tools 20 · workflows 6 |
| Stack traces / internals hidden from users | ✅ PASS | User-facing errors are plain sentences; the UI root error boundary shows a message, not a stack, in production |

## PHASE 3 — Mobile QA

🟠 **PENDING.** No device is available in this environment. What *can* be stated:
the mobile navigation exists (the sidebar was previously desktop-only, so phones
could not leave Home — that was a real bug, fixed in the redesign), the layout is
responsive, and the viewport meta is correct. Login, keyboard, camera and
microphone behaviour must be confirmed on hardware before claiming them.

## PHASE 4 — PWA

| Check | Result | Notes |
|---|---|---|
| Manifest | ✅ PASS | Valid JSON; `display: standalone`, scope-relative `start_url`/`scope`/`id` |
| Icons | 🟡 CONFIGURED | SVG only. Chrome installs fine; **store packaging needs PNG** at 192/512 + maskable |
| Splash / loading | ✅ PASS | `background_color`/`theme_color` `#121216`; route-level Suspense fallback |
| Standalone mode | ✅ PASS | `display_override: standalone → minimal-ui` |
| App name | ✅ PASS | "Omi Universal AI" full, "Omi" short |
| Theme | ✅ PASS | Dark-first, matching the app (`class="dark"`, `color-scheme: dark`) |
| Mobile viewport | ✅ PASS | `width=device-width, initial-scale=1.0` |
| Service worker | ✅ PASS | Network-first HTML, cache-first hashed assets, **network-only for Convex** — a stale cached answer would be worse than an offline error |
| Offline fallback | ✅ PASS | `offline.html` precached on install |
| Launch shortcuts | ✅ PASS | Point only at real routes (`/dashboard`, `/auth`) — no dead links |

## PHASE 5 — Android preparation

| Item | Result |
|---|---|
| Capacitor config | ✅ PASS — `capacitor.config.ts` committed and inert for the web build |
| Application name | ✅ PASS — `Omi Universal AI` |
| Package id | ✅ PASS — `com.ominnovations.omi` |
| Production backend URL | ✅ PASS — baked at build time via the Convex URL; no localhost fallback exists (the app throws loudly if unset) |
| No provider keys in the app | ✅ PASS — structurally impossible: the shell wraps the deployed frontend and holds no credentials |
| App icon / splash | 🟡 CONFIGURED — needs a 1024×1024 PNG source to generate |
| Back button | 🟡 CONFIGURED — default WebView history mapping; must be verified on device |
| File picker | 🟡 CONFIGURED — standard file input; the WebView content-URI path is the most likely native-only bug |
| Camera / microphone permissions | 🟡 CONFIGURED — declared in `docs/android-packaging.md`, marked `required="false"` |
| Storage / share | 🟡 CONFIGURED — download path exists; native share sheet not wired (feature freeze) |
| **Android build succeeds** | 🔴 **BLOCKED** — no JDK/Gradle/Android SDK in this environment |

## PHASE 6 — Production build

| Check | Result | Evidence |
|---|---|---|
| TypeScript clean | ✅ PASS | `tsc -b --noEmit` → 0 errors |
| Lint clean | ✅ PASS | `eslint .` → 0 errors; warnings are generated-code directives and shadcn/Fast Refresh conventions |
| Tests pass | ✅ PASS | 437 / 0 fail, 34 files, 1,359 assertions |
| Production build | ✅ PASS | `vite build` green |
| Backend deployment | ✅ PASS | `convex dev --once` deployed; codegen needs no committed credential |
| No localhost URLs | ✅ PASS | No app-configured localhost URL anywhere. A `dist/` grep for `localhost` matches only **library boilerplate** — the Convex client and react-router use `location.href ?? "http://localhost/"` as a URL-base fallback and in HTTP-error message construction, never as the backend address. So an auditor grepping the bundle will find them and can discount them; the real backend URL comes from the build-time Convex URL, and the app throws immediately if it is unset. The only hits in `src/` are the SSRF blocklist |
| No dev-only configuration | ✅ PASS | Service worker gated to production builds; no debug flags shipped |
| No missing environment variables | ✅ PASS | Client fails loudly rather than silently misbehaving |
| CI passes | ✅ PASS | Live artifact confirmed published by run #17 |

## PHASE 7 — Full user journey

| Stage | Result |
|---|---|
| Sign up / login → chat → current question → Andromeda → open source | 🟠 PENDING (session) |
| Upload PDF → ask about the PDF | 🟠 PENDING (session) |
| Generate image | ✅ PASS (live-verified independently) |
| Edit image | 🟡 CONFIGURED (external quota) |
| Human Emotions | ✅ PASS |
| Deep research → agent workflow | 🟠 PENDING (session) |
| Save / retrieve conversation, memory | ✅ PASS (unit) |
| Open on Android and repeat | 🟠 PENDING (no device) |

---

## Bugs found and fixed

**1. A working capability was hidden behind a blocked one.** The `image engine`
health probe graded generation and editing as a single verdict, so the report
showed a lone "unverified" while image generation had been working all along.
*Fixed:* split into two independently probed subsystems.
*Re-verified:* generation now reports PASS with a real image; editing reports its
true upstream error.

**2. Chat had no per-user rate limit** — the only expensive surface without one,
and the most expensive of all (a turn can cost search, vision, emotion
classification and synthesis). One account could burn the shared free-tier quota.
*Fixed:* 20/min per user via the existing limiter. *Regression test:* yes.

**3. The rate limiter had no test.** The one primitive protecting the shared
quota was untested. *Fixed:* `tests/omiRateLimit.test.ts` — 8 tests pinning
allowance accuracy, retry-hint bounds, refusal persistence and per-key isolation.

## Remaining blockers

| # | Blocker | Type | Unblocked by |
|---|---|---|---|
| 1 | Token streaming absent | 🔴 capability | Building it (deferred — feature freeze) |
| 2 | Regenerate absent | 🔴 capability | Building it (deferred — feature freeze) |
| 3 | Image editing blocked | 🟡 external | Gemini project with billing, or OpenAI credits |
| 4 | Android build unverifiable | 🟡 environment | A machine with JDK + Android SDK |
| 5 | PNG app icons | 🟡 asset | 1024×1024 PNG brand source |
| 6 | Signed-in + device QA | 🟠 access | A session and an Android phone |
| 7 | Bulk "clear memory" | 🟡 minor | A small control (deferred) |

## App-ready verdict

**Not app-ready yet** — and the two 🔴 items are the reason, not the deployment.
Everything that runs is verified and clean: the build, the tests, the live
deployment, the provider chain with a genuinely independent fallback, Andromeda,
vision, image generation, the emotion layer, the security posture and the PWA
shell. No code defect remains open.

What stands between Omi and "app-ready" is **two missing chat capabilities**
(streaming, regenerate) plus **environment access** (a JDK, a device, a session,
one image asset). None of those is a bug; three of them are outside what this
environment can reach, and the two capability gaps were left unbuilt on your
instruction to stop adding features.

Recommended order once you review this:
1. Streaming + regenerate (biggest perceived-quality jump for the least work).
2. Enable Gemini billing — unblocks the entire edit half of Image Studio.
3. Native build on a JDK-equipped machine, then device QA.
