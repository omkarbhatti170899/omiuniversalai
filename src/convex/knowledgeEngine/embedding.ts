/**
 * Omi Knowledge Intelligence — semantic retrieval math (pure).
 *
 * §1 of the completion spec: hybrid retrieval = keyword AND semantic, merged
 * and re-ranked. This module holds ONLY the deterministic math — cosine
 * similarity, semantic ranking, and Reciprocal Rank Fusion (the standard
 * parameter-light way to merge two ranked lists without normalising scores
 * from different scales). No network, no vendor, no Convex — so the whole
 * retrieval contract is unit-tested rather than trusted.
 *
 * The embedding VECTORS come from `aiProviders/embeddings.ts`, which returns
 * null when no embedding provider is configured. A null there means this
 * module is simply never consulted and BM25 remains the whole answer — the
 * graceful fallback the spec requires. A capability is never faked.
 */

export type EmbeddingVector = readonly number[];

/** Cosine similarity of two equal-length vectors, in [-1, 1]. 0 on mismatch. */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Highest cosine similarity between `v` and any of `others` (0 when empty). */
export function maxSimilarity(v: EmbeddingVector, others: EmbeddingVector[]): number {
  let best = 0;
  for (const o of others) best = Math.max(best, cosineSimilarity(v, o));
  return best;
}

export type SemanticallyRanked = { id: string; score: number };

/**
 * Rank candidates by cosine similarity to the query. The score is clamped to
 * [0,1]: a negative cosine means "less related than orthogonal", which for
 * retrieval is simply irrelevant — it must not reorder the tail upward.
 */
export function rankByEmbedding(
  query: EmbeddingVector,
  docs: Array<{ id: string; vector: EmbeddingVector | undefined }>,
): SemanticallyRanked[] {
  const scored: SemanticallyRanked[] = [];
  for (const d of docs) {
    if (!d.vector || d.vector.length === 0) continue;
    const sim = cosineSimilarity(query, d.vector);
    scored.push({ id: d.id, score: Math.max(0, Math.round(sim * 1000) / 1000) });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** RRF constant (Cormack et al. use 60; smaller sharpens the head of the list). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion of any number of ranked lists. Each list contributes
 * 1/(k + rank) per document, so a document that BOTH retrievers rank highly
 * wins, while a document only one retriever found still surfaces — and no
 * score normalisation (or tuned weight) is needed to combine BM25's unbounded
 * scores with cosine's [0,1].
 */
export function reciprocalRankFusion(
  lists: SemanticallyRanked[][],
  k = RRF_K,
): SemanticallyRanked[] {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((entry, rank) => {
      fused.set(entry.id, (fused.get(entry.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score: Math.round(score * 1_000_000) / 1_000_000 }))
    .sort((a, b) => b.score - a.score);
}

export type HybridOptions = {
  /** Keep this many results after fusion. */
  limit?: number;
  /** Documents found ONLY by the semantic retriever are usually noise. */
  dropSemanticOnly?: boolean;
  /** Minimum cosine for a semantic-only hit to survive. */
  semanticOnlyMinScore?: number;
};

/**
 * Hybrid merge + re-rank: fuse BM25 (keyword) with semantic ranking, then keep
 * the head of the fused list. When there is no semantic ranking this IS the
 * keyword ranking, so callers never need a branch.
 *
 * `dropSemanticOnly` guards the known failure mode of dense retrieval on a
 * small corpus: an irrelevant passage that happens to sit near the query
 * vector in embedding space. Such a hit must clear a real similarity floor to
 * be allowed to introduce a document keyword search never found.
 */
export function mergeHybrid(
  keyword: SemanticallyRanked[],
  semantic: SemanticallyRanked[],
  opts: HybridOptions = {},
): SemanticallyRanked[] {
  const limit = opts.limit ?? keyword.length;
  if (semantic.length === 0) return keyword.slice(0, limit);

  const keywordIds = new Set(keyword.map((k) => k.id));
  const semanticById = new Map(semantic.map((s) => [s.id, s.score]));
  const floor = opts.semanticOnlyMinScore ?? 0.28;

  const ranked = reciprocalRankFusion([keyword, semantic]);
  const kept = ranked.filter((r) => {
    if (keywordIds.has(r.id)) return true;
    if (opts.dropSemanticOnly === false) return true;
    return (semanticById.get(r.id) ?? 0) >= floor;
  });
  return kept.slice(0, limit);
}
