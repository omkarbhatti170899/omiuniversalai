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

const CACHE_NAME = "omi-shell-v1";
const OFFLINE_URL = "/offline.html";

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
  // Vite emits immutable, content-hashed bundles under /assets/.
  return (
    url.origin === self.location.origin &&
    url.pathname.startsWith("/assets/") &&
    /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|svg|webp|ico|wasm)$/.test(
      url.pathname,
    )
  );
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    // Opportunistically keep the latest HTML for the offline fallback.
    cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
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
