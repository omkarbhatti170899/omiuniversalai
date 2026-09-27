/**
 * REGRESSION — OFF-TOPIC SOURCES MUST NOT SURVIVE A FRESHNESS GATE.
 * =========================================================================
 *
 * Found by the post-enablement live run of the LangSearch work, and it is the
 * more serious of the two defects from that run: enabling the provider turned
 * a hard refusal into a real answer, but 2 of the 4 kept citations for
 * "Indian contingent medals tally in Asian Games 2026" were
 *
 *   - "Sri Lanka Maldives Twin Centre Holiday Package 2026/2027"
 *   - "RECPDCL Signs MoA with ICAR for Rooftop Solarisation of 76 Institutes"
 *
 * Both were FRESH and both were irrelevant. They survived because:
 *
 *   1. The ranker weights freshness 0.40 against relevance 0.28 on a `now`-tier
 *      question, so a fresh page on the wrong subject outranks a relevant older
 *      one. That weighting is deliberate and correct — answering with
 *      yesterday's number is *wrong*, not merely worse — so the fix is not to
 *      rebalance it.
 *   2. Nothing floored relevance. The wrong-YEAR gate was thorough, and the
 *      topical equivalent was simply missing.
 *
 * The principle pinned here: **freshness is evidence of currency, never of
 * subject.** A page about the wrong subject is not a fresher answer to the
 * question, it is a different answer entirely, and no amount of authority or
 * recency makes it evidence.
 *
 * The floor is deliberately the weakest one that fixes the observed defect —
 * zero shared topic words. A stricter threshold was rejected because
 * inflection and paraphrase ("medal"/"medals", "tally"/"medal count") are
 * routine in real headlines, and a threshold tuned on one query silently drops
 * legitimate evidence on the next.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOffTopic, topicKeywords, keywordSet } from "../src/convex/searchEngine/quality";
import type { WebCitation } from "../src/convex/searchProviders/types";

const PROJECT_ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(PROJECT_ROOT, rel), "utf8");

const QUERY = "Indian contingent medals tally in Asian Games 2026";

function cite(title: string, snippet = "", publishedAt = "2026-09-26"): WebCitation {
  return { title, url: "https://example.com/x", snippet, publishedAt };
}

/** The two sources that actually leaked into the live answer. */
const LEAKED = [
  "Sri Lanka Maldives Twin Centre Holiday Package 2026/2027",
  "RECPDCL Signs MoA with ICAR for Rooftop Solarisation of 76 Institutes Across India",
];

/** Sources that genuinely answer the question. */
const LEGITIMATE = [
  "Asian Games 2026: India's medal tally after Day 6, 25th September",
  "Asian Games 2026 Day 7, India Medal Tally, Results & Highlights",
  "Asian Games 2026, Day 7 LIVE: India look to add to medal tally",
  "Asian Games 2026: India's Prachi Choudhary wins bronze in 400m",
];

describe("topicKeywords — a year is a constraint, not a topic", () => {
  it("drops bare numbers, which every page on earth can match", () => {
    const topic = topicKeywords(QUERY);
    expect(topic).not.toContain("2026");
    expect(topic).toContain("asian");
    expect(topic).toContain("games");
    expect(topic).toContain("medals");
  });

  it("keeps the substantive words that keywordSet found", () => {
    // Every topic word must be a real keyword: dropping more than the numbers
    // would silently narrow the floor into over-rejection.
    const kw = keywordSet(QUERY).filter((w) => !/^\d+$/.test(w));
    expect(topicKeywords(QUERY)).toEqual(kw);
  });
});

describe("isOffTopic — the floor that stops a fresh wrong-subject page", () => {
  const topic = topicKeywords(QUERY);

  it("drops BOTH sources that leaked into the live answer", () => {
    for (const title of LEAKED) {
      expect(isOffTopic(cite(title), topic)).toBe(true);
    }
  });

  it("keeps every genuine answer to the question", () => {
    for (const title of LEGITIMATE) {
      expect(isOffTopic(cite(title), topic)).toBe(false);
    }
  });

  it("matches on the SNIPPET, not the title alone", () => {
    // A generically-titled page with a relevant body is still evidence; only
    // title matching would wrongly drop it.
    const c = cite("Sport update", "India's Asian Games medal tally after day six");
    expect(isOffTopic(c, topic)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isOffTopic(cite("ASIAN GAMES 2026 INDIA MEDAL TALLY"), topic)).toBe(false);
  });

  it("does NOT drop a source that shares only the year", () => {
    // Deliberate. A page mentioning "2026" plus one topic word is plausible
    // evidence; the floor targets total non-overlap, not weak overlap.
    const c = cite("Asian Games 2026 preview");
    expect(isOffTopic(c, topic)).toBe(false);
  });

  it("is a no-op when the question has no topic words", () => {
    // A question we cannot characterise is not evidence that a source is
    // off-topic. Dropping everything here would empty every search.
    expect(topicKeywords("2026")).toEqual([]);
    expect(isOffTopic(cite("Anything at all"), [])).toBe(false);
  });

  it("handles a citation with no snippet", () => {
    expect(isOffTopic({ title: "Holiday package", url: "https://e.com", publishedAt: "2026-09-26" }, topic)).toBe(true);
    expect(isOffTopic({ title: "India Asian Games medal tally", url: "https://e.com", publishedAt: "2026-09-26" }, topic)).toBe(false);
  });
});

describe("the floor is applied on the chat path AND the diagnostic", () => {
  it("both surfaces actually CALL the floor, not merely import it", () => {
    // The two disagreed once already in the other direction: the diagnostic
    // judged a 3-day-old set "answer" while the turn flagged it. If only one
    // surface applies the floor, the trace stops describing production.
    //
    // Asserting the CALL and not just the import matters: a mutation that
    // replaces `!isOffTopic(c, topic) &&` with `true &&` leaves the import in
    // place, so an import-only check passes while the product is unprotected.
    for (const f of ["src/convex/omiChat.ts", "src/convex/searchDebug.ts"]) {
      const src = read(f);
      expect(src).toContain("topicKeywords");
      expect(src).toMatch(/!isOffTopic\(\s*c\s*,\s*topic\s*\)/);
    }
  });

  it("the chat path matches on the USER's words, not the rewritten query", () => {
    // The rewriter appends recency words ("today", "latest") that describe
    // WHEN, not WHAT. Matching on those would let any fresh page through —
    // reintroducing the exact defect in a subtler form.
    const src = read("src/convex/omiChat.ts");
    expect(src).toMatch(/topicKeywords\(\s*trimmed\s*\)/);
    expect(src).not.toMatch(/topicKeywords\(\s*retrieval\s*\)/);
  });
});
