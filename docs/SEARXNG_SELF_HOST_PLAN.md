# Self-Hosted SearXNG — Plan

**Status:** PLAN, MOVED BEHIND THE FREE-TIER POLICY (owner decision 2026-09-30:
Omi search stays at ₹0/month — see §3). Self-hosting happens ONLY on a free or
owner-owned machine; until then SearXNG is OPPORTUNISTIC: used when a healthy
free instance exists, skipped without penalty when it does not.
**Why this plan exists:** the general-web breadth layer must not depend on a
third-party community instance.

---

## 1. The problem, measured

Omi currently points `SEARXNG_BASE_URL` at **`https://search.lumy.live`** — a **community** instance, free, with no SLA and no control.

Measured behaviour over this session:

| Observation | Evidence |
|---|---|
| It works, but slowly | Stress test: median **1,021 ms**, p95/max **12,112 ms**, 15/15 success |
| It intermittently times out | Several live runs returned **0 results after the 12 s budget** |
| It degraded our own health checks | Twice during this session `/selftest` dropped from 23/0 to **21/1** solely because the reachability probe timed out, then recovered to 23/0 with no code change |
| It is rate-limited | Repeated probing (mine) is enough to destabilise it |
| It is the only true general-web source | `gdelt` and `wikipedia-current-events` do not cover arbitrary queries, so when SearXNG goes quiet, Omi honestly refuses |

**The risk is not theoretical.** Omi already degrades correctly — it refuses rather than answering from memory — but the *user experience* is "Omi can't find anything", which is indistinguishable from a broken product.

## 3. Addendum — 2026-09-28 outage classification (measured, deployed runtime)

`search.lumy.live` went fully dark during this session. `diagnosticsSearxngDeep:probeSearxngCandidates` from the Convex runtime classified it decisively:

- **DNS resolves, TCP 443 accepts, TLS completes, and the host never sends an HTTP response** — the request dies at the 8 s client timeout. That is an **instance-side hang**, not an egress, DNS, or endpoint-configuration problem on Omi's side.
- A **control instance answered 200 + JSON in ~276 ms** from the same runtime in the same probe window, ruling out production egress entirely.
- A 12-instance sweep found **zero public fallbacks**: 1 dead (lumy), 1 broken TLS chain, 4 serving HTML because `search.formats` JSON is disabled, 5 returning 429 (rate-limited), 1 returning 403, 0 healthy.

**Conclusion:** every public JSON-enabled SearXNG endpoint reachable from this runtime is either dead, misconfigured for JSON, or rate-limited. The self-host plan in §2 is no longer optional — it is the only path to a reliable breadth/federation layer. The adapter already fails open (measured fallbacks, circuit breaker, partial results), so the outage degrades to LangSearch + structured providers instead of breaking search.

## 4. The fix — NOW BUILT (deploy/searxng/)

The deployment package exists and is tested:

| File | What it enforces |
|---|---|
| `deploy/searxng/settings.yml` | JSON format ON · curated permissive engines only (google/bing/duckduckgo/startpage/qwant explicitly off) · per-engine `request_timeout: 3.0` / hard cap 6.0 · limiter on |
| `deploy/searxng/docker-compose.yml` | read-only + no-new-privileges container · NO host ports (caddy is the only front door) · `/healthz` healthcheck drives Docker restarts |
| `deploy/searxng/Caddyfile` | automatic TLS · `X-Omi-Secret` shared-secret gate on `format=json` (403 without it) · unauthenticated `/healthz` for monitors · access logs |
| `deploy/searxng/limiter.toml` | real-IP behind the proxy · bot detection tuned · Andromeda exempted by the secret, not by IP |
| `deploy/searxng/README.md` | the runbook: provision → configure → deploy → **prove** → connect → monitor → rollback |

Adapter support shipped in the same pass:
- `SEARXNG_SHARED_SECRET` (server-side env) is presented as `X-Omi-Secret` on every probe and search.
- **Dead-instance skip**: the search path consults per-base health memory BEFORE dialing, so a fresh unhealthy probe means no timeout is paid at all; a success clears the verdict (self-healing); if every base is known-dead, one is still attempted so recovery is never locked out beyond the 5-minute TTL.
- `diagnosticsSearxngDeep:verifySearxngJson` — the proof gate: `/search?q=test&format=json` on N consecutive attempts, then the real Asian Games query with dated-share and engine attribution. `proofOk: true` is the precondition for switching `SEARXNG_BASE_URL`.

