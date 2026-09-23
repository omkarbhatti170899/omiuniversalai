/**
 * Tests for model discovery and the retired-model class of failure.
 *
 * The bug these lock down: Omi's configured Groq vision models were shut down
 * upstream on 2026-07-17, so every image upload 404'd in production while
 * /status still reported vision "available". Nothing in the build, the
 * deploy, or the type system could see that — only asking the provider what
 * it actually serves can.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearModelDiscoveryCache,
  fetchAvailableModelIds,
  filterToAvailableModels,
  modelsEndpoint,
  selectAvailableModels,
} from "../src/convex/aiProviders/modelDiscovery";
import { AI_PROVIDERS } from "../src/convex/aiProviders/catalog";
import {
  GROQ_VISION_MODEL,
  VISION_PROBE_IMAGE,
  VISION_PROVIDERS,
} from "../src/convex/aiProviders/visionCatalog";

/**
 * Models Groq has shut down (its public deprecation page), with the shutdown
 * dates. Configuring any of these guarantees a 404, so this list is asserted
 * to stay out of the catalogues entirely.
 */
const RETIRED_GROQ_MODELS = [
  "llama-3.1-8b-instant", // 2026-08-16
  "llama-3.3-70b-versatile", // 2026-08-16
  "meta-llama/llama-4-scout-17b-16e-instruct", // 2026-07-17
  "meta-llama/llama-4-maverick-17b-128e-instruct", // 2026-07-17
  "qwen/qwen3-32b", // 2026-07-17
  "qwen/qwen3.6-27b", // 2026-09-14
  "groq/compound", // 2026-09-21
  "groq/compound-mini", // 2026-09-21
];

/**
 * Gemini models an account can no longer call. Google still LISTS these, so
 * discovery (which filters against /models) happily keeps them — the failure
 * only appears as a 404 at call time: "no longer available to new users".
 * Probed live 2026-09-23: gemini-2.5-flash and gemini-2.5-flash-lite 404,
 * while gemini-flash-latest and gemini-3.8-flash answered 200.
 */
const RETIRED_GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    fetchCalls.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  clearModelDiscoveryCache();
  fetchCalls = [];
  globalThis.fetch = realFetch;
});

describe("model discovery — endpoint derivation", () => {
  test("maps a chat-completions URL to its /models sibling", () => {
    expect(
      modelsEndpoint("https://api.groq.com/openai/v1/chat/completions"),
    ).toBe("https://api.groq.com/openai/v1/models");
    expect(
      modelsEndpoint("https://api.openai.com/v1/chat/completions/"),
    ).toBe("https://api.openai.com/v1/models");
  });

  test("leaves an unexpected URL shape untouched rather than mangling it", () => {
    expect(modelsEndpoint("https://example.com/custom/path")).toBe(
      "https://example.com/custom/path",
    );
  });
});

describe("model discovery — selection is fail-open", () => {
  test("unknown catalogue returns candidates unchanged", () => {
    const c = ["a", "b"];
    expect(selectAvailableModels(c, null)).toBe(c);
    expect(selectAvailableModels(c, new Set())).toBe(c);
  });

  test("keeps only served models, preserving preference order", () => {
    expect(
      selectAvailableModels(["a", "b", "c"], new Set(["c", "a"])),
    ).toEqual(["a", "c"]);
  });

  test("agrees with NONE of the candidates → still tries them", () => {
    // An empty result here would disable a provider outright. One doomed
    // round-trip is far cheaper than a silently dead capability.
    expect(
      selectAvailableModels(["a", "b"], new Set(["x", "y"])),
    ).toEqual(["a", "b"]);
  });
});

