/**
 * Query-intent classifier for current / live information.
 *
 * WHY THIS MODULE EXISTS — the real bug it fixes
 * ----------------------------------------------
 * Real user testing found that live questions could still be answered from
 * stale or remembered information. The reproduction is exact:
 *
 *   "What is the Indian contingent medals tally in Asian Games 2026?"
 *     decision.intent        -> "knowledge"
 *     freshnessPolicy.requiresFreshness -> false
 *     vertical               -> "general"
 *
 * so the turn searched the open web, accepted a years-old article, and let
 * the model narrate a medal tally it had memorised. Two words did it:
 *
 *   1. "tally"/"medal" is a LIVE DATA NOUN, not a general knowledge noun.
 *      Nothing in the old detector knew that, so a live question looked like a
 *      static one.
 *   2. The year "2026" was never read as a freshness signal. A question scoped
 *      to the CURRENT year is asking about the present, whatever verb it uses.
 *
 * The fix is detection, not prompting. This module is PURE (no I/O, no clock
 * beyond an injectable `now`), deterministic and unit-tested, and it is the
 * single place that decides whether a question may be answered from model
 * memory at all.
 *
 * Design rules, learned from the failure:
 *   - IMPLICIT freshness counts. "medal tally in Asian Games 2026" needs live
 *     data without ever saying "latest".
 *   - But a PAST year opts OUT. "Who won the 2016 Olympics?" is history; the
 *     answer is stable and model knowledge is correct and fast. Forcing it
 *     through a live search would be slower and no more accurate.
 *   - An explicit freshness word always wins, even for a past year — if the
 *     user says "latest", they want live sources or an honest "not found".
 */

export type Vertical =
  | "news"
  | "sports"
  | "weather"
  | "markets"
  | "election"
  | "travel"
  | "general";

/** How current the evidence must be. See `CurrentIntent.freshnessTier`. */
export type FreshnessTier = "now" | "recent" | "live-feed" | "none";

/** The kind of live datum the question is asking for, when it is one. */
export type LiveDataKind =
  | "score"
  | "standing"
  | "tally"
  | "price"
  | "rate"
  | "weather"
  | "election"
  | "flight"
  | "news"
  | "status";

export type CurrentIntent = {
  /** The question may NOT be answered from model knowledge. */
  requiresFreshness: boolean;
  vertical: Vertical;
  /** Which live datum is being asked for, or null for a general current ask. */
  liveData: LiveDataKind | null;
  /**
   * HOW fresh the evidence must be. This is the single most important field
   * for ranking: "today" and "recent" are NOT the same request, and treating
   * them identically is what let a 3-day-old article answer "latest".
   *
   *  • "now"       — the user named today/now. Target: HOURS.
   *  • "recent"    — the user asked for latest/recent. Target: DAYS.
   *  • "live-feed" — a structured vertical (weather, rates) that refreshes in
   *                  minutes; the provider's own read time is the timestamp.
   *  • "none"      — not a freshness-sensitive question.
   */
  freshnessTier: FreshnessTier;
  /**
   * Years explicitly named in the question, ascending. A year >= the current
   * year means the user is asking about the present, not the archive.
   */
  years: number[];
  /** A named recurring event the question is scoped to, lowercased. */
  event: string | null;
  /** True when the question is pinned to a year and/or event. */
  eventScoped: boolean;
  /** Human-readable reasons, surfaced only in search debug mode. */
  reasons: string[];
  /** True when the question is scoped to a year that has already passed. */
  historical: boolean;
};

// --- Vocabulary -------------------------------------------------------------

/**
 * LIVE DATA NOUNS. A question demanding one of these is asking for a value
 * that only a live feed can supply, EVEN WITH NO TIME WORD AT ALL.
 *
 * This is the list that was missing. `score`, `price` and `rate` were already
 * covered by vertical routing; `tally`, `medal`, `standings`, `election
 * result` and `flight status` were not, which is exactly where the reported
 * bug lived.
 */
const LIVE_NOUN_RE =
  /\b(tally|tallies|medal|medals|medallist|medal table|gold count|standings|standing|league table|leaderboard|scorecard|scoreline|scores?|box office|gross collection|election results?|election count|vote count|vote share|seat count|swing|exit poll|polls?|flight status|flight updates?|train status|trains? running|availability|waitlist|outage|status page|incident|current office holder|who is the current)\b/i;