### Addendum (2026-09-28, later): the community instance RECOVERED

`search.lumy.live` came back mid-session. Host-side proof (3 consecutive
attempts + the real query):

- `/search?q=test&format=json` → 200 JSON ×3 (7.7 s, 2.0 s, 1.9 s)
- Asian Games query → 200 in 1.26 s, 15 results (olympics.com 2026 medal
  tally, NDTV medals tally), 3 dated, via `yandex`
- `unresponsive_engines`: duckduckgo (access denied), mwmbl (timeout),
  seznam (too many requests) — 3 engines self-suspended, the rest answering

**Honest read:** it answers today, but it is still a shared community host
with no SLA, an engine list we do not control, and today's own history of
multi-hour outages. The self-host remains the plan; the recovery removes the
emergency, not the dependency.

## 5. The fix (original plan text, kept for the rollback path)

Run SearXNG yourself. It is a single Docker container, no database, no account, and it removes the shared-instance dependency entirely.

### 2.1 Run it

```bash
docker run -d \
  --name omi-searxng \
  --restart unless-stopped \
  -p 8080:8080 \
  -e BASE_URL=http://searxng.your-domain.example/ \
  -e INSTANCE_NAME="Omi Search" \
  -v ./searxng:/etc/searxng \
  searxng/searxng:latest
```

### 2.2 **Enable the JSON format — this is the critical step**

Omi needs `application/json`. It is **off by default**, and this is precisely why 70 public instances were probed and only one returned usable results earlier.

`searxng/settings.yml`:

```yaml
use_default_settings: true

server:
  # Required for a real reverse proxy; optional for a private instance.
  secret_key: "CHANGE-ME-long-random-string"
  limiter: false          # only if strictly private
  image_proxy: false

search:
  # THE setting that matters.
  formats:
    - html
    - json

outgoing:
  request_timeout: 5.0
  max_request_timeout: 10.0
  pool_connections: 20
  pool_maxsize: 10

engines:
  # ---------------------------------------------------------------
  # CURATED LIST — revised 2026-09-27 after the provider capability
  # review (docs/ANDROMEDA_PROVIDER_CAPABILITY_MATRIX.md).
  #
  # The rule: SearXNG is a METASEARCH engine. Whatever we enable here, we
  # end up sending automated queries to. Enabling an engine therefore means
  # accepting that engine's terms of service on Andromeda's behalf. Google,
  # Bing, DuckDuckGo and Startpage all actively block or restrict automated
  # clients, and several serve bot challenges instead of results — so they
  # are not merely risky, they are also useless (we measured DuckDuckGo
  # returning zero results, reproducibly).
  #
  # Start with engines that either permit programmatic access or have an
  # official API. Add a commercial engine only with a licence.
  # ---------------------------------------------------------------

  # --- Safe: open APIs / permissive, no API key needed ---
  - name: wikipedia
    disabled: false
  - name: wikidata
    disabled: false
  - name: mojeek
    disabled: false       # own crawler + official API, AI usage permitted
  - name: openverse
    disabled: false
  - name: arxiv
    disabled: false
  - name: pubmed
    disabled: false
  - name: crossref
    disabled: false
  - name: openalex
    disabled: false
  - name: hackernews
    disabled: false
  - name: gitlab
    disabled: false
  - name: docker hub
    disabled: false
  - name: mwmbl
    disabled: false       # independent open index

  # --- Requires a licensed API key before enabling ---
  - name: brave
    disabled: true        # needs BRAVE_API_KEY ($5/1000; free tier removed)
  - name: qwant
    disabled: true        # no official API — needs anti-bot cookie bypass

  # --- NOT ENABLED: block automated clients and/or forbid it ---
  # Each of these blocks datacenter IPs, serves CAPTCHA/bot-challenge pages,
  # or prohibits scraping in its terms. Enabling one is both a ToS breach
  # and, measured, a source of zero results:
  - name: google
    disabled: true        # blocks automated queries; will ban the instance
  - name: bing
    disabled: true        # same class of restriction
  - name: duckduckgo
    disabled: true        # we already removed the direct scraper for this
  - name: startpage
    disabled: true
  - name: google images
    disabled: true
  - name: bing images
    disabled: true
  - name: duckduckgo images
    disabled: true
```

