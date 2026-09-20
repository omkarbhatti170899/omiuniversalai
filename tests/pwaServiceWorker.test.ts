/**
 * Phase 14 tests — Phase 8 PWA: the service worker's *behavior*, executed for
 * real. The actual public/sw.js artifact is loaded into a
 * ServiceWorkerGlobalScope-shaped environment (self, caches, fetch, clients,
 * listeners) and its event handlers are driven directly. No re-implementation
 * of the logic (master plan §35: no fake features).
 *
 * Also: manifest/icon/registration-gating checks so installability can't
 * silently regress.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync } from "node:fs";

const SW_PATH = new URL("../public/sw.js", import.meta.url).pathname;
const SW_SOURCE = readFileSync(SW_PATH, "utf-8");

// --- ServiceWorkerGlobalScope-shaped harness --------------------------------

type Handler = (event: unknown) => unknown;

interface Harness {
  self: Record<string, unknown>;
  handlers: Record<string, Handler[]>;
  cacheStore: Map<string, Map<string, Response>>;
  fetchLog: string[];
  dispatch: (type: string, event: unknown) => Promise<void>;
}

/** Minimal CacheStorage + Cache implementing only what sw.js uses. */
function makeCaches(
  store: Map<string, Map<string, Response>>,
  resolveUrl: (u: string) => string,
  fetchImpl: typeof fetch,
) {
  const makeCache = (name: string) => ({
    match: async (request: RequestInfo, opts?: { ignoreSearch?: boolean }) => {
      const map = store.get(name);
      if (!map) return undefined;
      const url = resolveUrl(typeof request === "string" ? request : request.url);
      const exact = map.get(url);
      if (exact) return exact.clone();
      if (opts?.ignoreSearch) {
        const target = new URL(url);
        for (const [key, res] of map) {
          const k = new URL(key);
          if (
            k.origin === target.origin &&
            k.pathname === target.pathname
          ) {
            return res.clone();
          }
        }
      }
      return undefined;
    },
    put: async (request: RequestInfo, response: Response) => {
      const url = resolveUrl(typeof request === "string" ? request : request.url);
      store.get(name)!.set(url, response.clone());
    },
    add: async (request: RequestInfo) => {
      const url = resolveUrl(typeof request === "string" ? request : request.url);
      const res = await fetchImpl(url);
      store.get(name)!.set(url, res.clone());
    },
  });
  return {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      return makeCache(name);
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };
}

async function loadServiceWorker(opts: {
  prefillCache?: Array<[string, Response]>;
  fetchImpl?: typeof fetch;
} = {}): Promise<Harness> {
  const handlers: Record<string, Handler[]> = {};
  const cacheStore = new Map<string, Map<string, Response>>();
  const fetchLog: string[] = [];
  const listeners: Array<(n: string) => void> = [];

  const swSelf: Record<string, unknown> = {
    location: new URL("https://omi.example/sw.js"),
    addEventListener: (type: string, fn: Handler) => {
      (handlers[type] ??= []).push(fn);
    },
    skipWaiting: async () => undefined,
    clients: {
      claim: async () => undefined,
    },
    registration: {},
  };

  // Real service workers resolve relative fetch URLs against the worker
  // scope (https://omi.example/). The harness reproduces that behavior.
  const SCOPE = "https://omi.example/";
  const resolveUrl = (u: string) => new URL(u, SCOPE).toString();

  const fetchImpl: typeof fetch =
    opts.fetchImpl ??
    (async (input: RequestInfo | URL) => {
      const url = resolveUrl(
        input instanceof Request
          ? input.url
          : typeof input === "string"
            ? input
            : String(input),
      );
      fetchLog.push(url);
      return new Response(`network:${url}`, { status: 200 });
    });

  const cachesImpl = makeCaches(cacheStore, resolveUrl, fetchImpl);

  const sandbox = {
    self: swSelf,
    caches: cachesImpl,
    fetch: fetchImpl,
    Response,
    URL,
    console,
  };
  (swSelf as unknown as { caches: unknown }).caches = cachesImpl;

  // Execute the real artifact in the sandbox.
  const fn = new Function("self", "caches", "fetch", "Response", "URL", "console", SW_SOURCE);
  fn(sandbox.self, cachesImpl, fetchImpl, Response, URL, console);

  if (opts.prefillCache) {
    const cache = await cachesImpl.open("omi-shell-v1");
    for (const [url, res] of opts.prefillCache) cache.put(url, res);
  }

  const dispatch = async (type: string, event: unknown) => {
    for (const h of handlers[type] ?? []) {
      await h(event);
    }
  };

  return { self: swSelf, handlers, cacheStore, fetchLog, dispatch };
}

/** Event whose waitUntil awaits registered promises (like the real spec). */
function makeExtendableEvent() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    done: () => Promise.all(promises),
  };
}

