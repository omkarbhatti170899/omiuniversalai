/**
 * Capacitor configuration — Android/iOS packaging for Omi Universal AI.
 *
 * Precondition: this file is INERT for the web build. Nothing in `src/`
 * imports it and Vite ignores it, so the working web app is unaffected whether
 * or not Capacitor is ever installed. It is committed now so the packaging step
 * is a `npx cap add android` away rather than a rebuild from scratch.
 *
 * Two rules this config exists to enforce:
 *
 * 1. NO AI PROVIDER KEYS IN THE APP. The Android shell is a WebView around the
 *    deployed frontend. Every provider key stays in the Convex deployment. The
 *    app must never grow its own copy of a provider credential, and there is
 *    deliberately nothing here to put one in.
 *
 * 2. NO LOCAL BACKEND. `webDir: "dist"` ships the same production bundle that
 *    GitHub Pages serves, and the backend URL is baked in at build time by
 *    `VITE_CONVEX_URL` (see src/main.tsx, which throws if it is unset). The
 *    app therefore talks to the real deployment — there is no localhost
 *    fallback to accidentally ship.
 *
 * `androidScheme: "https"` is required: on the default `http` scheme the
 * WebView origin is treated as insecure, which breaks the service worker,
 * Convex Auth's secure cookies, and the Web Speech API (microphone).
 */
const config = {
  appId: "com.ominnovations.omi",
  appName: "Omi Universal AI",
  webDir: "dist",
  // The remote content is our own deployed origin, not a third-party page,
  // so the WebView keeps standard HTTPS behaviour and blocks mixed content.
  server: {
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
    // Back button: Capacitor maps hardware back to WebView history by default,
    // which is what the SPA router expects. See docs/android-packaging.md.
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: "automatic",
  },
} as const;

export default config;