const TALLY_RE = /\b(tally|tallies|medal|medals|medal table|gold count)\b/i;
const STANDING_RE = /\b(standings|standing|league table|leaderboard)\b/i;
/**
 * MEASURED (golden-suite F1 test): "who is leading the F1 2026 drivers
 * championship" produced liveData=null — "leader"/"leading" names a ranking
 * position without using the word "standings", so the live-data detection
 * missed it and the source-quality gate for standings never armed. A
 * championship LEADER is a standings fact by any reading.
 */
const LEADER_RE = /\b(leader|leading|leads the|top of the (?:table|standings)|ahead in the (?:race|championship))\b/i;
/**
 * Score/result wording. Kept deliberately in step with `scoreDemanded` in
 * freshness.ts — "Arsenal vs Chelsea RESULT" names no sport at all, and a
 * narrower list here silently sent it to the general web floor.
 */
const SCORE_RE =
  /\b(score|scores|scoreline|scorecard|scorer|fixture|fixtures|result|results|final|who won|how many goals)\b/i;
const ELECTION_RE =
  /\b(election|elections|ballot|vote|voting|voter|votes|parliament|congress|assembly|polls?|exit poll|by-?poll|swing)\b/i;
const FLIGHT_RE = /\b(flight|flights|airline|airport|departure|arrival|terminal|gate|boarding)\b/i;
const BOX_OFFICE_RE = /\b(box office|gross collection|collection|opening weekend)\b/i;

/**
 * Named recurring events. Knowing the event lets ranking prefer that event's
 * own site and reject a lookalike from a different year or competition.
 */
const EVENTS: Array<{ re: RegExp; name: string }> = [
  { re: /\basian games\b/i, name: "asian games" },
  { re: /\bolympic games?\b|\bolympics\b/i, name: "olympics" },
  { re: /\bcommonwealth games\b/i, name: "commonwealth games" },
  { re: /\bworld cup\b/i, name: "world cup" },
  { re: /\b(ipl|indian premier league)\b/i, name: "ipl" },
  { re: /\b(cricket world cup|t20 world cup)\b/i, name: "cricket world cup" },
  { re: /\bchampions league\b/i, name: "champions league" },
  { re: /\bpremier league\b/i, name: "premier league" },
  { re: /\bformula ?1\b|\bf1\b/i, name: "formula 1" },
  { re: /\bnba\b/i, name: "nba" },
  { re: /\bnfl\b/i, name: "nfl" },
  { re: /\btennis (?:wimbledon|us open|australian open|french open)\b/i, name: "grand slam" },
  { re: /\bgeneral elections?\b|\belection results?\b/i, name: "general election" },
];

/** Words that make even a past-dated question a live one. */
const EXPLICIT_FRESH_RE =
  /\b(latest|newest|most recent|recent|recently|right now|as of (?:today|now)|today'?s?|tonight|currently|current|live|breaking|upcoming|so far|this (?:week|month|year|morning|evening)|updated)\b/i;

/**
 * The multilingual counterpart of EXPLICIT_FRESH_RE.
 *
 * This is the gate that actually decides `requiresFreshness`, so it — not
 * the tier helper — is where the English-only bug lived. Measured: French,
 * Spanish, German, Italian, Portuguese, Dutch, Swedish and CJK recency
 * wording all produced `requiresFreshness=false`, so those users got no
 * freshness gate, no escalation and no data timestamp, and a months-old page
 * could be presented as current.
 *
 * The user's language must never decide whether their data is stale.
 */
const EXPLICIT_FRESH_MULTILINGUAL_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(aujourd'hui|aujourdhui|maintenant|d[eé]sormais?|derni[eè]res?|nouvelles?|actuel(?:le|s)?|r[eé]cent(?:e|s)?)(?![\\p{L}\\p{N}])", // fr
    "(?<![\\p{L}\\p{N}])(heute|jetzt|aktuell\\w*|neueste?n?|gerade|neuer?)(?![\\p{L}\\p{N}])", // de
    "(?<![\\p{L}\\p{N}])(hoy|ahora|actuali[sz]|reciente[sd]?|[uú]ltim[oa]s?)(?![\\p{L}\\p{N}])", // es
    "(?<![\\p{L}\\p{N}])(oggi|adesso|attuali|ultim[io]|pi[uù] recenti|recenti|notizie)(?![\\p{L}\\p{N}])", // it
    "(?<![\\p{L}\\p{N}])(hoje|agora|atuais?|recentes?|atualmente)(?![\\p{L}\\p{N}])", // pt
    "(?<![\\p{L}\\p{N}])(vandaag|nu|actuele|laatste)(?![\\p{L}\\p{N}])", // nl
    "(?<![\\p{L}\\p{N}])(idag|nu|senaste|aktuella)(?![\\p{L}\\p{N}])", // sv
    "(?<![\\p{L}\\p{N}])(i dag|n[uå]v|aktuelle|siste)(?![\\p{L}\\p{N}])", // da/no
    "(今日|本日|今|最近|最新|現在|速報)", // ja
    "(오늘|지금|최근|최신|현재)",       // ko
    "(今天|今日|现在|最近|最新|当前|实时)", // zh
    "(сегодня|сейчас|последние|актуальные|свежие|новости)", // ru
    "(أحدث|الأخير|اليوم|الآن|حتى الآن|جديد)",                  // ar
  ].join("|"),
  "iu",
);

