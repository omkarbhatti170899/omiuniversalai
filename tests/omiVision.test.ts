/**
 * Phase 14 tests — Phase 4/5 multimodal: the VisionProvider catalog's
 * validation and parts-building logic (pure functions, no network).
 * Pins the security- and honesty-relevant behavior: server-side re-validation
 * of image data URLs (§12 defense in depth) and the exact multimodal message
 * shape the compatible transport receives.
 */
import { describe, test, expect } from "bun:test";
import {
  ALLOWED_IMAGE_TYPES,
  VISION_LIMITS,
  buildImageMessageParts,
  validateImageDataUrl,
  visionModelFor,
} from "../src/convex/aiProviders/visionCatalog";

const VALID_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const VALID_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/";

describe("vision catalog — data URL validation (server-side gate)", () => {
  test("accepts supported, well-formed image data URLs", () => {
    for (const url of [VALID_PNG, VALID_JPEG]) {
      const v = validateImageDataUrl(url);
      expect(v.ok).toBe(true);
    }
  });

  test("rejects non-data-URLs and wrong prefixes", () => {
    for (const bad of [
      "",
      "not-a-url",
      "https://example.com/img.png",
      "data:text/html;base64,PGI+aGk8L2I+",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", // SVG can carry scripts — excluded
    ]) {
      const v = validateImageDataUrl(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error.length).toBeGreaterThan(0);
    }
  });

  test("rejects malformed base64 payloads", () => {
    const v = validateImageDataUrl("data:image/png;base64,not*base64!!");
    expect(v.ok).toBe(false);
  });

  test("enforces the size cap", () => {
    const big = `data:image/png;base64,${"A".repeat(VISION_LIMITS.maxDataUrlChars + 1)}`;
    const v = validateImageDataUrl(big);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("too large");
  });

  test("allowed types set matches the advertised formats", () => {
    expect([...ALLOWED_IMAGE_TYPES].sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

describe("vision catalog — multimodal message parts", () => {
  test("builds a text + image_url pair in compatible-protocol order", () => {
    const parts = buildImageMessageParts(VALID_PNG, "What chart is shown?");
    expect(parts).toEqual([
      { type: "text", text: "What chart is shown?" },
      { type: "image_url", image_url: { url: VALID_PNG } },
    ]);
  });

  test("empty/whitespace prompt falls back to the default instruction", () => {
    const parts = buildImageMessageParts(VALID_PNG, "   ");
    expect(parts[0]).toEqual({ type: "text", text: "Describe this image." });
  });

  test("overlong prompts are clipped to the limit", () => {
    const parts = buildImageMessageParts(VALID_PNG, "x".repeat(VISION_LIMITS.maxPromptChars + 500));
    expect(parts[0].type === "text" && parts[0].text.length).toBe(VISION_LIMITS.maxPromptChars);
  });
});

describe("vision catalog — model routing", () => {
  test("env override (VISION_<ID>_MODEL) beats the catalog model", () => {
    const provider = {
      id: "groq" as const,
      label: "t",
      envKeys: ["GROQ_API_KEY"],
      cost: "",
      taskModels: {
        describe: "meta-llama/llama-4-scout-17b-16e-instruct",
        extract: "meta-llama/llama-4-scout-17b-16e-instruct",
        answer: "meta-llama/llama-4-scout-17b-16e-instruct",
      },
      fallbackModels: [],
      hint: "",
    };
    const prev = process.env["VISION_GROQ_MODEL"];
    process.env["VISION_GROQ_MODEL"] = "meta-llama/llama-4-maverick-17b-128e-instruct";
    try {
      expect(visionModelFor(provider, "describe")).toBe(
        "meta-llama/llama-4-maverick-17b-128e-instruct",
      );
    } finally {
      if (prev === undefined) delete process.env["VISION_GROQ_MODEL"];
      else process.env["VISION_GROQ_MODEL"] = prev;
    }
  });
});
