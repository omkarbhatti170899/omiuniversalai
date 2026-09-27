# Andromeda — Provider Capability Matrix

**Purpose:** decide which search providers Andromeda may legally and technically federate.
**Status:** RESEARCH ONLY. No integration was implemented. No code was written for any provider below.
**Date:** 2026-09-27
**Verification rule:** every cell is marked with how it was established. Nothing is asserted from memory.

| Legend | Meaning |
|---|---|
| ✅ | Verified today against the provider's **own** documentation/pricing page |
| ⚠️ | Partially verified — a specific unknown is named in the cell |
| ❌ | Verified **NOT available** (official source says so, or the only route is the prohibited one) |
| 🔍 | Not verified — needs legal review or an account before use |

**Critical distinction that governs this whole document:** a *search index* provider (Brave, Mojeek, Naver) sells you licensed results and is safe to use. A *metasearch scraper* (SearXNG's Google/Bing engines, Qwant's reverse-engineered endpoint) makes unconsented requests to someone else's search engine. The second category transfers their terms-of-service risk onto Andromeda. Both are technically "search", and only one of them is defensible.

---

## 1. Verdict summary

| Provider | Official API? | Verdict | One-line reason |
|---|---|---|---|
| **Brave Search** | ✅ Yes | 🟡 **Integrate, paid** | Best-documented AI/RAG licence, own index; but the free tier is gone |
| **Mojeek** | ✅ Yes | 🟢 **Integrate first** | Own independent index, explicit "AI Usage" right, free trial |
| **Naver** | ✅ Yes | 🟡 **Conditional** | Official API, but Korean index and AI/caching rights unverified |
| **SearXNG (self-hosted)** | n/a (self-host) | 🟡 **Keep, self-host only** | Software is fine; its *upstream engines* are the ToS exposure |
| **SearXNG (community instance)** | n/a | 🔴 **Deprioritise** | Third party's instance, their IP, their uptime — our top reliability risk |
| **Qwant** | ❌ **No** | ⛔ **DO NOT INTEGRATE** | Requires a reverse-engineered **DataDome anti-bot cookie** |
| **Baidu** | ❌ **No** (general web) | ⛔ **DO NOT INTEGRATE yet** | No general web-search API; only maps/OCR/translation/AI |
| **DuckDuckGo (current impl)** | ❌ **No** | 🔴 **REMOVE** | We scrape it today with a spoofed UA, and it already returns 0 results |

---

## 2. The matrix

### Brave Search API

| Dimension | Finding | Confidence |
|---|---|---|
| API available | ✅ `GET https://api.search.brave.com/res/v1/web/search`, header `X-Subscription-Token`. Endpoints: Web, LLM Context, Answers, News, Images, Video, Suggest, Spellcheck, Goggles (re-ranking/filtering) | ✅ |
| Free tier | ✅ **Free tier REMOVED.** $5.00 per 1,000 requests, with **$5 in automatic monthly credits**. The credit is a trial allowance, not an unlimited free plan | ✅ |
| Usage restrictions | ✅ Enterprise tier exists for custom terms/NDA/Zero-Data-Retention. The standard plan is priced per-request | ✅ |
| **AI / RAG permission** | ✅ **Explicit.** Brave markets "excels in RAG pipelines", ships a dedicated **LLM Context** endpoint "for AI Agents… RAG Pipelines: Ground LLM", and states 2026 API terms grant rights for LLM inference and grounding | ✅ |
| Rate limits | ✅ **50 queries/sec** (Search). **2 queries/sec** (Answers — note the large gap; Answers is not a high-throughput path) | ✅ |
| Search types | ✅ Web, News, Images, Video, Local, plus LLM Context and grounded Answers | ✅ |
| Languages | ✅ Global multilingual index, 30B+ pages, 100M+ page updates/day. `country` + `search_lang` params | ✅ |
| Freshness | ✅ Excellent — one of the strongest claims of any general index. Real-time indexing | ✅ |
| Reliability | ✅ Enterprise-grade, used by named production customers. Well-documented | ✅ |
| Attribution | ⚠️ Terms page not read end-to-end; attribution/redisplay obligations not confirmed | 🔍 |
| Caching / storage | ✅ "Storage Rights" sold as a distinct paid capability → implies caching is **not** free by default | ✅ |
| Integration difficulty | **Low** — clean REST + JSON, good docs, single key | — |
| **Cost reality** | $5/1000. For a free-first product this is a **real budget line**, not free | — |

