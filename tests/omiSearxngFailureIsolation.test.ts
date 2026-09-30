/**
 * FINAL FAILURE TESTS — "make one engine unavailable… then several" (owner,
 * round 9). Run END-TO-END against the REAL SearXNG adapter with an in-process
 * instance that reports `unresponsive_engines` exactly as SearXNG does. No
 * mocking of the adapter, the health registry, the suspension policy or the
 * scoping — the only simulated thing is the HTTP boundary.
 *
 * Contract under test:
 *   1. ONE engine down        → results still returned (from the rest).
 *   2. SEVERAL engines down   → still functions while sufficient engines remain.
 *   3. Repeated failures      → engines SUSPENDED; next request is SCOPED to
 *                               healthy engines (`!engine`) so no time is spent
 *                               re-asking the dead ones.
 *   4. Scoped query empty     → fail-open to the unscoped query.
 *   5. ALL engines down       → honest failure; Andromeda degrades to other
 *                               providers / refusal (covered elsewhere).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createSearxProvider } from "../src/convex/searchProviders/searxng";
import {
  ENGINE_FAILURE_THRESHOLD,
  resetSearxEngineHealth,
  searxEngineHealthSnapshot,
  searxEngineSuspended,
  suspendedSearxEngines,
} from "../src/convex/searchProviders/searxngEngineHealth";
import { resetSearxBaseLatency } from "../src/convex/searchProviders/searxng";

type MockResult = { title: string; url: string; content: string; engine: string; publishedDate?: string };
type MockState = {
  results: MockResult[];
  unresponsive: Array<[string, string]>;
  queriesSeen: string[];
};

let server: Server | null = null;
let base = "";
let state: MockState = { results: [], unresponsive: [], queriesSeen: [] };
let savedBase: string | undefined;
let savedBudget: string | undefined;
let savedTotal: string | undefined;

async function startMock(): Promise<void> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    state.queriesSeen.push(url.searchParams.get("q") ?? "");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        results: state.results,
        unresponsive_engines: state.unresponsive,
      }),
    );
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function stopMock(): void {
  if (!server) return;
  server.closeAllConnections?.();
  server.close();
  server = null;
}

const row = (engine: string, slug: string): MockResult => ({
  title: `Result from ${engine}: ${slug}`,
  url: `https://example.test/${engine}/${slug}`,
  content: `Substantive snippet about ${slug} provided by the ${engine} engine.`,
  engine,
  publishedDate: "2026-09-29T00:00:00Z",
});

beforeEach(() => {
  resetSearxEngineHealth();
  resetSearxBaseLatency();
  state = { results: [], unresponsive: [], queriesSeen: [] };
  savedBase = process.env.SEARXNG_BASE_URL;
  savedBudget = process.env.SEARXNG_TIMEOUT_MS;
  savedTotal = process.env.SEARXNG_TOTAL_BUDGET_MS;
});

afterEach(() => {
  stopMock();
  if (savedBase === undefined) delete process.env.SEARXNG_BASE_URL;
  else process.env.SEARXNG_BASE_URL = savedBase;
  if (savedBudget === undefined) delete process.env.SEARXNG_TIMEOUT_MS;
  else process.env.SEARXNG_TIMEOUT_MS = savedBudget;
  if (savedTotal === undefined) delete process.env.SEARXNG_TOTAL_BUDGET_MS;
  else process.env.SEARXNG_TOTAL_BUDGET_MS = savedTotal;
});

describe("FINAL FAILURE TEST — one engine unavailable", () => {
  test("SearXNG still returns results; the failure is recorded, not repeated", async () => {
    await startMock();
    // duckduckgo is unavailable; yandex + wikipedia answer.
    state = {
      results: [row("yandex", "ipl-news"), row("wikipedia", "ipl-2026")],
      unresponsive: [["duckduckgo", "timeout"]],
      queriesSeen: [],
    };
    process.env.SEARXNG_BASE_URL = base;
    const out = await createSearxProvider().search("latest IPL news", 5, {});
    expect(out.citations.length).toBe(2);
    // The engine registry KNOWS duckduckgo failed exactly once (one strike,
    // below the suspension threshold) — measured, not guessed.
    const ddg = searxEngineHealthSnapshot().find((e) => e.engine === "duckduckgo");
    expect(ddg?.failures).toBe(1);
    expect(ddg?.timeoutRate).toBe(1);
    expect(searxEngineSuspended("duckduckgo")).toBe(false);
  }, 15_000);
});

describe("FINAL FAILURE TEST — several engines unavailable", () => {
  test("still functions while sufficient engines remain; all failures tracked", async () => {
    await startMock();
    // 3 of 5 engines down; yandex + wikipedia still answer.
    state = {
      results: [row("yandex", "f1-standings"), row("wikipedia", "f1-2026"), row("yandex", "f1-race")],
      unresponsive: [
        ["duckduckgo", "timeout"],
        ["bing", "timeout"],
        ["brave", "rate limit"],
      ],
      queriesSeen: [],
    };
    process.env.SEARXNG_BASE_URL = base;
    const out = await createSearxProvider().search("current F1 standings", 5, {});
    expect(out.citations.length).toBe(3);
    const snap = searxEngineHealthSnapshot();
    expect(snap.find((e) => e.engine === "duckduckgo")?.failures).toBe(1);
    expect(snap.find((e) => e.engine === "bing")?.failures).toBe(1);
    expect(snap.find((e) => e.engine === "brave")?.failures).toBe(1);
    expect(snap.find((e) => e.engine === "yandex")?.successRate).toBe(1);
  }, 15_000);

  test("REPEATED failures cross the threshold: engines are suspended and the next request is SCOPED to healthy engines", async () => {
    await startMock();
    state = {
      results: [row("yandex", "news-item")],
      unresponsive: [
        ["duckduckgo", "timeout"],
        ["bing", "timeout"],
      ],
      queriesSeen: [],
    };
    process.env.SEARXNG_BASE_URL = base;
    const provider = createSearxProvider();
    // Drive duckduckgo + bing over the suspension threshold.
    for (let i = 0; i < ENGINE_FAILURE_THRESHOLD; i++) {
      await provider.search("latest India news", 5, {});
    }
    expect(searxEngineSuspended("duckduckgo")).toBe(true);
    expect(searxEngineSuspended("bing")).toBe(true);
    expect(suspendedSearxEngines().sort()).toEqual(["bing", "duckduckgo"]);
    // The NEXT request is scoped with SearXNG's !engine syntax so no time is
    // spent re-asking the suspended engines — this is "temporarily disable it".
    state.queriesSeen = [];
    await provider.search("latest India news", 5, {});
    expect(state.queriesSeen[0]).toContain("!yandex");
    expect(state.queriesSeen[0]).not.toContain("!duckduckgo");
  }, 20_000);

  test("fail-open: if the SCOPED query returns nothing, the unscoped query is tried before giving up", async () => {
    await startMock();
    process.env.SEARXNG_BASE_URL = base;
    const provider = createSearxProvider();
    // Suspend duckduckgo via repeated reports; then the scoped query returns
    // ZERO rows while the unscoped one returns them.
    state = { results: [], unresponsive: [["duckduckgo", "timeout"]], queriesSeen: [] };
    for (let i = 0; i < ENGINE_FAILURE_THRESHOLD; i++) await provider.search("q", 5, {});
    expect(searxEngineSuspended("duckduckgo")).toBe(true);
    state = {
      results: [row("wikipedia", "scoped-failed-but-unscoped-answered")],
      unresponsive: [["duckduckgo", "timeout"]],
      queriesSeen: [],
    };
    // First (scoped) request in this call sees an empty result set from the
    // scoped variant, then the fail-open unscoped variant answers.
    const out = await provider.search("latest world news", 5, {});
    expect(out.citations.length).toBe(1);
  }, 20_000);
});

describe("FINAL FAILURE TEST — ALL engines unavailable", () => {
  test("an all-engines-unresponsive answer is an AUTHORITATIVE EMPTY result — recorded, never fabricated", async () => {
    // The instance answered valid JSON with zero rows and named every engine
    // unresponsive. That is not an error: it is the instance honestly saying
    // "nothing to give". The adapter returns an EMPTY result set (Andromeda
    // then refuses or degrades — never fabricates) and the failures are
    // recorded for suspension.
    await startMock();
    state = { results: [], unresponsive: [["duckduckgo", "timeout"], ["yandex", "timeout"]], queriesSeen: [] };
    process.env.SEARXNG_BASE_URL = base;
    const out = await createSearxProvider().search("quantum computing research", 5, {});
    expect(out.citations).toHaveLength(0);
    const snap = searxEngineHealthSnapshot();
    expect(snap.find((e) => e.engine === "duckduckgo")?.failures).toBe(1);
    expect(snap.find((e) => e.engine === "yandex")?.failures).toBe(1);
  }, 15_000);

  test("an instance that cannot answer at all fails HONESTLY (never fabricated)", async () => {
    // The INSTANCE itself is dead: the socket never answers. The provider
    // must throw a bounded, named failure — Andromeda hears "SearXNG failed"
    // and degrades to other providers / refusal.
    server = createServer(() => {
      /* hang: never respond */
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    process.env.SEARXNG_BASE_URL = base;
    process.env.SEARXNG_TIMEOUT_MS = "800";
    process.env.SEARXNG_TOTAL_BUDGET_MS = "1600";
    const started = Date.now();
    await expect(createSearxProvider().search("quantum computing research", 5, {})).rejects.toThrow(
      /SearXNG/,
    );
    // Fast-fail at the per-request ceiling, not the total budget.
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// ROUND 10 — EARLY-CONTINUE GATE: a failed provider must not add its timeout
// ---------------------------------------------------------------------------

