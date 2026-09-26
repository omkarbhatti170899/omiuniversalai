import axios from "axios";
import {
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./types";

/**
 * Live market data — currency exchange rates.
 *
 * Why this exists: "current USD/INR rate" was routing to a NEWS index, which
 * is precisely the failure the brief calls out ("do not pretend ordinary web
 * search is a real-time database"). A news article about a currency rate is
 * not a quote.
 *
 * Scope, stated honestly: this provider serves EXCHANGE RATES from a keyless
 * public endpoint, dated with the provider's own update time. It does not
 * serve equities, crypto or live sports. For those Omi refuses rather than
 * guessing — see `isResolvableRateQuery`.
 *
 * No key, no account, $0. Not investment advice.
 */

const RATE_URLS = [
  "https://open.er-api.com/v6/latest",
  "https://api.exchangerate-api.com/v4/latest",
];

/** Pure: is this a rate question we can actually answer? */
export function isResolvableRateQuery(q: string): boolean {
  const text = q ?? "";
  if (!/\b(rate|exchange|forex|fx|convert|conversion|worth|in exchange|per\s+(usd|eur|gbp|inr))\b/i.test(text)) {
    return false;
  }
  const codes = text.toUpperCase().match(/\b(?:USD|EUR|GBP|INR|JPY|AUD|CAD|CHF|CNY|SGD|AED|SAR|HKD|NZD|ZAR|BRL|MXN|RUB|KRW|TRY|IDR|PHP|MYR|THB|ILS|PKR|BDT|LKR|KES|GHS|ISK|UAH)\b/g);
  return (codes?.length ?? 0) >= 2;
}

/** Pure: which pair is being asked about? e.g. ["USD","INR"]. */
export function pairFromQuery(q: string): [string, string] | null {
  const codes = (q ?? "")
    .toUpperCase()
    .match(/\b(?:USD|EUR|GBP|INR|JPY|AUD|CAD|CHF|CNY|SGD|AED|SAR|HKD|NZD|ZAR|BRL|MXN|RUB|KRW|TRY|IDR|PHP|MYR|THB|ILS|PKR|BDT|LKR|KES|GHS|ISK|UAH)\b/g);
  const unique = [...new Set(codes ?? [])];
  if (unique.length < 2) return null;
  return [unique[0], unique[1]];
}

type RatePayload = {
  result?: string;
  base_code?: string;
  rates?: Record<string, number>;
  time_last_update_utc?: string;
  date?: string;
};

/** Pure: compose the citation, with the provider's own update time. */
export function composeRateCitation(
  from: string,
  to: string,
  payload: RatePayload,
): WebCitation | null {
  const rate = payload.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  // Prefer the upstream update time; fall back to retrieval time only when the
  // provider gave none, and say so in the snippet.
  const updated =
    payload.time_last_update_utc ?? (payload.date ? `${payload.date}T00:00:00Z` : undefined);
  const publishedAt = updated && Number.isFinite(Date.parse(updated)) ? new Date(updated).toISOString() : new Date().toISOString();
  return {
    title: `1 ${from} = ${rate.toFixed(4)} ${to}`,
    url: `https://www.xe.com/currencyconverter/convert/?Amount=1&From=${from}&To=${to}`,
    snippet:
      `1 ${from} = ${rate.toFixed(4)} ${to}` +
      (updated ? ` (rate updated ${updated})` : " (provider gave no update time)") +
      `. Source: open.er-api.com / exchangerate-api.com (keyless public exchange-rate feed). ` +
      `Rates are reference values for information only, not a trading quote and not financial advice.`,
    publishedAt,
    providers: ["Open Exchange Rates (keyless)"],
  };
}

export function createMarketRatesProvider(): SearchProvider {
  return {
    id: "market-rates",
    label: "Live exchange rates (keyless)",
    missingKeyHint: "",
    isConfigured: () => true,

    async search(query, numResults): Promise<SearchProviderResult> {
      if (!isResolvableRateQuery(query)) return { citations: [] };
      const pair = pairFromQuery(query);
      if (!pair) return { citations: [] };
      const [from, to] = pair;

      let lastError: unknown = null;
      for (const url of RATE_URLS) {
        try {
          const res = await axios.get(`${url}/${from}`, {
            timeout: 8000,
            // A 4xx from a rate API means "unknown code", not a broken service.
            validateStatus: (s) => s >= 200 && s < 300,
            headers: { Accept: "application/json" },
          });
          const citation = composeRateCitation(from, to, res.data as RatePayload);
          if (citation) return { citations: numResults > 0 ? [citation] : [] };
        } catch (err) {
          lastError = err;
        }
      }
      throw new Error(
        `exchange-rate lookup for ${from}/${to} failed: ${
          lastError instanceof Error ? lastError.message : "unknown error"
        }`,
      );
    },
  };
}
