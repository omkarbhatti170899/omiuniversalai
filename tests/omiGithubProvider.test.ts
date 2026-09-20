/**
 * Milestone tests — GitHub source (master plan §5: "GitHub public APIs
 * within applicable limits"). Pins the pure behaviors: the relevance gate
 * that protects the shared keyless quota, metadata→citation mapping with
 * license provenance, and registry presence.
 */
import { describe, test, expect } from "bun:test";
import {
  isTechRepositoryQuery,
  mapRepoToCitation,
} from "../src/convex/searchProviders/github";

describe("github provider — relevance gate (quota citizenship)", () => {
  test("tech/library queries pass", () => {
    for (const q of [
      "best self-hosted search engine github",
      "rust parser library",
      "llm inference runtime vllm",
      "typescript framework for CLI",
      "open source kubernetes operator",
    ]) {
      expect(isTechRepositoryQuery(q)).toBe(true);
    }
  });

  test("non-technical queries are refused (no quota burn)", () => {
    for (const q of [
      "best pizza in rome",
      "who won the 1966 world cup",
      "history of jazz music",
      "symptoms of the flu",
    ]) {
      expect(isTechRepositoryQuery(q)).toBe(false);
    }
  });
});

describe("github provider — repo → citation mapping", () => {
  test("maps full metadata with license and stars (§29 provenance)", () => {
    const c = mapRepoToCitation({
      full_name: "searxng/searxng",
      html_url: "https://github.com/searxng/searxng",
      description: "Free internet metasearch engine",
      language: "Python",
      stargazers_count: 12345,
      pushed_at: "2026-09-01T00:00:00Z",
      license: { spdx_id: "AGPL-3.0" },
      archived: false,
    });
    expect(c).not.toBeNull();
    expect(c!.title).toBe("searxng/searxng");
    expect(c!.url).toBe("https://github.com/searxng/searxng");
    expect(c!.snippet).toContain("metasearch");
    expect(c!.snippet).toContain("AGPL-3.0");
    expect(c!.snippet).toContain("12,345 stars");
    expect(c!.publishedAt).toBe("2026-09-01T00:00:00Z");
  });

  test("archived repos are labeled; missing license omitted cleanly", () => {
    const c = mapRepoToCitation({
      full_name: "a/b",
      html_url: "https://github.com/a/b",
      description: null,
      language: null,
      stargazers_count: 0,
      license: null,
      archived: true,
    });
    expect(c!.snippet).toContain("archived");
    expect(c!.snippet).not.toContain("License");
  });

  test("incomplete API rows are dropped, not guessed", () => {
    expect(mapRepoToCitation({ description: "orphan" })).toBeNull();
  });
});

describe("github provider — registration", () => {
  test("registered in Andromeda as keyless and $0", async () => {
    const { getProviderStatus } = await import("../src/convex/searchProviders");
    const gh = getProviderStatus().find((p) => p.id === "github");
    expect(gh).toBeDefined();
    expect(gh!.ready).toBe(true);
    expect(gh!.cost).toMatch(/\$0/);
  });
});
