/**
 * Date-aware and event-aware source matching.
 *
 * THE SECOND HALF OF THE REPORTED BUG
 * -----------------------------------
 * Detecting that a question is current is only half the job. Even with a live
 * search, the answer was still wrong because the RANKER had no notion of which
 * YEAR or which EVENT a result was about. A 2018 Asian Games article was a
 * perfectly good, high-authority, "fresh-looking" search result for the 2026
 * medal tally, and nothing down-ranked it.
 *
 * The rule this module encodes is stronger than freshness:
 *
 *   A result about a DIFFERENT YEAR is not an old answer. It is the WRONG
 *   ANSWER.
 *
 * Recency alone cannot express that — a page published last week about the
 * 2018 Games is "fresh" by timestamp and useless by content. So matching is
 * done on the years and the event a source actually mentions, not on its
 * publication date.
 *
 * PURE, deterministic, `now`-injectable. No network.
 */

import type { WebCitation } from "../searchProviders/types";

/** What we concluded about a source's temporal relevance. */
export type TemporalVerdict =
  | "match" // about the right year/event
  | "unknown" // silent about year/event — usable, cannot be scored
  | "wrong-year" // explicitly about a different year — a wrong answer
  | "wrong-event"; // about a different named event

export type TemporalMatch = {
  verdict: TemporalVerdict;
  /** 0..1 — 1 is a confirmed match, 0 is a confirmed mismatch. */
  score: number;
  /** Years the SOURCE itself mentions, ascending. */
  sourceYears: number[];
  reasons: string[];
};

/** Every year mentioned anywhere in a source's text, URL or title. */
export function yearsInSource(c: WebCitation): number[] {
  const hay = `${c.title ?? ""} ${c.snippet ?? ""} ${c.url ?? ""}`;
  const out = new Set<number>();
  const re = /\b(19[5-9]\d|20\d\d)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay)) !== null) {
    const y = Number(m[1]);
    // Only plausible event/data years; avoids matching a street number.
    if (y >= 1950 && y <= 2100) out.add(y);
  }
  return [...out].sort((a, b) => a - b);
}

/** Event tokens a source mentions, from a small canonical vocabulary. */
/**
 * Exported for the entity-anchored relevance engine in ./quality — one list,
 * so the query side (intent) and the source side (this) can never disagree
 * about what a named competition looks like.
 */
export const EVENT_TOKENS: Array<{ re: RegExp; name: string }> = [
  { re: /\basian games\b|\bag\b(?!\w)/i, name: "asian games" },
  { re: /\bolympic|\bolympics\b|\bteam gb\b|\bteam india\b/i, name: "olympics" },
  { re: /\bcommonwealth games\b/i, name: "commonwealth games" },
  { re: /\bipl\b|indian premier league/i, name: "ipl" },
  { re: /\bworld cup\b/i, name: "world cup" },
  { re: /\bchampions league\b/i, name: "champions league" },
  { re: /\bpremier league\b/i, name: "premier league" },
  { re: /\bformula ?1\b|\bf1\b|\bgrand prix\b/i, name: "formula 1" },
];

function eventsInSource(c: WebCitation): string[] {
  const hay = `${c.title ?? ""} ${c.snippet ?? ""} ${c.url ?? ""}`;
  return EVENT_TOKENS.filter((e) => e.re.test(hay)).map((e) => e.name);
}

/**
 * Decide whether a source is about the year/event the user asked about.
 *
 * `askedYears` and `askedEvent` come straight from the current-intent
 * classifier, so the two layers cannot disagree about what was asked.
 */
export function matchTemporal(
  c: WebCitation,
  askedYears: number[],
  askedEvent: string | null,
): TemporalMatch {
  const reasons: string[] = [];
  const sourceYears = yearsInSource(c);

  if (askedYears.length > 0) {
    const overlap = sourceYears.filter((y) => askedYears.includes(y));
    if (overlap.length > 0) {
      reasons.push(`source mentions the asked year ${overlap.join(", ")}`);
      return { verdict: "match", score: 1, sourceYears, reasons };
    }
    if (sourceYears.length > 0) {
      // The hard case from the report: a source that is confidently about
      // some OTHER year. Timestamps cannot save it.
      reasons.push(
        `source is about ${sourceYears.join(", ")} but the question asked about ${askedYears.join(", ")}`,
      );
      return { verdict: "wrong-year", score: 0, sourceYears, reasons };
    }
    reasons.push("source does not name a year");
  }

  if (askedEvent) {
    const events = eventsInSource(c);
    if (events.includes(askedEvent)) {
      reasons.push(`source covers the "${askedEvent}"`);
      return { verdict: "match", score: 1, sourceYears, reasons };
    }
    if (events.length > 0) {
      reasons.push(`source covers ${events.join(", ")} rather than "${askedEvent}"`);
      return { verdict: "wrong-event", score: 0.2, sourceYears, reasons };
    }
    reasons.push(`source does not name the "${askedEvent}"`);
  }

  return { verdict: "unknown", score: 0.5, sourceYears, reasons };
}

/**
 * Multiplier applied to a source's blended ranking score.
 *
 * A wrong-year source is not merely deprioritised — it is driven to the floor,
 * because surfacing it is how a 2018 medal table becomes an answer about 2026.
 * An "unknown" source is left alone: plenty of good pages simply never print a
 * year, and punishing those would empty the result set.
 */
export function temporalPenalty(match: TemporalMatch): number {
  switch (match.verdict) {
    case "match":
      return 1.15;
    case "wrong-year":
      return 0.1;
    case "wrong-event":
      return 0.45;
    default:
      return 1;
  }
}

/** True when a source must not be used as current evidence at all. */
export function isWrongYear(match: TemporalMatch): boolean {
  return match.verdict === "wrong-year";
}
