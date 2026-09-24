# Omi Universal AI

Omi is a provider-neutral AI workspace built with React, Vite, Tailwind CSS, shadcn/ui, Framer Motion, Bun, and Convex. It combines chat, web research, files, image tools, vision, user-approved memory, workflows, and conservative emotion-aware communication behind authenticated, user-scoped Convex functions.

## Current status

The web application and Convex development deployment build successfully. Core provider routing, Gemini fallback, Andromeda search, image generation, vision, Human Emotions AI, file extraction, memory isolation, workflow approvals, PWA behavior, and security contracts are covered by automated tests.

Two requested chat capabilities are not implemented: token streaming and per-message regenerate. Image editing is implemented but currently blocked by upstream provider quota/credit failures. Signed-in journeys and native Android behavior still require a real account/device and Android SDK. See [`docs/final-completion-report.md`](docs/final-completion-report.md) for the exact readiness assessment.

## Architecture

```text
React routes and workspace UI
        │
        ├── Convex Auth / protected routes
        ├── Convex queries and mutations (user-scoped data)
        └── Convex actions (provider/tool calls)
                    │
                    ├── AI router → Groq / Gemini / OpenAI-compatible providers
                    ├── Andromeda → multi-source search → evidence → citations
                    ├── Image router → capability-based generation/edit providers
                    ├── Vision router → multimodal image understanding
                    ├── File ingestion → storage → extraction → knowledge retrieval
                    └── Tools/workflows → calculator, web, memory, approvals
```

Important locations:

- `src/main.tsx` — React bootstrap, router, auth redirects, service-worker registration
- `src/pages/` — landing, authentication, and protected dashboard
- `src/components/workspace/` — dashboard and feature views
- `src/convex/aiProviders/` — provider-neutral AI, image, and vision routing
- `src/convex/andromeda/` — research planning and orchestration
- `src/convex/searchEngine/` — security, quality, evidence, routing, resilience
- `src/convex/searchProviders/` — individual search sources
- `src/convex/omi*.ts` — authenticated product domains and persistence
- `tests/` — Bun unit, contract, security, routing, and PWA tests
- `public/sw.js` and `public/manifest.webmanifest` — installable PWA shell

## Requirements

- Bun
- A Convex deployment
- Node/browser support for the Vite toolchain

## Setup

```bash
bun install
bun run typecheck
bun test tests/
bun run lint
bun run build
```

For a connected development environment, Convex codegen is run with:

```bash
bun convex dev --once
```

Do not use an interactive `convex dev` process in automation. Never place provider credentials in `VITE_*` variables.

## Environment variables

### Frontend (public, non-secret)

| Variable | Required | Purpose |
|---|---:|---|
| `VITE_CONVEX_URL` | Yes | Public Convex client connection URL |
| `VITE_BASE_PATH` | Deployment-specific | Optional Vite base path, e.g. `/omiuniversalai/` |

`VITE_*` values are embedded in the browser bundle. Never put an AI/search/storage secret there.

### Convex backend (secret)

| Variable | Required | Purpose |
|---|---:|---|
| `GEMINI_API_KEY` | Optional | Gemini text, vision, and image capabilities |
| `GROQ_API_KEY` | Optional | Primary free-tier AI and vision provider |
| `OPENAI_API_KEY` | Optional | Additional AI/image fallback |
| `DEEPSEEK_API_KEY` | Optional | Optional compatible provider |
| `SEARXNG_BASE_URL` | Optional | Self-hosted SearXNG endpoint |
| `RATE_LIMIT_PER_MIN` | Optional | Deployment-wide per-user rate-limit override |
| `SEARCH_PROVIDER_TIMEOUT_MS` | Optional | Search-provider timeout |
| `OMI_DISABLE_PROVIDERS` | Optional | Comma-separated deployment kill switch |

Add credentials through the project's API Keys UI or Convex environment settings. Do not edit `.env` files or commit credentials.

## Authentication and authorization

Convex Auth protects the product workspace. The frontend uses `RequireAuth`; signed-out users are redirected to `/auth?returnTo=...`, and successful authentication returns to the requested protected route.

Backend queries, mutations, and actions enforce authentication and ownership. User files, conversations, projects, memories, images, workflows, and research records are scoped by user/project ID. Uploads and attachment references fail closed when ownership cannot be proven.

## AI providers and routing

