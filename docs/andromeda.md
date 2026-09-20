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

Every provider gets: timeout, retry, error isolation, health status; a slow
or dead source never blocks Andromeda (graceful fallback, §30). Cost
controls: bounded fan-out (≤3 query angles), per-engine result caps,
dedupe-before-synthesis, cache with freshness-aware bypass, synthesis only
when gates leave enough evidence.

**[PLANNED] provider seams** (interface already supports them):
- Commercial APIs (Brave, Exa, Tavily, Serper…) — optional, off by default,
  never mandatory (§2/§6)
- News GDELT-style open indexes — broader news coverage
- Document corpora — user-owned knowledge as a first-class source
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

## 8. Planned next [PLANNED]

- Omi crawler + self-hosted index (needs infrastructure)
- Semantic retrieval behind the reserved `retrievalMode` seam
- Commercial search adapters behind explicit user opt-in
- OCR for scanned PDFs (client-side Tesseract adapter)

## 9. Workspace surfaces [IMPLEMENTED]

- **Andromeda view** — meta-search with briefs, citations, provenance
- **Andromeda Pipeline card** (deep research) — the full §4 fabric visible:
  plan → retrieval → dedupe → gates → synthesis → verification, with a
  per-stage timing audit, gate warnings, and verdict badge
- **Automation view** — research-report workflows built on the same fabric
- **Agent tool** — `andromeda_research` callable by specialized agents
- **Files view** — text/DOCX/XLSX/PDF/images ingestion feeding the internal
  corpus that Andromeda searches first
