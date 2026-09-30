# HUMAN QA CHECKLIST — Omi Universal AI

**For the human reviewer.** Run in a real browser against the **deployed** site.
App: `https://omkarbhatti170899.github.io/omiuniversalai/` · Backend: `majestic-turtle-372` (production)

---

## ⚠️ BEFORE YOU START — verify you are testing the current build

The live site may still be serving an **older commit**. Confirm the deploy landed first:

**Step 0 — confirm the backend is AWAKE (do this first).** Production is
`majestic-turtle-372`;
dev is `striped-salmon-879`. If the deployment the frontend was built against is
paused or empty, the app shell loads and then *every* action fails with a server
error.

```bash
# Production backend
curl -s -X POST https://majestic-turtle-372.convex.cloud/api/query \
  -H 'Content-Type: application/json' \
  -d '{"path":"aiStatus:status","args":{},"format":"json"}'
```

A healthy deployment answers with `{"status":"success","value":{...}}`.
A paused one answers with `"Cannot run functions while this deployment is
paused"`; a never-deployed one answers with a bare `Server Error`. Both are
**deployment problems, not app bugs** — fix the deployment in the Convex
dashboard, then re-run this command.

Also confirm the **built frontend actually targets that backend** (it is baked
in at build time from `VITE_CONVEX_URL`):

```bash
# Extracts the Convex URL the deployed bundle was compiled against.
grep -ohE '[a-z]+-[a-z]+-[0-9]+\.convex\.cloud' /tmp/omi-all.js | sort -u
# Expect exactly: majestic-turtle-372.convex.cloud
# If it shows resolute-ptarmigan-187.convex.cloud, the live site is pointed at
# a retired deployment — rebuild the frontend before recording any result.
```

```bash
curl -s https://omkarbhatti170899.github.io/omiuniversalai/ | grep -o 'assets/index-[A-Za-z0-9]*\.js'
```

Then confirm the NEW code is present. **Important:** these markers are *not* in
the entry bundle — they live in the lazily-loaded view chunks, so grep only the
entry bundle and you will get a false "stale build". Walk the chunks:

```bash
BASE=https://omkarbhatti170899.github.io/omiuniversalai
ENTRY=$(curl -s $BASE/ | grep -o 'assets/index-[A-Za-z0-9-]*\.js' | head -1)
rm -rf /tmp/omichunks && mkdir -p /tmp/omichunks
curl -s "$BASE/$ENTRY" -o /tmp/omichunks/entry.js
grep -oE '\./[A-Za-z0-9_-]+\.js' /tmp/omichunks/entry.js | sed 's|^\./||' | sort -u > /tmp/omichunks/names.txt
# Chunks import OTHER chunks two levels deep, so walk the graph until it stops
# growing (two passes is enough today: entry -> views -> panels).
for pass in 1 2; do
  xargs -P 8 -I{} curl -s -o /tmp/omichunks/{} "$BASE/assets/{}" < /tmp/omichunks/names.txt
  cat /tmp/omichunks/*.js | grep -oE '\./[A-Za-z0-9_-]+\.js' | sed 's|^\./||' | sort -u > /tmp/omichunks/next.txt
  comm -13 /tmp/omichunks/names.txt /tmp/omichunks/next.txt > /tmp/omichunks/new.txt
  [ -s /tmp/omichunks/new.txt ] || break
  cp /tmp/omichunks/new.txt /tmp/omichunks/names.txt
done
cat /tmp/omichunks/*.js > /tmp/omi-all.js
for m in "Searching live sources" "Single source" "Cross-checked" "Back online"; do
  printf '%-24s %s\n' "$m" "$(grep -c "$m" /tmp/omi-all.js)"
done
```

Expected on the current build: ~25 chunks, ~1.7 MB concatenated, and **all four
markers >= 1**. Verified live 2026-09-30 against the deployed site.

