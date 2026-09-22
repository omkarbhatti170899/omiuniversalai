# Andromeda — Universal Web Intelligence & Search Layer

> Andromeda is Omi's information fabric: the layer that sits **underneath**
> Omi's intelligence and **above** many search engines and data sources.
> It is not a search page and not a Google clone — no single provider is
> inside the architecture; every source is a replaceable adapter.

Status marker legend: **[IMPLEMENTED]** = shipped, tested, running in the app
today · **[PLANNED]** = architecture reserves the seam; not built yet ·
**[EXCLUDED]** = evaluated and deliberately not included (license/cost/platform).

---

## 1. Position in the Omi architecture

```
USER
 ↓
OMI (chat / agents / automation — intelligence layer)
 ↓  tool call: andromeda_research  (or direct search intent)
ANDROMEDA ORCHESTRATOR            ← src/convex/andromeda/orchestrator.ts
 ↓
QUERY UNDERSTANDING               ← andromeda/query.ts        [IMPLEMENTED]
 ↓
SOURCE SELECTION (per query plan)                            [IMPLEMENTED]
 ↓
PARALLEL RETRIEVAL — Promise.allSettled, per-source timeout  [IMPLEMENTED]
 ↓
NORMALIZATION + DEDUPLICATION     ← quality.ts, plan.ts      [IMPLEMENTED]
 ↓
SOURCE VERIFICATION GATES         ← andromeda/gates.ts       [IMPLEMENTED]
   (quality floor · freshness · corroboration)
 ↓
PAGE RETRIEVAL + EXTRACTION       ← pageFetcher (SSRF-guarded) [IMPLEMENTED]
 ↓
EVIDENCE PACK (traceable blocks)  ← evidence.ts              [IMPLEMENTED]
 ↓
GROUNDED SYNTHESIS + CITATION     ← evidence.ts (integrity-   [IMPLEMENTED]
  INTEGRITY enforcement)            checked [n] markers)
 ↓
INDEPENDENT VERIFICATION          ← verification.ts (same     [IMPLEMENTED]
                                    verifier as agents)
 ↓
ANSWER + SOURCES + GATE AUDIT → OMI → USER
```

**Integration with the existing pipeline (no separate intelligence system):**
Andromeda is invoked by the OMI Agent runtime through the shared tool
registry (`andromeda_research`), feeds the same Verification Agent that
guards all agent output, and shares the evidence/citation machinery with
deep research and the Andromeda search UI. The Planner → Agent →
Verification chain is unchanged — Andromeda is the fabric underneath it.

---

## 2. Provider-agnostic source layer

All sources implement one interface (`SearchProvider`,
`src/convex/searchProviders/types.ts`) and register in one array
(`searchProviders/index.ts`). Adding a source = new file + one registry
line. No call site changes.

Registered today — **all keyless, all $0 per query:**

| Source | Ecosystem | Role |
|---|---|---|
| SearXNG | self-hosted / public instances | web metasearch floor |
| Wikipedia | Wikimedia | encyclopedic facts |
| Wikidata | Wikimedia (CC0) | structured knowledge graph |
| arXiv | Cornell | papers |
| OpenAlex | open | 250M+ scholarly works |
| Open Library | Internet Archive | books |
| Hacker News | Algolia (keyless) | practitioner signal |
| Openverse | WordPress/open | openly-licensed images |
| Common Crawl | AWS open data | web index metadata (provenance) |
| GitHub | Microsoft/GitHub | public repository search — tech queries only, keyless 10/min, metadata only |
| GDELT | open (GDELT Project) | global news index — scope-gated to news queries, metadata only |
| Open-Meteo | open (CC-BY 4.0) | weather/structured data — scope-gated, attribution carried in snippets |
| **Your documents** | internal (Convex + BM25) | highest-trust source — `internal://` citations, searched FIRST, never leaves the workspace |
| DuckDuckGo | keyless HTML | last-resort web floor |

Every provider call is wrapped in a **composed guard** (`guardedCall`):
circuit breaker (a provider failing 3× opens its circuit and is skipped for a
60s cooldown — half-open probes test recovery) + per-call timeout
(`SEARCH_PROVIDER_TIMEOUT_MS`, default 12s). A slow or dead source never
blocks Andromeda (graceful fallback, §30). Live-environment verification has
shown this matters: arXiv can exceed timeouts from some hosts — its breaker
opens and the other sources keep flowing. Cost controls: bounded fan-out
(≤3 query angles), per-engine result caps, dedupe-before-synthesis, cache
with freshness-aware bypass, synthesis only when gates leave enough evidence.

**[IMPLEMENTED] seams already in use:**
- Document corpora — user-owned knowledge is a first-class source (the
  `internal://` corpus, searched first, tier "highest trust")
- News coverage via the GDELT open index

**[PLANNED] provider seams** (interface already supports them):
- Commercial APIs (Brave, Exa, Tavily, Serper…) — optional, off by default,
  never mandatory (§2/§6)
- **Omi's own crawler/index** — self-hosted crawl + OpenSearch/FAISS index

**[EXCLUDED]:** metered-only APIs as mandatory dependencies; content
republishing beyond license terms.

---

## 3. Query understanding [IMPLEMENTED]

