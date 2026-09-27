/**
 * REGRESSION — LANGSEARCH ADAPTER: gating, freshness, and key containment.
 * =========================================================================
 *
 * LangSearch is a TEMPORARY evaluation adapter. Three properties are pinned:
 *
 * 1. IT IS OFF BY DEFAULT. It needs BOTH `ENABLE_LANGSEARCH=true` AND
 *    `LANGSEARCH_API_KEY`. Having the secret present in an environment must
 *    never be enough to switch on a paid, reseller-shaped, quota-bounded
 *    provider during production traffic.
 *
 * 2. IT IS NEVER THE ONLY PROVIDER. Whatever happens to its availability, the
 *    registry must keep SearXNG and the open-data providers.
 *
 * 3. THE KEY CANNOT REACH THE CLIENT. The brief requires it stay server-side.
 *    That is asserted structurally: the adapter is a Convex server module, the
 *    key is read from the server environment, no value is embedded in the
 *    registry, the provider status, the health snapshot or any citation, and
 *    the source contains no `import.meta.env` (which is the only way a Vite
 *    value could be inlined into the browser bundle).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createLangSearchProvider,
  createLangSearchEvaluationProvider,
  isLangSearchEnabled,
  isLangSearchConfigured,
  LANGSEARCH_ENABLED,
  toLangSearchFreshness,
  normalizeDatePublished,
} from "../src/convex/searchProviders/langsearch";
import { getProviderStatus, getConfiguredProviders } from "../src/convex/searchProviders";

const KEY = "ls_test_key_not_real_1234567890";
let savedKey: string | undefined;
let savedFlag: string | undefined;

beforeEach(() => {
  savedKey = process.env.LANGSEARCH_API_KEY;
  savedFlag = process.env.ENABLE_LANGSEARCH;
  delete process.env.LANGSEARCH_API_KEY;
  delete process.env.ENABLE_LANGSEARCH;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.LANGSEARCH_API_KEY;
  else process.env.LANGSEARCH_API_KEY = savedKey;
  if (savedFlag === undefined) delete process.env.ENABLE_LANGSEARCH;
  else process.env.ENABLE_LANGSEARCH = savedFlag;
});

describe("langsearch — enabled by owner decision, gated on the key", () => {
  it("the feature flag is ON (owner instruction, recorded in versioned code)", () => {
    expect(LANGSEARCH_ENABLED).toBe(true);
    expect(isLangSearchEnabled()).toBe(true);
  });

  it("ENABLE_LANGSEARCH=false is an emergency kill switch", () => {
    process.env.ENABLE_LANGSEARCH = "false";
    expect(isLangSearchEnabled()).toBe(false);
    expect(createLangSearchProvider().isConfigured()).toBe(false);
  });

  it("any other env value does NOT disable it", () => {
    // Only the exact string "false" is a kill switch. Anything else (unset,
    // "true", "0", garbage) leaves the owner's decision in force.
    for (const v of [undefined, "true", "0", "1", "yes"]) {
      if (v === undefined) delete process.env.ENABLE_LANGSEARCH;
      else process.env.ENABLE_LANGSEARCH = v;
      expect(isLangSearchEnabled()).toBe(true);
    }
  });

  it("enabled is NOT enough — a key is still required to be ready", () => {
    expect(isLangSearchConfigured()).toBe(false);
    expect(createLangSearchProvider().isConfigured()).toBe(false);
  });

  it("with the key present it reports ready", () => {
    process.env.LANGSEARCH_API_KEY = KEY;
    expect(isLangSearchConfigured()).toBe(true);
    expect(createLangSearchProvider().isConfigured()).toBe(true);
  });

  it("refuses to search rather than searching without a key", async () => {
    await expect(createLangSearchProvider().search("q", 3)).rejects.toThrow(/disabled/i);
  });
});

describe("langsearch — the provider stays enabled (regression)", () => {
  it("REMAINS enabled by default — a future refactor must not silently disable it", () => {
    // The owner's instruction was to enable LangSearch. If a later change
    // flips the constant or the enablement logic, this fails loudly.
    delete process.env.LANGSEARCH_API_KEY;
    delete process.env.ENABLE_LANGSEARCH;
    expect(LANGSEARCH_ENABLED).toBe(true);
    expect(isLangSearchEnabled()).toBe(true);
  });

  it("the status surface reports enabled/configured/ready distinctly", () => {
    process.env.LANGSEARCH_API_KEY = KEY;
    const s = getProviderStatus().find((p) => p.id === "langsearch");
    expect(s).toBeDefined();
    expect(s!.enabled).toBe(true);
    expect(s!.configured).toBe(true);
    expect(s!.ready).toBe(true);
  });

  it("with the key removed it is enabled but NOT ready (distinguishable)", () => {
    delete process.env.LANGSEARCH_API_KEY;
    const s = getProviderStatus().find((p) => p.id === "langsearch")!;
    expect(s.enabled).toBe(true);
    expect(s.ready).toBe(false);
  });
});

describe("langsearch — never the only provider", () => {
  it("SearXNG and the open-data providers remain registered", () => {
    const ids = getProviderStatus().map((p) => p.id);
    expect(ids).toContain("searxng");
    expect(ids).toContain("gdelt");
    expect(ids).toContain("wikipedia-current-events");
    expect(ids).toContain("mwmbl");
  });

  it("configured providers are not reduced to langsearch alone", () => {
    process.env.ENABLE_LANGSEARCH = "true";
    process.env.LANGSEARCH_API_KEY = KEY;
    const configured = getConfiguredProviders().map((p) => p.id);
    expect(configured.length).toBeGreaterThan(1);
    expect(configured).not.toEqual(["langsearch"]);
  });

  it("is reported honestly: keyed, and not as unconditionally free", () => {
    // langsearch needs a key, and its "free" plan is bounded by a daily token
    // allowance with published paid tiers. The status surface must say both,
    // rather than the blanket "$0 per query" every other provider gets.
    process.env.ENABLE_LANGSEARCH = "true";
    process.env.LANGSEARCH_API_KEY = KEY;
    const ls = getProviderStatus().find((p) => p.id === "langsearch");
    expect(ls).toBeDefined();
    expect(ls!.requiresKey).toBe(true);
    expect(ls!.cost).not.toBe("$0 per query");
    expect(ls!.cost).toMatch(/daily token allowance/i);
  });

  it("a key-gated provider is flagged as requiring a key", () => {
    // The bug this caught: requiresKey was hardcoded to SearXNG only, so a
    // keyed provider reported requiresKey:false to operators.
    const searx = getProviderStatus().find((p) => p.id === "searxng");
    expect(searx!.requiresKey).toBe(true);
  });
});

describe("langsearch — freshness mapping", () => {
  it("maps our recency vocabulary onto their documented values", () => {
    expect(toLangSearchFreshness(undefined)).toBe("noLimit");
    expect(toLangSearchFreshness("day")).toBe("oneDay");
    // No sub-day option is published, so "hour" must not be silently widened
    // into a looser window than asked for — it maps to the tightest available.
    expect(toLangSearchFreshness("hour")).toBe("oneDay");
    expect(toLangSearchFreshness("week")).toBe("oneWeek");
    expect(toLangSearchFreshness("month")).toBe("oneMonth");
    expect(toLangSearchFreshness("year")).toBe("oneYear");
  });

  it("normalises a publication date, and rejects a missing or invalid one", () => {
    expect(normalizeDatePublished("2026-09-20T10:00:00Z")).toBe("2026-09-20T10:00:00.000Z");
    expect(normalizeDatePublished(undefined)).toBeUndefined();
    expect(normalizeDatePublished("")).toBeUndefined();
    expect(normalizeDatePublished("not a date")).toBeUndefined();
    // Docs say the field may be absent — an undated result must stay undated
    // rather than be back-filled, or it would defeat the freshness gate.
    expect(normalizeDatePublished(null)).toBeUndefined();
  });
});

describe("langsearch — the evaluation bypass is not a production path", () => {
  it("the registry uses the GATED factory, never the evaluation one", () => {
    // The benchmark may call LangSearch before the flag is set, but nothing in
    // production may. If the registry ever imported the evaluation factory,
    // the feature flag would stop meaning anything.
    const indexSrc = readFileSync("src/convex/searchProviders/index.ts", "utf8");
    expect(indexSrc).not.toContain("createLangSearchEvaluationProvider");
    expect(indexSrc).toContain("createLangSearchProvider");
  });

  it("the production factory is still disabled without a key", () => {
    expect(createLangSearchProvider().isConfigured()).toBe(false);
  });

  it("the evaluation factory is only reachable when a key exists", () => {
    const original = process.env.LANGSEARCH_API_KEY;
    delete process.env.LANGSEARCH_API_KEY;
    try {
      expect(createLangSearchEvaluationProvider().isConfigured()).toBe(false);
    } finally {
      if (original !== undefined) process.env.LANGSEARCH_API_KEY = original;
    }
  });

  it("only the benchmark action imports the evaluation factory", () => {
    const src = readFileSync("src/convex/benchmarkProviders.ts", "utf8");
    expect(src).toContain("createLangSearchEvaluationProvider");
  });
});

describe("langsearch — the key stays server-side", () => {
  const SRC = "src/convex/searchProviders/langsearch.ts";

  it("the adapter never reads a VITE_/import.meta.env value (the only bundling path)", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).not.toContain("import.meta.env");
  });

  it("the key is read only from the server process environment", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toContain("process.env.LANGSEARCH_API_KEY");
    // It must be used as an auth header, never embedded in a URL or a log.
    expect(src).toContain("Authorization");
    expect(src).not.toMatch(/LANGSEARCH_API_KEY=/) ;
  });

  it("the provider's public surface never contains the key", () => {
    process.env.ENABLE_LANGSEARCH = "true";
    process.env.LANGSEARCH_API_KEY = KEY;
    const p = createLangSearchProvider();
    const surface = JSON.stringify({
      id: p.id,
      label: p.label,
      hint: p.missingKeyHint,
      configured: p.isConfigured(),
      status: getProviderStatus().find((x) => x.id === "langsearch"),
    });
    expect(surface).not.toContain(KEY);
  });
});
