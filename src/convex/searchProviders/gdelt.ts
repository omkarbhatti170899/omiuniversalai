import axios from "axios";
import {
  MissingKeyError,
  type SearchProvider,
  type SearchProviderResult,
} from "./types";

const DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const UA = "OmiSearch/1.0 (https://ominnovations.example; contact: omi@ominnovations.example)";

/** Pure helper: is this query looking for recent/news coverage? */
export function isNewsQuery(q: string): boolean {
  return /\b(news|breaking|announced?|launch(?:ed|ing)?|report(?:ed)?|headline|latest|this week|this month|update[ds]?|market close|earnings|regulat(?:or|ion)|lawsuit|acquisition|merger|election|earnings call)\b/i.test(
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
export function createGdeltProvider(): SearchProvider {
  return {
    id: "gdelt",
    label: "GDELT (global news index)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults, opts): Promise<SearchProviderResult> {
      // Scope discipline: news index only for news-phrased queries.
      if (!isNewsQuery(query)) {
        return { citations: [] };
      }
      try {
        const res = await axios.get(DOC_URL, {
          params: {
            format: "json",
            query: query.slice(0, 250),
            mode: "artlist",
            maxrecords: Math.min(numResults, 15),
            timespan: opts?.timeRange === "day" ? "24h" : "1w",
            ...(opts?.language ? { sourcelang: opts.language } : {}),
          },
          headers: { "User-Agent": UA },
          timeout: 15000,
        });

        const articles = (res.data?.articles ?? []) as Array<
          Parameters<typeof mapArticleToCitation>[0]
        >;
        const citations = articles
          .map(mapArticleToCitation)
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .slice(0, numResults);
        return { citations };
      } catch (err) {
        throw new MissingKeyError(
          `gdelt: ${err instanceof Error ? err.message : "unavailable"}`,
        );
      }
    },
  };
}