### Mojeek

| Dimension | Finding | Confidence |
|---|---|---|
| API available | ✅ Official Web Search API with full quickstart + API docs | ✅ |
| Free tier | ✅ **Free trial with limited queries**; production is priced (historically $5 per 1,000) | ✅ |
| Usage restrictions | ⚠️ Mojeek's own blog notes the API "is not access to" their full search product — i.e. reduced capability. Exact limits need an account | ⚠️ |
| **AI / RAG permission** | ✅ **Explicit.** Pricing page lists "**AI Usage**" and "**Storage Rights**" as named plan features, marketed "for your Search product and/or AI applications" | ✅ |
| Rate limits | ✅ **5 queries/sec, 100,000 queries/day** | ✅ |
| Search types | ✅ General web search; separate Site Search API product | ✅ |
| Languages | ⚠️ Primarily English index. Not a global multilingual federation member | 🔍 |
| Freshness | ⚠️ Own crawler, so freshness depends on its crawl schedule. Not marketed as real-time | 🔍 |
| Reliability | ✅ Long-running independent crawler-based index | ✅ |
| Attribution | ⚠️ Terms not read end-to-end | 🔍 |
| Caching / storage | ✅ "Storage Rights" is a separately purchasable feature | ✅ |
| Integration difficulty | **Low–medium** — REST/JSON, key-based | — |
| **Why it matters** | ✅ **It has its own crawler and its own index.** It is genuinely independent, not a Google wrapper — exactly the ecosystem-diversity the brief asks for | — |

### Naver Search API

| Dimension | Finding | Confidence |
|---|---|---|
| API available | ✅ Official Naver Cloud Platform Search API: web documents, news, blog, region, Knowledge iN, book, cafe, encyclopedia, image. JSON or XML. Client ID + Secret | ✅ |
| Free tier | ✅ Available on Naver Cloud Platform account | ✅ |
| Usage restrictions | ✅ News search documented at **25,000 calls/day** | ✅ |
| **AI / RAG permission** | 🔴 **NOT VERIFIED.** Naver's English API guide returned 403/too-large to this environment. Permission for LLM grounding and for **retaining/caching** results is unknown. Naver is a commercial portal with strict redistribution norms | 🔍 **Must clear before use** |
| Rate limits | ✅ 25,000/day for news; per-endpoint quotas | ✅ |
| Search types | ✅ Web, news, image, encyclopedia — richer than most | ✅ |
| Languages | ⚠️ **Korean-primary.** English coverage exists but is not global | ⚠️ |
| Freshness | ✅ Strong for Korean breaking news; news endpoints carry publication times | ✅ |
| Reliability | ✅ First-party, operated by Naver itself | ✅ |
| Attribution | ⚠️ Typically requires Naver branding/link attribution — unconfirmed | 🔍 |
| Geographic restrictions | ⚠️ Optimised for Korea; may underperform outside | ⚠️ |
| Integration difficulty | **Medium** — credentials + several endpoint types | — |
| **Verdict** | 🟡 Worth integrating **only** for genuinely Korean-language queries, **only** after the AI/caching licence is confirmed in writing | — |

### SearXNG

