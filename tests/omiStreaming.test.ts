/**
 * Master spec §1/§2 — real token streaming + fallback + Stop.
 *
 * These pin the contract the chat turn depends on:
 *   • tokens are handed to onToken as they arrive (not returned whole)
 *   • a provider that fails BEFORE emitting is transparently skipped
 *   • a Stop keeps the partial answer and reports `stopped` (never throws,
 *     never loses already-streamed text)
 */
import { describe, test, expect, afterEach } from "bun:test";
import { completeStream } from "../src/convex/aiProviders";
import { openAiCompatibleStream } from "../src/convex/aiProviders/openaiCompat";

function sseResponse(chunks: string[]): Response {
  const body =
    chunks
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const realFetch = globalThis.fetch;

function isolateProviders() {
  process.env.GROQ_API_KEY = "test-groq";
  process.env.GEMINI_API_KEY = "test-gemini";
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.VLY_INTEGRATION_KEY;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("streaming transport", () => {
  test("streams tokens incrementally and returns the joined text", async () => {
    globalThis.fetch = (async () => sseResponse(["Hel", "lo", " world"])) as typeof fetch;
    const tokens: string[] = [];
    const outcome = await openAiCompatibleStream(
      "https://example.test/v1/chat",
      "k",
      "m",
      { messages: [{ role: "user", content: "hi" }] },
      "Test",
      (delta) => {
        tokens.push(delta);
      },
    );
    expect(outcome.success).toBe(true);
    expect(outcome.emitted).toBe(true);
    expect(outcome.content).toBe("Hello world");
    expect(tokens).toEqual(["Hel", "lo", " world"]);
  });

  test("a Stop keeps the partial answer and never throws", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => sseResponse(["one ", "two ", "three"])) as typeof fetch;
    const tokens: string[] = [];
    const outcome = await openAiCompatibleStream(
      "https://example.test/v1/chat",
      "k",
      "m",
      { messages: [{ role: "user", content: "hi" }] },
      "Test",
      (delta) => {
        tokens.push(delta);
        if (tokens.length === 1) controller.abort();
      },
      controller.signal,
    );
    expect(outcome.aborted).toBe(true);
    expect(outcome.content).toBe("one ");
  });
});

describe("streaming router fallback", () => {
  test("falls through a provider that fails before emitting any token", async () => {
    isolateProviders();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("groq")) {
        return new Response("upstream boom", { status: 500 });
      }
      return sseResponse(["Fallback", " ok"]);
    }) as typeof fetch;

    const tokens: string[] = [];
    const res = await completeStream({
      task: "conversational",
      // An explicit model skips live /models discovery (no extra network).
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      onToken: (delta) => {
        tokens.push(delta);
      },
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("Fallback ok");
    expect(tokens.join("")).toBe("Fallback ok");
  });

  test("resolves honestly when no provider is configured", async () => {
    isolateProviders();
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    let called = false;
    const res = await completeStream({
      task: "conversational",
      messages: [{ role: "user", content: "hi" }],
      onToken: () => {
        called = true;
      },
    });
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
    expect(res.error).toMatch(/no AI provider is configured/i);
  });
});
