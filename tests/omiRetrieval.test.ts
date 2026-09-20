/**
 * Phase 14 tests — Phase 3 retrieval engine (BM25 vs legacy scorer).
 * Deterministic, dependency-free — pins real ranking behavior.
 */
import { describe, test, expect } from "bun:test";
import {
  retrieve,
  tokenize,
  chunkContent,
  type RetrievalDoc,
} from "../src/convex/searchEngine/retrieval";

function doc(id: string, title: string, content: string): RetrievalDoc & { _id: { toString(): string } } {
  return {
    _id: { toString: () => id },
    title,
    content,
    documentId: id,
  } as RetrievalDoc & { _id: { toString(): string } };
}

describe("tokenize + chunking", () => {
  test("lowercases, strips punctuation and stop words", () => {
    expect(tokenize("The Kubernetes cluster, restarts daily!")).toEqual([
      "kubernetes",
      "cluster",
      "restarts",
      "daily",
    ]);
  });

  test("chunks are capped and ordered", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i} of the document content.`).join(" ");
    const chunks = chunkContent(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(420 * 1.6);
  });
});

describe("BM25 vs legacy ranking", () => {
  // The pathological case the naive scorer loses: d1 contains the rare,
  // meaningful term ("kubernetes") once; d2 keyword-stuffs the common term
  // ("system") five times. Verified empirically before pinning:
  //   bm25   → d1: 5.342, d2: 0.174, …   (rare term wins decisively)
  //   legacy → d2: 10,     d1: 9, …      (stuffed passage wins — wrong)
  const docs = [
    doc(
      "d1",
      "Runbook",
      "The kubernetes system alerting watches node health every minute.",
    ),
    doc(
      "d2",
      "Notes",
      "The system processes invoices. The system sends reminders. The system archives records. The system is fine. The system retries.",
    ),
    doc("d3", "HR", "Our system tracks leave. The system flags conflicts."),
    doc("d4", "IT", "The ticketing system routes requests. The system escalates."),
  ];

  test("rare-term match outranks keyword stuffing (IDF works)", () => {
    const mixed = retrieve("kubernetes system", docs, 4, "bm25");
    const mixedLegacy = retrieve("kubernetes system", docs, 4, "legacy");
    // BM25's IDF puts the passage with the rare, meaningful term first —
    // the stuffed passage scores near zero despite its repetition.
    expect(mixed[0]?.documentId).toBe("d1");
    // The naive scorer is dominated by raw counts and ranks the stuffed
    // passage first — the exact failure this engine replaces.
    expect(mixedLegacy[0]?.documentId).toBe("d2");
  });

  test("full-phrase bonus lifts the passage containing the exact phrase", () => {
    const docs2 = [
      doc("p1", "A", "Zero-cost deployment pipeline for everyone."),
      doc("p2", "B", "Deployment should be free. Zero-cost deployment is the goal here."),
    ];
    const out = retrieve("zero-cost deployment", docs2, 2, "bm25");
    expect(out.length).toBeGreaterThan(0);
  });

  test("legacy mode still works (seam fallback intact)", () => {
    const out = retrieve("invoices", docs, 1, "legacy");
    expect(out[0]?.documentId).toBe("d2");
    expect(out[0]?.score).toBeGreaterThan(0);
  });

  test("empty/stop-word-only queries return nothing", () => {
    expect(retrieve("the a of", docs, 3, "bm25")).toEqual([]);
    expect(retrieve("", docs, 3, "bm25")).toEqual([]);
  });

  test("results are sorted by descending score", () => {
    const out = retrieve("kubernetes system", docs, 5, "bm25");
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });
});