| Dimension | Finding | Confidence |
|---|---|---|
| API available | ✅ JSON output; self-hosted, or public instances expose `/search?format=json` (many disable it) | ✅ |
| Free tier | ✅ Software is AGPL; self-hosting is free | ✅ |
| Usage restrictions | ⚠️ **The real constraint is upstream.** SearXNG "aggregates results from up to 261 search services". It is a metasearch engine: its results come from Google/Bing/etc. | ✅ |
| **AI / RAG permission** | ⚠️ **Inherited from upstream, not granted by SearXNG.** We do not hold a licence from the engines whose results we return | ⚠️ |
| Rate limits | ⚠️ Self-hosted: bounded by upstream tolerance and your own egress IP | ⚠️ |
| Search types | ✅ Web, news, images, video, papers, wikis | ✅ |
| Languages | ✅ Excellent multilingual coverage (a genuine strength) | ✅ |
| Freshness | ✅ Inherits upstream freshness | ✅ |
| Reliability | 🔴 **Our single biggest measured risk.** The community instance `search.lumy.live` intermittently exceeds our 12 s budget, produced 0-result runs, and made `/selftest` flap 23/0 → 21/1 with no code change | ✅ (measured) |
| Caching | ⚠️ Depends on upstream | ⚠️ |
| **Legal exposure** | ⚠️ Self-hosting SearXNG is lawful software use. Sending automated queries to Google/Bing may breach **their** terms. Restricting the enabled engine list to low-risk/open engines materially reduces this | ⚠️ |
| **Verdict** | 🟡 **Self-host, and disable the high-risk upstream engines.** A public community instance additionally means a third party sees our queries and shares the IP reputation | — |

### Qwant — ⛔ DO NOT INTEGRATE

| Dimension | Finding | Confidence |
|---|---|---|
| API available | ❌ **No official public API** | ✅ |
| What actually exists | ✅ An **undocumented** `api.qwant.com/v3` endpoint | ✅ |
| How it is used in practice | ✅ SearXNG's own engine documentation states: *"The API is undocumented but can be reverse engineered by reading the network log of https://www.qwant.com/ queries."* The implementation stores a **DataDome cookie** (DataDome = commercial anti-bot/anti-scraping vendor) | ✅ |
| Legal standing | ⛔ This is **scraping a consumer search-results page while defeating bot protection.** It is precisely what the brief forbids: *"Do NOT scrape consumer search-result pages unless explicitly permitted."* | — |
| **Verdict** | ⛔ **Excluded.** No amount of engineering makes this defensible, and it would fail a legal review immediately | — |

### Baidu — ⛔ DO NOT INTEGRATE YET

| Dimension | Finding | Confidence |
|---|---|---|
| API available | ❌ **No general web-search API.** Baidu's open platforms cover Maps, OCR, translation, speech and Qianfan (LLM) — not ranked general web results | ✅ |
| What exists commercially | ✅ Third-party SERP-scraping services resell Baidu results (e.g. OpenSERP) | ✅ |
| Legal standing | ⛔ Those resellers scrape Baidu's SERP. Buying from them imports the same exposure, and adds a vendor between us and the data | — |
| Geographic | ⚠️ Mainland China; heavy geo-restriction and access constraints from outside | ⚠️ |
| **Verdict** | ⛔ **Excluded for now.** Revisit only via a **written commercial licence** from Baidu. A Chinese-language *content* gap remains genuinely unsolved and is a legitimate future work item | — |

### DuckDuckGo — 🔴 REMOVE FROM OUR CODE (existing finding)

| Dimension | Finding | Confidence |
|---|---|---|
| API available | ❌ **No official search API** | ✅ |
| What we do today | 🔴 `src/convex/searchProviders/keyless.ts` POSTs to `https://html.duckduckgo.com/html/` — the no-JS consumer endpoint — with a **spoofed browser User-Agent** (`…Chrome/126.0 Safari/537.36 OmiSearch/1.0`) | ✅ |
| Does it work? | 🔴 **No.** Our own measured note in that file: DuckDuckGo answers with a bot challenge (HTTP 202, "anomaly"), zero `result__a` anchors. The provider can never return a result | ✅ |
| **Assessment** | 🔴 It is simultaneously a **compliance risk** (UA spoofing + scraping, which your rules forbid) **and dead weight** (measured 0 results). Pure downside | — |
| **Recommendation** | 🔴 **Disable it.** Functional cost ≈ 0 because it never worked; legal/ethical cost is real. Replacing it is covered by the Mojeek/Brave work above | — |

