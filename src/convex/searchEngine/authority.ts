/**
 * AUTHORITATIVE-SOURCE POLICY — generalized per vertical (2026-09-29).
 * =============================================================================
 *
 * MEASURED SUCCESS this generalizes: for "who is leading the F1 2026 drivers
 * championship", the pipeline now correctly REFUSES weak evidence (the Kim
 * Kardashian article) — but refusing is the floor, not the goal. The question
 * SHOULD be answerable from authoritative sources: official Formula 1, the
 * FIA, or major sports desks. This module states, per vertical, which source
 * classes are AUTHORITATIVE for a live-fact question and which are merely
 * acceptable background — so retrieval prefers the former instead of only
 * rejecting the latter.
 *
 * The rule is applied ONLY to live-fact questions (a current figure, standing,
 * score, price, reading). A historical or explanatory question may cite
 * anyone credible; the answerability layer already handles that.
 *
 * Contract:
 *   • PREFERRED providers are dialed first (already the case for structured
 *     feeds) and their citations are accepted by construction.
 *   • AUTHORITATIVE_MIN_WEIGHT is the trust floor: for live-fact questions,
 *     evidence from a source below the floor can still be PRESENT in the
 *     evidence set, but the authoritative gate in the answer path requires at
 *     least one source AT-or-above the floor, else Omi refuses honestly
 *     (NO_VERIFIED_RESULTS) rather than answering from weak sources.
 *   • No vertical is special-cased by name: every entry is a class of source,
 *     so "products", "health", "education" and "science" get the same
 *     treatment as sports without new code paths.
 *
 * PURE: data + one lookup. No network, no clock.
 */

import type { Vertical } from "./intent";
import { sourceTier } from "./quality";

/** Trust floor (sourceTier weight) for live-fact evidence, per vertical. */
export const AUTHORITATIVE_MIN_WEIGHT: Record<Vertical, number> = {
  // Official competition bodies (formula1.com, fia, iplt20, premierleague)
  // and major sports desks (SPORTS_AUTHORITY_RE) are 0.85+; a general sports
  // blog is 0.6 and cannot carry a standings answer alone.
  sports: 0.85,
  // Market figures come from exchanges/official desks or major financial
  // press; a personal blog quoting a price is not verification.
  markets: 0.85,
  // Weather is answered by the structured feed (accepted by construction);
  // any web fallback must still be a major outlet.
  weather: 0.85,
  // Election figures: election commissions and major news desks only.
  election: 0.85,
  // News: a current-events question needs at least one established outlet.
  news: 0.85,
  travel: 0.6, // broad subject; background coverage is acceptable
  general: 0.6, // broad subject; background coverage is acceptable
};

/**
 * Structured providers whose data IS the authoritative answer for a vertical.
 * A citation from one of these passes the authority gate by construction —
 * measured live: the EPL/live-score rows carry zero topical vocabulary yet
 * are the correct evidence.
 */
export const AUTHORITATIVE_PROVIDERS: Partial<Record<Vertical, string[]>> = {
  sports: ["sports-scores"],
  weather: ["openmeteo"],
  markets: ["market-rates"],
};

/**
 * Which source domains are the OFFICIAL/primary bodies for a subject? When a
 * question names one of these subjects (detected by the same regex that
 * classifies it), retrieval prefers their domain explicitly. This is data,
 * not code: adding coverage is a table row.
 */
export const OFFICIAL_DOMAIN_HINTS: Array<{
  /** What question pattern routes here (matched against the user's words). */
  match: RegExp;
  /** Canonical official domains, preferred at retrieval time. */
  domains: string[];
  /** Human label for traces. */
  label: string;
}> = [
  {
    match: /\bformula ?1\b|\bf1\b/i,
    domains: ["formula1.com", "fia.com"],
    label: "Formula 1 / FIA official",
  },
  {
    match: /\bipl\b|indian premier league/i,
    domains: ["iplt20.com", "bcci.tv"],
    label: "IPL official",
  },
  {
    match: /\bpremier league\b|\bepl\b/i,
    domains: ["premierleague.com"],
    label: "Premier League official",
  },
  {
    match: /\bnba\b/i,
    domains: ["nba.com"],
    label: "NBA official",
  },
  {
    match: /\bolympic|\basian games\b/i,
    domains: ["olympics.com", "ocasia.org"],
    label: "Games official",
  },
  {
    match: /\brbi\b|reserve bank/i,
    domains: ["rbi.org.in"],
    label: "RBI official",
  },
  {
    match: /\bsebi\b/i,
    domains: ["sebi.gov.in"],
    label: "SEBI official",
  },
  {
    match: /\binflation\b|\bcpi\b|\bcci\b/,
    domains: ["mospi.gov.in", "imf.org", "data.worldbank.org"],
    label: "Statistics official",
  },
  {
    match: /\bweather\b|\bforecast\b/i,
    domains: ["mausam.imd.gov.in", "weather.gov"],
    label: "Meteorology official",
  },
  {
    match: /\bcovid\b|\bvaccin|\bwho\b.*\bhealth\b|\bministry of health\b/i,
    domains: ["who.int", "mohfw.gov.in", "cdc.gov"],
    label: "Health official",
  },
];

/**
 * Is this question a LIVE-FACT question for its vertical — i.e. does the
 * authoritative floor apply? Live-data kinds are the current figures the
 * product exists to answer: scores, standings, tallies, prices, rates,
 * weather, election counts. A "history of…" or "how does X work" question is
 * exempt (the answerability layer governs it instead).
 */
export function authoritativeFloorApplies(liveData: string | null): boolean {
  return (
    liveData === "score" ||
    liveData === "standing" ||
    liveData === "tally" ||
    liveData === "price" ||
    liveData === "rate" ||
    liveData === "weather" ||
    liveData === "election" ||
    liveData === "status"
  );
}

/** The trust floor for one vertical's live-fact questions. */
export function authoritativeMinWeight(vertical: Vertical): number {
  return AUTHORITATIVE_MIN_WEIGHT[vertical] ?? 0.85;
}

/**
 * Official domains preferred for this question, if the question names a
 * subject with a known primary source. Empty when no hint applies.
 */
export function officialDomainsFor(query: string): string[] {
  for (const hint of OFFICIAL_DOMAIN_HINTS) {
    if (hint.match.test(query ?? "")) return hint.domains;
  }
  return [];
}

/** Human label of the matched official-source hint, or null. */
export function officialDomainLabel(query: string): string | null {
  for (const hint of OFFICIAL_DOMAIN_HINTS) {
    if (hint.match.test(query ?? "")) return hint.label;
  }
  return null;
}

/**
 * Does one citation pass the authoritative gate for this vertical?
 *
 * True when the citation came from a structured authoritative provider, OR
 * its domain is a known official body for the subject, OR its sourceTier
 * weight clears the vertical's floor.
 */
export function isAuthoritativeFor(
  c: { url: string; providers?: string[] },
  vertical: Vertical,
  query: string,
): boolean {
  const providers = c.providers ?? [];
  if ((AUTHORITATIVE_PROVIDERS[vertical] ?? []).some((p) => providers.includes(p))) {
    return true;
  }
  const domain = (() => {
    try {
      return new URL(c.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  })();
  if (officialDomainsFor(query).includes(domain)) return true;
  return sourceTier(c.url).weight >= authoritativeMinWeight(vertical);
}
