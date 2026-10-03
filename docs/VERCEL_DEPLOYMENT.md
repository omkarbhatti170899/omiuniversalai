# Vercel deployment

The repository's **primary** deployment is GitHub Pages
(`.github/workflows/deploy-pages.yml`). Vercel is a secondary/mirror target; it
was previously running with **no configuration at all**, which shipped a broken
build (blank page) because `VITE_CONVEX_URL` was never provided.

## What `vercel.json` pins

| Setting | Value | Why |
|---|---|---|
| `framework` | `vite` | Matches the repo (Vite + `@vitejs/plugin-react`). |
| `buildCommand` | `bun run build` | Uses the repo's own build (`convex codegen → tsc -b → vite build`). |
| `outputDirectory` | `dist` | Vite's default output; matches the Pages artifact. |
| `build.env.VITE_CONVEX_URL` | production Convex URL | **Required.** Inlined into the bundle at build time. |
| `rewrites` | `/(.*) → /index.html` | SPA deep links (react-router) must not 404. Static assets still serve first. |

## Required environment variable

- **`VITE_CONVEX_URL`** — build-time, inlined by Vite. Must be
  `https://majestic-turtle-372.convex.cloud` (the production Convex
  deployment). It is a **public** connection string — like a Firebase project
  id, it identifies the backend and grants no access.
- It is set in `vercel.json` so the deployment works with zero dashboard setup.
  If you prefer to manage it in the Vercel dashboard, set it there and remove
  the `build.env` block; **do not** point it at a retired deployment.
- `VITE_BASE_PATH` is intentionally **not** set on Vercel (root hosting, base
  `/`). GitHub Pages sets `/omiuniversalai/` in the workflow only.

## What must NOT be set on Vercel

Server-side provider credentials (`GROQ_API_KEY`, `GEMINI_API_KEY`,
`OPENAI_API_KEY`, `SEARXNG_*`, …) belong to the Convex deployment, not the
frontend build. Only the public `VITE_CONVEX_URL` is ever compiled into the
bundle.

## Parity with the intended workflow

`vercel.json` reproduces the intended **build + serve** behavior (bun build,
`dist`, public backend URL, SPA routing). Vercel does not run the
`bun run typecheck` / `bun run test` gates — those remain enforced by the
GitHub Pages workflow, which is the release gate.

## Failure modes this prevents

1. **Blank page** — a bundle built without `VITE_CONVEX_URL` used to throw at
   module scope (before React mounted, outside every error boundary). Now
   `src/main.tsx` renders an actionable "Omi is not connected yet" notice
   instead of a blank screen.
2. **404 on deep links** — the SPA rewrite keeps `/auth`, `/dashboard`, etc.
   resolving on a static host.