`andromeda/query.ts` — pure, deterministic, no network:
- classifies: factual / comparative / temporal / exploratory / definitional
- decides `freshnessMatters` (skips cache, boosts recency) and
  `corroborationRequired` (comparative + temporal)
- emits bounded subqueries (≤3 angles, e.g. both sides of a "vs" question)
- emits source hints and a synthesis discipline per question kind
- **security gate:** instruction-injection-patterned queries are rejected
  before any retrieval (§12)

## 4. Source verification gates [IMPLEMENTED]

`andromeda/gates.ts` — applied after dedupe, before synthesis; every
rejection is auditable with reasons:
1. **Quality floor** — "low"-tier sources never reach synthesis
2. **Freshness** — dated-but-stale evidence is held back on temporal
   questions; if ALL evidence is stale, the run **fails honestly instead of
   answering stale**. Undated sources are *not* treated as stale (they warn).
3. **Corroboration** — comparative/temporal claims need ≥2 *independent
   domains*; engine repetition is not independence (**REPETITION ≠ TRUTH**,
   §10). Unmet corroboration degrades to a loud warning, not silent confidence.

## 5. Synthesis, citations, verification [IMPLEMENTED]

- Evidence packs are built **only** from real citations (numbered, with
  domain + tier + dates) — the model never sees an invented source.
- `synthesizeResearchAnswer` forces inline `[n]` citations; post-synthesis
  integrity checking strips unmapped `[n]` and reports the verified ratio.
- The **independent Verification Agent** (separate adversarial prompt path)
  issues pass / warnings / unverified / failed on every answer.
- If no AI provider is configured: extractive floor + explicit
  "not full synthesis" note. **Never fabricates** (§35).

## 6. Tests [IMPLEMENTED]

`tests/andromedaQuery.test.ts` (10) · `tests/andromedaGates.test.ts` (11) ·
`tests/andromedaOrchestrator.test.ts` (13) — covering routing, duplicate
sources, stale results, citation integrity, provider-fallback/failure
contracts, and injection rejection; plus the full Omi suite (138+ tests).

Privacy boundary (§41): GitHub results carry public repository METADATA only
(name, description, language, stars, license, last push) — no code content is
fetched or stored, and private data never leaves the workspace to providers.

## 7. Operating-cost posture

Product goal: **free to use**. Reality: third-party APIs are rate-limited
and can change. Controls in place: zero mandatory paid dependency
(test-pinned), keyless sources only, bounded retrieval, caching, dedupe,
degradation paths. Optional keys (Groq/DeepSeek vision & reasoning) live in
env/secrets only — never in code, never in the frontend (§28).

## 8. Retrieval engine and what's still planned

**[IMPLEMENTED] hybrid local retrieval** (`searchEngine/retrieval.ts`):
BM25 (IDF · length normalization · term saturation) plus the locality
signals plain BM25 misses — BM25F-style *title field weighting*, *typo
tolerance* (edit-distance-1, reduced weight) and *proximity* (distinct query
terms near each other). Deterministic, explainable, zero dependencies, zero
cost. `retrievalMode` selects `hybrid` (default), `bm25`, or the legacy
keyword scorer for A/B comparison.

**[PLANNED] — blocked, and honestly so:** embedding-based vector search.
The seam is reserved, but this deployment has **no working embedding
provider** (the workspace gateway rejects its key and the OpenAI account has
no credits), and no free server-side embedding API is available. Shipping an
embedding path that could never run would be a fake feature (§35), so the
engine deliberately stays deterministic and dependency-free until a provider
exists. To unlock it: add an embeddings-capable key via the project's API
Keys tab; the adapter then slots in behind `parseRetrievalMode` with no call
site changes.

**[PLANNED] other:**
- Omi crawler + self-hosted index (needs infrastructure)
- Commercial search adapters behind explicit user opt-in

## 9. Workspace surfaces [IMPLEMENTED]

- **Andromeda view** — meta-search with briefs, citations, provenance
- **Andromeda Pipeline card** (deep research) — the full §4 fabric visible:
  plan → retrieval → dedupe → gates → synthesis → verification, with a
  per-stage timing audit, gate warnings, and verdict badge
- **Automation view** — research-report workflows built on the same fabric
- **Agent tool** — `andromeda_research` callable by specialized agents
- **Files view** — text/DOCX/XLSX/PDF/images ingestion feeding the internal
  corpus that Andromeda searches first; scanned PDFs fall back to on-device
  OCR (tesseract.js, Apache-2.0, keyless, §41-private) **[IMPLEMENTED]**
- **Automation approval gates** — workflows pause before saving a report and
  require an explicit human Approve/Reject decision (24h window, final,
  expiry-honest) per §11 **[IMPLEMENTED]**
- **Progressive chat** — Omi's reply updates live through
  thinking → searching → reading → reasoning stages; final answers are
  immutable **[IMPLEMENTED]**
- **Universal orchestration in chat** — every message is classified first:
  calculations → sandboxed local engine (zero network), greetings → no
  search, URLs → page-read instead of engine spam, knowledge/current/news →
  Andromeda **[IMPLEMENTED]**
- **Resilience** — `guardedCall` (circuit breaker + timeout) wraps every
  search provider; AI provider transports carry abort deadlines; /api/status
  surfaces circuit state **[IMPLEMENTED]**