| Marker | Expected | Lives in |
|---|---|---|
| `Searching live sources` | ≥ 1 — the calm research status | `OmiAssistantPanel` chunk |
| `Single source` | ≥ 1 — the honest source-verification badge | `Dashboard` chunk |
| `Cross-checked` | ≥ 1 — only shown for genuine cross-checking | `Dashboard` chunk |
| `Back online` | ≥ 1 — offline/reconnect bar | entry bundle |

**If any marker is 0, STOP: you are testing a stale build.** Ask for a redeploy before recording any result — every result below would be invalid.

---

## How to record each flow

Mark **one** of:

| Mark | Meaning |
|---|---|
| **PASS** | You did it in the browser and it behaved correctly |
| **FAIL** | You did it and it was wrong |
| **BLOCKED** | You could not do it (no account, no file, no device) |

> **Rule 5 — do not mark a human flow PASS based on automated tests.**
> 986 automated tests passing is *not* evidence for any row below. A row is PASS only if **you** performed it and watched it happen. If you did not run it, it is BLOCKED.

### For every FAIL, capture:

```
Flow:            <name>
Reproduction:    1. … 2. … 3. …   (exact steps someone else can repeat)
Expected:        <what should have happened>
Actual:          <what happened instead>
Severity:        blocker / major / minor
Screenshot:      <file or "not captured">
Browser/device:  <Chrome 120 / Firefox / Android Chrome, etc.>
```

Then the fix and a regression test get added by engineering. **A FAIL without reproduction steps cannot be actioned** and will be sent back.

---

## 1. Chat
- [ ] Send a normal question → clean markdown answer
- [ ] Send a second message → conversation continues, context kept
- [ ] Long answer → readable, no horizontal scroll
- [ ] Very long answer → scroll behaves, nothing clipped
- [ ] Emoji / links / code block render correctly

## 2. Streaming
- [ ] Send a long question → **tokens appear progressively** (not all at once)
- [ ] No freeze while waiting for the first token
- [ ] No layout jump when the first token lands
- [ ] Send button / input does not move during streaming

## 3. Current information  ← *most important section*
Run each. For every one: **does the answer carry a date, and does it refuse rather than guess?**

- [ ] "What is the Indian contingent medals tally in Asian Games 2026?"
- [ ] "What is India's medal tally in Asian Games 2026?"
- [ ] "latest India cricket score"
- [ ] "current gold price in India"
- [ ] "latest election results"
- [ ] "today's weather"
- [ ] "latest Apple stock price"
- [ ] "current USD INR rate"
- [ ] "latest AI news"
- [ ] "current IPL standings"
- [ ] "latest flight status"
- [ ] **CONTROL:** "Who won the 2016 Olympics men's 100m?" → must be answered normally, **not** treated as live

**Pass criteria:** a date or an explicit "I could not verify this". **Any answer that invents a figure without a source is a blocker FAIL**, even if the number happens to be right.

## 4. Search
- [ ] Research question → answer cites sources with `[1] [2]`
- [ ] Source cards show **publisher, date, and a snippet**
- [ ] Undated sources visibly marked "date not shown by the source"
- [ ] Verification badge: green "Cross-checked" only with 2+ independent sources
- [ ] One source only → badge reads **"Single source"**, never "verified"
- [ ] Conflicting sources → Omi says they disagree and shows both
- [ ] Click a source → opens in a new tab, correct page

## 5. Andromeda (deep research)
- [ ] Run a research/comparison question
- [ ] Progress status appears and is **calm** — no jumping bar, no repeated restarts
- [ ] Spinner **stops** when finished (never left running)
- [ ] Per-stage detail visible
- [ ] Conflicts surfaced, not silently merged

