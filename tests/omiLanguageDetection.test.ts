/**
 * PHASE 3 (minimal step) — QUERY LANGUAGE DETECTION.
 * =============================================================================
 * Pins the detector's contract: scripts win immediately, Latin-script
 * languages need ≥2 distinctive words, borrowed single words never flip the
 * locale, and everything unknown fails safe to the English default (today's
 * behaviour, byte-for-byte).
 */

import { describe, expect, test } from "bun:test";
import { detectQueryLanguage, providerLocaleFor } from "../src/convex/searchEngine/language";

describe("query language detection", () => {
  test("non-Latin scripts are detected unambiguously", () => {
    expect(detectQueryLanguage("日本の最新ニュース").code).toBe("ja");
    expect(detectQueryLanguage("آخر الأخبار").code).toBe("ar");
    expect(detectQueryLanguage("नवीनतम समाचार").code).toBe("hi");
    expect(detectQueryLanguage("최신 뉴스").code).toBe("ko");
    expect(detectQueryLanguage("актуальные новости").code).toBe("ru");
  });

  test("Latin-script languages need TWO distinctive words — one borrowed word never flips", () => {
    expect(detectQueryLanguage("dernières nouvelles France").code).toBe("fr");
    expect(detectQueryLanguage("aktuelle Nachrichten Deutschland").code).toBe("de");
    expect(detectQueryLanguage("últimas noticias España").code).toBe("es");
    expect(detectQueryLanguage("ultime notizie Italia").code).toBe("it");
    // Single borrowed token: stays English (the déjà vu / piñata rule).
    expect(detectQueryLanguage("a story with déjà vu vibes").code).toBe("en");
    expect(detectQueryLanguage("what is a fiesta").code).toBe("en");
  });

  test("English and unknown input fail safe to the default", () => {
    expect(detectQueryLanguage("latest India cricket score").via).toBe("default");
    expect(providerLocaleFor("latest India cricket score")).toBeUndefined();
    expect(detectQueryLanguage("").code).toBe("en");
    expect(detectQueryLanguage("??? 123").code).toBe("en");
  });

  test("providerLocaleFor maps detected languages to locale codes, default → undefined", () => {
    expect(providerLocaleFor("dernières nouvelles France")).toBe("fr");
    expect(providerLocaleFor("日本の最新ニュース")).toBe("ja");
    expect(providerLocaleFor("plain english query")).toBeUndefined();
  });
});
