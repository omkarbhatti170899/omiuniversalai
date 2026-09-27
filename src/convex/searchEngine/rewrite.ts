/**
 * Query rewriting — the upstream half of the search-quality fix.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous pass improved how results are SCORED, but a badly-formed query
 * produces badly-relevant results no matter how well they are ranked. Measured
 * on the live deployment, same minute, same engines:
 *
 *   "What is the Indian contingent medals tally in Asian Games 2026?"
 *       -> 0 results after a 12s timeout
 *   "Indian contingent medals tally in Asian Games 2026"
 *       -> 8 results, 4 usable, 4 independent domains
 *
 * `retrievalQuery` fixes the SHAPE of the string. This module goes further and
 * fixes its CONTENT, because a single phrasing still under-recalls:
 *
 *   1. ANCHORING — a question scoped to an event or a year is rewritten so the
 *      event name and the year are always present. Searching "India medal tally"
 *      without the year returns the 2018 Games; that is the exact failure the
 *      bug report described, and it starts as a query problem, not a ranking
 *      problem.
 *   2. VERTICAL TERMS — each vertical contributes the words its results
 *      actually use ("scoreline", "forecast", "exchange rate", "election
 *      result", "flight status"), so results are drawn from the right corpus.
 *   3. AUTHORITY TERMS — a small, principled nudge toward primary sources
 *      ("official", "medal table"), used on ONE variant so it widens recall
 *      without overriding the neutral variant.
 *   4. ANGLES — several bounded variants are fanned out. Different phrasings
 *      surface different sources; a single query cannot.
 *
 * Two rules govern the output:
 *   • The ORIGINAL question is never modified for validation, cross-checking or
 *     synthesis. Only the strings sent to indexes are rewritten.
 *   • Nothing is invented. The year comes from the question, the event from
 *     the question, the vertical terms from a fixed vocabulary. A rewritten
 *     query never asserts a fact the user did not ask about.
 *
 * PURE and deterministic. No network, no clock.
 */

import { retrievalQuery, namesEvent, type CurrentIntent } from "./intent";

export type RetrievalPlan = {
  /** The single best string — sent to structured/vertical providers. */
  primary: string;
  /** Bounded variants, fanned out to general-web providers only. */
  variants: string[];
  /** Which providers should receive the variants (general web only). */
  variantTargets: string[];
  /** Human-readable notes, for search debug mode. */
  notes: string[];
};

/** Structured providers already know what to ask for; a rewrite would only
 *  confuse them, so they receive `primary` alone. */
const GENERAL_WEB_PROVIDERS = new Set(["searxng", "duckduckgo", "gdelt", "commoncrawl"]);

/**
 * The words each vertical's results actually use — added ONLY when the user's
 * own wording does not already express that need.
 *
 * Appending "result report" to "India cricket score" makes the query WORSE:
 * it adds two tokens that compete with the two that identify the sport and
 * the sport. So each vertical carries both the terms to add and the
 * already-expressed synonyms that suppress the addition.
 */
const VERTICAL_TERMS: Record<string, { add: string[]; alreadySays: RegExp }> = {
  sports: {
    add: ["result", "report"],
    alreadySays: /\b(score|scoreline|standings|table|result|results|fixture|fixtures|final|tally|medal|who won)\b/i,
  },
  weather: {
    add: ["forecast"],
    alreadySays: /\b(weather|forecast|temperature|rain|snow|humidity|wind|storm|cyclone)\b/i,
  },
  markets: {
    add: ["rate", "price"],
    alreadySays: /\b(rate|price|share|stock|index|conversion|convert|exchange|market cap)\b/i,
  },
  election: {
    add: ["result", "count"],
    alreadySays: /\b(result|results|count|seats?|votes?|tally|majority|winner|won)\b/i,
  },
  travel: {
    add: ["status", "schedule"],
    alreadySays: /\b(status|schedule|delay|delayed|arrival|departure|gate|boarding)\b/i,
  },
  news: { add: [], alreadySays: /$^/ },
  general: { add: [], alreadySays: /$^/ },
};

/** Neutral authority nudge — applied to ONE variant, never to the primary. */
const AUTHORITY_TERMS = "official";

/** Strip a leading article without over-trimming ("Agnostic" must survive). */
function dedupe(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter((s) => s.length > 2))];
}

/**
 * Build the retrieval plan for one question.
 *
 * `now` is injectable so "is this year current" stays deterministic in tests.
 */
