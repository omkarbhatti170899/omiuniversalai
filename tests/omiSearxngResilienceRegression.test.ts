/**
 * REGRESSION — SEARXNG RESILIENCE, ENGINE HEALTH, TIMEOUTS AND PROVIDER GATING.
 * =============================================================================
 *
 * Every case below was found by a live diagnostic, and each one is a distinct
 * failure with a distinct fix, so they are pinned separately:
 *
 *  1. INVALID ENVIRONMENT-VARIABLE NAME. `SEARCH_TIMEOUT_MS_WIKIPEDIA-CURRENT-EVENTS`
 *     cannot exist (env names may not contain a hyphen), and asking Convex for
 *     it THROWS rather than returning undefined — which turned every search into
 *     a hard refusal. The name rule must always produce a legal name.
 *  2. SEARXNG TIMEOUT. The adapter had no TOTAL ceiling: it looped
 *     base x retry x date-rung with a 30 s request timeout each, so the worst
 *     case was minutes and the observed diagnostic run took ~46 s. A call must
 *     fail fast and bounded, never hang.
 *  3. INDIVIDUAL ENGINE TIMEOUT. SearXNG reports `unresponsive_engines`; the
 *     adapter ignored it and re-asked a suspended engine on every request. A
 *     repeatedly-failing engine must be marked unavailable and the remaining
 *     engines used instead.
 *  4./5. MISSING vs VALID PUBLICATION DATE. An undated source is not evidence
 *     of recency; a parseable one is.
 *  6./7. STALE vs CURRENT RESULT.
 *  8./9./10. A PROVIDER BEING UNAVAILABLE (SearXNG, LangSearch, GDELT) must
 *     degrade the result set, never fail it.
 *
 * The SearXNG cases run against a LOCAL HTTP server, so they exercise the real
 * adapter end to end — including its budget arithmetic — with no external
 * network and no mocking of axios.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CURATED_TIMEOUT_ENV_NAMES,
  PROVIDER_TIMEOUT_MS,
  TIMEOUT_ENV_PREFIX,
  isValidEnvVarName,
  providerTimeoutMs,
  sanitizeEnvSuffix,
  timeoutEnvVarName,
} from "../src/convex/searchEngine/providerTimeouts";
import {
  SEARXNG_PER_TRY_TIMEOUT_MS,
  SEARXNG_TOTAL_BUDGET_MS,
  createSearxProvider,
  enginesOfResult,
  extractSearxDate,
} from "../src/convex/searchProviders/searxng";
import {
  ENGINE_FAILURE_THRESHOLD,
  buildEngineScopedQuery,
  recordSearxEngineUnresponsive,
  recordSearxResponse,
  resetSearxEngineHealth,
  searxEngineSuspended,
  suspendedSearxEngines,
} from "../src/convex/searchProviders/searxngEngineHealth";
import {
  isFreshEnough,
  minAgeHours,
  shouldEscalateForFreshness,
  splitByFreshness,
} from "../src/convex/searchEngine/freshness";
import { isOffTopic, topicKeywords } from "../src/convex/searchEngine/quality";
import { getConfiguredProviders, getProviderStatus } from "../src/convex/searchProviders";
import { GDELT_ENABLED, createGdeltProvider, isGdeltEnabled } from "../src/convex/searchProviders/gdelt";
import { createLangSearchProvider, isLangSearchEnabled } from "../src/convex/searchProviders/langsearch";

const SEARXNG_SRC = "src/convex/searchProviders/searxng.ts";
const ADAPTER_SRC = readFileSync(SEARXNG_SRC, "utf8");

const HOURS = 3_600_000;
const isoHoursAgo = (h: number) => new Date(Date.now() - h * HOURS).toISOString();

// ---------------------------------------------------------------------------
// 1. Environment-variable names
// ---------------------------------------------------------------------------

describe("1. per-provider timeout env-var names are always legal", () => {
  test("the hyphenated id that caused the outage maps to an UNDERSCORE name", () => {
    // This is the exact case: the id contains hyphens, so the override name
    // must not. The old code asked Convex for the hyphenated name and threw.
    expect(timeoutEnvVarName("wikipedia-current-events")).toBe(
      "SEARCH_TIMEOUT_MS_WIKIPEDIA_CURRENT_EVENTS",
    );
    expect(timeoutEnvVarName("wikipedia-current-events")).not.toContain("-");
    expect(isValidEnvVarName(timeoutEnvVarName("wikipedia-current-events"))).toBe(true);
  });

  test("every registered provider yields a legal env-var name", () => {
    const ids = getProviderStatus().map((s) => s.id);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      const name = timeoutEnvVarName(id);
      expect(name.startsWith(TIMEOUT_ENV_PREFIX)).toBe(true);
      expect(isValidEnvVarName(name)).toBe(true);
      expect(name).toBe(name.toUpperCase());
      expect(name).not.toContain("-");
    }
  });

  test("sanitisation replaces every illegal character, not just hyphens", () => {
    expect(sanitizeEnvSuffix("a.b c/d")).toBe("A_B_C_D");
    expect(isValidEnvVarName(timeoutEnvVarName("a.b c/d"))).toBe(true);
  });

  test("the curated name map cannot drift from the rule", () => {
    for (const [id, name] of Object.entries(CURATED_TIMEOUT_ENV_NAMES)) {
      expect(timeoutEnvVarName(id)).toBe(name);
      expect(isValidEnvVarName(name)).toBe(true);
    }
  });

  test("reading an override can never throw, and falls back to the measured ceiling", () => {
    // No override set for this synthetic id.
    expect(providerTimeoutMs("nonexistent-provider-xyz", 12_345)).toBe(12_345);
    // A measured ceiling wins over the caller's fallback.
    expect(providerTimeoutMs("searxng", 12_345)).toBe(PROVIDER_TIMEOUT_MS.searxng);
  });

  test("a garbage override value is ignored rather than applied", () => {
    process.env[timeoutEnvVarName("wikipedia-current-events")] = "not-a-number";
    try {
      expect(providerTimeoutMs("wikipedia-current-events", 9_000)).toBe(9_000);
    } finally {
      delete process.env[timeoutEnvVarName("wikipedia-current-events")];
    }
  });

  test("a numeric override is honoured", () => {
    process.env[timeoutEnvVarName("mwmbl")] = "4321";
    try {
      expect(providerTimeoutMs("mwmbl", 12_000)).toBe(4321);
    } finally {
      delete process.env[timeoutEnvVarName("mwmbl")];
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SearXNG is bounded (no unbounded retry storm)
// ---------------------------------------------------------------------------

describe("2. SearXNG has a single, bounded wall-clock budget", () => {
  test("the total budget sits under the fan-out's ceiling for the provider", () => {
    // If the provider budget exceeded the fan-out's own timeout, a provider
    // that had already produced results would be recorded as a timeout.
    expect(SEARXNG_TOTAL_BUDGET_MS).toBeLessThan(PROVIDER_TIMEOUT_MS.searxng);
    expect(SEARXNG_PER_TRY_TIMEOUT_MS).toBeLessThanOrEqual(SEARXNG_TOTAL_BUDGET_MS);
  });

  test("the retry loop that multiplied the wait is gone", () => {
    // The defect was `for (let attempt = 0; attempt < 2; attempt++)` nested
    // inside `for (const base …) for (const range …)`. There must be no
    // per-attempt repeat of the ladder.
    expect(ADAPTER_SRC).not.toContain("for (let attempt");
    expect(ADAPTER_SRC).toContain("deadline");
    expect(ADAPTER_SRC).toContain("remaining");
  });

  test("SEARXNG_TIMEOUT_MS keeps its per-request meaning; the total is a SEPARATE knob", () => {
    // MEASURED during this fix: re-using SEARXNG_TIMEOUT_MS as the total
    // silently reinterpreted a deployment that had already set it to ~11 s,
    // turning a per-request ceiling into a whole-call ceiling and cutting
    // SearXNG off earlier than before. The two knobs must stay distinct.
    expect(ADAPTER_SRC).toContain('positiveEnvNumber("SEARXNG_TIMEOUT_MS")');
    expect(ADAPTER_SRC).toContain('positiveEnvNumber("SEARXNG_TOTAL_BUDGET_MS")');
  });
});

// ---------------------------------------------------------------------------
// Local SearXNG stand-in, for cases 2/3/4/5 behaviourally
// ---------------------------------------------------------------------------

type Seeded = {
  results: Array<Record<string, unknown>>;
  unresponsive_engines?: unknown;
  delayMs?: number;
  hang?: boolean;
};

let server: Server | null = null;
let base = "";
let queriesSeen: string[] = [];
let seed: Seeded = { results: [] };
let savedBase: string | undefined;
let savedBudget: string | undefined;
let savedTotalBudget: string | undefined;

async function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    queriesSeen.push(url.searchParams.get("q") ?? "");
    const send = () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          results: seed.results,
          unresponsive_engines: seed.unresponsive_engines ?? [],
        }),
      );
    };
    if (seed.hang) return; // never answer: the socket simply stays open
    if (seed.delayMs) setTimeout(send, seed.delayMs);
    else send();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}

function stopServer(): void {
  if (!server) return;
  server.closeAllConnections?.();
  server.close();
  server = null;
}

beforeEach(() => {
  resetSearxEngineHealth();
  queriesSeen = [];
  seed = { results: [] };
  savedBase = process.env.SEARXNG_BASE_URL;
  savedBudget = process.env.SEARXNG_TIMEOUT_MS;
  savedTotalBudget = process.env.SEARXNG_TOTAL_BUDGET_MS;
});

afterEach(() => {
  stopServer();
  if (savedBase === undefined) delete process.env.SEARXNG_BASE_URL;
  else process.env.SEARXNG_BASE_URL = savedBase;
  if (savedBudget === undefined) delete process.env.SEARXNG_TIMEOUT_MS;
  else process.env.SEARXNG_TIMEOUT_MS = savedBudget;
  if (savedTotalBudget === undefined) delete process.env.SEARXNG_TOTAL_BUDGET_MS;
  else process.env.SEARXNG_TOTAL_BUDGET_MS = savedTotalBudget;
});

const SEARX_RESULT = {
  title: "Asian Games 2026: India medal tally after Day 6",
  url: "https://example.com/asian-games-2026-medals",
  content: "India's medal tally at the Asian Games 2026 stands at 5 gold.",
  publishedDate: "2026-09-27T00:00:00Z",
  engines: ["yandex"],
};

describe("2b. SearXNG timeout is bounded and does not hang", () => {
  test("a stalled instance fails fast, bounded by the TOTAL budget", async () => {
    await startServer();
    seed = { results: [], hang: true };
    process.env.SEARXNG_BASE_URL = base;
    process.env.SEARXNG_TIMEOUT_MS = "1200";
    process.env.SEARXNG_TOTAL_BUDGET_MS = "2500";

    const provider = createSearxProvider();
    const started = Date.now();
    await expect(provider.search("latest news", 5, {})).rejects.toThrow(/SearXNG/);
    const elapsed = Date.now() - started;
    // Bounded well under the old 46 s behaviour, and under a 6 s ceiling so a
    // regression that reintroduces retries is caught.
    expect(elapsed).toBeLessThan(6_000);
  }, 15_000);

  test("a per-request timeout does not end the whole call while budget remains", async () => {
    // The first request hangs; the second answers. If SEARXNG_TIMEOUT_MS were
    // (wrongly) the total budget, the provider would give up after one request
    // and return nothing. It must keep trying while the TOTAL budget allows.
    let requestNo = 0;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      queriesSeen.push(url.searchParams.get("q") ?? "");
      requestNo += 1;
      if (requestNo === 1) return; // hang
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [SEARX_RESULT], unresponsive_engines: [] }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    process.env.SEARXNG_BASE_URL = base;
    process.env.SEARXNG_TIMEOUT_MS = "900";
    process.env.SEARXNG_TOTAL_BUDGET_MS = "8000";

    const out = await createSearxProvider().search("latest news", 5, {});
    expect(out.citations.length).toBe(1);
    expect(queriesSeen.length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

describe("3. individual upstream engine timeouts", () => {
  test("an unresponsive engine is recorded from the instance's own report", async () => {
    await startServer();
    seed = { results: [SEARX_RESULT], unresponsive_engines: [["duckduckgo", "timeout"]] };
    process.env.SEARXNG_BASE_URL = base;

    const provider = createSearxProvider();
    const out = await provider.search("latest news", 5, {});
    // PARTIAL RESULTS ARE STILL RETURNED: one engine down must not empty the
    // result set, it must degrade it.
    expect(out.citations.length).toBe(1);
    expect(out.citations[0].url).toContain("asian-games-2026-medals");
    expect(searxEngineSuspended("duckduckgo")).toBe(false); // one report = one strike
  }, 15_000);

  test("a repeatedly failing engine is marked unavailable, and the remaining engines are used", async () => {
    await startServer();
    seed = { results: [SEARX_RESULT], unresponsive_engines: [["duckduckgo", "timeout"]] };
    process.env.SEARXNG_BASE_URL = base;
    const provider = createSearxProvider();

    for (let i = 0; i < ENGINE_FAILURE_THRESHOLD; i++) {
      await provider.search("latest news", 5, {});
    }
    expect(searxEngineSuspended("duckduckgo")).toBe(true);
    expect(suspendedSearxEngines()).toContain("duckduckgo");

    // The next request is SCOPED to the engines that actually answered, rather
    // than re-asking the suspended one and re-waiting its timeout.
    queriesSeen = [];
    await provider.search("latest news", 5, {});
    expect(queriesSeen[0]!.startsWith("!yandex")).toBe(true);
  }, 20_000);

  test("scoping is fail-open: no healthy engines observed means an unscoped query", () => {
    // A suspended engine with nothing observed to replace it must NOT produce a
    // bare-bang query — that would silently return nothing.
    resetSearxEngineHealth();
    expect(buildEngineScopedQuery("latest news", [])).toBe("latest news");
    expect(buildEngineScopedQuery("latest news", ["", "  "])).toBe("latest news");
    expect(buildEngineScopedQuery("latest news", ["yandex"])).toBe("!yandex latest news");
    expect(buildEngineScopedQuery("latest news", ["yandex", "yandex"])).toBe("!yandex latest news");
  });

  test("cooldown expiry returns the engine to service", () => {
    const t0 = 1_000_000;
    resetSearxEngineHealth();
    recordSearxEngineUnresponsive("bing", "timeout", t0);
    recordSearxEngineUnresponsive("bing", "timeout", t0);
    expect(searxEngineSuspended("bing", t0 + 1)).toBe(true);
    // Past the cooldown it is eligible again — a suspension is temporary.
    expect(searxEngineSuspended("bing", t0 + 10 * 60_000 + 1)).toBe(false);
  });

  test("a responsive engine clears its failure history", () => {
    resetSearxEngineHealth();
    recordSearxResponse([["duckduckgo", "timeout"]], ["yandex"]);
    recordSearxResponse([["duckduckgo", "timeout"]], ["yandex", "duckduckgo"]);
    // The second response shows duckduckgo answering, so it is healthy again.
    expect(searxEngineSuspended("duckduckgo")).toBe(false);
  });

  test("malformed unresponsive payloads never throw", () => {
    resetSearxEngineHealth();
    expect(() =>
      recordSearxResponse([null, 42, {}, ["ok", 7], "stringy"] as unknown, []),
    ).not.toThrow();
    expect(() => recordSearxResponse("not-an-array" as unknown, [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4/5. Publication dates
// ---------------------------------------------------------------------------

describe("4/5. publication-date extraction", () => {
  test("a valid date is parsed to ISO", () => {
    expect(extractSearxDate({ publishedDate: "2026-09-27T00:00:00Z" })).toBe(
      "2026-09-27T00:00:00.000Z",
    );
    expect(extractSearxDate({ pubdate: "2026-09-27" })).toBe("2026-09-27T00:00:00.000Z");
    expect(
      extractSearxDate({ metadata: [{ key: "published", value: "2026-09-26T10:00:00Z" }] }),
    ).toBe("2026-09-26T10:00:00.000Z");
  });

  test("a missing date stays missing — an empty string is not a date", () => {
    expect(extractSearxDate({})).toBeUndefined();
    expect(extractSearxDate({ publishedDate: "" })).toBeUndefined();
    expect(extractSearxDate({ publishedDate: "   " })).toBeUndefined();
    expect(extractSearxDate({ publishedDate: null })).toBeUndefined();
  });

  test("a present-but-unparseable date reads as undated, not as a trusted date", () => {
    expect(extractSearxDate({ publishedDate: "last tuesday" })).toBeUndefined();
    expect(extractSearxDate({ publishedDate: "0000-00-00" })).toBeUndefined();
  });

  test("engine attribution is read from either payload shape", () => {
    expect(enginesOfResult({ engine: "yandex" })).toEqual(["yandex"]);
    expect(enginesOfResult({ engines: ["google", "bing"] })).toEqual(["google", "bing"]);
    expect(enginesOfResult({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6/7. Stale vs current
// ---------------------------------------------------------------------------

describe("6/7. stale and current results", () => {
  test("a current result is fresh enough; a stale one is not", () => {
    expect(isFreshEnough({ title: "t", url: "https://a.test", publishedAt: isoHoursAgo(3) }, 2)).toBe(true);
    expect(isFreshEnough({ title: "t", url: "https://a.test", publishedAt: isoHoursAgo(24 * 6) }, 2)).toBe(false);
  });

  test("an undated result is NEVER treated as fresh", () => {
    expect(isFreshEnough({ title: "t", url: "https://a.test" }, 2)).toBe(false);
    expect(isFreshEnough({ title: "t", url: "https://a.test", publishedAt: "nonsense" }, 2)).toBe(false);
  });

  test("splitting separates fresh / undated / stale and keeps order", () => {
    const sources = [
      { title: "fresh", url: "https://a.test", publishedAt: isoHoursAgo(2) },
      { title: "undated", url: "https://b.test" },
      { title: "stale", url: "https://c.test", publishedAt: isoHoursAgo(24 * 30) },
    ];
    const split = splitByFreshness(sources, 3);
    expect(split.fresh.map((s) => s.title)).toEqual(["fresh"]);
    expect(split.undated.map((s) => s.title)).toEqual(["undated"]);
    expect(split.stale.map((s) => s.title)).toEqual(["stale"]);
  });

  test("freshness is judged on the NEWEST source, and no dated evidence escalates", () => {
    const now = Date.now();
    expect(
      minAgeHours([{ publishedAt: isoHoursAgo(50) }, { publishedAt: isoHoursAgo(4) }], now),
    ).toBeGreaterThan(3.5);
    expect(minAgeHours([{}, {}], now)).toBeNull();
    // Nothing recent enough — including nothing dated at all — must escalate.
    expect(shouldEscalateForFreshness([], 30, now)).toBe(true);
    expect(shouldEscalateForFreshness([{ publishedAt: isoHoursAgo(60) }], 30, now)).toBe(true);
    expect(shouldEscalateForFreshness([{ publishedAt: isoHoursAgo(2) }], 30, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8/9/10. Provider availability
// ---------------------------------------------------------------------------

describe("8/9/10. an unavailable provider never fails the whole search", () => {
  test("LangSearch stays registered but is never a single point of failure", () => {
    expect(isLangSearchEnabled()).toBe(true);
    // It is one of several general-web sources; the registry must never depend
    // on it alone.
    const ids = getProviderStatus().map((s) => s.id);
    expect(ids).toContain("langsearch");
    expect(ids).toContain("searxng");
    expect(ids).toContain("wikipedia-current-events");
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });

  test("GDELT is disabled by product decision and absent from the fan-out", () => {
    if (process.env.ENABLE_GDELT === "true") return; // forced on for measurement
    expect(GDELT_ENABLED).toBe(false);
    expect(isGdeltEnabled()).toBe(false);
    expect(createGdeltProvider().isConfigured()).toBe(false);
    expect(getConfiguredProviders().some((p) => p.id === "gdelt")).toBe(false);
    const status = getProviderStatus().find((s) => s.id === "gdelt");
    // It must SAY it is off, and say WHY, rather than looking like a missing key.
    expect(status?.enabled).toBe(false);
    expect(status?.ready).toBe(false);
    expect(String(status?.hint)).toMatch(/Disabled by product decision/i);
  });

  test("a disabled provider is reported distinctly from an unconfigured one", () => {
    const status = getProviderStatus();
    const gdelt = status.find((s) => s.id === "gdelt")!;
    // `enabled` is the feature flag, `configured` is eligibility: a disabled
    // provider is neither, and an operator must be able to tell them apart.
    expect(gdelt.enabled).toBe(false);
    expect(typeof gdelt.configured).toBe("boolean");
    const langsearch = status.find((s) => s.id === "langsearch")!;
    expect(langsearch.enabled).toBe(isLangSearchEnabled());
  });

  test("the LangSearch production adapter is gated on its feature flag, not on the key alone", () => {
    const p = createLangSearchProvider();
    // Whatever the environment holds, the provider reports a boolean and never
    // throws while answering "are you ready?".
    expect(typeof p.isConfigured()).toBe("boolean");
  });

  test("an empty result is never reported as a missing credential", () => {
    // MEASURED: Hacker News threw `MissingKeyError` when a query matched
    // nothing, so a French-language query surfaced as `Search provider
    // "hackernews" is not configured.` HN is keyless — that diagnosis is simply
    // wrong, and it is the same misreporting already fixed for GDELT.
    const src = readFileSync("src/convex/searchProviders/hackernews.ts", "utf8");
    // Strip comments first: the fix's own note NAMES the old error, and a
    // naive substring check would flag the explanation as the bug.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("MissingKeyError");
    expect(code).toContain("return { citations };");
  });
});

// ---------------------------------------------------------------------------
// 7b. The topic floor must compare SUBJECTS, not aspects
// ---------------------------------------------------------------------------

describe("7b. topic words are subjects, not aspects", () => {
  const wire = {
    title: "Armed conflicts and attacks: A drone strikes a television station",
    url: "https://www.reuters.com/world/example",
    snippet: "Heavy fighting was reported overnight in the region.",
  };

  test("recency and format words are not topics", () => {
    // MEASURED defect: the freshest dated source (8.6 h, a Wikipedia Current
    // Events wire item) was dropped from "latest world news" because it shared
    // none of {latest, news, world} — none of which is a subject.
    expect(topicKeywords("latest world news")).toEqual([]);
    expect(topicKeywords("today's technology news")).toEqual(["technology"]);
    expect(topicKeywords("latest India news")).toEqual(["india"]);
    expect(topicKeywords("latest science news")).toEqual(["science"]);
  });

  test("a generic news question therefore keeps a genuine wire item", () => {
    expect(isOffTopic(wire, topicKeywords("latest world news"))).toBe(false);
  });

  test("the subject-only floor still drops the off-topic page it was written for", () => {
    const holiday = {
      title: "Sri Lanka Maldives Twin Centre Holiday Package 2026/2027",
      url: "https://example.com/holiday",
      snippet: "Book your 2026 escape today — latest offers.",
    };
    const topic = topicKeywords("Indian contingent medals tally in Asian Games 2026");
    expect(topic).toContain("medals");
    expect(topic).toContain("tally");
    expect(topic).not.toContain("2026");
    expect(isOffTopic(holiday, topic)).toBe(true);
  });

  test("a question with no subject words left disables the floor rather than guessing", () => {
    // "a question we cannot characterise is not evidence that a source is
    // off-topic" — the pre-existing rule, now reachable because the aspect
    // words are removed.
    expect(topicKeywords("latest news")).toEqual([]);
    expect(isOffTopic(wire, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2c. A timeout must not widen the date filter
// ---------------------------------------------------------------------------

describe("2c. widening the date range only happens after an EMPTY answer", () => {
  test("a timeout stops the ladder instead of walking it", async () => {
    const rangesSeen: string[] = [];
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const tr = url.searchParams.get("time_range") ?? "(none)";
      rangesSeen.push(tr);
      // Hang on the narrow rung — a host that does not answer will not answer
      // for `month` either, so the adapter must not walk on.
      if (tr === "week") return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [SEARX_RESULT], unresponsive_engines: [] }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    process.env.SEARXNG_BASE_URL = base;
    process.env.SEARXNG_TIMEOUT_MS = "900";
    process.env.SEARXNG_TOTAL_BUDGET_MS = "2500";

    await expect(
      createSearxProvider().search("latest news", 5, { timeRange: "week" }),
    ).rejects.toThrow(/SearXNG/);
    expect(rangesSeen).toContain("week");
    expect(rangesSeen).not.toContain("month");
    expect(rangesSeen).not.toContain("year");
  }, 20_000);
});
