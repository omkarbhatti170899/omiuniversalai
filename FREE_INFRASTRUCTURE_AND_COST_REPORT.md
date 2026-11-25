# Omi Universal AI — Free Infrastructure & Cost Report

Owner: Omkar Prakash Bhatti
Scope: ₹0 mandatory operating cost for core functionality. Honest limitations are recorded, not papered over.

This document is the canonical place where every non-trivial dependency is recorded with its real free-tier posture. It is meant to be updated when the architecture changes, not replaced by marketing language in the UI.

## 1. Core principle

Core workspace functionality — chat, search orchestration, document tools, status/health surfaces — must remain usable without any mandatory paid API key, mandatory credit purchase, mandatory paid hosting tier, or mandatory billing-enabled account.

That does NOT mean everything is unlimited. It means:
- There is no service that is silently required and also paid.
- Every provider that costs money is optional and clearly labeled optional.
- Every free tier that is bounded is openly bounded.
- The product is honest when a capability is not available because the relevant free tier is not configured / is exhausted / is not available from this runtime.

## 2. Search (Andromeda)

### SearXNG — PRIMARY general-web provider (self-hosted)
- Purpose: general-web metasearch.
- Free-tier availability: self-hosted is free software. There is no per-search fee.
- Limits: same as the host you run it on; public instances are not dependable from this runtime.
- Billing requirements: none, if you self-host.
- Current usage: Not reliably available in the current runtime until a configured instance exists.
- Honest status: The adapter does not claim readiness from configuration alone. It probes for a working JSON API and reports honestly. Public instances measured here do not currently serve JSON reliably, so they are not treated as a working general-web source.
- Real blocker: A working general-web floor requires either a self-hosted SearXNG instance with JSON enabled and reachable, or a configured private/shared secret-gated instance. Until that exists, general-web breadth from Andromeda is limited.
- Setup path: `deploy/searxng/` contains the self-host package and runbook.
- Alternative providers: DuckDuckGo Instant (keyless official API, encyclopedic only), Mwmbl (free, keyless, AGPL, own index, but no time-range/language/region support), Wikipedia, Wikidata, arXiv, OpenAlex, Open Library, Hacker News Algolia, Common Crawl, GitHub, Openverse, Wikipedia Current Events, Open-Meteo, market rates, sports.

### Supporters that are NOT used as the general-web floor
- DuckDuckGo consumer SERP scraping: removed. No official API; not permitted.
- Brave Search API: not purchased, not used.
- Mojeek: adapter exists and is registered. Honest note: it is zero per-search cost in principle, but it is not usable as a mandatory backbone here until a compliant key/integration is verified. Used only if/when permitted and free; not treated as a paid dependency.
- Startpage: investigated directionally; not wired as a mandatory backend until a compliant free path is verified.
- LangSearch: temporary evaluation adapter, off by default, not a sole dependency. It is a reseller with published paid upstream tiers, so it is labeled as such.

## 3. AI chat / completion

### Groq — primary
- Purpose: conversational, summarization, extraction, classification, reasoning, coding, research inference.
- Free-tier availability: free tier exists; rate-limited.
- Limits: rate limits and model availability can change; models retire.
- Billing requirements: none for the free tier.
- Current usage: primary provider when configured. Provider-independent router keeps Groq from being a single point of failure.
- Honest status: Do not describe as unlimited. When the free tier is exhausted or the model is retired, the router falls back to other configured providers.

### Google Gemini — secondary
- Purpose: independent free-tier fallback for the same tasks, separate quota from Groq.
- Free-tier availability: free tier exists; rate-limited and account/project bound.
- Limits: quota limits apply; some models/images may require billing depending on capability and account state.
- Billing requirements: none for the base free tier for text inference where available; image generation is not assumed free.
- Honest status: Gemini image models are explicitly NOT assumed free; the image catalog says billing may be required for image generation.

### OpenAI — optional
- Purpose: optional metered adapter.
- Free-tier availability: paid/metered; not required.
- Billing requirements: yes, if you enable it.
- Current usage: off unless key configured.
- Honest status: labeled optional. Not a mandatory dependency.

### DeepSeek — optional
- Purpose: optional adapter.
- Free-tier availability: free tier exists; optional.
- Billing requirements: none for the free tier if used; optional overall.
- Honest status: optional, not required.

## 4. Vision

Vision adapters (Groq/Gemini/OpenAI) exist for document/image understanding. They follow the same provider-independent, free-tier-first, fallback, health, rate-limit, and honest 429/quota handling as the chat layer.

Honest limitation: vision quality and availability depend on the configured provider and its free-tier limits. This is not advertised as unlimited.

## 5. Image generation / editing

### Text-to-image generation
- Primary keyless path: Pollinations (free, keyless, rate-limited).
- Honest status: works without a key, but is rate-limited and not unlimited.

### Image editing / in/outpainting / style / combine / background ops
- Free-capable direction: Pollinations-edit (OpenAI Images-Edits-compatible endpoint, `kontext`) with a Pollinations key, and Gemini where available.
- Honest status: editing is explicitly not claimed working unless it passes actual tests with a real provider/key. Gemini image editing is not assumed free; image billing/quota may apply.
- OpenAI image models are optional and metered.

## 6. Database / backend / hosting

### Convex
- Purpose: backend and database already in use by the project.
- Free-tier availability: Convex has a free tier.
- Limits: free-tier allowances and limits apply; monitor usage.
- Billing requirements: none if kept within the free tier.

### Frontend hosting candidates
- GitHub Pages: repo has Pages enabled; sustainable free static hosting option.
- Cloudflare Workers: potential free-tier option for edge需要时.
- GitHub Actions: free allowances exist for CI/CD, within limits.
- Vercel: existing deployment target; free tier limits apply.

