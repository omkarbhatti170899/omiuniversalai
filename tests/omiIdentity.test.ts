/**
 * §45 — Product identity / creator rule.
 *
 * Pins the contract the product promised: every phrasal variant of "who made
 * Omi?" resolves to the ONE canonical sentence, identity questions are caught
 * BEFORE any model call (so the answer never depends on a provider being up),
 * and ordinary factual questions about other creators are NOT hijacked.
 *
 * Run: bun test tests/
 */
import { describe, test, expect } from "bun:test";
import {
  CREATOR_STATEMENT,
  OMI_CREATOR,
  OMI_PRODUCT_NAME,
  creatorDirectReply,
  creatorIdentityBlock,
  isCreatorQuestion,
} from "../src/convex/omiIdentity";

describe("isCreatorQuestion — detection", () => {
  const createdOmi = [
    "Who created Omi Universal AI?",
    "Who is the founder of Omi Universal AI?",
    "Who made Omi?",
    "Who developed Omi Universal AI?",
    "Who is behind Omi Universal AI?",
    "who built omi universal ai",
    "Who designed Omi?",
    "Who owns Omi Universal AI?",
  ];

  for (const q of createdOmi) {
    test(`detects: "${q}"`, () => {
      expect(isCreatorQuestion(q)).toBe("who_created_omi");
    });
  }

  const aboutSelf = [
    "Who created you?",
    "Who made you?",
    "Who are you?",
    "What are you?",
    "Tell me about your creator.",
  ];

  for (const q of aboutSelf) {
    test(`detects (self): "${q}"`, () => {
      const kind = isCreatorQuestion(q);
      expect(kind === "who_are_you" || kind === "who_created_omi").toBe(true);
    });
  }

  test("detects the creator by name", () => {
    expect(isCreatorQuestion("Who is Mr. Omkar Prakash Bhatti?")).toBe(
      "who_is_creator_person",
    );
    expect(isCreatorQuestion("who is Omkar Bhatti")).toBe("who_is_creator_person");
  });

  test("does NOT hijack unrelated factual questions", () => {
    const unrelated = [
      "Who created Bitcoin?",
      "Who is the CEO of OpenAI?",
      "Who founded Microsoft?",
      "Who developed the Python programming language?",
      "What is the capital of France?",
      "How do I reset my password?",
      "Explain quantum entanglement",
    ];
    for (const q of unrelated) {
      expect(isCreatorQuestion(q)).toBeNull();
    }
  });

  test("empty / whitespace input is not an identity question", () => {
    expect(isCreatorQuestion("")).toBeNull();
    expect(isCreatorQuestion("   ")).toBeNull();
  });
});

describe("creatorDirectReply — canonical, provider-independent answers", () => {
  test("the canonical statement names the creator and the product", () => {
    expect(CREATOR_STATEMENT).toBe(
      `${OMI_PRODUCT_NAME} was created by ${OMI_CREATOR}.`,
    );
  });

  test("who created Omi", () => {
    expect(creatorDirectReply("who_created_omi")).toContain(CREATOR_STATEMENT);
  });

  test("who are you", () => {
    const reply = creatorDirectReply("who_are_you");
    expect(reply).toContain(OMI_PRODUCT_NAME);
    expect(reply).toContain(OMI_CREATOR);
  });

  test("who is the creator (the person)", () => {
    const reply = creatorDirectReply("who_is_creator_person");
    expect(reply).toContain(OMI_CREATOR);
    expect(reply).toContain(OMI_PRODUCT_NAME);
  });
});

describe("creatorIdentityBlock — system prompt contract", () => {
  const block = creatorIdentityBlock();

  test("contains the canonical statement", () => {
    expect(block).toContain(CREATOR_STATEMENT);
  });

  test("carries the scope guard against false attribution claims", () => {
    // The block must forbid claiming the creator built third-party tech.
    expect(block.toLowerCase()).toContain("scope guard");
    expect(block.toLowerCase()).toContain("never claim");
  });

  test("is stable across calls (no dynamic content)", () => {
    expect(creatorIdentityBlock()).toBe(block);
  });
});