/**
 * "As of RIGHT NOW" wording — the tightest possible freshness demand.
 *
 * Measured failure this fixes: a user asked for India's LATEST Asian Games
 * medal tally and Omi answered from a source THREE DAYS OLD, at full
 * confidence, because every freshness rule used the same 14-day window and a
 * 3-day-old page scored identically to a 1-day-old one. Asking for "today"
 * must mean a materially different thing from asking for "recent".
 */
const NOW_TIER_RE =
  /\b(today|tonight|right now|as of (?:today|now)|at the moment|current score|current tally|current status|so far today|this (?:morning|afternoon|evening)|live now|just now)\b/i;

/**
 * "Today" in the languages Omi actually serves.
 *
 * MEASURED DEFECT: recency wording was English-only, so a French, Spanish,
 * German, Italian or Japanese user asking for TODAY's news was classified
 * `tier=none` -> `requiresFreshness=false`. Live consequence: no freshness
 * gate, no escalation pass, and no "Current as of" timestamp, so Omi would
 * answer from a months-old page and present it as current. The user's
 * language must not decide whether their data is stale.
 *
 * This is a word list per language, not a per-query patch: adding a language
 * adds its recency vocabulary and nothing else changes.
 */
const NOW_TIER_MULTILINGUAL_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(aujourd'hui|aujourdhui)(?![\\p{L}\\p{N}])", // fr
    "(?<![\\p{L}\\p{N}])(heute|jetzt|gerade eben|sofort)(?![\\p{L}\\p{N}])", // de
    "(?<![\\p{L}\\p{N}])(hoy|ahora|mism[oó] momento)(?![\\p{L}\\p{N}])", // es
    "(?<![\\p{L}\\p{N}])(oggi|adesso|ora)(?![\\p{L}\\p{N}])", // it
    "(?<![\\p{L}\\p{N}])(hoje|agora)(?![\\p{L}\\p{N}])", // pt
    "(?<![\\p{L}\\p{N}])(vandaag|nu)(?![\\p{L}\\p{N}])", // nl
    "(?<![\\p{L}\\p{N}])(idag|nu|dabar)(?![\\p{L}\\p{N}])", // sv
    "(?<![\\p{L}\\p{N}])(i dag|akkurat|n[åa])(?![\\p{L}\\p{N}])", // no/da
    "(今日|本日|今朝|今晩|いま|今)", // ja
    "(오늘|지금|현재)",       // ko
    "(今天|今日|现在)",        // zh
    "(сегодня|сейчас)",       // ru
    "(اليوم|الآن|حتى الآن)",   // ar
  ].join("|"),
  "iu",
);

/** "Give me something recent" wording — a looser but still real demand. */
const RECENT_TIER_RE =
  /\b(latest|newest|most recent|recent|recently|this week|past few days|current|currently|updated|up to date|breaking|upcoming|recently updated)\b/i;

/**
 * "Latest / current / updated" in the languages Omi serves. Same measured
 * defect as NOW_TIER_MULTILINGUAL_RE: without these, non-English recency
 * requests silently lost their freshness requirement.
 */
