import axios from "axios";
import {
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

/**
 * IS GDELT PART OF THE SEARCH PATH? No — and that is a deliberate decision.
 *
 * MEASURED across three separate sessions from the Convex runtime: DNS resolves
 * (7 ms) and raw TCP 443 is accepted (35 ms), but BOTH the documented API path
 * and the bare host fail to answer — `error sending request for url
 * https://api.gdeltpr…` after ~10.5 s, every time, with 0% availability in the
 * provider benchmark. `diagnoseGdeltTls` localises it: the origin accepts the
 * socket and then never completes the HTTPS exchange for this egress, which is
 * an origin-side block or routing problem. NOT a DNS fault, NOT a bad query
 * parameter, and not something a code change can fix.
 *
 * The ADAPTER already isolates its own failures (a 429 degrades to an empty
 * result rather than throwing), but an unreachable provider still costs a real
 * 15–20 s of every freshness-gated fan-out in which it is listed — latency the
 * user pays for a source that has never once answered. So it is switched OFF in
 * the product, which is the honest version of "disable it cleanly instead of
 * allowing it to block search".
 *
 * This is a FEATURE FLAG, not a deletion: the adapter, its tests and the
 * `diagnoseGdelt` / `diagnoseGdeltTls` diagnostics all stay, so re-enabling is
 * one reviewable line once the egress problem is understood. `ENABLE_GDELT=true`
 * forces it on (used to re-measure from inside the runtime that has the keys).
 */
export const GDELT_ENABLED = false;

/** The provider is in the search path only when the flag is on. */
export function isGdeltEnabled(): boolean {
  return GDELT_ENABLED || process.env.ENABLE_GDELT === "true";
}

const DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const UA = "OmiSearch/1.0 (https://ominnovations.example; contact: omi@ominnovations.example)";
/** GDELT's documented floor: about one request every 5 seconds. */
const MIN_INTERVAL_MS = 5200;
let lastRequestAt = 0;

/** Pure helper: is this query looking for recent/news coverage? */
export function isNewsQuery(q: string): boolean {
  return /\b(news|breaking|announced?|launch(?:ed|ing)?|report(?:ed)?|headline|latest|this week|this month|update[ds]?|market close|earnings|regulat(?:or|ion)|lawsuit|acquisition|merger|election|earnings call|what happened|what(?:'s| is| are)? happening|going on)\b/i.test(
    q ?? "",
  );
}

/** Pure helper: map a GDELT DOC 2.0 row to a citation. */
export function mapArticleToCitation(r: {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  sourcecountry?: string;
}): { title: string; url: string; snippet: string; publishedAt?: string } | null {
  if (!r.url || !r.title) return null;
  // GDELT seendate format: YYYYMMDDTHHMMSSZ → ISO.
  let publishedAt: string | undefined;
  if (r.seendate && /^\d{8}T\d{6}Z$/.test(r.seendate)) {
    const iso = `${r.seendate.slice(0, 4)}-${r.seendate.slice(4, 6)}-${r.seendate.slice(6, 8)}T${r.seendate.slice(9, 11)}:${r.seendate.slice(11, 13)}:${r.seendate.slice(13, 15)}Z`;
    const t = Date.parse(iso);
    if (Number.isFinite(t)) publishedAt = iso;
  }
  const dom = r.domain ? ` — ${r.domain}` : "";
  return {
    title: r.title.slice(0, 200),
    url: r.url,
    snippet: `News coverage via GDELT${dom}.`,
    publishedAt,
  };
}

/**
 * GDELT DOC 2.0 news provider — the world's largest open news index
 * (master plan §5: news/structured open sources). Keyless, no account,
 * $0 per query. Rows are article metadata (url/title/seen-date/domain);
 * content is retrieved live via Omi's own SSRF-guarded fetcher when a page
 * is read, never pre-stored (copyright-safe usage).
 */
/**
 * Classify a GDELT failure honestly.
 *
 * MEASURED BUG (provider benchmark, 2026-09-27): every non-429 failure used to
 * be rethrown as `MissingKeyError`, so a 15 s upstream timeout surfaced as
 * `Search provider "gdelt: timeout of 15000ms exceeded" is not configured` —
 * telling the user to add an API key to a provider that is keyless. A wrong
 * diagnosis sends debugging in the wrong direction, and it is exactly the
 * misreporting this codebase already fixed once for DuckDuckGo.
 *
 * Exported purely so it can be tested without a network call.
 */
export function describeGdeltFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const isTimeout = /timeout|timed out|ECONNABORTED/i.test(msg);
  return isTimeout
    ? "gdelt: upstream timed out after 15000ms (no key required — this is an availability problem, not a configuration one)"
    : `gdelt: upstream unavailable — ${msg.slice(0, 120)}`;
}

export function createGdeltProvider(): SearchProvider {
  return {
    id: "gdelt",
    label: "GDELT (global news index)",
    // Not a configuration gap — a product decision, recorded so the status
    // surface says WHY rather than implying someone forgot a key.
    missingKeyHint: isGdeltEnabled()
      ? ""
      : "Disabled by product decision: GDELT has measured 0% availability from the Convex runtime (TCP connects, HTTPS never answers). Set ENABLE_GDELT=true to force it back into the fan-out for re-measurement.",
    /**
     * GATED ON THE FEATURE FLAG, not just on reachability. A provider that is
     * switched off must be ABSENT from the fan-out, or an unreachable source
     * keeps costing 15–20 s on every freshness-gated turn.
     */
    isConfigured: () => isGdeltEnabled(),

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      // Scope discipline: news index only for news-phrased queries.
      if (!isNewsQuery(query)) {
        return { citations: [] };
      }
      // GDELT hard-limits to roughly one request every 5 seconds and answers
      // anything faster with HTTP 429. Throwing on 429 turned a normal,
      // documented limit into a "missing key" failure that killed the whole
      // fan-out; waiting briefly and degrading to an empty result is correct.
      const sinceLast = Date.now() - lastRequestAt;
      if (sinceLast < MIN_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - sinceLast));
      }
      lastRequestAt = Date.now();

      try {
        const res = await axios.get(DOC_URL, {
          params: {
            format: "json",
            query: query.slice(0, 250),
            mode: "artlist",
            maxrecords: Math.min(numResults, 15),
            // An explicit short window is honoured; anything else uses 24h so
            // a "current" question still gets today's coverage.
            timespan: opts?.timeRange === "hour" || opts?.timeRange === "day" ? "24h" : "1w",
            sort: "datedesc",
            ...(opts?.language ? { sourcelang: opts.language } : {}),
          },
          headers: { "User-Agent": UA },
          timeout: 15000,
          // A 429 is handled below, not thrown.
          validateStatus: (s) => s >= 200 && s < 300,
        });

        if (res.status === 429) {
          // Rate-limited: this is a "no results this time", not a broken
          // provider. The orchestrator continues with the other engines.
          return { citations: [] };
        }

        const articles = (res.data?.articles ?? []) as Array<
          Parameters<typeof mapArticleToCitation>[0]
        >;
        const citations = articles
          .map(mapArticleToCitation)
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .slice(0, numResults);
        return { citations };
      } catch (err) {
        // A 429 surfacing as a thrown axios error is still just a rate limit.
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 429) return { citations: [] };

        // MEASURED BUG (provider benchmark, 2026-09-27): every non-429 failure
        // was reported as a MissingKeyError, so a 15 s UPSTREAM TIMEOUT surfaced
        // to the user as `Search provider "gdelt: timeout of 15000ms exceeded"
        // is not configured` — telling them to go and add an API key that does
        // not exist, when GDELT is keyless. That is a wrong diagnosis of a
        // network condition, and it is exactly the misreporting this codebase
        // already fixed once for DuckDuckGo.
        //
        // GDELT needs no key, so MissingKeyError is never truthful here. A
        // timeout or upstream 5xx is an availability problem and is rethrown
        // as such, so the status surface, the circuit breaker and the health
        // metrics all classify it correctly.
        throw new Error(describeGdeltFailure(err));
      }
    },
  };
}
