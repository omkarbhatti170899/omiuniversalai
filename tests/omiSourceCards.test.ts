/**
 * §8 SOURCE UI — the rule is that a user must be able to judge how fresh a
 * source is, and must never be shown a link that was invented for a citation
 * marker the answer never gave a URL for.
 */
import { describe, expect, it } from "bun:test";
import { hostOf, sourceAgeLabel } from "@/components/answer/SourceCards";
import { urlForMarker } from "@/components/answer/AnswerRenderer";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("source cards — publisher and link", () => {
  it("derives a clean host from a URL", () => {
    expect(hostOf("https://www.reuters.com/world/story")).toBe("reuters.com");
    expect(hostOf("https://news.bbc.co.uk/x")).toBe("news.bbc.co.uk");
  });

  it("never throws on a malformed URL", () => {
    expect(hostOf("not a url")).toBe("unknown source");
    expect(hostOf("")).toBe("unknown source");
  });
});

describe("source cards — published/updated time is shown honestly", () => {
  it("labels a recent source in human terms", () => {
    expect(sourceAgeLabel("2026-09-26T11:59:30Z", NOW)).toBe("just now");
    expect(sourceAgeLabel("2026-09-26T11:45:00Z", NOW)).toBe("15 min ago");
    expect(sourceAgeLabel("2026-09-26T11:00:00Z", NOW)).toBe("an hour ago");
    expect(sourceAgeLabel("2026-09-26T06:00:00Z", NOW)).toBe("6 hours ago");
    expect(sourceAgeLabel("2026-09-25T12:00:00Z", NOW)).toBe("yesterday");
    expect(sourceAgeLabel("2026-09-20T12:00:00Z", NOW)).toBe("6 days ago");
    expect(sourceAgeLabel("2026-06-26T12:00:00Z", NOW)).toBe("3 months ago");
    expect(sourceAgeLabel("2024-09-26T12:00:00Z", NOW)).toBe("over a year ago");
  });

  it("returns null for a missing or unparseable date — never a guess", () => {
    expect(sourceAgeLabel(undefined, NOW)).toBeNull();
    expect(sourceAgeLabel(null, NOW)).toBeNull();
    expect(sourceAgeLabel("", NOW)).toBeNull();
    expect(sourceAgeLabel("sometime last week", NOW)).toBeNull();
  });

  it("does not report a far-future date as fresh (clock skew is not freshness)", () => {
    // Two days ahead is not "just now", and not "very fresh" either — it is an
    // unusable timestamp, so the card must fall back to the honest undated state.
    expect(sourceAgeLabel("2026-09-28T12:00:00Z", NOW)).toBeNull();
    expect(sourceAgeLabel("2027-01-01T00:00:00Z", NOW)).toBeNull();
  });

  it("tolerates small forward offsets as ordinary timezone skew", () => {
    // Up to 6h ahead is a real timestamp from another timezone, not junk.
    expect(sourceAgeLabel(new Date(NOW + 3 * HOUR).toISOString(), NOW)).toBe("just now");
  });

  it("treats a date just under the boundary as the nearer label", () => {
    expect(sourceAgeLabel(new Date(NOW - 90 * MINUTE).toISOString(), NOW)).toBe("an hour ago");
    expect(sourceAgeLabel(new Date(NOW - 30 * MINUTE).toISOString(), NOW)).toBe("30 min ago");
    expect(sourceAgeLabel(new Date(NOW - 36 * HOUR).toISOString(), NOW)).toBe("yesterday");
  });
});

describe("source cards — a marker never gets a link the answer did not give it", () => {
  const answer = `Rain fell in Mumbai today [1] and Delhi stayed dry [2].

[1] https://www.reuters.com/world/story-1
[2] https://www.bbc.co.uk/news/story-2`;

  it("finds the URL belonging to each marker", () => {
    expect(urlForMarker(answer, 1)).toBe("https://www.reuters.com/world/story-1");
    expect(urlForMarker(answer, 2)).toBe("https://www.bbc.co.uk/news/story-2");
  });

  it("does not hand one marker's link to another marker", () => {
    // [2] appears in the body before its own definition; the link after the
    // FIRST [2] belongs to [2], not to [1].
    expect(urlForMarker(answer, 1)).not.toContain("bbc.co.uk");
    expect(urlForMarker(answer, 2)).toContain("bbc.co.uk");
  });

  it("returns null for a marker with no URL anywhere after it", () => {
    expect(urlForMarker("Something happened [1] with no link at all.", 1)).toBeNull();
  });

  it("returns null for a marker that does not exist", () => {
    expect(urlForMarker(answer, 9)).toBeNull();
  });

  it("does not swallow trailing punctuation into the link", () => {
    const t = "Report [1] — see https://example.com/story.";
    expect(urlForMarker(t, 1)).toBe("https://example.com/story");
  });
});
