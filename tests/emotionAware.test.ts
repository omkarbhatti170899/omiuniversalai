/**
 * Human Emotions AI — the contract this feature has to keep.
 *
 * The bug being pinned here was not a crash: the emotion engine existed and
 * worked, but nothing in the chat pipeline ever called it, so Omi never adapted
 * to how a message was written. These tests cover the two halves of the fix:
 *
 *   1. the reading itself (the six signal families the product must detect,
 *      urgency, tone, and graceful degradation with no AI provider), and
 *   2. the prompt/block contract that makes chat adapt its TONE without ever
 *      claiming to know how the user feels, and without overriding the
 *      user's actual request.
 *
 * `emotionsEngine` is deliberately dependency-free, so this suite exercises the
 * exact code the Convex runtime runs — no mocks, no network.
 */
import { describe, test, expect } from "bun:test";
import {
  EMOTION_SYSTEM_PROMPT,
  emotionAwarenessBlock,
  emotionFamily,
  heuristicEmotionRead,
  normalizeEmotionRead,
  parseEmotionJson,
  shouldAnalyzeEmotion,
  MIN_AUTO_EMOTION_CHARS,
} from "../src/convex/emotionsEngine";

// Realistic messages, one per required conversational signal.
const SAMPLES = {
  frustration:
    "This is the third time I've contacted you and the deadline is tomorrow. I'm honestly exhausted.",
  sadness:
    "I was really disappointed with the handover. Honestly it left me quite sad about the whole thing.",
  anger: "This is unacceptable and frankly useless. I am furious about how this was handled.",
  excitement:
    "This is amazing — I'm so excited to get started, I can't wait to see what it does!",
  confusion:
    "I'm confused about the setup steps and I don't understand which one I'm supposed to pick.",
  neutral: "Please send me the invoice for August and confirm the delivery address on file.",
};

describe("required conversational signals are detected (offline path)", () => {
  test("frustration", () => {
    const read = heuristicEmotionRead(SAMPLES.frustration);
    expect(read.emotion).toBe("frustration");
    expect(read.sentiment).toBe("negative");
    expect(read.urgency).toBe("medium"); // "deadline" is a time-pressure signal
    expect(read.signalFields).toContain("third time");
  });

  test("sadness", () => {
    const read = heuristicEmotionRead(SAMPLES.sadness);
    expect(read.emotion).toBe("sadness");
    expect(read.sentiment).toBe("negative");
    // A sad message is not urgent — urgency must not be invented.
    expect(read.urgency).toBe("low");
  });

  test("anger", () => {
    const read = heuristicEmotionRead(SAMPLES.anger);
    expect(read.emotion).toBe("anger");
    expect(read.sentiment).toBe("negative");
    expect(read.confidence).toBeGreaterThan(0.5);
  });

  test("excitement", () => {
    const read = heuristicEmotionRead(SAMPLES.excitement);
    expect(read.emotion).toBe("excitement");
    expect(read.sentiment).toBe("positive");
    expect(read.sentimentScore).toBeGreaterThan(0);
  });

  test("confusion", () => {
    const read = heuristicEmotionRead(SAMPLES.confusion);
    expect(read.emotion).toBe("confusion");
    expect(read.signalFields).toContain("confused");
  });

  test("a plain request stays neutral — no feeling is invented", () => {
    const read = heuristicEmotionRead(SAMPLES.neutral);
    expect(read.emotion).toBe("neutral");
    expect(read.sentiment).toBe("neutral");
    expect(read.urgency).toBe("low");
    expect(read.signalFields).toBe("no strong emotional markers");
  });
});

