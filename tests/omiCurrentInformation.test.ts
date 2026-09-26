/**
 * CURRENT-INFORMATION CONTRACT — regression tests for the priority bug
 * "current/live information is not working reliably".
 *
 * The behaviours pinned here are the ones a user would notice breaking:
 * freshness intent detection, vertical routing, timestamp handling, and above
 * all the rule that Omi must never answer a current question from model
 * memory, and must never let a NEWS page stand in for real weather, a real
 * exchange rate or a real scoreline.
 */
import { describe, expect, it } from "bun:test";

import {
  ageInDays,
  clarifyForMissingInput,
  detectVertical,
  formatSourceLine,
  freshnessInstruction,
  freshnessPolicyFor,
  freshnessStatement,
  isFreshEnough,
  missingInputFor,
  noVerificationMessage,
  relativeAge,
  requiresFreshness,
  splitByFreshness,
  timeRangeFor,
} from "../src/convex/searchEngine/freshness";
import {
  isOpenEndedEventsQuestion,
  canUseEventsFrontPage,
  parseCurrentEvents,
  portalPublishedAt,
  portalTitle,
  rankEvents,
} from "../src/convex/searchProviders/wikipediaCurrentEvents";
import {
  isResolvableRateQuery,
  pairFromQuery,
  composeRateCitation,
} from "../src/convex/searchProviders/markets";
import { isNewsQuery, mapArticleToCitation } from "../src/convex/searchProviders/gdelt";
import { composeWeatherCitation } from "../src/convex/searchProviders/openmeteo";
import { decideSearch } from "../src/convex/searchEngine/decision";
import { CURRENT_INFO_SCENARIOS } from "../src/convex/omiSelfTest";

const NOW = Date.parse("2026-09-26T12:00:00Z");

// --- 1. The 10 exact scenarios from the bug report --------------------------

describe("current info — the 10 reported scenarios all request freshness", () => {
  it("the scenario list is exactly the 10 reported questions", () => {
    expect(CURRENT_INFO_SCENARIOS).toHaveLength(10);
    expect(CURRENT_INFO_SCENARIOS.map((s) => s.query)).toEqual([
      "What is the latest news in India?",
      "What happened in the world today?",
      "What is happening right now?",
      "Latest technology news",
      "Latest AI news",
      "Today's weather",
      "Current USD/INR rate",
      "Live sports score",
      "Latest announcements",
      "News from the last hour",
    ]);
  });

  for (const { query } of CURRENT_INFO_SCENARIOS) {
    it(`"${query}" routes to a live, dated source`, () => {
      const decision = decideSearch(query);
      const policy = freshnessPolicyFor(query, decision.intent);
      expect(`${query} needsSearch`).toBe(
        `${query} ${decision.needsSearch === true ? "needsSearch" : "NO SEARCH"}`,
      );
      expect(policy.requiresFreshness).toBe(true);
      // A current question must never be served from a stale cache.
      expect(decision.skipCache || policy.requiresFreshness).toBe(true);
    });
  }
});

describe("current info — natural-language intent, not just keywords", () => {
  it("detects current intent with no time word at all", () => {
    for (const q of [
      "What is happening in India?",
      "What's happening?",
      "What happened in the world today?",
      "What is going on with the election?",
    ]) {
      expect(`${q} → ${requiresFreshness(q)}`).toContain("true");
    }
  });

  it("does not treat an ordinary knowledge question as time-sensitive", () => {
    for (const q of [
      "What is the capital of France?",
      "Who invented the telephone?",
      "Explain recursion",
      "What is the difference between a mutex and a semaphore?",
    ]) {
      expect(`${q} → ${requiresFreshness(q)}`).toContain("false");
    }
  });

  it("trusts the decision engine's own classification", () => {
    expect(requiresFreshness("give me a summary", "current")).toBe(true);
    expect(requiresFreshness("give me a summary", "news")).toBe(true);
  });

  it("narrows the window when the user names one", () => {
    expect(timeRangeFor("News from the last hour")).toBe("hour");
    expect(timeRangeFor("news from the last 3 hours")).toBe("day");
    expect(timeRangeFor("news from the last 30 minutes")).toBe("hour");
    expect(timeRangeFor("news from the last 2 days")).toBe("week");
    expect(timeRangeFor("anything", "news")).toBe("week");
  });
});

