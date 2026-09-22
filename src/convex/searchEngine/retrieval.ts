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

/**
 * `hybrid` (default) = BM25 + the locality signals that plain BM25 misses:
 *   • BM25F-style field weighting — a query term in the TITLE outweighs the
 *     same term buried in body text
 *   • typo tolerance — a query term that matches a corpus term within one
 *     edit is counted at reduced weight ("kubernetis" still finds "kubernetes")
 *   • proximity — distinct query terms occurring near each other mark a
 *     passage as on-topic even when neither repeats
 *
 * It is deliberately NOT embedding-based vector search: no free
 * server-side embedding provider is available to this deployment, and this
 * codebase's rule (§35) is that a capability is never faked. Real vector
 * search stays [PLANNED] behind this same seam — see docs/andromeda.md.
 */
export type RetrievalMode = "hybrid" | "bm25" | "legacy";

/**
 * Parse a caller-supplied mode string. Unknown/absent values fall back to
 * `hybrid` (the best available engine), which keeps one place responsible for
 * the default instead of every call site re-deriving it.
 */
export function parseRetrievalMode(raw?: string): RetrievalMode {
  return raw === "legacy" || raw === "bm25" || raw === "hybrid"
    ? raw
    : "hybrid";
}

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

/**
 * Field weight for a query term in the document TITLE, in multiples of that
 * term's IDF (BM25F-style). The title is the document's own summary of itself,
 * so it is a stronger signal than body text: 1.5 is tuned so a title match
 * outranks a single passing mention in the body, while a passage that
 * genuinely discusses the term can still beat a merely-titled one.
 */
const TITLE_FIELD_WEIGHT = 1.5;
/** Weight for a typo-tolerant (edit-distance-1) match, relative to an exact one. */
const FUZZY_WEIGHT = 0.5;
/** Flat bonus for a passage containing the whole query as a contiguous phrase. */
const PHRASE_BONUS = 4;
/** Bonus when two distinct query terms occur close together. */
const PROXIMITY_BOOST = 0.8;
/** Max token distance for the proximity bonus. */
const PROXIMITY_WINDOW = 6;

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
  /** Token stream in order — proximity scoring needs positions. */
  tokens: string[];
  /** Distinct title terms — BM25F-style field weighting. */
  titleTerms: Set<string>;
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
        tokens,
        titleTerms: new Set(tokenize(doc.title)),
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
 * True when `a` and `b` are within one insert/delete/substitute of each
 * other. Used for typo tolerance — intentionally strict (distance ≤ 1) so it
 * can never blend two genuinely different terms.
 */
export function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let diffs = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    diffs++;
    if (diffs > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  if (i < la || j < lb) diffs++;
  return diffs <= 1;
}

/** Distinct query terms co-occurring inside `window` tokens ⇒ likely on-topic. */
export function hasProximity(
  tokens: string[],
  queryTerms: string[],
  window = 6,
): boolean {
  if (queryTerms.length < 2) return false;
  const wanted = new Set(queryTerms);
  const hits: Array<{ term: string; idx: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (wanted.has(t)) hits.push({ term: t, idx: i });
  }
  for (let a = 0; a < hits.length; a++) {
    for (let b = a + 1; b < hits.length; b++) {
      if (hits[a].term === hits[b].term) continue;
      if (hits[b].idx - hits[a].idx <= window) return true;
    }
  }
  return false;
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
  mode: RetrievalMode = "hybrid",
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

  const idfOf = (term: string) => {
    const df = docFreq.get(term) ?? 0;
    return Math.log(1 + (passages.length - df + 0.5) / (df + 0.5));
  };

  // Fuzzy expansions are computed ONCE per query, not per passage. Only
  // terms long enough to be distinctive are expanded, and each expands to at
  // most a few corpus terms — so typo tolerance can never dissolve ranking.
  const fuzzyMap = new Map<string, string[]>();
  if (mode === "hybrid") {
    const vocabulary = [...docFreq.keys()];
    for (const qt of queryTerms) {
      if (qt.length < 5) continue;
      const expansions = vocabulary
        .filter(
          (v) =>
            v !== qt &&
            v.length >= 4 &&
            Math.abs(v.length - qt.length) <= 1 &&
            withinEditDistance1(qt, v),
        )
        .slice(0, 3);
      if (expansions.length > 0) fuzzyMap.set(qt, expansions);
    }
  }

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
    // Contiguous-phrase bonus — genuine multi-word phrases only. For a
    // single-term query this just re-awards the term match it already scored,
    // and the flat bonus completely swamped BM25's IDF weighting (a passing
    // mention won over the document actually titled with the term).
    if (
      queryTerms.length >= 2 &&
      phrase.length > 8 &&
      p.snippet.toLowerCase().includes(phrase)
    ) {
      score += PHRASE_BONUS;
    }

    if (mode === "hybrid") {
      // Field weighting: the title is the document's own summary of itself,
      // so a query term there is a much stronger signal than one in the body.
      for (const qt of queryTerms) {
        if (p.titleTerms.has(qt)) score += idfOf(qt) * TITLE_FIELD_WEIGHT;
      }
      // Typo tolerance at reduced weight, only where the exact term is absent.
      for (const [qt, expansions] of fuzzyMap) {
        if (p.termCounts.has(qt)) continue;
        const hit = expansions.find((v) => p.termCounts.has(v));
        if (hit) {
          score += FUZZY_WEIGHT * Math.min(p.termCounts.get(hit) ?? 1, 3);
        }
      }
      // Locality: distinct query terms close together ⇒ the passage is about
      // the query, not merely mentioning one of its words.
      if (hasProximity(p.tokens, queryTerms, PROXIMITY_WINDOW)) {
        score += PROXIMITY_BOOST;
      }
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
