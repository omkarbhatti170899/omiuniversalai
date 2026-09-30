# OMI UNIVERSAL AI — VISUAL SYSTEM (frozen)

**Date:** 2026-09-30 · **Status: FROZEN.** Future UI changes must be targeted
improvements driven by real user feedback, not redesigns.

> Premium · Calm · Intelligent · Trustworthy · Fast · Distinctive

---

## 1. Identity

| | |
|---|---|
| Product | **OMI UNIVERSAL AI** |
| Descriptor | **Universal Intelligence** |
| Motto | **One Intelligence. Infinite Possibilities.** |
| Creator | **Created by Omkar Prakash Bhatti** |

Defined once in `src/components/brand/OmiMark.tsx` (`BRAND`) and used by every
surface. Copy is never retyped in a component.

## 2. The mark — one geometry, seven renderings

A luminous core inside an open orbital ring: **one** intelligence, held by
**infinite** possibility. The ring is elliptical and rotated −22° so the mark
reads as reaching rather than finished.

Canonical geometry (512 design space, identical everywhere):

```
core      circle  r 74    at (256,256)
ring      ellipse rx 176  ry 132   rotated −22°, stroke 11
nodes     (424,256) r19 · (140,192) r13 · (196,374) r11
glow      radial   r 196, indigo @ 0.30 → 0
accent    #8B98FF → #6E7BFF → #22D3EE
```

| Variant | File | Used for |
|---|---|---|
| Master mark | `public/logo.svg` | favicon, PWA, anywhere sharp |
| Maskable | `public/icon-maskable.svg` | Android crop (art in the 80% safe zone) |
| Lockup | `public/omi-lockup.svg` | social preview, print |
| Monochrome | `public/omi-mono.svg` | single-colour print/emboss |
| PNG set | `public/icons/*.png` | 192/512/maskable-512/apple-touch |
| React | `src/components/brand/OmiMark.tsx` | every in-app surface |
| Offline shell | `public/offline.html` (inline) | the no-network screen |

**The rule: one mark.** A second logo is a bug, and
`tests/omiBrandIdentity.test.ts` fails if the shell ever draws its own. Change the
mark by editing `logo.svg` **and** the constants in
`scripts/generateBrandIcons.ts` in the same commit, then re-run
`bun scripts/generateBrandIcons.ts`.

## 3. Colour

| Role | Token | Value |
|---|---|---|
| Canvas | `--background` | `oklch(0.135 0.012 268)` · app shell `#0B0B0F` |
| Surface | `--card` | `oklch(0.178 0.014 266)` |
| Border | `--border` | `oklch(1 0 0 / 8%)` — deliberately faint |
| Accent | `--primary` | `oklch(0.7 0.145 272)` — the mark's indigo |
| Accent 2 | *(mark only)* | `#22D3EE` cyan |

Dark is the identity, not a mode. Light remains available via the existing
theme toggle; nothing in the brand depends on it.

**Glass is selective, not a texture.** `.omi-panel` (blur + hairline) is used for
the command bar, menus, dialogs and the sign-in field — not for every card.
Ordinary content is `.omi-panel`-free: a border and a slightly lifted surface
carry hierarchy.

## 4. Motion

Motion communicates state. It never decorates.

- Allowed: fade, slide, scale, message/loading/sidebar/search-state transitions.
- Duration budget: 150–600 ms; the sign-in entrance totals ≈1.2 s and only on a
  first visit.
- Banned: constant animation, spinning logos, excessive particles, background
  motion that competes with content, anything that delays a click.
- `prefers-reduced-motion` disables the ambient field, the mark's breathing glow
  and the splash animation.
- The ambient field (`OmiAmbientField`) is one static SVG with a single 46 s
  transform — no JS loop, `pointer-events: none`, masked to fade before content.

## 5. Surfaces

| Screen | Contract |
|---|---|
| **Sign-in** | Mark is the hero → OMI → UNIVERSAL INTELLIGENCE → motto → creator → one way in. Near-black, one ambient field, glass only on the input. Returning users skip the entrance (localStorage `omi-brand-seen`) |
| **Landing** | States the product in the first screen. Eleven real capabilities, Emotions AI as one card. Three acceptance tests: 5 s / 30 s / 1 min |
| **Workspace** | Sidebar groups by frequency — **Primary** (Home, Chat, Andromeda, Research, Projects) · **Tools** · **Automation** · **System**. Progressive disclosure; nothing removed |
| **Mobile** | Designed, not squeezed: tab bar Home · Chat · Andromeda · Files · More, composer always primary, safe-area insets respected, content padded so the composer is never trapped |
| **Andromeda** | "Search & Research". The journey is shown (Search → Find → Compare → Verify → Answer); provider names live behind a per-citation disclosure, never in the hero |
| **Splash** | Inline in `index.html`, dismissed by the app on mount, self-removing after 2.5 s. Cannot outlive the app |

## 6. Trust is a design feature

The brand promise is that Omi does not bluff, so the UI is held to it:

- **Trust strip** (`components/answer/TrustStrip`): real source count, real
  freshness, real cross-check state. Independence is counted **by domain** — two
  copies of one article are one source. No sources says so. Undated sources
  produce no freshness claim.
- **Progress states** map 1:1 to backend statuses. `Thinking…` was added because
  the backend really emits it. There is deliberately **no** "Comparing" state:
  cross-checking happens, but the backend reports no distinct status, and
  faking one would be theatre.
- **Error copy** is human-first. The all-sources-failed case reads *"I couldn't
  verify this right now"* and keeps the guarantee that Omi will say so **rather
  than invent** an answer it couldn't check.

## 7. Performance budget

| Rule | Status |
|---|---|
| Visual pass must not slow startup | splash is inline CSS, self-removing |
| No unnecessary bundle growth | entry chunk +≈2 kB (478.8 kB, gzip 149.1 kB) |
| No new runtime dependency | icon PNGs generated with stdlib `zlib` only |
| Mobile performance | one composited transform for ambient motion; no loops |
| Accessibility | reduced-motion honoured, focus states preserved, `aria-live` on the status line, ≥44 px targets, labels on icon buttons |
| No regression | **1,469 tests / 0 fail** · tsc 0 · eslint 0 errors in `src/` |

## 8. Frozen — do not

- Add a second logo, or restyle the mark without updating all seven renderings.
- Re-run a redesign without real user feedback.
- Turn the UI neon, or glass everything.
- Add a state, badge or "verified" claim the backend cannot actually support.
- Let a visual change reach into Andromeda, the providers or the backend — a new
  test asserts the search modules stay brand-free.