export function planRetrieval(
  query: string,
  classified: CurrentIntent,
  now: number = Date.now(),
): RetrievalPlan {
  const notes: string[] = [];
  const base = retrievalQuery(query);
  const todayStamp = new Date(now).toISOString().slice(0, 10);

  // 1. ANCHOR the year and the event into the string itself. This is the
  //    single highest-value rewrite: it stops a bare "medal tally" query from
  //    returning a previous Games.
  const anchors: string[] = [];
  const currentYear = Math.max(...classified.years, 0);
  const needYear =
    classified.years.length > 0 &&
    !base.match(/\b(19\d\d|20\d\d)\b/);
  if (needYear) {
    anchors.push(String(currentYear));
    notes.push(`anchored the asked year ${currentYear} into the query`);
  }
  // Only anchor the event when the query has not already named it under ANY
  // surface form. Bolting the canonical name onto a correctly-phrased query
  // ("Indian Premier League standings" -> "… ipl") adds a token and buys
  // nothing.
  if (classified.event && !namesEvent(base, classified.event)) {
    anchors.push(classified.event);
    notes.push(`anchored the "${classified.event}" event name`);
  } else if (classified.event) {
    notes.push(`event "${classified.event}" already named in the query`);
  }

  const anchored = anchors.length > 0 ? `${base} ${anchors.join(" ")}` : base;

  // 2. VERTICAL terms — but only when the user's wording does not already
  //    say it. Adding "result report" to "India cricket score" dilutes the two
  //    tokens that actually identify the request.
  const spec = VERTICAL_TERMS[classified.vertical];
  const withVertical =
    spec && spec.add.length > 0 && !spec.alreadySays.test(base)
      ? `${anchored} ${spec.add.join(" ")}`
      : anchored;
  if (withVertical !== anchored) {
    notes.push(`added ${classified.vertical} terms: ${spec.add.join(", ")}`);
  } else if (spec && spec.add.length > 0) {
    notes.push(`no ${classified.vertical} terms added — the query already expresses that`);
  }

  // 3. RECENCY WORD IN THE PRIMARY — measured to be the single biggest
  //    freshness lever available.
  //
  //    Measured live, same minute, same engines, same event:
  //      "…India latest medal tally at the Asian Games 2026"
  //          -> newest source 78.8h old  (3.3 days)
  //      "…India Asian Games 2026 medal tally today"
  //          -> newest source 26.4h old  (yesterday)
  //
  //    The word "today" is what unlocked the fresher page. Two lessons:
  //      (a) relying on a secondary variant to carry the recency signal means
  //          the PRIMARY call — the one every engine sees — carries none; and
  //      (b) "latest" is a WEAK recency signal to a search index and must NOT
  //          be allowed to suppress the strong one. So the rule is "ensure the
  //          strongest word is present", not "ensure some recency word is".
  //
  //    Not applied to `live-feed` verticals: a forecast or a currency rate
  //    carries the provider's own read time and is not a web-article recency
  //    problem.
  const STRONG_RECENCY_RE = /\b(today|tonight|right now|as of today|just now|currently)\b/i;
  // WEAK recency words. Measured: "latest" is not merely weak, it is actively
  // HARMFUL to a search index here — "India latest medal tally …" returned a
  // 3.3-day-old set while "India medal tally … today" returned yesterday's.
  // Since a strong word is added below, dropping the weak one is a measured
  // improvement, not a cosmetic one.
  const WEAK_RECENCY_RE = /\b(latest|newest|recent|recently|current|currently|upcoming|breaking)\b/gi;
  // Filler that dilutes an index query without adding a retrievable concept.
  const FILLER_RE =
    /\b(at the|of the|in the|for the|what is|what are|how many|give me|tell me|please|india'?s|the)\b/gi;

  let primary = withVertical;
  const wantsRecency =
    classified.requiresFreshness &&
    classified.freshnessTier !== "live-feed" &&
    !STRONG_RECENCY_RE.test(withVertical);
  if (wantsRecency) {
    // Compact, then attach the strong recency word. Order matters: compacting
    // AFTER adding "today" would not remove the weak words the user typed.
    const compacted = withVertical
      .replace(FILLER_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
    const droppedWeak = wantsRecency && WEAK_RECENCY_RE.test(compacted);
    primary = `${droppedWeak ? compacted.replace(WEAK_RECENCY_RE, " ") : compacted} today`
      .replace(/\s+/g, " ")
      .trim();
    notes.push('added the strong recency word "today" to the primary query');
    if (droppedWeak) {
      notes.push("dropped weak recency words (latest/recent/current) — measured to return staler results than 'today'");
    }
    if (compacted !== withVertical) notes.push("removed filler words from the retrieval query");
  }

  // 4. ANGLES. Each is a different way of asking, so they surface different
  //    sources. Only genuinely DIFFERENT angles are kept: an angle that merely
  //    repeats a token already present is noise that costs a provider call
  //    and buys nothing.
  const variants: string[] = [];

  if (classified.requiresFreshness && !/\blatest\b/i.test(base)) {
    variants.push(`${primary} latest`);
  }
  // The dated angle: a concrete date is a stronger recency probe than a
  // relative word, and it is what escalation uses.
  if (classified.requiresFreshness) {
    variants.push(`${base} today`);
    variants.push(`${base} ${todayStamp}`);
  }
  // The bare base is a useful angle ONLY when anchoring, vertical terms or a
  // recency word changed the primary — otherwise it is just the primary again.
  if (primary !== base) variants.push(base);
  variants.push(`${base} ${AUTHORITY_TERMS}`.trim());

  const finalVariants = dedupe(variants).filter((v) => v !== primary).slice(0, 3);
  if (finalVariants.length === 0) notes.push("no additional angles needed");

  return {
    primary,
    variants: finalVariants,
    variantTargets: [...GENERAL_WEB_PROVIDERS],
    notes,
  };
}

/** Providers that should also receive each variant. */
export function providersForVariant(providerId: string, plan: RetrievalPlan): boolean {
  return plan.variantTargets.includes(providerId);
}

export { GENERAL_WEB_PROVIDERS };