Honest stance: keep the existing working backend unless there is a verified migration plan. Do not introduce new paid hosting.

## 7. Search self-hosting

Self-hosted SearXNG is the intended general-web backbone because it removes per-search API dependence.

Required to make it genuinely primary:
- A host with Docker.
- `settings.yml` with JSON format enabled.
- Reverse proxy / shared-secret gate as in `deploy/searxng/`.
- Server-side Convex env: `SEARXNG_BASE_URL` and `SEARXNG_SHARED_SECRET`.
- Post-deploy verification per the runbook before trusting it as the primary source.

No paid VPS is assumed; the current interim public-instances path is explicitly treated as unreliable from this runtime.

## 8. What is NOT a mandatory paid dependency

- No Brave Search API access.
- No mandatory paid AI provider.
- No mandatory paid search API.
- No mandatory paid image provider.
- No mandatory credit purchase to use core chat/search.
- No auto-upgrade to a paid plan for core functionality.

## 9. What is optional and clearly labeled optional

- OpenAI AI and image adapters.
- DeepSeek adapter.
- Any paid add-on the owner may choose to configure.

## 10. Honest limitations

- General-web search is only as good as the configured search backend. Today, without a working self-hosted SearXNG instance or equivalent, general-web breadth is limited; specialist open-data sources still work.
- Free AI inference is rate-limited and model-dependent; retirements and quota exhaustion can temporarily remove a provider.
- Image generation works keyless via Pollinations but is rate-limited; image editing needs a configured provider/key and is not assumed free.
- Free hosting tiers have usage limits; monitor them.
- No system should be described as unlimited when third-party quotas, model retirements, or host capacity apply.

## 11. Verification checklist before claiming ₹0 for a capability

For each capability, confirm:
1. Is any key required?
2. If yes, is there a free tier that actually covers it?
3. If yes, is the free tier bounded, and is that bounded nature visible to the user?
4. If no free tier covers it, is the capability optional?
5. Can the capability fail honestly (429/quota/retired model/unconfigured) without the product pretending it works?

## 12. Service register

| Service | Purpose | Free tier | Limits | Billing req | Optional? | Notes |
|---|---|---|---|---|---|---|
| SearXNG self-hosted | General-web search | Yes (self-host) | Host-dependent | No | No (primary intent) | Needs deployment + JSON enabled + secret gate |
| DuckDuckGo Instant | Encyclopedic entities | Yes (keyless) | Upstream limits | No | Yes | Not a web-search engine |
| Mwmbl | Free search signal | Yes (keyless) | Own index, limited features | No | Yes | No time-range/language/region support |
| Wikipedia | Encyclopedic facts | Yes | API limits | No | Yes | Specialist, not general web |
| Wikidata | Structured knowledge | Yes (CC0) | API limits | No | Yes | Specialist |
| arXiv | Papers | Yes | API limits | No | Yes | Research vertical |
| OpenAlex | Scholarly works | Yes | API limits | No | Yes | Research vertical |
| Open Library | Book catalog | Yes | API limits | No | Yes | Specialist |
| Hacker News Algolia | Tech/practitioner signal | Yes (keyless) | API limits | No | Yes | Specialist |
| Common Crawl | Web index metadata | Yes (open data) | Data size/access limits | No | Yes | Provenance/diversity |
| GitHub REST API | Repo search | Yes (keyless, rate-limited) | 10/min without key, higher with key | No | Yes | Tech queries only |
| Openverse | Openly-licensed media | Yes | Rate-limited anonymous | No | Yes | Image/media specialist |
| Wikipedia Current Events | Dated current events | Yes | API limits | No | Yes | Reliable current-events floor |
| Open-Meteo | Weather/structured data | Yes | API limits | No | Yes | Scope-gated |
| Market rates | FX data | Yes | Scope-gated | No | Yes | Not financial advice |
| Sports DB | Scores | Yes | Scope-gated | No | Yes | Sports vertical |
| Groq | AI chat/completion | Yes (free tier) | Rate limits, model changes | No | No (primary) | Provider-independent fallback exists |
| Gemini | AI chat/completion + vision | Yes (free tier) | Rate limits, quota, some image features may need billing | Partial (some image features) | No (secondary) | Image generation not assumed free |
| OpenAI | AI + image (optional) | No (metered) | Paid | Yes if enabled | Yes | Optional adapter |
| DeepSeek | AI (optional) | Yes (free tier) | Rate limits | No if used | Yes | Optional adapter |
| Pollinations text-to-image | Image generation | Yes (keyless) | Rate-limited | No | No (primary image gen) | Not unlimited |
| Pollinations-edit (kontext) | Image editing | Free tier with key | Rate limits, key required | No (if free key suffices) | No (free editing path) | Needs key; edit ops not assumed free until verified |
| Convex | Backend/database | Yes (free tier) | Free-tier limits | No if within free tier | No (existing) | Keep within free allowance |
| GitHub Pages | Static hosting | Yes | Limits | No if within limits | No (candidate) | Already enabled on repo |
| Cloudflare Workers | Edge hosting option | Yes (free tier) | Limits | No if within limits | Yes | Optional |
| GitHub Actions | CI/CD | Yes (free allowance) | Limits | No if within limits | No (used for CI) | Existing |
| Vercel | Hosting (existing) | Yes (free tier) | Limits | No if within limits | No (existing) | Existing deployment target |

## 13. Signed-off stance

This report reflects the repository’s actual dependency posture at the time it is written. If any capability later becomes dependent on a paid tier, or if a free tier is bounded in a way that matters to users, that change must be recorded here and surfaced honestly in-product.
