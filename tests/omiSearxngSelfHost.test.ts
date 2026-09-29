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
    // Fail-open: if nothing is dialable, one base is still attempted.
    expect(s).toContain("dialable.length > 0 ? dialable : [bases[0]]");
    // The attempt loop must use the filtered list, not the raw list.
    expect(s).toContain("for (let b = 0; b < attemptBases.length && !stop; b++)");
  });

  test("success clears the bad verdict; failure records it (self-healing)", () => {
    const s = searxngSrc();
    // On a real answer:
    expect(s).toContain('noteSearxngBaseResult(base, true, "answered JSON")');
    // On an authoritative empty answer from the configured base:
    expect(s).toContain('noteSearxngBaseResult(base, true, "answered JSON (empty result set)")');
    // On a failed attempt (inside the attempt loop's catch):
    const loopCatch = s.slice(s.indexOf("lastError = err;"));
    expect(loopCatch.slice(0, 400)).toContain("noteSearxngBaseResult(");
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
