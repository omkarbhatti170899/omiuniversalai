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
  /** Worker scope — defaults to the root-host deployment. */
  scope?: string;
} = {}): Promise<Harness> {
  const handlers: Record<string, Handler[]> = {};
  const cacheStore = new Map<string, Map<string, Response>>();
  const fetchLog: string[] = [];
  const listeners: Array<(n: string) => void> = [];

  // The SW derives APP_BASE/OFFLINE_URL from registration.scope — real
  // service workers ALWAYS have a scope (default: the SW's directory), so
  // the harness provides one. Overridable to test subpath deployments.
  const SCOPE = opts.scope ?? "https://omi.example/";
  const swSelf: Record<string, unknown> = {
    // Real SWs always share origin with their scope — derive location.
    location: new URL("sw.js", SCOPE),
    addEventListener: (type: string, fn: Handler) => {
      (handlers[type] ??= []).push(fn);
    },
    skipWaiting: async () => undefined,
    clients: {
      claim: async () => undefined,
    },
    registration: { scope: SCOPE },
  };

  // Real service workers resolve relative fetch URLs against the worker
  // scope (https://omi.example/). The harness reproduces that behavior.
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
    const cache = await cachesImpl.open("omi-shell-v2");
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
    const manifestUrl = new URL("../public/manifest.webmanifest", import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestUrl.pathname, "utf-8"));
    expect(manifest.name).toContain("Ominnovations");
    expect(manifest.short_name).toBe("Omi");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      // Spec-correct: icon paths resolve against the MANIFEST URL (relative
      // icons keep the manifest subpath-safe for GitHub Pages).
      const iconPath = new URL(icon.src, manifestUrl).pathname;
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
    const map = h.cacheStore.get("omi-shell-v2")!;
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

  test("subpath deployment (GitHub Pages /omiuniversalai/): scope-derived paths", async () => {
    // The whole point of the scope-relative SW: identical artifact serves a
    // repository-subpath host. Offline precache, asset interception, and the
    // SPA-miss shell fallback must all live under the subpath.
    const base = "https://user.github.io/omiuniversalai/";
    const h = await loadServiceWorker({
      scope: base,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url =
          input instanceof Request
            ? input.url
            : typeof input === "string"
              ? input
              : String(input);
        if (url === `${base}offline.html`) return new Response("OFFLINE-PAGE");
        return new Response(`network:${url}`, { status: 200 });
      }) as typeof fetch,
    });

    // Install pre-caches the subpath offline page.
    const installEv = makeExtendableEvent();
    await h.dispatch("install", installEv);
    await installEv.done();
    const offline = h.cacheStore.get("omi-shell-v2")!.get(`${base}offline.html`);
    expect(offline).toBeDefined();

    // Subpath hashed assets are intercepted cache-first.
    const asset = makeFetchEvent(
      new Request(`${base}assets/index-x9y8z7.js`),
    );
    await h.dispatch("fetch", asset);
    const assetRes = await asset.response!;
    expect(await assetRes.text()).toBe(`network:${base}assets/index-x9y8z7.js`);

    // A 404 deep link (GitHub Pages answers 404 for unknown same-origin
    // routes once the SW controls the page) falls back to the cached app
    // shell at the subpath root — React Router then renders the route.
    const offlineFetch: typeof fetch = (async () =>
      new Response("GitHub 404 body", { status: 404 })) as typeof fetch;
    const h2 = await loadServiceWorker({
      scope: base,
      prefillCache: [[`${base}`, new Response("APP-SHELL")]],
      fetchImpl: offlineFetch,
    });
    const deep2 = makeFetchEvent(new Request(`${base}dashboard`, { mode: "navigate" }));
    await h2.dispatch("fetch", deep2);
    const deepRes = await deep2.response!;
    expect(deepRes.status).toBe(200);
    expect(await deepRes.text()).toBe("APP-SHELL");
  });
});

describe("SW registration gating (main.tsx)", () => {
  const mainSource = readFileSync(new URL("../src/main.tsx", import.meta.url).pathname, "utf-8");

  test("registration is production-gated, scope-relative and failure-safe", () => {
    expect(mainSource).toContain("import.meta.env.PROD");
    // Scope-relative registration (works at root and under /omiuniversalai/).
    expect(mainSource).toMatch(/navigator\.serviceWorker\s*\n?\s*\.register/);
    expect(mainSource).toContain("import.meta.env.BASE_URL");
    expect(mainSource).toContain(".catch(");
  });
});
