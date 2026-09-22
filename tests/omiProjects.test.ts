/**
 * §5 Projects — context isolation tests.
 *
 * The property that matters: a project's context NEVER mixes with other
 * projects or with personal space, in either direction. These pin the pure
 * scoping rule the chat grounding path uses.
 */
import { describe, expect, test } from "bun:test";
import { scopeDocumentsToProject } from "../src/convex/omiKnowledge";

// Opaque IDs are fine — the rule never inspects their contents.
const P1 = "p1" as never;
const P2 = "p2" as never;

type Doc = { title: string; projectId?: string };

const corpus: Doc[] = [
  { title: "personal-notes", projectId: undefined },
  { title: "personal-2", projectId: undefined },
  { title: "p1-launch", projectId: P1 },
  { title: "p1-second", projectId: P1 },
  { title: "p2-paper", projectId: P2 },
];

describe("project context isolation — scoping cuts both ways", () => {
  test("a project sees ONLY its own documents", () => {
    const out = scopeDocumentsToProject(corpus as never, P1 as never);
    expect(out.map((d) => (d as Doc).title).sort()).toEqual([
      "p1-launch",
      "p1-second",
    ]);
  });

  test("different projects never see each other's documents", () => {
    const p2 = scopeDocumentsToProject(corpus as never, P2 as never);
    const titles = p2.map((d) => (d as Doc).title);
    expect(titles).toEqual(["p2-paper"]);
    expect(titles).not.toContain("p1-launch");
  });

  test("personal chat sees ONLY personal documents — never project files", () => {
    const out = scopeDocumentsToProject(corpus as never, undefined);
    expect(out.map((d) => (d as Doc).title).sort()).toEqual([
      "personal-2",
      "personal-notes",
    ]);
  });

  test("an unknown project id yields an empty scope (no leakage)", () => {
    const out = scopeDocumentsToProject(corpus as never, "ghost" as never);
    expect(out).toEqual([]);
  });

  test("an empty corpus yields an empty scope in both modes", () => {
    expect(scopeDocumentsToProject([], undefined)).toEqual([]);
    expect(scopeDocumentsToProject([], P1 as never)).toEqual([]);
  });

  test("scoping never mutates the input corpus", () => {
    const before = corpus.map((d) => d.title).join(",");
    scopeDocumentsToProject(corpus as never, P1 as never);
    scopeDocumentsToProject(corpus as never, undefined);
    expect(corpus.map((d) => d.title).join(",")).toBe(before);
  });

  test("every document lands in exactly one scope across all projects", () => {
    const seen: string[] = [];
    for (const p of [P1, P2] as never[]) {
      for (const d of scopeDocumentsToProject(corpus as never, p)) {
        seen.push((d as Doc).title);
      }
    }
    for (const d of scopeDocumentsToProject(corpus as never, undefined)) {
      seen.push((d as Doc).title);
    }
    // No document appears in two scopes, and none is lost.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(corpus.map((d) => d.title).sort());
  });
});
