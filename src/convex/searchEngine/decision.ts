/**
 * Omi Search Decision Engine — classifies a request BEFORE any network
 * call, so Omi only searches when searching helps, and searches the right
 * way (category, freshness, language) when it does.
 *
 *   knowledge question   → search (cache-friendly)
 *   current-info request → search, bypass cache, prefer fresh sources
 *   news request         → news category, last week, fresh
 *   research request     → multi-source research (deep mode recommended)
 *   URL present          → retrieve + analyze the page, no engine search
 *   calculation          → compute directly, no search
 *   conversational       → answer directly, no search
 */

export type SearchIntent =
  | "knowledge"
  | "current"
  | "news"
  | "research"
  | "url"
  | "calculation"
  | "conversational";

export type DecisionResult = {
  intent: SearchIntent;
  needsSearch: boolean;
  skipCache: boolean;
  category?: "general" | "news" | "images" | "videos" | "science";
  timeRange?: "day" | "week" | "month" | "year";
  language?: string;
  cleanedQuery: string;
  reasons: string[];
};

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

const FRESH_WORDS =
  /\b(latest|today|today's|todays|current(ly)?|now|right now|recent(ly)?|price|prices|pricing|live|availability|in stock|this week|this month|update[ds]?)\b/i;
const NEWS_WORDS =
  /\b(news|breaking|headline[ds]?|announced?|announcement|launch(?:ed|ing)?|report(?:ed)?|market (?:today|close)|what happened)\b/i;
const RESEARCH_WORDS =
  /\b(compare|comparison|vs\.?|versus|best|top \d+|research|alternatives|pros and cons|which .*(?:best|better))\b/i;
const CONVO_RE =
  /^(hi+|hello+|hey+|yo+|thanks|thank you|good (morning|afternoon|evening|night)|bye+|ok(?:ay)?|who invented you|who are you|what are you|how are you)\b[\s,!.]*(there|everyone|all|omi|team|bro)?[\s!?.]*$/i;
const FILLER_RE =
  /^(?:please\s+)?(?:search(?:\s+for)?|find(?:\s+me)?|look\s+up|google|show\s+me|tell\s+me\s+about|what\s+(?:is|are)|who\s+(?:is|was)|whats|what's)\s+/i;

const CALC_CHARS_RE = /^[\s\d+\-*/().,%^!]+$/;
const CALC_HINT_RE = /\b(?:calculate|compute|how much is|what is)\b/i;

export function extractUrl(query: string): string | null {
  const m = query.match(URL_RE);
  return m ? m[0] : null;
}

const CALC_FUNC_RE =
  /\b(sqrt|cbrt|sin|cos|tan|log|ln|abs|floor|ceil|round|min|max|pi|e)\b/gi;

export function isCalculation(query: string): boolean {
  const q = query.trim();
  if (q.length === 0 || q.length > 80) return false;
  if (CALC_HINT_RE.test(q) && /\d\s*[+\-*/]\s*\d/.test(q)) return true;
  // Strip known function/constant names, then the remainder must be pure
  // arithmetic characters (includes `!` for factorial, e.g. "17!").
  const stripped = q.replace(CALC_FUNC_RE, " ").trim();
  if (
    CALC_CHARS_RE.test(stripped) &&
    /\d/.test(stripped) &&
    /[+\-*/^!]/.test(stripped)
  ) {
    return true;
  }
  return false;
}

const SCRIPTS: Array<[RegExp, string]> = [
  [/[\u0400-\u04FF]/, "ru"],
  [/[\u4E00-\u9FFF]/, "zh"],
  [/[\u3040-\u30FF]/, "ja"],
  [/[\uAC00-\uD7AF]/, "ko"],
  [/[\u0600-\u06FF]/, "ar"],
  [/[\u0900-\u097F]/, "hi"],
];

/** Script-based language hint for non-Latin queries (Latin → undefined). */
export function detectScriptLanguage(query: string): string | undefined {
  for (const [re, lang] of SCRIPTS) {
    if (re.test(query)) return lang;
  }
  return undefined;
}

export function decideSearch(rawQuery: string): DecisionResult {
  const reasons: string[] = [];
  const url = extractUrl(rawQuery);

  const cleanedQuery =
    rawQuery
      .replace(URL_RE, "")
      .replace(FILLER_RE, "")
      .replace(/^["']+|["']+$/g, "")
      .replace(/\s+/g, " ")
      .trim() || rawQuery.trim();

  const base = { cleanedQuery, reasons };

  if (url) {
    reasons.push("URL detected → retrieve and analyze the page directly");
    return { intent: "url", needsSearch: false, skipCache: false, ...base };
  }
  if (isCalculation(rawQuery)) {
    reasons.push("Arithmetic expression → compute directly, no search needed");
    return { intent: "calculation", needsSearch: false, skipCache: false, ...base };
  }
  if (CONVO_RE.test(rawQuery.trim())) {
    reasons.push("Conversational message → answer directly, no search needed");
    return { intent: "conversational", needsSearch: false, skipCache: false, ...base };
  }
  if (NEWS_WORDS.test(rawQuery)) {
    reasons.push("News phrasing → news category, last week, fresh results");
    return {
      intent: "news",
      needsSearch: true,
      skipCache: true,
      category: "news",
      timeRange: "week",
      ...base,
    };
  }
  if (FRESH_WORDS.test(rawQuery)) {
    reasons.push("Freshness requested → bypass cache, prefer recent sources");
    return {
      intent: "current",
      needsSearch: true,
      skipCache: true,
      timeRange: "month",
      ...base,
    };
  }
  if (RESEARCH_WORDS.test(rawQuery)) {
    reasons.push("Comparative/research phrasing → multi-source research");
    return { intent: "research", needsSearch: true, skipCache: false, ...base };
  }
  const language = detectScriptLanguage(rawQuery);
  if (language) reasons.push(`Non-Latin script detected → language hint "${language}"`);
  reasons.push("Knowledge question → standard web search (cache-friendly)");
  return { intent: "knowledge", needsSearch: true, skipCache: false, language, ...base };
}
