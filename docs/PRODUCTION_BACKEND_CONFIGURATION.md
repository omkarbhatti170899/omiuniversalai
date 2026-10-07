# Production backend configuration — owner runbook

**Scope:** the Convex deployment the GitHub Pages frontend is compiled against.
**Applies to:** `majestic-turtle-372` (production) · audited 2026-10-07.
**Rule:** this document names env vars, never values. Set them per-deployment in
the Convex dashboard or CLI — never in the repository, never in the frontend.

---

## 1. Why this document exists

Every automated gate was green while production was unusable:

| Check | Result | What it did **not** prove |
| --- | --- | --- |
| `/status`, `/health`, `/selftest` return 200 | pass | the deployment is *configured* |
| bundle compiled against the approved backend | pass | the backend can authenticate a user |
| commit / base path / secret-shape gates | pass | an AI provider can be called |

Measured on 2026-10-07:

```text
https://majestic-turtle-372.convex.site/.well-known/jwks.json  → HTTP 500
https://striped-salmon-879.convex.site/.well-known/jwks.json   → HTTP 200 (1 signing key)

majestic-turtle-372 (production)  ai.configured=false  vision=false  keyed sources 0/2
striped-salmon-879   (dev)        ai.configured=true   vision=true   keyed sources 2/2
```

`JWKS`/`JWT_PRIVATE_KEY` are absent on production, so Convex Auth cannot publish
signing keys and every sign-in returns HTTP 500 (`RequireAuth` sends the visitor
to `/auth`, which cannot complete). The AI, vision and keyed-search gaps sit on
the same root cause: the production deployment has no environment variables
while the dev deployment holds all of them.

This is now machine-checked — see `scripts/prodGates/checkBackendConfig.ts`,
wired into `.github/workflows/deploy-pages.yml` (report in the build job,
`--strict` in `verify-live`). Until production is configured, `verify-live`
fails on purpose; that red check *is* the report.

---

## 2. What to set on `majestic-turtle-372`

Minimum for a usable product:

| Env var | Needed for | Effect when missing |
| --- | --- | --- |
| `JWT_PRIVATE_KEY` | sign-in (Convex Auth) | `/auth` fails — **no user can sign in** |
| `JWKS` | sign-in (publishes the public key) | `/.well-known/jwks.json` → HTTP 500 |
| `GROQ_API_KEY` | AI synthesis + vision (free tier) | extractive mode only; images cannot be described |

Optional capability (same keys unlock the listed feature):

| Env var | Needed for |
| --- | --- |
| `GEMINI_API_KEY` | second AI + vision provider (independent free quota) |
| `OPENAI_API_KEY` | paid AI + vision adapter |
| `DEEPSEEK_API_KEY` | paid AI adapter |
| `SEARXNG_BASE_URL` | general-web search breadth (JSON-format instance) |
| `SEARXNG_SHARED_SECRET` | when the self-hosted instance is behind the shared-secret proxy |
| `ENABLE_LANGSEARCH=true` + `LANGSEARCH_API_KEY` | the LangSearch evaluation adapter |
| `POLLINATIONS_API_KEY` | image generation (works keyless; the key raises limits) |
| `SPORTSDB_API_KEY` | live sports scores |
| `OMI_DISABLE_PROVIDERS=vly` | keeps the rejected workspace gateway unrouted |

Env vars this codebase reads (from `src/convex`), for reference:
`SEARXNG_BASE_URL`, `SEARXNG_SHARED_SECRET`, `POLLINATIONS_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`,
`LANGSEARCH_API_KEY`, `ENABLE_LANGSEARCH`, `OMI_DISABLE_PROVIDERS`,
`SPORTSDB_API_KEY`, `ENABLE_GDELT`, `VISION_MAX_TOKENS`, `VLY_CONVEX_AUTH_ISSUER`,
`VLY_INTEGRATION_KEY`, `VLY_INTEGRATION_BASE_URL`, plus timing/limit tunables
(`AI_PROVIDER_TIMEOUT_MS`, `SEARCH_PROVIDER_TIMEOUT_MS`, `SEARCH_CACHE_TTL_MS`,
`PAGE_CACHE_TTL_MS`, `OMI_SEARCH_DEADLINE_MS`, `RATE_LIMIT_PER_MIN`).

Notes:

- `SITE_URL` on production points at the dev deployment. Nothing in this
  codebase reads `SITE_URL`, so it is harmless — but it is misleading in the
  dashboard; set it to `https://majestic-turtle-372.convex.site` for tidiness.
- `CONVEX_SITE_URL`/`CONVEX_CLOUD_URL` are system vars; never set them by hand.
- Production and dev are separate deployments with separate databases and
  separate auth material. Adding a key to production does not affect dev.

---

## 3. How to set them

**Dashboard (recommended):** Convex → team `omkar-bhatti` → project
`omiuniversalai` → deployment `majestic-turtle-372` → Deployment Settings →
Environment variables → add each name from the tables above.

**CLI:** select the production deployment explicitly. If `CONVEX_DEPLOY_KEY` is
set in the shell, the CLI uses *its* deployment and silently ignores
`--prod`/`--deployment-name` — so verify which deployment you are on first:

```bash
bunx convex env list --names-only        # which names are already there
bunx convex env set GROQ_API_KEY          # prompts for the value (no shell history)
```

**Auth keys:** `JWT_PRIVATE_KEY` and `JWKS` are a matched pair generated for the
deployment. Do not copy dev's pair if you can avoid it — generate a production
pair with the Convex Auth generator (`npx @convex-dev/auth`), or copy the pair
only as a stopgap and rotate it afterwards.

**Never:** commit values, paste them into issues/docs/chat, or bake them into
`VITE_*` variables (the frontend bundle is public).

---

## 4. Verify — the only proof that counts

```bash
# 1. The audit itself (exit 0 = configured, exit 1 = gaps; --strict fails on warnings)
bun scripts/prodGates/checkBackendConfig.ts https://majestic-turtle-372.convex.cloud --strict

# 2. Auth directly
curl -s -o /dev/null -w '%{http_code}\n' \
  https://majestic-turtle-372.convex.site/.well-known/jwks.json   # expect 200

# 3. Capabilities
curl -s https://majestic-turtle-372.convex.site/status | head -c 400
#   expect: "configured": true and "activeProvider": "groq"
# 4. End-to-end
curl -s https://majestic-turtle-372.convex.site/selftest
#   expect: "ai providers" and "vision" move off [fail]
```

After the first successful run, the `verify-live` job in the Pages workflow goes
green — that is the signal this section is done.

---

## 5. The alternative (decision, not a recommendation)

The other way to make production work is to point the frontend at the
deployment that is already configured (`striped-salmon-879`). That is a
two-literal change (`.github/workflows/deploy-pages.yml` → `VITE_CONVEX_URL`,
and `vercel.json` → `build.env.VITE_CONVEX_URL`), but it means production runs
on the **dev** deployment: same database as preview, no isolation, and
`docs/OMI_1_0_RELEASE_GATE.md` documents that deployment as dev. Prefer
configuring `majestic-turtle-372` unless you deliberately decide otherwise.