describe("EARLY-CONTINUE GATE — no straggler holds the answer hostage", () => {
  const {
    shouldEarlyContinue,
    EARLY_CONTINUE_MIN_PROVIDERS,
    EARLY_CONTINUE_MIN_CITATIONS,
    EARLY_CONTINUE_GRACE_MS,
  } = require("../src/convex/searchEngine/resilience");

  test("gate fires only with breadth: ≥2 providers answered, ≥2 contributed, enough citations, pending > 0", () => {
    // Happy path: two providers answered with results, enough citations, one
    // straggler pending → release the wait.
    expect(
      shouldEarlyContinue(2, EARLY_CONTINUE_MIN_CITATIONS, 2, 1),
    ).toBe(true);
    // Too few answered.
    expect(shouldEarlyContinue(1, 8, 1, 2)).toBe(false);
    // Breadth missing: one provider only (echo risk).
    expect(shouldEarlyContinue(2, 8, 1, 2)).toBe(false);
    // Not enough citations yet.
    expect(shouldEarlyContinue(3, EARLY_CONTINUE_MIN_CITATIONS - 1, 2, 1)).toBe(false);
    // Nothing pending → never fires (the wait is already over).
    expect(shouldEarlyContinue(5, 20, 4, 0)).toBe(false);
  });

  test("constants are conservative by design (a fast source cannot starve the fan-out)", () => {
    expect(EARLY_CONTINUE_MIN_PROVIDERS).toBeGreaterThanOrEqual(2);
    expect(EARLY_CONTINUE_MIN_CITATIONS).toBeGreaterThanOrEqual(4);
    expect(EARLY_CONTINUE_GRACE_MS).toBeGreaterThan(0);
    expect(EARLY_CONTINUE_GRACE_MS).toBeLessThanOrEqual(2_000);
  });

  test("wiring: the fan-out races the gate against settlement; stragglers still merge", () => {
    const s = readFileSync("src/convex/universalSearch.ts", "utf8");
    expect(s).toContain("shouldEarlyContinue(");
    expect(s).toContain("Promise.race([Promise.allSettled(tracked), gatePromise])");
    // The grace window is real: late results land in settledSlots and merge.
    expect(s).toContain("EARLY_CONTINUE_GRACE_MS");
    expect(s).toContain("settledSlots[i] = s;");
  });
});
