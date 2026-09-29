/**
 * REGRESSION — SEARXNG SELF-HOST WIRING + DEAD-INSTANCE SKIP.
 * =============================================================================
 *
 * Context (2026-09-28): `search.lumy.live` went half-wedged — DNS/TLS fine,
 * `/` answering 200 in ~9 s, but `/search` hanging for full timeouts while
 * engines `duckduckgo` and `seznam` sat suspended. Every search paid that
 * timeout against a host we ALREADY KNEW was dead, because the health verdict
 * existed only for the status surface, not for the search path.
 *
 * Contract pinned here:
 *   1. The search path consults per-base health memory BEFORE dialing and
 *      skips a base with a fresh unhealthy verdict (`isKnownDead`), while an
 *      unknown base is always dialable (a cold isolate can still search).
 *   2. A successful response (or an authoritative empty answer) CLEARS the
 *      bad verdict — self-healing — so a recovered instance returns to
 *      service on its first success, not on the next cron.
 *   3. A failed attempt records the verdict, so the NEXT search skips.
 *   4. If every base is known-dead, exactly one base is still attempted so
 *      recovery is never locked out longer than the probe TTL.
 *   5. `SEARXNG_SHARED_SECRET` (server-side) is presented as `X-Omi-Secret`
 *      on both probe and search requests — the private-instance auth gate.
 *   6. The endpoint-proof action exists and runs BEFORE any base switch.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const searxngSrc = () => readFileSync("src/convex/searchProviders/searxng.ts", "utf8");

describe("dead-instance skip (per-base health memory)", () => {
  test("search() consults health memory before dialing", () => {
    const s = searxngSrc();
    expect(s).toContain("const dialable = bases.filter((b) => !isKnownDead(b))");
    // SLOW-BASE DEMOTION: measured-latency memory re-orders the dial list so a
    // chronically slow base is tried after fast ones (never excluded).
    expect(s).toContain("const fast = dialable.filter((b) => !baseIsSlow(b))");
    // ROUND-8: the recovery dial (every base known-dead) is RATE-LIMITED — the
    // escalation pass must not re-pay a full timeout seconds after pass 1 just
    // recorded the same failure.
    expect(s).toContain("RECOVERY_DIAL_MIN_MS");
    // The attempt loop must use the filtered list, not the raw list.
    expect(s).toContain("for (let b = 0; b < attemptBases.length && !stop; b++)");
  });

  test("latency discipline: budgets are tight and slow bases are demoted by order", () => {
    const s = searxngSrc();
    // MEASURED 2026-09-29: 12–15 s searches were three ~5 s rungs against a
    // flaky instance. The ceiling is TIGHTENED, never raised, per owner
    // direction that 20–30 s searches are unacceptable.
    expect(s).toContain("export const SEARXNG_TOTAL_BUDGET_MS = 10_000;");
    expect(s).toContain("export const SEARXNG_PER_TRY_TIMEOUT_MS = 5_000;");
    // Demotion lever is ORDER: slow bases dial after fast ones, never starved.
    expect(s).toContain("const ordered = [...fast, ...slow]");
    // The fan-out slot matches: searxng 12 s, not the old 30 s.
    const t = readFileSync("src/convex/searchEngine/providerTimeouts.ts", "utf8");
    expect(t).toMatch(/searxng: 12_000/);
  });

  test("success clears the bad verdict; failure records it (self-healing)", () => {
    const s = searxngSrc();
    // On a real answer:
    expect(s).toContain('noteSearxngBaseResult(base, true, "answered JSON")');
    // On an authoritative empty answer from the configured base:
    expect(s).toContain('noteSearxngBaseResult(base, true, "answered JSON (empty result set)")');
    // On a failed attempt (inside the attempt loop's catch — round 8 added
    // the in-call failure memory ahead of the health note, so widen the view):
    const loopCatch = s.slice(s.indexOf("lastError = err;"));
    expect(loopCatch.slice(0, 700)).toContain("noteSearxngBaseResult(");
    expect(loopCatch.slice(0, 700)).toContain("failedThisCall.add(base);");
  });

  test("the health probe feeds the SAME memory, so verdicts cannot disagree", () => {
    const s = searxngSrc();
    // Inside searxngHealth's loop:
    const healthBlock = s.slice(s.indexOf("export async function searxngHealth"));
    expect(healthBlock).toContain("noteSearxngBaseResult(base, r.healthy, r.detail)");
  });
});

describe("private-instance auth (X-Omi-Secret)", () => {
  test("both probe and search present the shared secret when configured", () => {
    const s = searxngSrc();
    // The header builder reads the env var set via `bunx convex env set` —
    // the production URL and its secret are stored server-side only.
    expect(s).toContain("process.env.SEARXNG_SHARED_SECRET");
    expect(s).toContain('"X-Omi-Secret"');
    // Spread into BOTH request sites:
    const probeBlock = s.slice(s.indexOf("export async function probeInstance"));
    expect(probeBlock).toContain("...searxngAuthHeaders()");
    const fetchBlock = s.slice(s.indexOf("async function fetchInstance"));
    expect(fetchBlock).toContain("...searxngAuthHeaders()");
  });
});

describe("endpoint proof gate (verifySearxngJson)", () => {
  test("the proof action exists and is ordered BEFORE the base switch", () => {
    const s = readFileSync("src/convex/diagnosticsSearxngDeep.ts", "utf8");
    expect(s).toContain("verifySearxngJson");
    // It proves /search?q=test&format=json and runs the real query:
    expect(s).toContain('params: { q: "test", format: "json" }');
    expect(s).toContain("PROVEN");
    expect(s).toContain("NOT PROVEN");
  });
});

describe("self-host deployment package", () => {
  test("settings enable JSON, harden timeouts, and keep restricted engines off", () => {
    const s = readFileSync("deploy/searxng/settings.yml", "utf8");
    expect(s).toMatch(/formats:\s*\n\s*- html\s*\n\s*- json/);
    expect(s).toContain("request_timeout: 3.0");
    expect(s).toContain("limiter: true");
    // Licence control: the banned engines are documented as NOT enabled
    // (commented out with reasoning, or explicitly disabled).
    for (const engine of ["google", "bing", "duckduckgo", "startpage", "qwant"]) {
      const banned = new RegExp(
        `(//|#)[^\\n]*${engine}|(- name: ${engine}\\s*\\n\\s*disabled: true)`,
        "i",
      ).test(s);
      // Must NOT appear as an enabled engine block:
      const enabled = new RegExp(`- name: ${engine}\\s*\\n\\s*disabled: false`, "i").test(s);
      expect(banned || !enabled).toBe(true);
      expect(enabled).toBe(false);
    }
  });

  test("compose keeps the instance private, hardened, and health-checked", () => {
    const s = readFileSync("deploy/searxng/docker-compose.yml", "utf8");
    expect(s).toContain("read_only: true");
    expect(s).toContain("no-new-privileges:true");
    // No SearXNG ports published — caddy is the only front door.
    expect(s).toMatch(/caddy[\s\S]*ports:/);
    expect(s).toContain("/healthz");
  });

  test("the proxy enforces the shared-secret gate on the JSON API", () => {
    const s = readFileSync("deploy/searxng/Caddyfile", "utf8");
    expect(s).toContain("X-Omi-Secret");
    expect(s).toContain("403");
    expect(s).toContain("/healthz");
  });
});