// --- 6. LIVE vs CURRENT: vertical routing -----------------------------------

describe("current info — a question is routed to the source that can actually answer it", () => {
  it("classifies each vertical", () => {
    expect(detectVertical("What's the weather in Paris?")).toBe("weather");
    expect(detectVertical("current USD to INR rate")).toBe("markets");
    expect(detectVertical("live sports score for the match")).toBe("sports");
    expect(detectVertical("latest news in India")).toBe("news");
    expect(detectVertical("what is a mutex")).toBe("general");
  });

  it("weather routes ONLY to a weather source", () => {
    const p = freshnessPolicyFor("Today's weather in Mumbai", "current");
    expect(p.vertical).toBe("weather");
    // A news page is not a thermometer.
    expect(p.preferredProviders).toContain("openmeteo");
    expect(p.preferredProviders).not.toContain("wikipedia-current-events");
  });

  it("markets routes to a real rate source", () => {
    const p = freshnessPolicyFor("Current USD/INR rate", "current");
    expect(p.vertical).toBe("markets");
    expect(p.preferredProviders).toContain("market-rates");
  });

  it("news routes to genuinely dated news sources", () => {
    const p = freshnessPolicyFor("What happened in the world today?", "news");
    expect(p.vertical).toBe("news");
    expect(p.preferredProviders).toContain("wikipedia-current-events");
    expect(p.preferredProviders).toContain("gdelt");
  });

  it("marks a market question as requiring fresher data than a general one", () => {
    expect(freshnessPolicyFor("Current USD/INR rate", "current").maxAgeDays).toBe(7);
    expect(freshnessPolicyFor("What happened today?", "news").maxAgeDays).toBe(14);
    // "last hour" is a hard window.
    expect(freshnessPolicyFor("News from the last hour", "current").maxAgeDays).toBe(1);
  });

  it("a non-current question has no freshness requirement at all", () => {
    const p = freshnessPolicyFor("What is the capital of France?");
    expect(p.requiresFreshness).toBe(false);
    expect(p.timeRange).toBeUndefined();
  });
});

// --- 5. Timestamps ----------------------------------------------------------