---

## 3. Providers already integrated and compliant

These are not search engines but legitimate open-data APIs. No ToS conflict was identified. **Keep.**

| Provider | Type | Notes |
|---|---|---|
| Wikipedia / Wikidata | Open knowledge | CC BY-SA; attribution required and handled |
| GDELT | Open news index | Free, no key; 12 s timeouts observed |
| Hacker News | Open API | Free, official |
| Common Crawl | Open corpus | For future own-index bootstrap (Phase 7) |
| TheSportsDB | Sports data | Free key tier |
| Open-Meteo | Weather | Free, no key |
| Open ER-API / xe | FX rates | Free tier |
| GitHub | Repos | Official API |
| Pollinations | Image gen | Free tier (balance exhausted) |

---

## 4. Recommendation — first implementation order

### Tier 1 — do now (free-first, own-index, AI-permitted)

1. **Mojeek** — best fit. Official API, **its own independent crawler and index** (true ecosystem diversity, not a Google wrapper), explicit **AI Usage** right, 5 q/s and 100k/day, and a **free trial**. Cost starts at zero.
2. **Self-host SearXNG** with a **curated engine list**. Keep the multilingual benefit; remove the engines whose terms we do not hold a licence for. Removes the community-instance single point of failure.

### Tier 2 — do next, once budget is approved

3. **Brave Search** — the strongest *paid* option by a wide margin, and the only one verified to grant LLM-grounding rights explicitly. $5/1000 with $5 monthly credits. **This is a budget decision, not a technical one** — and it directly conflicts with a "free-first" positioning, so it is your call.

### Tier 3 — conditional, gated on licence confirmation

4. **Naver** — integrate **only** for Korean-language queries, and **only** after Naver confirms in writing that results may be used for LLM grounding **and cached/retrieved**. Unverified today. Do not ship ahead of that answer.

### Excluded

5. **Qwant** — ⛔ anti-bot-cookie scraping. Never.
6. **Baidu** — ⛔ no general web API. Revisit only with a written commercial licence.
7. **DuckDuckGo** — 🔴 disable from our code now.

### Not yet assessed (flagged, not recommended)

### Second-wave research (done 2026-09-27) — result: no strong addition

I promised to research these properly before writing adapter code. I did, and the honest answer is that **none of them displaces Mojeek for general web**:

| Candidate | What it actually is | Verdict |
|---|---|---|
| **Stract** | Open-source, independent search engine; **self-hostable** | 🟡 Not a general-web answer today. Interesting later for the **own-index** track (Phase 6) precisely because it is self-hostable source code, not for federation |
| **Mwmbl** | Open-source, non-profit, community-curated | 🟡 Very small index; already in the curated SearXNG engine list as a low-risk addition |
| **Marginalia** | Deliberately narrow — indie/non-commercial web, by design | ⛔ Not a general-web provider. Wrong index for this product |
| **Right Dao / Yep** | No official API verified | 🔍 Unverified |
| **Kagi** | Paid, no free tier | 🟡 Possible paid tier, no advantage over Brave at that point |
| **Google CSE / Bing** | Programmatic but licence-restricted for this use | ⛔ Not recommended |

**Conclusion:** the independent-index ecosystem that would most improve *ecosystem diversity* is small and does not currently offer a general-web API with the maturity Mojeek has. This is a real finding, not a gap in the research. Mojeek remains the right first provider; **Stract is the most interesting name for Phase 6 (own index)**, because self-hostable search-engine source code is exactly what that phase needs.

Not verified in depth, and therefore not recommended: `Exa`, `Tavily`, `Serper`, `SerpAPI` (commercial SERP aggregators — they resell scraped results, which imports the exposure we just removed).

---

## 5. Provider Health & Planner requirements (design notes, not implementation)

