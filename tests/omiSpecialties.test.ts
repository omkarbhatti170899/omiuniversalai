/**
 * Phase 14 tests — agent specialties (Phase 6): prompt hierarchy + per-
 * specialty tool permissions. These pin the security-relevant behavior:
 * the executor's allowlist must match what the UI promises.
 */
import { describe, test, expect } from "bun:test";
import {
  SPECIALTIES,
  GENERAL_SPECIALTY,
  specialtyProfile,
  toolAllowedForSpecialty,
  allowedToolIds,
} from "../src/convex/omiTools/specialties";
import { toolCatalogPrompt, TOOL_IDS } from "../src/convex/omiTools/registry";

describe("specialty resolution", () => {
  test("known specialties resolve to themselves", () => {
    for (const p of SPECIALTIES) {
      expect(specialtyProfile(p.id).id).toBe(p.id);
    }
  });

  test("legacy free-text specialty falls back to general (backward compat)", () => {
    expect(specialtyProfile("my custom thing").id).toBe("general");
    expect(specialtyProfile("").id).toBe("general");
    expect(specialtyProfile(undefined).id).toBe("general");
    expect(specialtyProfile(null).id).toBe("general");
  });

  test("resolution is case-insensitive", () => {
    expect(specialtyProfile("  Research ").id).toBe("research");
  });
});

describe("per-specialty tool permissions", () => {
  test("every registry tool id referenced by profiles exists", () => {
    for (const p of SPECIALTIES) {
      if (p.tools === "all") continue;
      for (const t of p.tools) {
        expect(TOOL_IDS).toContain(t);
      }
    }
  });

  test("document specialty is restricted to local sources", () => {
    expect(allowedToolIds("document").sort()).toEqual([
      "knowledge_search",
      "memory_list",
    ]);
    expect(toolAllowedForSpecialty("web_search", "document")).toBe(false);
    expect(toolAllowedForSpecialty("read_page", "document")).toBe(false);
    expect(toolAllowedForSpecialty("knowledge_search", "document")).toBe(true);
  });

  test("research can search and read but not save memories", () => {
    expect(toolAllowedForSpecialty("web_search", "research")).toBe(true);
    expect(toolAllowedForSpecialty("read_page", "research")).toBe(true);
    expect(toolAllowedForSpecialty("memory_save", "research")).toBe(false);
  });

  test("general retains the full safe set (backward compat)", () => {
    for (const t of TOOL_IDS) {
      expect(toolAllowedForSpecialty(t, "general")).toBe(true);
    }
    expect(allowedToolIds("general")).toEqual([...TOOL_IDS]);
  });

  test("legacy/unknown specialties get the general allowlist", () => {
    expect(allowedToolIds("my custom thing")).toEqual([...TOOL_IDS]);
    expect(toolAllowedForSpecialty("memory_save", "something else")).toBe(true);
  });

  test("executor allowlist matches the filtered catalog prompt", () => {
    // Whatever the prompt shows must be exactly what the executor permits.
    const prompt = toolCatalogPrompt(allowedToolIds("document"));
    expect(prompt).not.toContain("web_search");
    expect(prompt).toContain("knowledge_search");
    const full = toolCatalogPrompt();
    for (const t of TOOL_IDS) {
      expect(full).toContain(t);
    }
  });
});

describe("prompt hierarchy", () => {
  test("each specialty defines planning and execution discipline", () => {
    for (const p of SPECIALTIES) {
      expect(p.planning.length).toBeGreaterThan(40);
      expect(p.execution.length).toBeGreaterThan(40);
    }
    expect(GENERAL_SPECIALTY.planning.length).toBeGreaterThan(40);
  });
});