> **Do not enable Google, Bing, DuckDuckGo or Startpage.** They block automated
> clients and restrict scraping in their terms. A metasearch instance is only as
> defensible as its *weakest enabled engine*, so the curated list above is a legal
> control, not a performance tweak.
>
> **On Qwant specifically:** SearXNG's shipped Qwant engine works by
> reverse-engineering an undocumented endpoint and storing a **DataDome
> anti-bot cookie**. That is scraping with bot-protection bypass, which this
> project forbids. It stays disabled. If Qwant is ever wanted, it must be via a
> written commercial agreement, not an engine toggle.

### 2.3 Keep it private

If the instance is **not** public, the only thing exposed to the internet is Omi's own backend. Do not publish a JSON-enabled instance publicly — open SearXNG instances get abused within hours and then block you.

- Bind to `127.0.0.1` and let only the Convex deployment reach it, **or**
- Put it behind a reverse proxy with a shared secret / IP allow-list.

### 2.4 Point Omi at it

```bash
bunx convex env set SEARXNG_BASE_URL https://searx.your-domain.example
```

Then verify **from inside the Convex runtime** (this is the honest check — it proves the backend can actually reach it, not just that a variable is set):

```bash
bunx convex run diagnostics:probeSearxng '{}'
# expect: "JSON API reachable (N probe results, application/json)"
```

Readiness is **measured**, never inferred: `isConfigured()` treats a configured instance as eligible unless a probe has *proved* it broken, and a 5-minute `warmWebHealth` cron re-probes.

## 3. Where to host it

> **POLICY (owner decision, 2026-09-30): the entire search infrastructure stays
> at ₹0/month. No Fly.io deployment, no paid VPS, no paid proxy, no paid search
> API. Nothing that can generate a bill gets provisioned without the owner's
> explicit approval. Self-hosting remains POSSIBLE only as a free-tier or
> owner-owned machine; until then SearXNG is used opportunistically — see §0.**

| Option | Cost | Notes |
|---|---|---|
| **Free public instances (current mode)** | **₹0** | Use opportunistically; never a hard dependency (see §0) |
| A home machine / NAS (owner-owned) | ₹0 | Fine for development; acceptable for production if uptime is real |
| ~~Fly.io / any paid VPS~~ | ~~€4/mo~~ | **REMOVED from the roadmap by owner decision** — do not provision without explicit approval |
| Cloudflare Workers | not suitable | SearXNG is a Python app, not edge-compatible |

Anything with a public HTTPS endpoint and a stable IP will do. **Avoid serverless platforms that suspend instances** — a cold start is exactly the 12 s timeout we are trying to eliminate.

## 4. Verification before switching over

1. `docker logs omi-searxng` shows no engine errors.
2. From your machine: `curl -s "https://searx.example/search?q=test&format=json" | head -c 300` returns real results.
3. `bunx convex run diagnostics:probeSearxng '{}'` → reachable **from the Convex runtime**.
4. `bunx convex run diagnostics:stressSearxng '{}'` → aim for **median < 1.5 s, max < 5 s** over 15 queries.
5. Point `SEARXNG_BASE_URL` at it, then re-run `GET /selftest` twice, 10 minutes apart, and confirm **23/0** both times.

## 5. Rollback

The old value is one env var. If the new instance misbehaves:

```bash
bunx convex env set SEARXNG_BASE_URL https://search.lumy.live
```

Because readiness is measured, the health cron re-verifies within one probe cycle. **Keep the community instance configured as a documented fallback until the new one has run clean for a week** — it is a worse experience, but it is better than none.

## 6. Expected effect

| Metric | Now | After self-hosting |
|---|---|---|
| Median search latency | 1,021 ms | Target **< 1.5 s** (controlled) |
| p95 / max | 12,112 ms | Target **< 5 s** (we control the timeout) |
| Zero-result runs | frequent | Should reach ~0 |
| Third-party dependency | **yes** | **none** |
| `/selftest` flapping | observed twice | Should stop |

**Note honestly:** self-hosting improves *reliability*, not *relevance*. The relevance work — query rewriting, event/year matching, authority ranking, cross-checking — is already in place and is what makes the results correct. Self-hosting makes sure the results actually arrive.
