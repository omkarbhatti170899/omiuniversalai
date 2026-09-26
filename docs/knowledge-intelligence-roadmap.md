# Omi Knowledge Intelligence — Roadmap & Architecture (locked)

This document locks the architecture and principles for Omi Knowledge
Intelligence so future work extends it rather than re-deciding it. It is
**free/open-source-first**: the base system must work with **no paid
knowledge-base vendor** (no RightAnswers/ServiceNow/Salesforce/Zendesk
subscription, no paid vector database).

## Locked product principles

1. **Actionable answers, not summaries.** A procedural answer is converted into
   an ACTION PLAN the user can follow:
   `DIRECT ANSWER → WHAT TO DO (steps) → REQUIRED INFORMATION → IMPORTANT CHECKS → EXCEPTIONS → WHEN TO ESCALATE → SOURCE → VERSION/EFFECTIVE → EVIDENCE`.
2. **NEVER invent procedural steps.** Steps, checks and required-info are
   extracted **only** from the retrieved authoritative article text. If the
   article lists no steps, the plan says so and points at the evidence — it
   never fabricates a procedure.
3. **Never guess when information is missing.** Insufficient evidence yields an
   explicit "not enough information" answer plus a logged knowledge gap.
4. **Conflicts are surfaced, not resolved silently.** Two close-scoring
   approved procedures produce a "human review required" notice.
5. **Internal vs external is never silently mixed.** Every answer is labelled
   `INTERNAL KNOWLEDGE` / `EXTERNAL RESEARCH` / `USER-PROVIDED FILE` / `WEB RESEARCH`.
6. **Version-aware.** The currently effective approved version wins; obsolete
   procedures are never used.
7. **The Critic recommends; humans publish.** No automatic authoritative changes.

## Target architecture

```
OMI
 ↓
KNOWLEDGE ROUTER  (decides the source; labels it)
 ↓
┌──────────────────────────────────────────┐
│ Omi Native KB            (implemented)   │
│ Uploaded files / project files (existing) │
│ BookStack                (planned)       │
│ Wiki.js                  (planned)       │
│ DokuWiki                 (planned)       │
│ MediaWiki                (planned)       │
│ Docusaurus               (planned)       │
│ Git repositories         (planned)       │
│ Andromeda / SearXNG      (implemented)   │
└──────────────────────────────────────────┘
 ↓
HYBRID RETRIEVAL (keyword + recency + authority + version; semantic = planned)
 ↓
PERMISSION CHECK (role-based, per-user; multi-tenant = planned)
 ↓
VERSION CHECK (effective/expiration/region/product/department)
 ↓
EVIDENCE VERIFICATION (hard evidence floor)
 ↓
ACTIONABLE ANSWER (steps + checks + exceptions + escalation)
 ↓
SOURCE + VERSION + CITATION
 ↓
USER FEEDBACK
 ↓
KNOWLEDGE GAP / IMPROVEMENT
 ↓
HUMAN APPROVAL  →  UPDATED KNOWLEDGE
```

## Implemented now

- **Omi Native KB** — `omiKnowledgeArticles`/`omiKnowledgeRevisions` with
  categories, tags, product/department/region, owner, audience roles,
  status lifecycle (draft → in review → approved → published → expired →
  archived), version, effective/review/expiration dates, provenance.
- **Ingest entry points** — the existing Files pipeline already extracts
  PDF/DOCX/XLSX/CSV/TXT/MD/HTML/OCR on-device; knowledge articles can be
  authored or created from those files or from a knowledge gap.
- **Hybrid retrieval** — BM25 hybrid scorer (keyword + field weighting + typo
  tolerance + proximity) plus metadata filters, recency/authority via
  effective-date version selection.
- **Permissions** — per-user isolation + knowledge-role visibility (`agent`,
  `supervisor`, `admin`, `knowledge_manager`).
- **Version-aware selection** — one effective version per family.
- **Actionable answers** — `buildActionPlan` / `formatActionPlan` (procedure and
  troubleshooting shapes), with the no-invention guarantee.
- **Knowledge Critic**, **Gap engine**, **Feedback**, **Admin dashboard**, and
  the **Knowledge Intelligence UI** view.
- **SearXNG** — already an optional Andromeda search provider
  (`SEARXNG_BASE_URL`), used for web discovery only, never as the internal KB.

## Planned / NOT implemented (do not claim these as done)

- **Optional free/open-source connectors:** BookStack, Wiki.js, DokuWiki,
  MediaWiki, Docusaurus, Git/markdown repositories. Each is an adapter behind
  the Knowledge Router; Omi must work perfectly without them.
- **Knowledge Router** as an explicit multi-source component with source labels
  across chat/Andromeda/Files/Agents (today: native KB first, labelled, then
  web — the router abstraction is not yet extracted).
- **Semantic/embedding retrieval** (today: BM25 hybrid only).
- **Knowledge graph** (product → process → procedure → step → exception →
  escalation → source).
- **Multi-tenant / organization model** (today: per-user + roles).
- **Workflow-shaped action plans** (`START → STEP → DECISION POINT → NEXT → COMPLETION`).
- **Domain profiles** for insurance/contact-center (SOPs, claims, QA,
  escalation rules, scripts) — configurable domains, not hard-coded assumptions.
- **Canvas integration** and a **scheduled Critic sweep**.

## Cost principle

Free/open-source components are preferred, but **free software ≠ zero
infrastructure cost**. Documented separately:

- Convex (hosting + storage) — the app's existing backend; scales with usage.
- Optional self-hosted **SearXNG** container — the user's own infra cost.
- Optional embedding model/host if semantic retrieval is added later.
- No paid knowledge-base subscription is required for the base system.

## Testing expectations

Import/parsing, indexing, search, hybrid retrieval, permissions, version
selection, expiration, citations, **action steps**, contradictions, feedback,
knowledge gaps, admin approval, and cross-tenant isolation each need automated
coverage, followed by real end-to-end testing. Engine rules are covered in
`tests/omiKnowledgeIntelligence.test.ts`.