describe("current info — timestamps decide what counts as evidence", () => {
  const fresh = { title: "A", url: "https://a.example/x", publishedAt: "2026-09-26T08:00:00Z" };
  const old = { title: "B", url: "https://b.example/x", publishedAt: "2026-06-01T08:00:00Z" };
  const undated = { title: "C", url: "https://c.example/x" };

  it("computes age in days", () => {
    expect(ageInDays("2026-09-25T12:00:00Z", NOW)).toBeCloseTo(1, 1);
    expect(ageInDays(undefined, NOW)).toBeNull();
    expect(ageInDays("not a date", NOW)).toBeNull();
  });

  it("treats an UNDATED result as not fresh — the key rule", () => {
    expect(isFreshEnough(fresh, 7, NOW)).toBe(true);
    expect(isFreshEnough(old, 7, NOW)).toBe(false);
    expect(ageInDays(undated.publishedAt, NOW)).toBeNull();
    expect(isFreshEnough(undated, 3650, NOW)).toBe(false);
  });

  it("splits results into fresh, undated and stale without losing any", () => {
    const s = splitByFreshness([fresh, old, undated], 7, NOW);
    expect(s.fresh).toEqual([fresh]);
    expect(s.undated).toEqual([undated]);
    expect(s.stale).toEqual([old]);
    expect(s.fresh.length + s.undated.length + s.stale.length).toBe(3);
  });

  it("describes relative age honestly, including when it is unknown", () => {
    expect(relativeAge("2026-09-26T11:30:00Z", NOW)).toBe("just now");
    expect(relativeAge("2026-09-26T06:00:00Z", NOW)).toBe("6 hours ago");
    expect(relativeAge("2026-09-25T12:00:00Z", NOW)).toBe("yesterday");
    expect(relativeAge(undefined, NOW)).toMatch(/not shown/i);
  });

  it("leads with a freshness statement naming the window and the newest item", () => {
    const s = freshnessStatement([fresh], 14, NOW);
    expect(s).toContain("1 report");
    expect(s).toContain("today");
    expect(s).toContain("4 hours ago");
  });

  it("says today when everything is from today, and the window otherwise", () => {
    expect(freshnessStatement([fresh], 14, NOW)).toContain("today");
    const week = freshnessStatement(
      [{ title: "A", url: "https://a.example", publishedAt: "2026-09-22T08:00:00Z" }],
      14,
      NOW,
    );
    expect(week).toContain("last 14 days");
  });

  it("returns null when nothing is fresh — the caller must then refuse", () => {
    expect(freshnessStatement([old, undated], 7, NOW)).toBeNull();
  });

  it("discloses that some results carried no date", () => {
    const s = freshnessStatement([fresh, undated], 14, NOW);
    expect(s).toMatch(/did not show a publish date/);
  });

  it("formats a source line with its domain and its date", () => {
    const line = formatSourceLine(
      { title: "Storm warning", url: "https://www.reuters.com/world/story", publishedAt: "2026-09-26T09:00:00Z" },
      3,
      NOW,
    );
    expect(line).toContain("[3]");
    expect(line).toContain("reuters.com");
    expect(line).toMatch(/published: 3 hours ago/);
  });

  it("an undated source line says so rather than implying freshness", () => {
    const line = formatSourceLine({ title: "X", url: "https://x.example" }, 1, NOW);
    expect(line).toMatch(/published: date not shown by the source/);
  });
});

// --- 7. Failure behaviour ---------------------------------------------------

