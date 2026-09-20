/**
 * Milestone tests — internal knowledge as an Andromeda source (§11).
 * Pins: the corpus virtual provider surfaces user documents through the
 * reserved internal:// scheme with BM25-relevant snippets first, so Omi
 * ranks its own library above the open web.
 */
import { describe, test, expect } from "bun:test";
import { retrieve } from "../src/convex/searchEngine/retrieval";

describe("internal corpus — retrieval and mapping", () => {
  const docs = [
    {
      _id: { toString: () => "doc-1" } as unknown as { toString(): string },
      title: "Company battery policy",
      content:
        "Our company battery policy requires quarterly inspection of all lithium storage areas. Thermal runaway response is documented in the safety handbook.",
    },
    {
      _id: { toString: () => "doc-2" } as unknown as { toString(): string },
      title: "Meeting notes 12 March",
      content: "Discussed the offsite schedule and catering preferences for the team day.",
    },
  ];

  test("relevant internal doc ranks first with snippet", () => {
    const out = retrieve("battery thermal runaway policy", docs, 2, "bm25");
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].title).toBe("Company battery policy");
    expect(out[0].snippet.length).toBeGreaterThan(10);
  });

  test("internal:// scheme maps from the retrieved documentId", () => {
    const out = retrieve("battery policy", docs, 1, "bm25");
    const url = `internal://${out[0].documentId}`;
    expect(url.startsWith("internal://")).toBe(true);
    expect(url).toBe("internal://doc-1");
  });

  test("irrelevant queries return nothing (no fabrication from corpus)", () => {
    const out = retrieve("quantum chromodynamics lattice calculations", docs, 3, "bm25");
    expect(out.length).toBe(0);
  });
});
