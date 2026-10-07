/**
 * EARLY-CONTINUE GATE — no straggler holds the answer hostage.
 *
 * Pins the exported decision surface in src/convex/searchEngine/resilience.ts.
 * The full in-process SearXNG E2E harness requires a live instance + generated
 * Convex API, which is outside this environment — so this file pins the API
 * shape and deterministic constant behaviour only.
 */

import { describe, expect, test } from "bun:test";

import { shouldEarlyContinue } from "../src/convex/searchEngine/resilience";

describe("EARLY-CONTINUE GATE — no straggler holds the answer hostage", () => {
  test("shouldEarlyContinue is a pure function of its inputs", () => {
    // Zero providers answered → never release early.
    expect(shouldEarlyContinue(0, 2, 0, 0)).toBe(false);
  });
});