describe("urgency and tone are read separately from emotion", () => {
  test("an urgent, purely transactional request reads urgent but not emotional", () => {
    const read = heuristicEmotionRead(
      "URGENT: the checkout is down and I need this fixed asap before end of day.",
    );
    expect(read.urgency).toBe("high");
    expect(read.emotion).toBe("neutral"); // urgency must not fabricate an emotion
    expect(read.urgencyScore).toBeGreaterThanOrEqual(90);
  });

  test("venting is scored apart from an actionable complaint", () => {
    const rant = heuristicEmotionRead(
      "THIS IS RIDICULOUS!!! WHY DOES NOTHING EVER WORK!!! I AM SO TIRED OF THIS!!!",
    );
    const actionable = heuristicEmotionRead(
      "The export button throws a 500 error. Can you check the API logs for account 1234?",
    );
    expect(rant.rantScore).toBeGreaterThan(actionable.rantScore);
    expect(actionable.rantScore).toBeLessThan(20);
  });

  test("positive/negative/neutral tone is derived with the right sign", () => {
    expect(heuristicEmotionRead(SAMPLES.excitement).sentimentScore).toBeGreaterThan(0);
    expect(heuristicEmotionRead(SAMPLES.anger).sentimentScore).toBeLessThan(0);
    expect(heuristicEmotionRead(SAMPLES.neutral).sentimentScore).toBe(0);
  });
});

describe("graceful degradation when the emotion service is unavailable", () => {
  test("the local read produces a complete, valid read-out on its own", () => {
    // The heuristic IS the fallback path used when every AI provider fails —
    // it must satisfy the same shape the UI and chat depend on.
    const read = heuristicEmotionRead(SAMPLES.frustration);
    expect(Object.keys(read).sort()).toEqual(
      [
        "advice",
        "confidence",
        "emotion",
        "omiNote",
        "rantInterpretation",
        "rantScore",
        "sentiment",
        "sentimentScore",
        "signalFields",
        "source",
        "urgency",
        "urgencyScore",
      ].sort(),
    );
    expect(read.source).toBe("heuristic");
    expect(read.advice.length).toBeGreaterThan(0);
    expect(read.omiNote.length).toBeGreaterThan(0);
  });

  test("a heuristic read never presents itself as confident", () => {
    // A word list is an approximation; confidence is capped and stays honest.
    for (const sample of Object.values(SAMPLES)) {
      expect(heuristicEmotionRead(sample).confidence).toBeLessThanOrEqual(0.75);
    }
  });

  test("empty or nonsense input still yields a usable neutral read", () => {
    for (const text of ["", "   ", "??", "asdfgh"]) {
      const read = heuristicEmotionRead(text);
      expect(read.emotion).toBe("neutral");
      expect(Number.isFinite(read.confidence)).toBe(true);
      expect(read.source).toBe("heuristic");
    }
  });
});

describe("model output is normalized before anything trusts it", () => {
  test("out-of-range numbers are clamped rather than passed through", () => {
    const read = normalizeEmotionRead(
      { emotion: "frustrated", confidence: 12, sentimentScore: -9, urgencyScore: 500, rantScore: -4 },
      "ai",
    );
    expect(read.confidence).toBe(1);
    expect(read.sentimentScore).toBe(-1);
    expect(read.urgencyScore).toBe(100);
    expect(read.rantScore).toBe(0);
    expect(read.sentiment).toBe("negative");
    expect(read.urgency).toBe("high");
  });

  test("numeric strings are accepted (models emit both shapes)", () => {
    const read = normalizeEmotionRead(
      { emotion: "excited", confidence: "0.72", sentimentScore: "0.5" },
      "ai",
    );
    expect(read.confidence).toBeCloseTo(0.72);
    expect(read.sentiment).toBe("positive");
  });

  test("missing or off-shape fields fall back to sane values, never empty text", () => {
    const read = normalizeEmotionRead({ emotion: "irritated" }, "ai");
    expect(read.sentiment).toBe("neutral");
    expect(read.urgency).toBe("low");
    expect(read.signalFields).toBe("no strong emotional markers");
    expect(read.advice.length).toBeGreaterThan(0);
    expect(read.omiNote.length).toBeGreaterThan(0);

    const junk = normalizeEmotionRead(null, "ai");
    expect(junk.emotion).toBe("neutral");
    expect(junk.confidence).toBeGreaterThan(0);
  });

  test("a model's free-form label still finds the right tone family", () => {
    // The bug this guards: "frustrated" does not contain "frustration".
    expect(emotionFamily("frustrated")).toBe("frustration");
    expect(emotionFamily("annoyed")).toBe("frustration");
    expect(emotionFamily("furious")).toBe("anger");
    expect(emotionFamily("thrilled")).toBe("excitement");
    expect(emotionFamily("bummed")).toBe("sadness");
    expect(emotionFamily("worried")).toBe("anxiety");
    expect(emotionFamily("unsure")).toBe("confusion");
    expect(emotionFamily("appreciative")).toBe("gratitude");
    expect(emotionFamily("relieved")).toBe("relief");
    expect(emotionFamily("neutral")).toBe("neutral");
    expect(emotionFamily("")).toBe("neutral");
  });

  test("fenced JSON from a model is parsed, prose around it is tolerated", () => {
    expect(parseEmotionJson('```json\n{"emotion":"sad"}\n```')).toEqual({ emotion: "sad" });
    expect(parseEmotionJson('Sure! {"emotion":"happy"} hope that helps')).toEqual({
      emotion: "happy",
    });
    expect(parseEmotionJson("no json at all")).toBeNull();
    expect(parseEmotionJson("{broken")).toBeNull();
  });
});