describe("current info — Omi refuses rather than answering from memory", () => {
  it("states the limitation and offers a real next step", () => {
    const m = noVerificationMessage("latest news", "news");
    expect(m).toMatch(/can't reliably verify/);
    expect(m).toMatch(/not going to answer this from memory/);
    expect(m).toMatch(/Retry Search/);
  });

  it("never names a vertical it cannot serve", () => {
    expect(noVerificationMessage("weather", "weather")).toMatch(/which city|location/i);
    expect(noVerificationMessage("rate", "markets")).toMatch(/currency pair|USD to INR/i);
    expect(noVerificationMessage("score", "sports")).toMatch(/no live score feed/i);
  });

  it("asks for a location instead of guessing one", () => {
    expect(missingInputFor("What's the weather today?", "weather")).toBe("location");
    expect(missingInputFor("What's the weather in Mumbai?", "weather")).toBeNull();
    const q = clarifyForMissingInput("What's the weather today?", "weather");
    expect(q).toMatch(/which location/i);
    expect(q).toMatch(/Mumbai/);
  });

  it("asks for a currency pair instead of guessing a rate", () => {
    expect(missingInputFor("current exchange rate", "markets")).toBe("currency-pair");
    expect(missingInputFor("Current USD/INR rate", "markets")).toBeNull();
    expect(clarifyForMissingInput("current exchange rate", "markets")).toMatch(/which currency pair/i);
  });

  it("needs no clarification for a normal news question", () => {
    expect(missingInputFor("What happened today?", "news")).toBeNull();
    expect(clarifyForMissingInput("What happened today?", "news")).toBeNull();
  });

  it("tells the model the freshness rules for this turn", () => {
    const p = freshnessPolicyFor("what happened today", "news");
    const block = freshnessInstruction(p);
    expect(block).toContain("LIVE NEWS SEARCH");
    expect(block).toMatch(/cite it inline as \[1\]/);
    expect(block).toMatch(/Never estimate or invent a date/);
    expect(block).toMatch(/do NOT fill the gap from your own training data/);
    // It must admit the source class rather than claiming to be a database.
    expect(block).toMatch(/not a real-time news database/);
  });

  it("gives the ordinary instruction for a non-current question", () => {
    const block = freshnessInstruction(freshnessPolicyFor("what is a mutex"));
    // The current-information rules must NOT be applied to a normal question.
    expect(block).not.toMatch(/live results only/i);
    expect(block).not.toMatch(/never estimate or invent a date/i);
    expect(block).toMatch(/cite them inline/i);
  });
});

// --- Wikipedia Current Events provider -------------------------------------

describe("current info — the current-events provider is scoped honestly", () => {
  const WIKI = `{{Current events|year=2026}}
'''Disasters and accidents'''
*Four sailors are missing after a fire aboard the [[Russian Far East|Russian]] fishing vessel. [https://www.reuters.com/world/story-123 (Reuters)]
'''Politics'''
*Leaders meet in [[Delhi]] for talks. [https://www.france24.com/en/story (France 24)]
'''Disasters and accidents'''
*Short one.`;

  it("parses sections, text and the original source link", () => {
    const events = parseCurrentEvents(WIKI);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].section).toBe("Disasters and accidents");
    expect(events[0].url).toBe("https://www.reuters.com/world/story-123");
    expect(events[0].source).toBe("Reuters");
    expect(events[0].text).toContain("Four sailors are missing");
    // The wiki-link is reduced to display text, not left as markup.
    expect(events[0].text).not.toContain("[[");
    expect(events[1].section).toBe("Politics");
  });

  it("drops fragments that are not real events", () => {
    const events = parseCurrentEvents(WIKI);
    expect(events.some((e) => e.text === "Short one.")).toBe(false);
  });

  it("builds a dated portal title and a midnight-UTC publish time", () => {
    const d = new Date("2026-09-26T13:00:00Z");
    expect(portalTitle(d)).toBe("Portal:Current events/2026 September 26");
    expect(portalPublishedAt(d)).toBe("2026-09-26T00:00:00.000Z");
  });

  it("may answer an open-ended news question from the day's front page", () => {
    expect(canUseEventsFrontPage("What happened in the world today?")).toBe(true);
    expect(canUseEventsFrontPage("Latest announcements")).toBe(true);
    expect(canUseEventsFrontPage("Latest AI news")).toBe(true);
    expect(isOpenEndedEventsQuestion("what's new")).toBe(true);
  });

  it("REFUSES to answer weather, rate or score questions from a news page", () => {
    // This is the "ordinary web search pretending to be real-time data" rule.
    for (const q of [
      "Today's weather",
      "Current USD/INR rate",
      "Live sports score",
      "What is the weather in Mumbai?",
      "Bitcoin price right now",
      "What is the exchange rate for GBP to EUR?",
    ]) {
      expect(`${q} → ${canUseEventsFrontPage(q)}`).toContain("false");
    }
  });

  it("ranks a topical event above the front page for a specific question", () => {
    const events = parseCurrentEvents(WIKI);
    const picked = rankEvents(events, "Delhi talks", 3);
    expect(picked[0].text).toContain("Delhi");
  });

  it("returns nothing for a specific question it cannot match", () => {
    const events = parseCurrentEvents(WIKI);
    // A weather question must not be answered with a fire at sea.
    expect(rankEvents(events, "will it rain in Paris tomorrow", 3)).toEqual([]);
  });

  it("falls back to the front page only for an open question", () => {
    const events = parseCurrentEvents(WIKI);
    expect(rankEvents(events, "what happened today", 3).length).toBeGreaterThan(0);
  });
});

// --- Market rates provider -------------------------------------------------

