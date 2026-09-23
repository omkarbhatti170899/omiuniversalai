# Omi Universal AI — PWA / Android packaging

Status of this document: **prepared, not yet packaged.** Everything the web app
must provide to be installable and packageable is in place; one binary asset is
missing and is called out explicitly rather than worked around.

## What is already in place

| Requirement | Where |
|---|---|
| HTTPS origin | GitHub Pages (`omkarbhatti170899.github.io/omiuniversalai/`) |
| Web app manifest | `public/manifest.webmanifest`, linked from `index.html` |
| `display: standalone` | manifest — no browser chrome when launched from the home screen |
| `start_url` / `scope` / `id` | manifest, all scope-relative so one manifest serves both the root preview host and the `/omiuniversalai/` subpath |
| Install icons | `public/logo.svg` (see gap below) |
| Theme + splash colors | `background_color` / `theme_color` `#121216`, matching the dark-first identity |
| Service worker | `public/sw.js` — network-first HTML, cache-first hashed assets, **network-only for Convex API calls** |
| Offline fallback | `public/offline.html`, precached on install |
| iOS home-screen meta | `apple-mobile-web-app-*` tags in `index.html` |
| Launch shortcuts | manifest `shortcuts` → the real routes only (`/dashboard`, `/auth`). Omi's workspace views are internal state, not URL-addressable, so no shortcut points at a view that cannot be opened by URL. |

Safety note: `sw.js` never caches Convex API responses. A stale cached answer
from Omi would be worse than an offline error, so only the app shell is cached.

## Gap: raster icons

The manifest currently ships a single **SVG** icon. That is enough for Chrome's
desktop/Android *install* prompt, but it is **not** enough for store packaging:

- Google Play requires a **512×512 PNG** app icon for the listing.
- Android/TWA launchers and the maskable icon spec require **PNG** at
  192×192 and 512×512, with maskable art kept inside the inner **80% safe
  zone** (Android crops to a circle/squircle and will clip an edge-to-edge
  logo).
- Some tooling (PWABuilder's report, Lighthouse's installability audit)
  downgrades or fails a manifest whose only icon is SVG.

Adding these icons requires a rasterizer (`sharp`, `resvg`, ImageMagick, or any
design tool). No rasterizer is installed in this project and it is not worth a
build dependency for two static files, so this is left as an explicit
**BLOCKED** item rather than silently faked.

### To close it

1. Export from `public/logo.svg` (or the source brand art):
   - `public/icons/icon-192.png` — 192×192
   - `public/icons/icon-512.png` — 512×512
   - `public/icons/maskable-512.png` — 512×512, art inset to the safe zone
2. Add to the `icons` array in `public/manifest.webmanifest`:

   ```json
   { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
   { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
   { "src": "icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
   ```

   Keep the SVG entry as well — it stays the sharpest option on desktop.
3. No code change is needed anywhere else: `index.html` references the manifest
   by path, and `sw.js` already caches PNGs under `/assets/` rules.

## Packaging path (once the icons exist)

A Trusted Web Activity is the right target: it renders the real Omi web app
full-screen with no browser UI, so there is no second codebase to keep in sync
and no fork of the provider-neutral backend.

1. **Verify the live site is clean** — `https://resolute-ptarmigan-187.convex.site/selftest`
   must report `status: ok`. Packaging a degraded build ships the degradation.
2. **Generate the project** with PWABuilder (`pwabuilder.com`, point it at the
   Pages URL) or Bubblewrap:
   `bubblewrap init --manifest https://omkarbhatti170899.github.io/omiuniversalai/manifest.webmanifest`
3. **Digital Asset Links.** Android verifies the app owns the domain; without
   this the TWA silently falls back to a browser-chrome Custom Tab. The Play
   Console signing key's SHA-256 fingerprint must be published at
   `https://omkarbhatti170899.github.io/.well-known/assetlinks.json`:

   ```json
   [
     {
       "relation": ["delegate_permission/common.handle_all_urls"],
       "target": {
         "namespace": "android_app",
         "package_name": "com.ominnovations.omi",
         "sha256_cert_fingerprints": ["<PLAY_APP_SIGNING_SHA256>"]
       }
     }
   ]
   ```

   Two constraints specific to this deployment:
   - Pages serves this repository under `/omiuniversalai/`, so a
     `.well-known/` directory inside *this* repo lands at
     `/omiuniversalai/.well-known/…`, which Android does **not** check. Asset
     Links must be served from the **domain root** — i.e. a separate
     `omkarbhatti170899.github.io` repository — or the app must be pointed at a
     root-level custom domain.
   - Use the **Play App Signing** fingerprint from Play Console, not the local
     upload key, or verification fails after the first Play upload.
4. **Sign and upload** the generated AAB in Play Console.
5. **Re-run `/selftest`** after shipping, so the store listing and the health
   report agree.

No API keys are involved anywhere in this flow. The Android app is a shell
around the same deployed frontend; every provider secret stays server-side in
the Convex deployment and is never bundled — the built client was scanned for
key material during QA and contains none (only the *names* of env vars, inside
the setup hints shown in Settings).

## Capacitor path (config already committed)

`capacitor.config.ts` is committed and ready. It is **inert for the web build**
— nothing in `src/` imports it and Vite ignores it — so the working web app is
unaffected whether or not Capacitor is ever installed.

Already configured there: application name `Omi Universal AI`, package id
`com.ominnovations.omi`, `webDir: dist` (the same production bundle Pages
serves), `androidScheme: "https"`, and mixed content disabled.

### Steps

```bash
bun add -d @capacitor/cli && bun add @capacitor/core @capacitor/android
npx cap add android
# icons/splash: drop a 1024×1024 PNG at resources/icon.png, then
npx @capacitor/assets generate --android
bun run build && npx cap sync android
npx cap open android        # requires JDK + Android SDK
```

### Permissions to declare in `android/app/src/main/AndroidManifest.xml`

The features Omi actually uses, and nothing speculative:

| Permission | Why |
|---|---|
| `android.permission.INTERNET` | The app is a WebView over the deployed frontend and backend |
| `android.permission.RECORD_AUDIO` | Voice input — the on-device Web Speech API |
| `android.permission.CAMERA` | Only if camera capture is exposed to the file picker |
| `android.permission.READ_MEDIA_IMAGES` (API 33+) | Image/attachment picking |

Use `<uses-feature android:required="false">` for camera and microphone, so a
device without them can still install Omi.

Two Android behaviours need explicit handling in the shell:

- **Back button.** Capacitor maps hardware back to WebView history by default,
  which matches the SPA router. Verify on device that back from `/dashboard`
  returns to the landing page instead of closing the app, and that the auth
  redirect does not create a back-button loop.
- **File picker.** Attachments use a standard `<input type="file">`. Confirm the
  Android chooser returns content URIs correctly for PDF/DOCX/XLSX and images,
  and that the on-device extraction path (which reads the file in the WebView)
  still works — this is the single most likely place for a WebView-only bug.

### Environment blocker for the native build

A native build cannot be produced or verified in this environment: **no JDK,
no Gradle and no Android SDK are installed** (verified — `java` is not found).
Capacitor's `npx cap add android`, `assets generate` and the Gradle build all
require a JDK. So the Android build is **not** claimed as passing; the config,
permissions and steps above are prepared and the remaining work needs a machine
with the Android toolchain.
