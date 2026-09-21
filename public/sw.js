/**
 * Ominnovations Intelligence — service worker (Phase 8).
 *
 * Strategy (conservative by design — a stale app is worse than an offline
 * error):
 *   • HTML navigations: network-first, fall back to cache, then offline page
 *   • hashed build assets (/assets/*): cache-first — they're immutable
 *   • everything else: network-only (Convex API calls are NEVER cached)
 *   • old caches are purged on activation
 *
 * Zero dependencies. Registered ONLY in production builds (main.tsx gates
 * on import.meta.env.PROD) so the managed preview/dev session is never
 * served stale caches.
 */

// Scope-relative paths: the SW lives at the app root (whatever that is —
// "/" on the managed preview, "/omiuniversalai/" on GitHub Pages). Deriving
// from registration.scope means one SW serves both hosts correctly.
const APP_BASE = new URL(self.registration.scope).pathname;
// Bump the cache version when the shell's URL structure changes (the
// subpath deployment moved from absolute to scope-relative offline URL).
const CACHE_NAME = "omi-shell-v2";
const OFFLINE_URL = new URL("offline.html", self.registration.scope).toString();

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Pre-cache the offline fallback so first-offline is covered.
      const cache = await caches.open(CACHE_NAME);
      await cache.add(OFFLINE_URL);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Purge caches from previous service worker versions.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isHashedAsset(url) {
  // Vite emits immutable, content-hashed bundles under the app's assets dir
  // (scope-relative: /assets/ at root, /omiuniversalai/assets/ on Pages).
  return (
    url.origin === self.location.origin &&
    url.pathname.startsWith(`${APP_BASE}assets/`) &&
    /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|svg|webp|ico|wasm)$/.test(
      url.pathname,
    )
  );
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      // Opportunistically keep the latest HTML for the offline fallback.
      cache.put(request, fresh.clone()).catch(() => {});
      return fresh;
    }
    // Static-host SPA miss (GitHub Pages answers 404) or server error:
    // serve the cached app shell for THIS url if seen before, else the
    // cached app root — React Router (with its basename) then renders the
    // correct route in place. Never cache the error page itself.
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // NOTE: Cache.match wants a Request or string — an URL object is not
    // RequestInfo in all implementations (found by the PWA test harness).
    const shell = await cache.match(
      new URL(APP_BASE, self.location.origin).toString(),
    );
    if (shell) return shell;
    return (await cache.match(OFFLINE_URL)) || fresh;
  } catch {
    // Offline: cached copy → app shell → offline page.
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const shell = await cache.match(
      new URL(APP_BASE, self.location.origin).toString(),
    );
    if (shell) return shell;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && (fresh.ok || fresh.type === "opaque")) {
    cache.put(request, fresh.clone()).catch(() => {});
  }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept non-http(s) or cross-origin traffic (Convex, providers).
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirstAsset(request));
    return;
  }

  // Everything else (incl. same-origin API calls) goes straight to network.
});