const RECENT_TIER_MULTILINGUAL_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(derni[eè]res?|r[eé]cent[e]?s?|actualis[eé]|nouveaux?|nouvelles?)(?![\\p{L}\\p{N}])", // fr
    "(?<![\\p{L}\\p{N}])(neueste?n?|aktuell\\w*|neuer?)(?![\\p{L}\\p{N}])", // de
    "(?<![\\p{L}\\p{N}])([uú]ltim[oa]s?|actuali[sz]|recientes?)(?![\\p{L}\\p{N}])", // es
    "(?<![\\p{L}\\p{N}])(ultim[io]|pi[uù] recenti|attuali)(?![\\p{L}\\p{N}])", // it
    "(?<![\\p{L}\\p{N}])([uú]ltim[oa]s?|atuais?|recentes?)(?![\\p{L}\\p{N}])", // pt
    "(?<![\\p{L}\\p{N}])(laatste|actuele|recente)(?![\\p{L}\\p{N}])", // nl
    "(?<![\\p{L}\\p{N}])(senaste|senas|aktuella)(?![\\p{L}\\p{N}])", // sv
    "(?<![\\p{L}\\p{N}])(siste|aktuelle)(?![\\p{L}\\p{N}])", // da/no
    "(最新|最近|現在|本日)", // ja
    "(최근|최신|현재)",       // ko
    "(最新|最近|今日|当前|更新)", // zh
    "(последние|актуальные|свежие|новости)", // ru
    "(أحدث|الأخير|جديد)",     // ar
  ].join("|"),
  "iu",
);

/** Past-tense framing — strong evidence the user wants history, not a feed. */
const HISTORICAL_RE =
  /\b(who won|who won the|what was|what were|when did|when was|used to|in \d{4}\b|history of|originally|first (?:won|held|hosted)|as of \d{4}\b|back in \d{4}\b|final score in \d{4}\b)/i;

// --- Extraction -------------------------------------------------------------

/** Every 4-digit year in the query, between 1990 and currentYear+3. */
export function extractYears(query: string, currentYear: number): number[] {
  const out = new Set<number>();
  const re = /\b(19[9]\d|20\d\d)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query ?? "")) !== null) {
    const y = Number(m[1]);
    if (y >= 1990 && y <= currentYear + 3) out.add(y);
  }
  return [...out].sort((a, b) => a - b);
}

/** The named event the question is scoped to, or null. */
export function extractEvent(query: string): string | null {
  for (const e of EVENTS) {
    if (e.re.test(query ?? "")) return e.name;
  }
  return null;
}

/**
 * True when the query text already names the event under ANY of its known
 * surface forms.
 *
 * Needed so query rewriting does not bolt a canonical name onto a query that
 * already used a synonym: "Indian Premier League 2026 standings" must not
 * become "… standings ipl". The canonical name is for MATCHING sources, not
 * for decorating a query the user already phrased correctly.
 */
export function namesEvent(query: string, event: string | null): boolean {
  if (!event) return false;
  const entry = EVENTS.find((e) => e.name === event);
  if (!entry) return query.toLowerCase().includes(event);
  return entry.re.test(query ?? "");
}

function detectLiveKind(q: string): LiveDataKind | null {
  if (WEATHER_RE.test(q)) return "weather";
  if (TALLY_RE.test(q)) return "tally";
  if (STANDING_RE.test(q) || LEADER_RE.test(q)) return "standing";
  if (SCORE_RE.test(q)) return "score";
  if (BOX_OFFICE_RE.test(q)) return "price";
  if (FLIGHT_RE.test(q)) return "flight";
  if (ELECTION_RE.test(q)) return "election";
  if (MARKETS_RE.test(q) && MARKET_VALUE_RE.test(q)) return "rate";
  return null;
}

// --- Vertical routing -------------------------------------------------------

const WEATHER_RE =
  /\b(weather|forecast|temperature|raining|rain|rainfall|snow|snowfall|humidity|wind speed|wind|storm|cyclone|how (?:hot|cold)|will it (?:rain|snow)|air quality)\b/i;
const MARKETS_RE =
  /\b(stock|stocks|share price|share prices|market cap|sensex|nifty|nasdaq|dow jones|sp ?500|exchange rate|exchange rates|forex|crypto|bitcoin|btc|ethereum|etf|gold price|oil price|brent|commodit|bullion|conversion rate)\b/i;
