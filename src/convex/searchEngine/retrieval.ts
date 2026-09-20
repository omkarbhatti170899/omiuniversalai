/**
 * Local retrieval engine (master plan Phase 3 — "FAISS/OpenSearch-style
 * semantic retrieval" behind the provider-neutral retriever seam).
 *
 * This is a self-contained BM25 implementation — the industry-standard
 * probabilistic ranking function (used by Lucene/OpenSearch/Elasticsearch
 * internally). Zero dependencies, runs in any JS runtime, and deterministic
 * so tests can pin exact behavior. The old naive keyword scorer remains
 * available as a fallback via the `retrievalMode` switch, so a future
 * hosted FAISS/OpenSearch provider can slot in at the same seam without
 * touching any call site.
 *
 * Why BM25 over the old scorer:
 *   • inverse document frequency (IDF) — a match on a rare, meaningful term
 *     ("kubernetes") outranks a match on a common one ("system")
 *   • length normalization — a 10-word snippet matching all terms beats a
 *     500-word ramble matching them once
 *   • saturation — the 8th occurrence of a term adds almost nothing,
 *     so keyword-stuffed passages no longer dominate
 */

// --- Chunking ---------------------------------------------------------------

/** Split a document into readable chunks (~sentence-sized, capped). */
export function chunkContent(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const t = current.trim();
    if (t.length > 0) chunks.push(t);
    current = "";
  };

  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if ((current + " " + s).trim().length > CHUNK_CHARS) pushCurrent();
      current = `${current} ${s}`.trim();
      if (current.length > CHUNK_CHARS * 1.5) pushCurrent();
    }
    if (current.length > CHUNK_CHARS) pushCurrent();
  }
  pushCurrent();
  return chunks.slice(0, 120);
}

// --- BM25 ranking engine ----------------------------------------------------

export type RetrievalMode = "bm25" | "legacy";

export interface RetrievalDoc {
  documentId: string;
  title: string;
  content: string;
}

export interface RetrievedPassage {
  documentId: string;
  title: string;
  snippet: string;
  /** BM25 score (unbounded, comparable within one query). */
  score: number;
}

/** Standard BM25 parameters (Lucene defaults). */
const K1 = 1.2;
const B = 0.75;

const CHUNK_CHARS = 420;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "how", "in", "is", "it", "its", "of", "on", "or", "that", "the", "to", "was",
  "what", "when", "where", "which", "who", "why", "will", "with", "do", "does",
  "did", "can", "could", "should", "would", "me", "my", "your", "you", "i",
  "this", "these", "those", "their", "there", "about", "into", "over", "than",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

interface IndexedPassage {
  docId: string;
  title: string;
  snippet: string;
  /** term → count within this passage. */
  termCounts: Map<string, number>;
  length: number;
}

/** Index the corpus once per query: chunk → tokenize → term counts. */
function buildIndex(docs: RetrievalDoc[]): IndexedPassage[] {
  const passages: IndexedPassage[] = [];
  for (const doc of docs) {
    for (const chunk of chunkContent(doc.content)) {
      const tokens = tokenize(chunk);
      if (tokens.length === 0) continue;
      const termCounts = new Map<string, number>();
      for (const t of tokens) {
        termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
      }
      passages.push({
        docId: doc.documentId,
        title: doc.title,
        snippet: chunk.length > 400 ? `${chunk.slice(0, 400)}…` : chunk,
        termCounts,
        length: tokens.length,
      });
    }
  }
  return passages;
}

/**
 * BM25 score of one passage for one query.
 * Exported for tests: deterministic and dependency-free.
 */
export function bm25Score(
  queryTerms: string[],
  termCounts: Map<string, number>,
  length: number,
  avgLength: number,
  docFreq: Map<string, number>,
  totalPassages: number,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const tf = termCounts.get(term) ?? 0;
    if (tf === 0) continue;
    // IDF: rare terms matter more (Lucene's "sparsity-safe" variant —
    // never negative even if a term appears in every passage).
    const df = docFreq.get(term) ?? 0;
    const idf = Math.log(1 + (totalPassages - df + 0.5) / (df + 0.5));
    // Saturation + length normalization.
    const tfNorm =
      (tf * (K1 + 1)) /
      (tf + K1 * (1 - B + B * (length / Math.max(avgLength, 1))));
    score += idf * tfNorm;
  }
  return score;
}

/**
 * Rank a corpus of documents for a query. `mode: "legacy"` falls back to
 * the previous naive scorer (kept behind the seam for provider swaps and
 * A/B comparison).
 */
export function retrieve(
  query: string,
  docs: Array<{ _id: { toString(): string }; title: string; content: string }>,
  limit: number,
  mode: RetrievalMode = "bm25",
): RetrievedPassage[] {
  if (mode === "legacy") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return legacyFallback(query, docs, limit);
  }

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const passages = buildIndex(
    docs.map((d) => ({ documentId: d._id.toString(), title: d.title, content: d.content })),
  );
  if (passages.length === 0) return [];

  // Corpus statistics.
  const docFreq = new Map<string, number>();
  for (const p of passages) {
    for (const term of p.termCounts.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  const avgLength =
    passages.reduce((sum, p) => sum + p.length, 0) / passages.length;

  // Full-phrase bonus: a passage containing the exact query phrase is
  // overwhelmingly likely to be the actual answer.
  const phrase = query.toLowerCase().replace(/\s+/g, " ").trim();

  const scored: RetrievedPassage[] = [];
  for (const p of passages) {
    let score = bm25Score(
      queryTerms,
      p.termCounts,
      p.length,
      avgLength,
      docFreq,
      passages.length,
    );
    if (phrase.length > 8 && p.snippet.toLowerCase().includes(phrase)) {
      score += 4;
    }
    if (score > 0) {
      scored.push({
        documentId: p.docId,
        title: p.title,
        snippet: p.snippet,
        score: Math.round(score * 1000) / 1000,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function legacyFallback(
  query: string,
  docs: Array<{ _id: { toString(): string }; title: string; content: string }>,
  limit: number,
): RetrievedPassage[] {
  const kws = tokenize(query);
  if (kws.length === 0) return [];
  const phrase = query.toLowerCase().replace(/\s+/g, " ").trim();
  const scored: RetrievedPassage[] = [];

  for (const doc of docs) {
    for (const chunk of chunkContent(doc.content)) {
      const lower = chunk.toLowerCase();
      let score = 0;
      for (const k of kws) {
        let hits = 0;
        let idx = lower.indexOf(k);
        while (idx !== -1) {
          hits++;
          idx = lower.indexOf(k, idx + k.length);
        }
        if (hits > 0) score += 2 * Math.min(hits, 5);
      }
      if (phrase.length > 8 && lower.includes(phrase)) score += 5;
      if (score > 0) {
        scored.push({
          documentId: doc._id.toString(),
          title: doc.title,
          snippet: chunk.length > 400 ? `${chunk.slice(0, 400)}…` : chunk,
          score,
        });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
