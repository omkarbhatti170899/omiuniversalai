/**
 * REGRESSION — MULTILINGUAL FRESHNESS + OVER-EAGER CLARIFICATION.
 * =========================================================================
 *
 * Both defects were found by an ADVERSARIAL live stress run
 * (scripts/searchStress.ts) against the deployed build, not by the happy-path
 * suite. They are recorded here because the happy path passed throughout.
 *
 * DEFECT 1 — a non-English recency question lost its freshness requirement.
 *   Live: "Quelles sont les dernières nouvelles en France?" returned
 *   intent=knowledge, requiresFreshness=FALSE, and five sources of unknown
 *   age were treated as evidence. The consequences are silent and severe:
 *   no freshness gate, no escalation pass, no "Current as of" timestamp, and
 *   a months-old page could be presented as today's news. The user's
 *   LANGUAGE decided whether their data was treated as stale.
 *
 * DEFECT 2 — a nonsense clarifying question blocked answerable questions.
 *   Live: "What is the current market cap of Apple?" and "Current gold price
 *   in Tokyo?" were both answered with "Which currency pair do you mean?".
 *   The old rule demanded a currency pair from ANY markets query lacking two
 *   ISO codes, so it fired on equity, commodity and index questions. Those
 *   queries returned 0 results purely because Omi asked instead of searching.
 */

import { describe, expect, it } from "bun:test";
import { classifyCurrentIntent } from "../src/convex/searchEngine/intent";
import { decideSearch } from "../src/convex/searchEngine/decision";
import { freshnessPolicyFor, clarifyForMissingInput } from "../src/convex/searchEngine/freshness";

const NOW = Date.parse("2026-09-27T12:00:00Z");

function policyFor(q: string) {
  return freshnessPolicyFor(q, decideSearch(q).intent);
}

describe("regression — recency is detected in every language served", () => {
  const MULTILINGUAL_RECENCY: Array<[string, string]> = [
    // French
    ["Quelles sont les dernières nouvelles en France?", "recent"],
    ["Quel est le prix de l'or aujourd'hui ?", "now"],
    ["Taux de change actuel", "recent"],
    // German. A WEATHER question is a live-feed vertical, so it resolves to
    // "live-feed" rather than the article tier — that is the intended
    // difference between a forecast and a news article, not a miss.
    ["Was ist die aktuelle Wetterlage in Berlin?", "live-feed"],
    ["aktuelle Nachrichten aus Deutschland", "recent"],
    ["Was kostet Gold heute?", "now"],
    // Spanish
    ["¿Cuáles son las últimas noticias de hoy?", "now"],
    ["últimas noticias", "recent"],
    ["precio del oro ahora", "now"],
    // Italian
    ["Quali sono le ultime notizie oggi?", "now"],
    ["notizie recenti", "recent"],
    // Portuguese
    ["quais são as últimas notícias hoje?", "now"],
    // Dutch / Swedish / Danish-Norwegian
    ["laatste nieuws", "recent"],
    ["senaste nyheter", "recent"],
    ["siste nyheter", "recent"],
    // CJK
    ["今日の最新ニュースは何ですか", "now"],
    ["最新ニュース", "recent"],
    ["오늘의 뉴스", "now"],
    ["최신 뉴스", "recent"],
    ["今天的最新消息", "now"],
    ["最新消息", "recent"],
    // Russian / Arabic
    ["последние новости сегодня", "now"],
    ["أحدث الأخبار اليوم", "now"],
  ];

  for (const [q, expectedTier] of MULTILINGUAL_RECENCY) {
    it(`"${q}" demands freshness (tier=${expectedTier})`, () => {
      const c = classifyCurrentIntent(q, undefined, NOW);
      expect(c.requiresFreshness).toBe(true);
      expect(c.freshnessTier).toBe(expectedTier);
    });
  }

  it("every non-English recency question gets a freshness WINDOW, not a fortnight", () => {
    for (const [q] of MULTILINGUAL_RECENCY) {
      const p = policyFor(q);
      expect(p.requiresFreshness).toBe(true);
      expect(p.maxAgeDays).toBeLessThanOrEqual(7);
      // And it must be able to escalate when the evidence is too old.
      expect(p.preferFreshHours).toBeGreaterThan(0);
    }
  });

  it("a timeless non-English question is still NOT dragged into the tier", () => {
    // The fix must not make every foreign query "current".
    for (const q of [
      "Qui a remporté les Jeux olympiques de 2016 ?",
      "Wer gewann 2016 die Olympischen Spiele?",
      "¿Quién ganó los Juegos Olímpicos de 2016?",
    ]) {
      const c = classifyCurrentIntent(q, undefined, NOW);
      expect(c.requiresFreshness).toBe(false);
    }
  });

  it("English behaviour is unchanged by the multilingual addition", () => {
    expect(policyFor("latest news in France").requiresFreshness).toBe(true);
    expect(policyFor("What happened in the world today?").requiresFreshness).toBe(true);
    expect(policyFor("Who won the 2016 Olympics?").requiresFreshness).toBe(false);
  });
});

