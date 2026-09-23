/**
 * Image-error presentation tests.
 *
 * Regression origin: attempting an image EDIT on a phone rendered the router's
 * raw provider errors into Image Studio — two multi-line JSON objects with
 * escaped braces, a quote cut off mid-string, and the same text printed twice
 * (the headline was the per-provider list joined into one line, with that list
 * repeated underneath it).
 *
 * The fix has two halves, both pinned here:
 *   1. `humanizeImageError` turns a provider failure into one short sentence,
 *      keeping the REASON and dropping the serialized object.
 *   2. The credits-vs-quota distinction must survive. OpenAI says "no credits
 *      remaining" and Gemini says "exceeded your current quota … billing
 *      details", and BOTH are prefixed "error 429:" by their adapters — so a
 *      naive 429 test would describe two different problems identically and
 *      send the user to the wrong fix.
 *
 * The payloads below are the real ones from the bug report, not invented.
 */
import { describe, expect, test } from "bun:test";
import { humanizeImageError } from "../src/convex/aiProviders/imageProviders";

/** The exact OpenAI body seen in the report (adapter prefix included). */
const OPENAI_NO_CREDITS =
  'error 429: {\n  "error": {\n    "message": "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing';

/** The exact Gemini body seen in the report (adapter prefix included). */
const GEMINI_QUOTA =
  'error 429: {\n  "error": {\n    "code": 429,\n    "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error,';

describe("humanizeImageError — the reported payloads", () => {
  test("OpenAI 'no credits' is reported as a credits problem, not a quota problem", () => {
    const out = humanizeImageError(OPENAI_NO_CREDITS);
    expect(out).toContain("no remaining credits");
    expect(out).not.toContain("quota");
  });

  test("Gemini 'exceeded quota' is reported as a quota problem, not a credits problem", () => {
    const out = humanizeImageError(GEMINI_QUOTA);
    expect(out).toContain("quota");
    expect(out).not.toContain("credits");
  });

  test("neither message leaks JSON, escaped quotes or braces", () => {
    for (const raw of [OPENAI_NO_CREDITS, GEMINI_QUOTA]) {
      const out = humanizeImageError(raw);
      expect(out).not.toContain("{");
      expect(out).not.toContain("}");
      expect(out).not.toContain('"');
      expect(out).not.toContain("\\n");
      expect(out).not.toContain("code");
      expect(out).not.toContain("message");
    }
  });

  test("every verdict is a single short line", () => {
    for (const raw of [OPENAI_NO_CREDITS, GEMINI_QUOTA]) {
      const out = humanizeImageError(raw);
      expect(out.includes("\n")).toBe(false);
      expect(out.length).toBeLessThanOrEqual(141);
    }
  });
});

describe("humanizeImageError — router-produced refusals", () => {
  test("'op not supported' passes through unchanged (already precise)", () => {
    expect(humanizeImageError("op not supported by provider")).toBe(
      "op not supported by provider",
    );
  });

  test("'needs image input' becomes a sentence that explains the limitation", () => {
    const out = humanizeImageError(
      "op needs image input, provider is text-to-image only",
    );
    expect(out).toContain("cannot edit an image");
    expect(out).not.toContain("op needs");
  });
});

describe("humanizeImageError — other failure classes", () => {
  test("rejected credential", () => {
    expect(humanizeImageError('error 401: {"error":{"message":"Invalid API key"}}'))
      .toContain("credential");
  });

  test("retired model is distinguishable from a credential problem", () => {
    const out = humanizeImageError(
      'error 404: {"error":{"message":"model no longer available"}}',
    );
    expect(out).toContain("no longer available");
    expect(out).not.toContain("credential");
  });

  test("timeout", () => {
    expect(humanizeImageError("selftest image edit timed out after 90000ms"))
      .toContain("timed out");
  });

  test("content-policy refusal", () => {
    expect(humanizeImageError("blocked by content policy")).toContain(
      "content policy",
    );
  });

  test("an empty or missing error never renders as a blank cell", () => {
    expect(humanizeImageError("")).toBe("no response from the provider");
    expect(humanizeImageError("   ")).toBe("no response from the provider");
  });

  test("an unrecognised payload still yields a readable sentence", () => {
    const out = humanizeImageError(
      '{"error":{"type":"weird_thing","message":"the flux capacitor diverged"}',
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("{");
    expect(out).not.toContain('"');
    expect(out).toContain("flux capacitor");
  });

  test("an unrecognised payload is truncated rather than dumped whole", () => {
    const out = humanizeImageError(
      '{"error":{"message":"' + "x".repeat(600) + '"}}',
    );
    expect(out.length).toBeLessThanOrEqual(141);
    expect(out.endsWith("…")).toBe(true);
  });
});