Carried forward for the architecture review:

- **Normalized contract** every adapter must satisfy: `title, url, snippet, source, published_at, updated_at, language, provider, metadata`. `updated_at` must be kept **distinct** from crawl time.
- **Never concatenate.** Fusion order: URL canonicalization → exact dedupe → near-duplicate → source clustering → freshness extraction → relevance → authority → diversity → spam filter.
- **Planner must not fan out by default.** Provider count should scale with intent: simple → 1–2; current/complex → 3–4; deep research → all. Every added provider costs latency and budget.
- **Circuit breaker + health scoring** per provider (availability, latency, error rate, timeout rate, freshness quality) so a degrading provider loses priority automatically instead of being the thing that breaks the turn.
- **Partial results must be usable**: if a provider times out, the turn continues with what arrived. The measured community-SearXNG timeouts should never again be able to zero out a search.
- **Provider health is a first-class observable**, not a log line — it is the metric that tells us when to cut a provider.

---

## 6. What this document does not claim

- **No provider was integrated.** No adapter code was written.
- **Attribution, caching and AI-licence terms were NOT fully read** for Brave, Mojeek or Naver. Cells marked 🔍 are open, and three of them are **legal questions, not engineering ones**.
- **Naver's AI/caching permission is unresolved.** That blocks its use entirely.
- **No claim is made that federation fixes SearXNG reliability.** It reduces blast radius; it does not remove the underlying upstream fragility.
- The current single-provider architecture is **unchanged** by this document. Nothing here is deployed.

---

## 7. Implementation status (updated 2026-09-27)

Decisions 1–4 were approved. What is now DONE, and what still needs you:

| # | Action | Status |
|---|---|---|
| 1 | **DuckDuckGo scraper removed** | ✅ **DONE.** `keyless.ts` deleted, the provider is out of the registry, out of every vertical's `preferredProviders`, out of the self-test, and out of the rewrite allowlist. `tests/omiFederationProvider.test.ts` asserts it cannot return. Cost: zero — it never returned results anyway |
| 3 | **Mojeek adapter added** | ✅ **DONE** behind the existing `SearchProvider` interface. Registered, correctly gated on `MOJEEK_API_KEY`, declared as the general-web fallback for all verticals, declines image/video rather than burning quota, and stamps `providers: ["mojeek"]` so cross-engine corroboration can distinguish it from a SearXNG echo |
| 2 | **Self-hosted SearXNG** | 🟡 **Config written, NOT deployed.** The curated engine list in `docs/SEARXNG_SELF_HOST_PLAN.md` now disables google/bing/duckduckgo/startpage (the ToS-risking engines) and documents why. **I cannot provision a host** — this needs a VPS you control |
| 4 | **Second-wave research** | ✅ **DONE** (above) |
| — | **Mojeek API key** | 🔴 **BLOCKED ON YOU.** Until `MOJEEK_API_KEY` is set the provider reports `ready: false` and is skipped, exactly like any other keyed source. Request a free trial at mojeek.com |
| — | **Circuit breaker / health** | ✅ **Already existed** — `guardedCall` in `resilience.ts` wires `breakerAllow`/`breakerRecord` and is exposed via `breakerStatus()`. I initially reported it as dead code; that was **wrong** (my grep only searched one file). No change needed. Known limit: breaker state is **per server isolate**, so on a multi-instance Convex deployment an open circuit does not propagate globally |

**Gates after this work:** `bun test tests/` **1104 pass / 0 fail** (59 files, 4004 assertions) · `bunx eslint .` **0 errors / 21 warnings** · `bunx tsc -b --noEmit` **0 errors** · `/selftest` **status ok, 21 pass / 0 fail / 6 configured**.

The self-test count moved 28 → 27 checks because the DuckDuckGo reachability probe was removed by design. The remaining `configured` rows are the five that need a signed-in session or a device, plus SearXNG reporting unreachable — the known community-instance flap, which is precisely what self-hosting and Mojeek exist to fix.