const SPORTS_RE =
  /\b(score|scores|scoreline|fixture|fixtures|match|matches|game|tournament|league|ipl|football|soccer|cricket|nba|nfl|f1|formula ?1|tennis|olympic|asian games|commonwealth games|world cup|medal)\b/i;
const NEWS_RE =
  /\b(news|headlines?|breaking|what'?s happening|what is happening|what happened|developments?|announcements?|announced|press release|update[ds]?|latest)\b/i;

/** A named currency, e.g. "USD", "INR" — a PAIR of them is a market question. */
const CURRENCY_CODE_RE =
  /\b(usd|eur|gbp|inr|jpy|aud|cad|chf|cny|sgd|aed|sar|hkd|nzd|zar|brl|mxn|rub|krw|try|idr|php|myr|thb|ils|pkr|bdt|lkr|kes|ghs|isk|uah)\b/i;

/** Does the wording ask for the NUMBER (rate/price), not a discussion? */
const MARKET_VALUE_RE =
  /\b(rate|rates|price|prices|trading|quote|worth|cost|conversion|convert|exchange|market cap|how much)\b/i;

function namesCurrencyPair(q: string): boolean {
  // "gi" must be repeated: `new RegExp(re, flags)` REPLACES the source flags
  // rather than adding to them, so without it "USD" in caps would never match.
  const codes = new Set(q.toLowerCase().match(new RegExp(CURRENCY_CODE_RE, "gi")) ?? []);
  return codes.size >= 2;
}

/**
 * Which vertical serves this question. Order matters: an explicit vertical
 * wins over the generic news catch-all, and a sport name wins over "news"
 * ("latest cricket news" is sport reporting, not a news index).
 */
/**
 * Weather vocabulary outside English. Unicode-aware boundaries via
 * `(?<![\p{L}\p{N}])` — plain `\b` is ASCII-only and silently fails to match
 * before an accented letter such as "ü" or "é", which is exactly how the
 * first attempt at this fix appeared to work and did not.
 */
const WEATHER_MULTILINGUAL_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(wetterlage|wetteraussicht|wetter\\w*|wetter|vorhersage)(?![\\p{L}\\p{N}])", // de
    "(?<![\\p{L}\\p{N}])(m[eé]t[eé]o|tiempo|clima|pr[ée]vision m[ée]t[ée]o)(?![\\p{L}\\p{N}])", // es/fr/it mix
    "(?<![\\p{L}\\p{N}])(temps|pr[ée]vision m[ée]t[ée]o)(?![\\p{L}\\p{N}])", // fr
    "(?<![\\p{L}\\p{N}])(tempo|meteo|previsioni)(?![\\p{L}\\p{N}])", // it
    "(?<![\\p{L}\\p{N}])(tempo|previsao|weather)(?![\\p{L}\\p{N}])", // pt
    "(?<![\\p{L}\\p{N}])(weer|weersverwachting)(?![\\p{L}\\p{N}])", // nl
    "(?<![\\p{L}\\p{N}])(v[aä]der|v[aä]dret)(?![\\p{L}\\p{N}])", // sv
    "(?<![\\p{L}\\p{N}])(v[aæ]r|v[aæ]rret)(?![\\p{L}\\p{N}])", // da/no
    "(?<![\\p{L}\\p{N}])(tiempo|meteorolog[ií]a)(?![\\p{L}\\p{N}])", // es
    "(天气|気象|天気|天氣|기상|날씨| погод|الطقس)",                            // zh/ja/ko/ru/ar
  ].join("|"),
  "iu",
);