## 6. Knowledge Base
- [ ] Create a project
- [ ] Add a document
- [ ] Ask a question about it → answer cites `[K#]`
- [ ] Cited text actually appears in the source document
- [ ] Documents isolated per project (project A's docs never appear under project B)

## 7. PDF / DOCX / XLSX
- [ ] Upload a **real** PDF → extracted → answerable
- [ ] Upload a **real** DOCX → extracted → answerable
- [ ] Upload a **real** XLSX → ask about a cell/table → correct value
- [ ] Answer cites the source, and the cited content matches the file
- [ ] A question the document does **not** contain → Omi says so, does not invent

## 8. Vision
- [ ] Upload a photo → preview shown
- [ ] "What is in this image?" → accurate description
- [ ] Ask about a specific detail in the image

## 9. Image generation
- [ ] Generate an image → real image appears in the gallery
- [ ] View / save / regenerate all work
- [ ] Wait does not leave a spinner forever

## 10. Image editing
- [ ] Upload an image and request an edit
- [ ] Result **derives from the uploaded image**, not an unrelated generation
- [ ] Background removal / replacement / upscale behave
- [ ] If a credits error appears → message is human and gives a next step (**not** raw JSON)

## 11. Regeneration
- [ ] Press Regenerate → new answer replaces the old one
- [ ] **No duplicate bubble**
- [ ] Previous answer not left visible in the thread

## 12. Errors / retry
- [ ] Trigger an error (e.g. ask something while offline) → human message
- [ ] Message says **what happened + what to do next**
- [ ] Retry works and recovers
- [ ] No raw stack traces, no secret-looking strings
- [ ] **Go offline** → offline bar appears → **go online** → "Back online" appears

## 13. Authentication
- [ ] Sign up with email → lands in the protected workspace
- [ ] Sign out → protected routes require sign-in again
- [ ] Sign back in → history still present and correctly scoped
- [ ] Guest/anonymous sign-in works
- [ ] Not signed in → no data leaks into the view

## 14. History
- [ ] Old conversations listed
- [ ] Open an old conversation → messages intact
- [ ] New conversation starts clean (no bleed from the previous one)

## 15. Dark theme
- [ ] Default theme is dark
- [ ] No white/light panels leaking into dark mode
- [ ] Text contrast readable throughout
- [ ] No flash of light theme on load

## 16. Scrolling
- [ ] Scroll does not jump while an answer streams
- [ ] Scroll position is preserved when content grows
- [ ] No horizontal scrollbar on desktop **or** mobile width

## 17. Keyboard
- [ ] Tab through the interface — every control reachable
- [ ] Visible focus ring on the focused element
- [ ] Enter sends a message
- [ ] No keyboard trap
- [ ] **On mobile:** opening the keyboard does **not** cover the input box, and nothing jumps

## 18. Performance
- [ ] First token arrives quickly on a normal question
- [ ] Search feels responsive; a slow search shows honest progress rather than freezing
- [ ] No visible stutter while scrolling
- [ ] DevTools → Performance: no long tasks > 50 ms during idle
- [ ] DevTools → Network: no request fails silently

---

## 19. Android / PWA — **only after browser QA is clean**

🛑 Needs a **physical Android device**.

- [ ] Chrome loads the app
- [ ] "Add to Home screen" → launches standalone (not a browser tab)
- [ ] Keyboard does not cover the input
- [ ] Touch targets comfortable one-handed
- [ ] Scrolling smooth, no horizontal scroll
- [ ] Offline shell loads; reconnect shows "Back online"
- [ ] Chat / search / Andromeda / files / vision / image gen / image edit all work on device

---

## Result sheet

| # | Flow | Result | Notes |
|---|---|---|---|
| 1 | Chat | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 2 | Streaming | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 3 | Current information (11 queries) | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 4 | Search | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 5 | Andromeda | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 6 | Knowledge Base | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 7 | PDF/DOCX/XLSX | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 8 | Vision | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 9 | Image generation | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 10 | Image editing | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 11 | Regeneration | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 12 | Errors / retry / offline | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 13 | Authentication | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 14 | History | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 15 | Dark theme | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 16 | Scrolling | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 17 | Keyboard | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 18 | Performance | ☐ PASS ☐ FAIL ☐ BLOCKED | |
| 19 | Android / PWA | ☐ PASS ☐ FAIL ☐ BLOCKED | |

**Do not report a flow as PASS unless you personally performed it in a browser or on a device.**