describe("current info — the rate provider quotes a real rate or nothing", () => {
  it("only fires on a genuine two-currency rate question", () => {
    expect(isResolvableRateQuery("Current USD/INR rate")).toBe(true);
    expect(isResolvableRateQuery("what is the exchange rate from GBP to EUR")).toBe(true);
    // One currency, or not a rate question at all.
    expect(isResolvableRateQuery("what is a USD")).toBe(false);
    expect(isResolvableRateQuery("latest news")).toBe(false);
  });

  it("extracts the pair in the order asked", () => {
    expect(pairFromQuery("Current USD/INR rate")).toEqual(["USD", "INR"]);
    expect(pairFromQuery("1 GBP in EUR")).toEqual(["GBP", "EUR"]);
    expect(pairFromQuery("what about USD")).toBeNull();
  });

  it("composes a citation carrying the provider's own update time", () => {
    const c = composeRateCitation("USD", "INR", {
      base_code: "USD",
      rates: { INR: 95.9187 },
      time_last_update_utc: "Sat, 26 Sep 2026 00:02:32 +0000",
    });
    expect(c).not.toBeNull();
    expect(c!.title).toBe("1 USD = 95.9187 INR");
    expect(c!.publishedAt).toBe("2026-09-26T00:02:32.000Z");
    expect(c!.snippet).toMatch(/not financial advice/);
    // A rate with no update time is still usable, but says so.
    expect(c!.publishedAt.length).toBeGreaterThan(0);
  });

  it("returns null when the provider has no such rate", () => {
    expect(composeRateCitation("USD", "INR", { rates: {} })).toBeNull();
    expect(composeRateCitation("USD", "INR", {})).toBeNull();
  });
});

// --- GDELT provider --------------------------------------------------------

describe("current info — GDELT still scopes itself to news and keeps timestamps", () => {
  it("only fires on news phrasing", () => {
    expect(isNewsQuery("latest news in India")).toBe(true);
    expect(isNewsQuery("what happened today")).toBe(true);
    expect(isNewsQuery("what is happening right now")).toBe(true);
    expect(isNewsQuery("explain recursion")).toBe(false);
  });

  it("converts the GDELT seen-date into a real ISO timestamp", () => {
    const c = mapArticleToCitation({
      url: "https://example.com/a",
      title: "Something happened",
      seendate: "20260926T081500Z",
      domain: "example.com",
    });
    expect(c?.publishedAt).toBe("2026-09-26T08:15:00Z");
    // And it must be parseable as a real date, not a string that looks like one.
    expect(Number.isFinite(Date.parse(c!.publishedAt!))).toBe(true);
    expect(ageInDays(c!.publishedAt, Date.parse("2026-09-26T12:00:00Z"))).toBeCloseTo(0.15, 1);
  });

  it("rejects a row with no url or title rather than emitting a broken citation", () => {
    expect(mapArticleToCitation({ title: "no url" })).toBeNull();
    expect(mapArticleToCitation({ url: "https://x.example" })).toBeNull();
  });

  it("leaves publishedAt undefined when GDELT gives no date — it is never faked", () => {
    const c = mapArticleToCitation({ url: "https://x.example", title: "T" });
    expect(c?.publishedAt).toBeUndefined();
  });
});

// --- Open-Meteo provider ----------------------------------------------------

describe("current info — a live weather observation carries its retrieval time", () => {
  it("stamps the observation, so the freshness gate does not discard it", () => {
    const c = composeWeatherCitation(
      { name: "Mumbai", country: "India", latitude: 19.07, longitude: 72.87 },
      { current: { temperature_2m: 28.4, weather_code: 2, wind_speed_10m: 14 } },
      NOW,
    );
    expect(c).not.toBeNull();
    expect(c!.publishedAt).toBe("2026-09-26T12:00:00.000Z");
    expect(c!.title).toContain("Mumbai");
    // And it therefore passes the freshness gate.
    expect(isFreshEnough(c!, 1, NOW)).toBe(true);
  });

  it("returns null rather than inventing weather it did not receive", () => {
    expect(composeWeatherCitation({ name: "X" }, { current: { temperature_2m: 20 } }, NOW)).toBeNull();
    expect(composeWeatherCitation({ name: "X", latitude: 1, longitude: 2 }, {}, NOW)).toBeNull();
  });
});