/** News vocabulary outside English — the "latest news" catch-all. */
const NEWS_MULTILINGUAL_RE = new RegExp(
  [
    "(?<![\\p{L}\\p{N}])(nouvelles?|actualit[eé]s?|d[eé]p[eê]ches?)(?![\\p{L}\\p{N}])", // fr
    "(?<![\\p{L}\\p{N}])(nachrichten|meldungen|neues|neuigkeiten)(?![\\p{L}\\p{N}])", // de
    "(?<![\\p{L}\\p{N}])(noticias|novedades|actualidad)(?![\\p{L}\\p{N}])", // es
    "(?<![\\p{L}\\p{N}])(notizie|ultime notizie|cronaca)(?![\\p{L}\\p{N}])", // it
    "(?<![\\p{L}\\p{N}])(not[ií]cias|noticias|atualidades)(?![\\p{L}\\p{N}])", // pt
    "(?<![\\p{L}\\p{N}])(nieuws|actualiteiten)(?![\\p{L}\\p{N}])", // nl
    "(?<![\\p{L}\\p{N}])(nyheter|nyheterna|nyhetsl[aä]gen)(?![\\p{L}\\p{N}])", // sv
    "(?<![\\p{L}\\p{N}])(nyheder|nyhetslarm|nyhetsniva)(?![\\p{L}\\p{N}])", // da
    "(?<![\\p{L}\\p{N}])(uutiset|uutis[aä]t)(?![\\p{L}\\p{N}])", // fi
    "(?<![\\p{L}\\p{N}])(wiadomo[sś]ci|aktualno[sś]ci)(?![\\p{L}\\p{N}])", // pl
    "(?<![\\p{L}\\p{N}])(haber|notic[ií]as|actualidad)(?![\\p{L}\\p{N}])", // tr/es
    "(ニュース|報道|chwita|뉴스|보도|新闻|新聞|消息|资讯|новост|أخبار)",          // ja/ko/zh/ru/ar
  ].join("|"),
  "iu",
);

export function classifyVertical(query: string): Vertical {
  const q = query ?? "";
  if (WEATHER_RE.test(q)) return "weather";
  if (MARKETS_RE.test(q)) return "markets";
  // "1 USD in EUR", "USD to INR" — a currency PAIR is a market question even
  // without the word "rate". Dropping this rule sent currency questions to the
  // general web floor, so the rate had to be narrated from memory.
  if (namesCurrencyPair(q)) return "markets";
  if (FLIGHT_RE.test(q)) return "travel";
  if (SPORTS_RE.test(q)) return "sports";
  if (ELECTION_RE.test(q)) return "election";
  if (/\bvs\.?\b|\bagainst\b/i.test(q) && SCORE_RE.test(q)) return "sports";
  if (NEWS_RE.test(q)) return "news";
  // MEASURED DEFECT: the vertical keywords above are English-only, so a
  // French "dernieres nouvelles" or a German "Wetterlage" was routed to the
  // general web floor instead of the news/weather feeds. Combined with the
  // freshness fix that made non-English news queries HONESTLY REFUSE (no
  // general-web source carried a recent date) instead of reaching the feed
  // that can answer them. Only the two verticals actually observed failing
  // live are added here; the rest is Phase 4 global-intent work and is not
  // guessed at.
  if (WEATHER_MULTILINGUAL_RE.test(q)) return "weather";
  if (NEWS_MULTILINGUAL_RE.test(q)) return "news";
  return "general";
}

// --- The classifier ---------------------------------------------------------

/**
 * The query to actually SEND to a search engine.
 *
 * Found by running the real pipeline: Omi was forwarding the user's raw
 * question verbatim ("What is India's medal tally in Asian Games 2026?").
 * Measured side by side:
 *
 *   "Indian contingent medals tally in Asian Games 2026"  -> 4 results
 *   "What is India's medal tally in Asian Games 2026?"     -> 0 results, 12s
 *
 * Search indexes are keyword corpora, not conversational agents. The
 * interrogative frame ("what is", "who is", "tell me") and the trailing "?"
 * are noise to them, and on a busy instance they are the difference between a
 * result set and a timeout. This is very likely a large part of why users saw
 * irrelevant information: the query was malformed before it ever left Omi.
 *
 * The ORIGINAL question is still what gets validated and synthesized — only
 * the retrieval string is cleaned.
 */
export function retrievalQuery(raw: string): string {
  const cleaned = (raw ?? "")
    .trim()
    // Leading command/politeness frame.
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:(?:tell me|give me|show me)\s+(?:about\s+)?)?(?:research|investigate|find(?: out)?|look up|search(?: for)?|give me|show me|tell me|what(?:'s| is| are| was| were)|who(?:'s| is| are| was| were)|when(?:'s| is| was| did)|where(?:'s| is| was)|how (?:much|many|is|are|do|does|did)|which|why)\s+/i, "")
    .replace(/^(?:the\s+)?(?:current|latest|recent|present)\s+/i, "")
    // Leading article left behind by stripping the question frame ("What is
    // THE Indian…"), which measurably changes what the indexes return.
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s*\?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // Never return something empty or degenerate — a blank query is worse than
  // the original phrasing.
  return cleaned.length >= 3 ? cleaned : (raw ?? "").trim();
}

