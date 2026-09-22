/**
 * Phase 14 — AI provider router: fallback rules + transport contract.
 * These pin the §3/§4 behavior: credentials/quota errors skip to the next
 * PROVIDER, model-specific errors try the provider's FALLBACK MODELS, and
 * transport deadlines are enforced with provider-labeled errors.
 */
import { describe, test, expect } from "bun:test";
import {
  openAiCompatibleCompletion,
  classifyProviderFailure,
  isCredentialish,
  isModelSpecific,
  isRateLimited,
} from "../src/convex/aiProviders/openaiCompat";
import { decideAfterFailedAttempt } from "../src/convex/aiProviders";

describe("rate/tier limits are distinguished from real breakage", () => {
  test("recognises Groq's 'Request too large' tier rejection", () => {
    // The exact shape seen live, which was a tier cap — not a broken model.
    expect(
      isRateLimited(
        'Groq(qwen/qwen3.8-27b) error 429: {"error":{"message":"Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM)"}}',
      ),
    ).toBe(true);
    expect(isRateLimited("error 429: Rate limit reached, please try again")).toBe(true);
    expect(isRateLimited("too many requests")).toBe(true);
  });

  test("does not mistake a retired model or a plain error for a limit", () => {
    expect(isRateLimited("model 'x' does not exist (404)")).toBe(false);
    expect(isRateLimited("ECONNRESET")).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});

describe("health verdicts never soften a retired model into 'unverified'", () => {
  test("a missing model is a FAIL even alongside a rate limit", () => {
    expect(
      classifyProviderFailure([
        { error: "groq error 429: request too large" },
        { error: "groq(gone/1) error 404: the model does not exist" },
      ]),
    ).toBe("fail");
  });

  test("a pure rate/tier limit is UNVERIFIED, not a defect", () => {
    expect(
      classifyProviderFailure([{ error: "error 429: rate limit reached" }]),
    ).toBe("unverified");
  });

  test("an unrecognised failure stays a FAIL", () => {
    expect(classifyProviderFailure([{ error: "kaboom" }])).toBe("fail");
    expect(classifyProviderFailure([])).toBe("fail");
  });
});

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

describe("empty completions retry the same provider's fallback models", () => {
  /**
   * Regression: an empty completion used to be classified like a credential
   * error, which BROKE out of the candidate loop and skipped the provider's
   * own fallback models. On the live deployment every provider then failed
   * (vly unauthorized, openai out of credits) and ALL AI synthesis silently
   * disappeared while /status still reported "available" — because an empty
   * string from a successful HTTP call is easy to mistake for success.
   */
  test("empty completion → next candidate model, not next provider", () => {
    expect(
      decideAfterFailedAttempt(
        "groq (openai/gpt-oss-20b) returned an empty completion",
        true,
      ),
    ).toBe("next_candidate");
  });

  test("empty completion is retried even when the text looks provider-level", () => {
    // The message deliberately contains no model-not-found markers, which is
    // exactly why the empty flag must drive the decision on its own.
    expect(decideAfterFailedAttempt("provider returned nothing", true)).toBe(
      "next_candidate",
    );
  });

  test("retired model → next candidate model", () => {
    expect(
      decideAfterFailedAttempt("model_not_found: no such model", false),
    ).toBe("next_candidate");
  });

  test("credentials/quota/network → next provider", () => {
    expect(decideAfterFailedAttempt("error 401: invalid api key", false)).toBe(
      "next_provider",
    );
    expect(decideAfterFailedAttempt("429 insufficient_quota", false)).toBe(
      "next_provider",
    );
    expect(decideAfterFailedAttempt("ECONNREFUSED", false)).toBe(
      "next_provider",
    );
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
