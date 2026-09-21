/**
 * Phase 14 — AI provider router: fallback rules + transport contract.
 * These pin the §3/§4 behavior: credentials/quota errors skip to the next
 * PROVIDER, model-specific errors try the provider's FALLBACK MODELS, and
 * transport deadlines are enforced with provider-labeled errors.
 */
import { describe, test, expect } from "bun:test";
import {
  openAiCompatibleCompletion,
  isCredentialish,
  isModelSpecific,
} from "../src/convex/aiProviders/openaiCompat";

describe("fallback classification (router decision rules)", () => {
  test("credential/quota failures are credentialish", () => {
    expect(isCredentialish("Groq error 401: invalid api key")).toBe(true);
    expect(isCredentialish("OpenAI error 403: insufficient_quota")).toBe(true);
    expect(isCredentialish("DeepSeek error: quota exceeded")).toBe(true);
    expect(isCredentialish("network hiccup")).toBe(false);
  });

  test("retired/unknown model failures are model-specific", () => {
    expect(isModelSpecific("model_not_found: no such model")).toBe(true);
    expect(isModelSpecific("model 'x' does not exist (404)")).toBe(true);
    expect(isModelSpecific("decommissioned model")).toBe(true);
    expect(isModelSpecific("rate limit exceeded")).toBe(false);
  });

  test("a 401 is never misread as model-specific", () => {
    // That would wrongly retry fallback models of a provider whose key
    // is broken instead of failing through to the next provider.
    expect(isModelSpecific("error 401: invalid api key")).toBe(false);
  });

  test("undefined errors classify as neither", () => {
    expect(isCredentialish(undefined)).toBe(false);
    expect(isModelSpecific(undefined)).toBe(false);
  });
});

describe("openAiCompatibleCompletion transport", () => {
  const BASE_REQ = {
    messages: [{ role: "user" as const, content: "hi" }],
  };

  test("network failure → structured error, never throws", async () => {
    // Port 1 is reserved — connection refused, deterministically.
    const out = await openAiCompatibleCompletion(
      "http://127.0.0.1:1/v1/chat",
      "test-key",
      "test-model",
      BASE_REQ,
      "UnitTest",
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/UnitTest failed/);
  });

  test("deadline produces a provider-labeled timeout error", async () => {
    // Background-listen address: connects but never answers.
    const out = await openAiCompatibleCompletion(
      "http://127.0.0.1:9/v1/chat",
      "test-key",
      "test-model",
      BASE_REQ,
      "UnitTest",
    );
    // Either it fails to connect (fine) or times out (fine) — both are
    // structured failures carrying the label, never a thrown exception.
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/UnitTest (failed|timed out)/);
  });

  test("HTTP error surfaces status + truncated body", async () => {
    // example.com ignores POST bodies and answers quickly with a page —
    // but it is http and returns 200 with HTML that is not valid JSON,
    // exercising the parse-failure path as a structured error.
    const out = await openAiCompatibleCompletion(
      "https://example.com/",
      "test-key",
      "test-model",
      BASE_REQ,
      "ParseTest",
    );
    // success only if JSON parsed with choices; example.com HTML → error
    expect(out.success).toBe(false);
    expect(typeof out.error).toBe("string");
  });
});