/**
 * Classify a question for current-information handling. `now` is injectable
 * so year-relative logic is deterministic in tests.
 */
export function classifyCurrentIntent(query: string, intent?: string, now = Date.now()): CurrentIntent {
  const q = query ?? "";
  const currentYear = new Date(now).getUTCFullYear();
  const reasons: string[] = [];

  const years = extractYears(q, currentYear);
  const event = extractEvent(q);
  const vertical = classifyVertical(q);
  const liveData = detectLiveKind(q);

  const explicit =
    EXPLICIT_FRESH_RE.test(q) || EXPLICIT_FRESH_MULTILINGUAL_RE.test(q);
  if (explicit) reasons.push("explicit freshness wording");

  if (intent === "current" || intent === "news") {
    reasons.push(`decision engine classified the query as "${intent}"`);
  }

  // A year at or beyond the current year means the user is asking about the
  // present, whatever verb they used. This is the signal the old detector
  // lacked entirely, and it is what made "Asian Games 2026" look historical.
  const currentYearNamed = years.some((y) => y >= currentYear);
  if (currentYearNamed) reasons.push(`names the current year (${currentYear})`);

  // Live data nouns imply freshness with no time word at all.
  const liveNoun = LIVE_NOUN_RE.test(q);
  if (liveNoun) reasons.push(`asks for a live value ("${liveData ?? "live data"}")`);

  // A past year plus past framing means history — model knowledge is correct
  // and a live search would only be slower.
  const pastYearNamed = years.length > 0 && !currentYearNamed;
  const historicalFraming = HISTORICAL_RE.test(q);
  const historical = pastYearNamed && historicalFraming && !explicit;
  if (historical) reasons.push("asks about a past year — history, not a live feed");

  let requiresFreshness: boolean;
  if (historical) {
    requiresFreshness = false;
  } else if (explicit || currentYearNamed || liveNoun || intent === "current" || intent === "news") {
    requiresFreshness = true;
  } else {
    // "What is happening…", "as of", "the last 3 hours" — current with no
    // time word and no live noun.
    requiresFreshness =
      /\bwhat(?:'s| is| was)?\s+(?:happen(?:ing|ed)?|going on|new)\b/i.test(q) ||
      /\b(?:as of|since|updated|update)\b/i.test(q) ||
      /\b(?:last|past|previous)\s+(\d{1,3})?\s*(minute|min|hour|hr|day|week)s?\b/i.test(q) ||
      /\bthese days\b|\bright now\b|\bat the moment\b/i.test(q);
    if (requiresFreshness) reasons.push("asks about the current situation");
  }

  return {
    requiresFreshness,
    vertical,
    freshnessTier: tierFor(q, vertical, requiresFreshness),
    liveData,
    years,
    event,
    eventScoped: years.length > 0 || event !== null,
    reasons,
    historical,
  };
}

/**
 * Which freshness tier applies.
 *
 * A structured feed (weather, a currency rate) reports its own read time and
 * is "live" by construction, so it must not be judged against a web-article
 * window. Everything else is judged by how tight the user's own wording was.
 */
function tierFor(q: string, vertical: Vertical, requiresFreshness: boolean): FreshnessTier {
  if (!requiresFreshness) return "none";
  if (vertical === "weather" || vertical === "markets") return "live-feed";
  if (NOW_TIER_RE.test(q)) return "now";
  if (RECENT_TIER_RE.test(q)) return "recent";
  // Non-English recency wording. Without this, a user asking for "les
  // dernieres nouvelles" or "今日の最新ニュース" fell through to `none` and
  // lost its freshness requirement entirely.
  if (NOW_TIER_MULTILINGUAL_RE.test(q)) return "now";
  if (RECENT_TIER_MULTILINGUAL_RE.test(q)) return "recent";
  // Inherently-live nouns (a medal tally, standings) with no time word still
  // want a recent answer, not a fortnight-old one.
  if (LIVE_NOUN_RE.test(q)) return "recent";
  return "recent";
}