Call sites request a task, not a vendor. The AI router selects a healthy configured provider, retries compatible model fallbacks, applies timeouts/circuit breakers, and reports actionable failures. Gemini is interchangeable with the other providers and uses only `GEMINI_API_KEY` on the server.

To add a provider:

1. Add a descriptor to `src/convex/aiProviders/catalog.ts` with environment variable **names**, never values.
2. Implement the compatible transport or adapter.
3. Add task models, fallback models, timeout behavior, and health classification.
4. Add routing, failure, and secret-hygiene tests.

## Image engine

Image requests are classified as generation, edit, background removal/replacement, style transfer, upscale, enhance, variation, combine, outpaint, or understanding. The router selects only providers declaring the requested capability. Text-to-image providers never receive edit requests, and failed edits never return a newly generated unrelated image.

Generation is available through the keyless provider. Editing requires an image-input-capable provider and currently depends on external provider quota/billing.

## Andromeda and research

Andromeda plans the query, fans out across scoped search sources, deduplicates results, ranks source quality and freshness, reads pages, extracts evidence, maps claims to citations, detects conflicts/thin evidence, synthesizes an answer, and runs verification gates. Current/temporal queries bypass stale caching. Deep Research persists progress/results in `researchRuns`.

See [`docs/andromeda.md`](docs/andromeda.md) for pipeline details.

## Human Emotions AI

Emotion handling is conservative inference from conversational signals, not a claim to know a person's internal state. It is bounded by the user's actual request, can be disabled per user, falls back to a local heuristic when the model is unavailable, and does not persist chat emotion reads unless the user explicitly chooses to save an analysis.

## Files and knowledge

Supported paths include PDF, DOCX, TXT, CSV, XLSX, and images. Uploads are size/type validated, stored privately, extracted on-device where practical, ingested into owned document records, and retrieved through project/user-scoped hybrid search. Invalid and oversized files fail with explicit errors.

## Security model

- Provider credentials remain in Convex server environment variables.
- Web pages and documents are treated as untrusted data.
- SSRF checks reject local/private destinations.
- Prompt-injection and tool-call smuggling are sanitized and allowlisted.
- Upload validation, ownership checks, and rate limits protect expensive surfaces.
- Public health endpoints expose status/counts, not secrets or stack traces.
- CI rejects frontend builds that do not contain the configured backend URL.

## Testing and quality gates

```bash
bun tsc -b --noEmit       # TypeScript
bun test tests/           # 437 tests
bun run lint              # ESLint
bun run build             # Convex codegen + TypeScript + Vite production bundle
```

The suite covers Andromeda planning/evidence/citations, calculator sandboxing, DOCX/XLSX extraction, emotion scenarios and fallback, image intent/routing/errors/contracts, vision validation, provider fallback and model discovery, rate limiting, workflow approvals, project isolation, injection/SSRF defenses, and service-worker behavior.

## Deployment

`.github/workflows/deploy-pages.yml` installs with a frozen Bun lockfile, runs typecheck/tests/build, verifies `VITE_CONVEX_URL` is present in the bundle, and deploys `dist/` to GitHub Pages. The Convex backend is deployed separately; AI credentials stay in that deployment.

The current public web deployment and backend coordinates are recorded in [`docs/qa-report.md`](docs/qa-report.md).

## PWA and Android preparation

The web app includes a dark manifest, scoped start URL, service worker, offline fallback, standalone display mode, and production-only registration. `capacitor.config.ts` uses `com.ominnovations.omi`, the `dist` web directory, HTTPS, and no local backend. Native packaging instructions and current blockers are documented in [`docs/android-packaging.md`](docs/android-packaging.md).

## Troubleshooting

- **Blank preview:** verify `VITE_CONVEX_URL`, run `bun tsc -b --noEmit`, and inspect the root error boundary.
- **Convex binding errors:** run `bun convex dev --once`, then typecheck again. Do not edit `src/convex/_generated/*` manually.
- **Provider unavailable:** inspect the self-test/provider status; distinguish not configured, auth failure, quota/rate limit, timeout, and unsupported capability.
- **Image edit unavailable:** an edit-capable provider must be configured and funded; the router will not substitute generation.
- **Emotion indicator missing:** check the per-user emotion-aware setting and ensure normal chat still works when disabled.
- **PWA not updating:** rebuild with the deployment base path and verify `sw.js` scope; Convex/API calls intentionally remain network-only.