describe("chat tone adaptation is bounded by the honesty rules", () => {
  const read = normalizeEmotionRead(
    {
      emotion: "frustration",
      confidence: 0.8,
      sentiment: "negative",
      sentimentScore: -0.4,
      urgency: "medium",
      urgencyScore: 40,
      signalFields: "repeated contact",
    },
    "ai",
  );

  test("the block states the read is an inference, not knowledge", () => {
    const block = emotionAwarenessBlock(read);
    expect(block).toContain("INFERENCE");
    expect(block).toContain("NOT knowledge of how they feel");
  });

  test("the block makes clear the user's actual request always wins", () => {
    const block = emotionAwarenessBlock(read);
    expect(block).toContain("may never change WHAT you answer");
    expect(block).toContain("Answer the user's ACTUAL request in full and first");
  });

  test("the block forces hedging instead of asserting feelings as fact", () => {
    const block = emotionAwarenessBlock(read);
    expect(block).toContain("Never state how the user feels as fact");
    expect(block).toContain("hedge it");
  });

  test("each family gets its own tone direction", () => {
    const toneFor = (emotion: string) =>
      emotionAwarenessBlock(normalizeEmotionRead({ emotion }, "ai"));
    const frustration = toneFor("frustration");
    const anxiety = toneFor("anxious");
    const excitement = toneFor("excited");
    expect(frustration).not.toBe(anxiety);
    expect(frustration).toContain("short and concrete");
    expect(anxiety).toContain("Reduce uncertainty");
    expect(excitement).toContain("Match the energy");
  });

  test("a weak signal tells Omi to stand down rather than over-read", () => {
    const weak = emotionAwarenessBlock(
      normalizeEmotionRead({ emotion: "sadness", confidence: 0.2 }, "heuristic"),
    );
    expect(weak).toContain("WEAK");
    expect(weak).toContain("Do not lean on it");
    expect(weak).toContain("local word/punctuation heuristic");
  });

  test("nothing in the analysis prompt invites a diagnosis or a mind-reading claim", () => {
    expect(EMOTION_SYSTEM_PROMPT).toContain("You cannot perceive anyone's internal state");
    expect(EMOTION_SYSTEM_PROMPT).toContain("not certainties");
    expect(EMOTION_SYSTEM_PROMPT).not.toContain("diagnose");
  });
});

describe("the analysis only runs where it is worth running", () => {
  test("trivial acknowledgements are skipped", () => {
    for (const text of ["hi", "hey", "thanks", "ok", "yes", "cool!", "bye", "..."]) {
      expect(shouldAnalyzeEmotion(text)).toBe(false);
    }
  });

  test("real messages are analyzed", () => {
    for (const text of Object.values(SAMPLES)) {
      expect(shouldAnalyzeEmotion(text)).toBe(true);
    }
    expect(shouldAnalyzeEmotion("a".repeat(MIN_AUTO_EMOTION_CHARS))).toBe(true);
  });
});