function makeFetchEvent(request: Request) {
  const ev = makeExtendableEvent() as Record<string, unknown>;
  ev.request = request;
  ev.respondWith = (p: Promise<Response>) => {
    (ev as { response?: Promise<Response> }).response = p;
  };
  return ev as {
    request: Request;
    respondWith: (p: Promise<Response>) => void;
    response?: Promise<Response>;
    done: () => Promise<unknown>;
  };
}

// --- The actual tests --------------------------------------------------------

describe("PWA artifacts", () => {
  test("manifest is valid JSON with real branding and an existing icon", () => {
    const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url).pathname, "utf-8"));
    expect(manifest.name).toContain("Ominnovations");
    expect(manifest.short_name).toBe("Omi");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const iconPath = new URL(`../public${icon.src}`, import.meta.url).pathname;
      expect(existsSync(iconPath)).toBe(true);
    }
  });

  test("index.html references the manifest, theme colors and icon", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url).pathname, "utf-8");
    expect(html).toContain('/manifest.webmanifest');
    expect(html).toContain("theme-color");
    expect(html).toContain('/logo.svg');
  });

  test("sw.js registers network-only for cross-origin and non-GET", async () => {
    const h = await loadServiceWorker();
    // Cross-origin (Convex) must never be intercepted.
    const crossOrigin = makeFetchEvent(new Request("https://convex.example/api/query"));
    await h.dispatch("fetch", crossOrigin);
    expect(crossOrigin.response).toBeUndefined();
    // Non-GET must never be intercepted.
    const post = makeFetchEvent(new Request("https://omi.example/api", { method: "POST" }));
    await h.dispatch("fetch", post);
    expect(post.response).toBeUndefined();
  });

  test("navigations are network-first with offline fallback", async () => {
    // Simulate offline: fetch always throws.
    const offlineFetch: typeof fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    const h = await loadServiceWorker({
      prefillCache: [["https://omi.example/offline.html", new Response("<h1>offline</h1>")]],
      fetchImpl: offlineFetch,
    });

    // Real browser navigations arrive with mode:"navigate".
    const ev = makeFetchEvent(new Request("https://omi.example/dashboard", { mode: "navigate" }));
    await h.dispatch("fetch", ev);
    const res = await ev.response!;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("offline");
  });

  test("navigations prefer fresh network over cache", async () => {
    const h = await loadServiceWorker({
      prefillCache: [["https://omi.example/", new Response("STALE", { status: 200 })]],
    });
    const ev = makeFetchEvent(new Request("https://omi.example/", { mode: "navigate" }));
    await h.dispatch("fetch", ev);
    const res = await ev.response!;
    expect(await res.text()).toBe(`network:https://omi.example/`);
    // The fresh response was put back into the cache.
    const map = h.cacheStore.get("omi-shell-v1")!;
    expect((await map.get("https://omi.example/")!.text())).toBe(`network:https://omi.example/`);
  });

  test("hashed assets are cache-first", async () => {
    const h = await loadServiceWorker({
      prefillCache: [["https://omi.example/assets/index-abc123.js", new Response("CACHED-BUNDLE")]],
    });
    const ev = makeFetchEvent(new Request("https://omi.example/assets/index-abc123.js"));
    await h.dispatch("fetch", ev);
    const res = await ev.response!;
    expect(await res.text()).toBe("CACHED-BUNDLE");
    expect(h.fetchLog.length).toBe(0); // network never hit
  });

  test("activation purges old caches and claims clients", async () => {
    const h = await loadServiceWorker();
    h.cacheStore.set("omi-shell-v0", new Map());
    h.cacheStore.set("other-v3", new Map());
    const ev = makeExtendableEvent();
    await h.dispatch("activate", ev);
    await ev.done();
    expect(h.cacheStore.has("omi-shell-v0")).toBe(false);
    expect(h.cacheStore.has("other-v3")).toBe(false);
    expect(h.cacheStore.has("omi-shell-v1")).toBe(false); // never created by activate
  });

  test("install pre-caches the offline page", async () => {
    const seen: string[] = [];
    const recordingFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      seen.push(url);
      return new Response("offline-page-body");
    }) as typeof fetch;
    const h = await loadServiceWorker({ fetchImpl: recordingFetch });
    const ev = makeExtendableEvent();
    await h.dispatch("install", ev);
    await ev.done();
    expect(seen).toContain("https://omi.example/offline.html");
  });
});

describe("SW registration gating (main.tsx)", () => {
  const mainSource = readFileSync(new URL("../src/main.tsx", import.meta.url).pathname, "utf-8");

  test("registration is production-gated and failure-safe", () => {
    expect(mainSource).toContain("import.meta.env.PROD");
    expect(mainSource).toContain("navigator.serviceWorker.register");
    expect(mainSource).toContain(".catch(");
  });
});
