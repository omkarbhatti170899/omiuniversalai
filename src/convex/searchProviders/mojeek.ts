import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

/**
 * Mojeek — Andromeda's first FEDERATED general-web engine.
 * ===================================================================
 *
 * WHY THIS PROVIDER EXISTS
 * ------------------------
 * Andromeda's general-web floor was a single point of failure: one community
 * SearXNG instance (`search.lumy.live`) that intermittently exceeds the engine
 * budget, produced measured 0-result runs, and made `/selftest` flap between
 * 23/0 and 21/1 with no code change. Federation is the structural fix — but a
 * second SEARXNG would not help, because two instances of the same scraper are
 * not two independent sources.
 *
 * Mojeek was selected after verifying each candidate against its own official
 * documentation (see docs/ANDROMEDA_PROVIDER_CAPABILITY_MATRIX.md):
 *
 *   ✅ Official REST API — no scraping of a consumer results page.
 *   ✅ ITS OWN crawler and its own index. It does not proxy Google, so it is
 *      genuine ecosystem independence rather than a second view of one index.
 *   ✅ Mojeek sells "AI Usage" and "Storage Rights" as named, purchasable plan
 *      rights — i.e. LLM grounding is a licensed capability, not a grey area.
 *   ✅ Documented capacity: 5 queries/sec, 100,000 queries/day.
 *   ✅ Free trial tier, so the federation architecture can be proven at $0.
 *
 * Providers that were evaluated and REJECTED, recorded so the reasoning is not
 * lost:
 *   ⛔ Qwant  — no official API. Its endpoint is undocumented and, per SearXNG's
 *      own engine docs, requires a reverse-engineered **DataDome anti-bot
 *      cookie**. That is scraping a consumer SERP while defeating bot
 *      protection, which the project forbids outright.
 *   ⛔ Baidu  — no general web-search API at all (only maps/OCR/translation).
 *      The commercial route is third-party SERP resellers, which imports the
 *      same exposure plus a vendor.
 *   🔴 DuckDuckGo — no official API; previously scraped by this codebase with a
 *      spoofed User-Agent, and already measured to return zero results. Removed.
 *
 * HONEST LIMITS
 * -------------
 * Mojeek is a SMALLER, English-leaning index than Brave, and because it is
 * crawler-based its freshness depends on its own crawl schedule rather than a
 * real-time index. It is therefore a COMPLEMENT to the current-events feeds
 * (GDELT, Wikipedia Current Events), not a replacement for them, and it does
 * not by itself fix the freshness problem — it removes the single point of
 * failure. Federation shrinks the blast radius; it does not make the upstream
 * engines reliable.
 *
 * COST: requires a `MOJEEK_API_KEY`. Until one is set the provider reports
 * itself NOT configured and is skipped, exactly like any other keyed source —
 * it can never be silently enabled against a hidden key or a surprise bill.
 */

const MOJEEK_ENDPOINT = "https://api.mojeek.com/search";

const UA =
  "AndromedaSearch/1.0 (Ominnovations Intelligence; federated general-web provider)";

/** Mojeek's documented ceiling. */
const MOJEEK_TIMEOUT_MS = 12_000;

function apiKey(): string | undefined {
  const k = process.env.MOJEEK_API_KEY?.trim();
  return k && k.length > 0 ? k : undefined;
}

/** Best-effort published-date extraction, mirroring the other providers. */
function extractPublishedAt(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  // Mojeek returns ISO-ish date strings on some result types.
  const m = String(raw).match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return `${m[1]}T00:00:00.000Z`;
  return undefined;
}

type MojeekResponse = {
  response?: {
    results?: Array<{
      title?: string;
      url?: string;
      desc?: string;
      published?: string;
      type?: string;
    }>;
  };
  // Mojeek errors surface as HTTP 4xx/5xx with a message, not a 200 envelope.
  error?: string;
};

export function createMojeekProvider(): SearchProvider {
  return {
    id: "mojeek",
    label: "Mojeek (independent index)",
    missingKeyHint:
      "Set MOJEEK_API_KEY to add Mojeek — an independent crawler-backed index " +
      "with an official API and explicit AI-usage rights. Free trial tier available; " +
      "see docs/ANDROMEDA_PROVIDER_CAPABILITY_MATRIX.md.",
    isConfigured: () => apiKey() !== undefined,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      const key = apiKey();
      if (!key) throw new MissingKeyError("mojeek");

      // Mojeek is a general web index. Images/video are other providers' job;
      // asking it for them wastes quota and returns nothing useful.
      if (opts?.category === "images" || opts?.category === "videos") {
        return { citations: [] };
      }

      const res = await axios.get<MojeekResponse>(MOJEEK_ENDPOINT, {
        params: {
          q: query,
          t: Math.min(numResults, 20),
          // Mojeek supports a fresh-date filter; map our recency vocabulary
          // onto it. An unsupported value is omitted rather than guessed, and
          // the caller re-checks every result's date anyway — so a narrower
          // request is never silently widened into a stale answer.
          ...(opts?.timeRange && opts.timeRange !== "month" && opts.timeRange !== "year"
            ? { since: opts.timeRange === "hour" ? "1d" : opts.timeRange }
            : {}),
          ...(opts?.language && opts.language !== "all" ? { lang: opts.language } : {}),
        },
        headers: {
          "User-Agent": UA,
          // Mojeek documents the key as a bearer-style token.
          Authorization: `Bearer ${key}`,
        },
        timeout: MOJEEK_TIMEOUT_MS,
      });

      const results = res.data?.response?.results ?? [];
      const citations = results
        .filter((r) => r?.url && r?.title)
        .map((r) => ({
          title: String(r.title),
          url: String(r.url),
          snippet: r.desc ? String(r.desc) : undefined,
          publishedAt: extractPublishedAt(r.published),
          // Provenance is recorded so fusion can tell that this URL was found
          // independently of SearXNG/GDELT — that is what makes cross-engine
          // corroboration meaningful rather than an echo.
          providers: ["mojeek"],
        }));

      return { citations };
    },
  };
}