describe("regression — non-English questions reach the right vertical feed", () => {
  // MEASURED DEFECT: vertical keywords were English-only, so these were routed
  // to the general web floor. Combined with requiresFreshness=true that turned
  // into an honest-but-useless refusal: the general web returned no recent
  // dated source, so Omi refused a question the news feed could have answered.
  const NEWS_CASES = [
    "Quelles sont les dernières nouvelles en France?",
    "¿Cuáles son las últimas noticias de hoy?",
    "Quali sono le ultime notizie oggi?",
    "Was sind die Nachrichten heute?",
    "Wat zijn de laatste nieuws?",
    "Vilka är nyheterna just nu?",
    "quais são as últimas notícias?",
    "今日のニュースは何ですか",
    "오늘의 뉴스",
    "今天的最新消息",
  ];
  for (const q of NEWS_CASES) {
    it(`routes "${q}" to the news vertical`, () => {
      expect(policyFor(q).vertical).toBe("news");
    });
  }

  const WEATHER_CASES = [
    "Was ist die aktuelle Wetterlage in Berlin?",
    "Quel temps fait-il aujourd'hui à Paris?",
    "¿Qué tiempo hace hoy en Madrid?",
    "Che tempo fa oggi a Roma?",
    "Vandaag weer in Amsterdam",
  ];
  for (const q of WEATHER_CASES) {
    it(`routes "${q}" to the weather vertical`, () => {
      expect(policyFor(q).vertical).toBe("weather");
    });
  }

  it("does not over-route: a non-English question with no vertical stays general", () => {
    expect(policyFor("Qui a écrit Hamlet?").vertical).toBe("general");
    expect(policyFor("Was ist Kapitalismus?").vertical).toBe("general");
  });
});

describe("regression — no nonsense clarifying question", () => {
  it("does NOT ask for a currency pair on an equity question", () => {
    expect(clarifyForMissingInput("What is the current market cap of Apple?", "markets")).toBeNull();
    expect(clarifyForMissingInput("What is the market cap of Tesla?", "markets")).toBeNull();
    expect(clarifyForMissingInput(
      "What is the current market cap of Zorblatt Quantum Holdings?",
      "markets",
    )).toBeNull();
  });

  it("does NOT ask for a currency pair on a commodity or index question", () => {
    expect(clarifyForMissingInput("Current gold price in Tokyo?", "markets")).toBeNull();
    expect(clarifyForMissingInput("What is the Nifty 50 doing today?", "markets")).toBeNull();
    expect(clarifyForMissingInput("Current bitcoin price?", "markets")).toBeNull();
  });

  it("STILL asks when the question really is about converting currencies", () => {
    const c = clarifyForMissingInput("What is the current exchange rate?", "markets");
    expect(c).toContain("currency pair");
  });

  it("STILL asks for a location on a location-less weather question", () => {
    expect(clarifyForMissingInput("What is the current temperature?", "weather")).toContain(
      "location",
    );
  });

  it("a real currency pair is never questioned", () => {
    expect(clarifyForMissingInput("Current USD INR rate", "markets")).toBeNull();
    expect(clarifyForMissingInput("1 GBP in EUR", "markets")).toBeNull();
  });
});
