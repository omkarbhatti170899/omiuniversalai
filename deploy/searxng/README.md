# Omi's self-hosted SearXNG — deploy runbook

Architecture this establishes:

```
Omi (Convex chat/search)
  → Andromeda pipeline
    → OUR SearXNG  (JSON API, curated engines, limiter, health)
      → multiple legitimate engines (wikipedia, mwmbl, arxiv, openalex, …)
```

The public community instance stays configured as a documented fallback; the
circuit breaker, health probing, and fail-open engine scoping in the adapter
are unchanged. **No search-engine restrictions are bypassed**: the engine
list in `settings.yml` enables only official-API / permissive sources, and
Google/Bing/DuckDuckGo/Startpage/Qwant remain off (see the file's reasoning).

## 1. Provision a host

Any small VPS with a stable IP and Docker (Hetzner/DO ~€4/mo). Point a DNS
A/AAAA record at it, e.g. `searxng.example.com`.

## 2. Configure

```bash
cd deploy/searxng

# Secrets — generate both, never commit them:
openssl rand -hex 32   # → SEARXNG_SECRET   (settings/compose)
openssl rand -hex 32   # → SEARXNG_SHARED_SECRET (the X-Omi-Secret gate)

cat > .env <<'EOF'
SEARXNG_DOMAIN=searxng.example.com
SEARXNG_BASE_URL=https://searxng.example.com/
SEARXNG_SECRET=<hex-32>
SEARXNG_SHARED_SECRET=<hex-32>
EOF

# Replace the placeholder real_ip prefix in limiter.toml with your host's
# public network (or remove the section to use SearXNG defaults).
```

## 3. Deploy

```bash
docker compose up -d
docker compose logs -f searxng   # watch for engine errors on first start
```

## 4. PROVE IT — before touching the pipeline

The gate Omi requires, in order:

```bash
# 4a. JSON API answers at all:
curl -s "https://searxng.example.com/search?q=test&format=json" | head -c 300
# expect: {"query":"test","results":[ … ]}      (200, application/json)

# 4b. Without the shared secret it must be CLOSED:
curl -s -o /dev/null -w "%{http_code}\n" "https://searxng.example.com/search?q=test&format=json"
# expect: 403

# 4c. The real query, with the secret Andromeda will send:
curl -s -H "X-Omi-Secret: $SEARXNG_SHARED_SECRET" \
  "https://searxng.example.com/search?q=Indian+contingent+medals+tally+Asian+Games+2026&format=json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['results']),'results'); print(d.get('unresponsive_engines'))"

# 4d. Health endpoint for monitors:
curl -s -o /dev/null -w "%{http_code}\n" https://searxng.example.com/healthz
# expect: 200
```

## 5. Connect to the pipeline (server-side only)

The production URL is stored **server-side** — never in the frontend:

```bash
bunx convex env set SEARXNG_BASE_URL https://searxng.example.com
bunx convex env set SEARXNG_SHARED_SECRET <hex-32>
```

The adapter (`src/convex/searchProviders/searxng.ts`) sends the secret
automatically when `SEARXNG_SHARED_SECRET` is present; readiness stays
measured (probe-gated), and the existing circuit breaker, per-engine
suspension, total budget, and partial-result behaviour are untouched.

Verify from inside the Convex runtime (the honest check):

```bash
bunx convex run diagnostics:probeSearxng '{}'
# expect: probe.healthy = true, "JSON API reachable"
bunx convex run diagnostics:stressSearxng '{}'   # target: median < 1.5 s, max < 5 s
```

## 6. Monitoring

- `/healthz` (200, no auth) — point any uptime monitor at it; it is the
  compose healthcheck too, so an unhealthy container is restarted by Docker.
- `docker compose logs searxng` — engine timeouts/suspensions appear here and
  in `unresponsive_engines` on every JSON response.
- Caddy access log: `/data/access.log` (10 MiB rotation, 5 kept) inside the
  `caddy_data` volume — who hit the JSON gate and when.
- Alert on: healthz non-200 for 2 minutes, or unresponsive_engines containing
  ≥3 engines for 10 minutes (upstream-wide trouble, not one bad engine).

## 7. Rollback

```bash
bunx convex env set SEARXNG_BASE_URL https://search.lumy.live
```

One env var. Readiness is measured, so the health cron re-verifies within a
probe cycle. Keep the community instance configured as documented fallback
until the self-hosted one has run clean for a week.

## 8. What "reliably responding" means here (acceptance)

- `/search?q=test&format=json` → 200 JSON on 3 consecutive attempts
- Asian Games query → ≥5 results, ≤8 s, with the curated engines answering
- 403 without the shared secret
- `unresponsive_engines` never contains more than a minority of engines
- 48 h of healthz 200s before it is trusted as the primary breadth layer