describe("model discovery — catalogue fetch", () => {
  test("parses the OpenAI-compatible { data: [{ id }] } shape", async () => {
    stubFetch(() =>
      jsonResponse({ data: [{ id: "openai/gpt-oss-120b" }, { id: "qwen/qwen3.8-27b" }] }),
    );
    const ids = await fetchAvailableModelIds("groq", "https://x/chat/completions", "k");
    expect(ids).not.toBeNull();
    expect([...(ids ?? [])].sort()).toEqual([
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
    ]);
  });

  test("tolerates a { models: [] } shape and bare strings", async () => {
    stubFetch(() => jsonResponse({ models: ["m-one", { id: "m-two" }] }));
    const ids = await fetchAvailableModelIds("groq", "https://x/chat/completions", "k");
    expect([...(ids ?? [])].sort()).toEqual(["m-one", "m-two"]);
  });

  test("returns null (never throws) when the provider errors", async () => {
    stubFetch(() => jsonResponse({ error: "nope" }, 500));
    expect(await fetchAvailableModelIds("groq", "https://x/chat/completions", "k")).toBeNull();
  });

  test("returns null when the network throws", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch;
    expect(await fetchAvailableModelIds("groq", "https://x/chat/completions", "k")).toBeNull();
  });

  test("returns null on an empty catalogue", async () => {
    stubFetch(() => jsonResponse({ data: [] }));
    expect(await fetchAvailableModelIds("groq", "https://x/chat/completions", "k")).toBeNull();
  });

  test("caches a success, so per-request cost is one call per TTL", async () => {
    stubFetch(() => jsonResponse({ data: [{ id: "a" }] }));
    await fetchAvailableModelIds("groq", "https://x/chat/completions", "k", 1000);
    await fetchAvailableModelIds("groq", "https://x/chat/completions", "k", 2000);
    expect(fetchCalls.length).toBe(1);
    // Past the 10-minute success TTL it refreshes.
    await fetchAvailableModelIds("groq", "https://x/chat/completions", "k", 1000 + 11 * 60_000);
    expect(fetchCalls.length).toBe(2);
  });

  test("a FAILURE is retried quickly, so an outage self-heals", async () => {
    stubFetch(() => jsonResponse({}, 500));
    await fetchAvailableModelIds("groq", "https://x/chat/completions", "k", 1000);
    await fetchAvailableModelIds("groq", "https://x/chat/completions", "k", 61_001);
    expect(fetchCalls.length).toBe(2);
  });

  test("filterToAvailableModels drops retired models but never empties the list", async () => {
    stubFetch(() => jsonResponse({ data: [{ id: "live-a" }] }));
    expect(
      await filterToAvailableModels("groq", "https://x/chat/completions", "k", [
        "retired-z",
        "live-a",
      ]),
    ).toEqual(["live-a"]);
  });

  test("filterToAvailableModels keeps everything when discovery is unavailable", async () => {
    stubFetch(() => jsonResponse({}, 503));
    expect(
      await filterToAvailableModels("groq", "https://x/chat/completions", "k", [
        "a",
        "b",
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("catalogues contain no model the provider has retired", () => {
  test("no retired Groq model is configured for text", () => {
    const groq = AI_PROVIDERS.find((p) => p.id === "groq");
    expect(groq).toBeDefined();
    const configured = [
      ...Object.values(groq!.taskModels),
      ...groq!.fallbackModels,
    ];
    for (const dead of RETIRED_GROQ_MODELS) {
      expect(configured).not.toContain(dead);
    }
  });

  test("no retired Groq model is configured for vision", () => {
    const groq = VISION_PROVIDERS.find((p) => p.id === "groq");
    expect(groq).toBeDefined();
    const configured = [
      ...Object.values(groq!.taskModels),
      ...groq!.fallbackModels,
    ];
    for (const dead of RETIRED_GROQ_MODELS) {
      expect(configured).not.toContain(dead);
    }
  });

  test("vision points at the multimodal model Groq currently serves", () => {
    expect(GROQ_VISION_MODEL).toBe("qwen/qwen3.8-27b");
  });

  test("no Gemini model an account can no longer call is configured for text", () => {
    const gemini = AI_PROVIDERS.find((p) => p.id === "gemini");
    expect(gemini).toBeDefined();
    const configured = [
      ...Object.values(gemini!.taskModels),
      ...gemini!.fallbackModels,
    ];
    for (const dead of RETIRED_GEMINI_MODELS) {
      expect(configured).not.toContain(dead);
    }
  });

  test("no Gemini model an account can no longer call is configured for vision", () => {
    const gemini = VISION_PROVIDERS.find((p) => p.id === "gemini");
    expect(gemini).toBeDefined();
    const configured = [
      ...Object.values(gemini!.taskModels),
      ...gemini!.fallbackModels,
    ];
    for (const dead of RETIRED_GEMINI_MODELS) {
      expect(configured).not.toContain(dead);
    }
  });
});

describe("vision probe image", () => {
  test("is a well-formed 64×64 PNG data URL", () => {
    const prefix = "data:image/png;base64,";
    expect(VISION_PROBE_IMAGE.startsWith(prefix)).toBe(true);
    const bytes = Buffer.from(VISION_PROBE_IMAGE.slice(prefix.length), "base64");
    // PNG signature.
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // IHDR width/height, 8-bit truecolour.
    expect(bytes.readUInt32BE(16)).toBe(64);
    expect(bytes.readUInt32BE(20)).toBe(64);
    expect(bytes[24]).toBe(8);
    expect(bytes[25]).toBe(2);
    // Ends with an IEND chunk.
    expect(bytes.subarray(-8).toString("latin1")).toContain("IEND");
  });

  test("is far under the vision size cap, so it never trips validation", () => {
    expect(VISION_PROBE_IMAGE.length).toBeLessThan(1_000);
  });
});
