/**
 * Image provider router + response verification (pure, zero network).
 *
 * The router is the fix for the worst bug this engine had: an EDIT could reach
 * a text-to-image provider and come back as a brand-new random image that
 * looked like a (bad) edit. The rule is absolute and is pinned here —
 * capability-based selection, no cross-class fallback, honest unavailability,
 * and health states that distinguish "no key" from "quota spent" from
 * "credential rejected".
 *
 * `verifyImageBytes` is pinned too: a provider that answers with an HTML error
 * page, a JSON error body or a truncated payload must never be stored as "the
 * result".
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  capabilityClass,
  capableButUnconfigured,
  classifyFailure,
  describeUnavailable,
  healthSentence,
  overallHealth,
  providersForOp,
} from "../src/convex/aiProviders/imageRouter";
import { verifyImageBytes, sniffImageFormat, MIN_IMAGE_BYTES } from "../src/convex/aiProviders/imageVerify";

const KEYS = ["GEMINI_API_KEY", "OPENAI_API_KEY", "OMI_DISABLE_PROVIDERS"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const withKey = (name: string) => {
  process.env[name] = "test-key-present";
};

describe("router — capability classes never cross", () => {
  test("generation-class ops are exactly the ones that need no input", () => {
    expect(capabilityClass("generate")).toBe("generation");
    expect(capabilityClass("variation")).toBe("generation");
    for (const op of ["edit", "remove", "replace", "background", "style", "upscale", "enhance", "combine", "outpaint"] as const) {
      expect(capabilityClass(op)).toBe("edit");
    }
  });

  test("an edit request can NEVER be routed to the text-to-image provider", () => {
    // Pollinations is keyless, so it is always "configured" — the only thing
    // keeping edits away from it is the capability rule itself.
    withKey("GEMINI_API_KEY");
    withKey("OPENAI_API_KEY");
    for (const op of ["edit", "remove", "replace", "background", "style", "upscale", "enhance", "combine", "outpaint"] as const) {
      const ids = providersForOp(op, true).map((p) => p.id);
      expect(ids).not.toContain("pollinations");
      expect(ids.length).toBeGreaterThan(0);
    }
  });

  test("generation still prefers the free, keyless provider", () => {
    const ids = providersForOp("generate", false).map((p) => p.id);
    expect(ids[0]).toBe("pollinations");
  });

  test("variation with an input skips the text-only provider", () => {
    const withoutInput = providersForOp("variation", false).map((p) => p.id);
    expect(withoutInput).toContain("pollinations");
    withKey("GEMINI_API_KEY");
    const withInput = providersForOp("variation", true).map((p) => p.id);
    expect(withInput).not.toContain("pollinations");
    expect(withInput).toContain("gemini");
  });

  test("an unconfigured edit capability is reported, never faked", () => {
    expect(providersForOp("edit", true)).toEqual([]);
    // Gemini declares editing but has no key: that is WHY it is unavailable.
    expect(capableButUnconfigured("edit").map((p) => p.id)).toContain("gemini");
    // The reason names the capability and what is missing — never a generic
    // "something went wrong".
    const reason = describeUnavailable("edit");
    expect(reason).toContain("image editing");
    expect(reason).toContain("Keys tab");
    expect(reason).not.toContain("undefined");
  });

  test("a deployment kill switch removes a provider from routing", () => {
    process.env.OMI_DISABLE_PROVIDERS = "pollinations";
    expect(providersForOp("generate", false)).toEqual([]);
    process.env.OMI_DISABLE_PROVIDERS = "";
    expect(providersForOp("generate", false).length).toBeGreaterThan(0);
  });
});

describe("router — health states are not all 'unavailable'", () => {
  test("classifies the failures users actually hit", () => {
    expect(classifyFailure('error 429: {"error":{"code":429}}')).toBe("rate_limited");
    expect(classifyFailure("quota exceeded for gemini-2.5-flash-image")).toBe("rate_limited");
    expect(classifyFailure('error 401: {"message":"Invalid API key"}')).toBe("auth_error");
    expect(classifyFailure("op not supported by provider")).toBe("capability_unsupported");
    expect(classifyFailure("no credits remaining")).toBe("unavailable");
    expect(classifyFailure("selftest timed out after 90000ms")).toBe("unavailable");
    expect(classifyFailure(undefined)).toBe("unavailable");
  });

  test("overall health surfaces the most actionable state", () => {
    expect(overallHealth([{ state: "unavailable" }, { state: "rate_limited" }])).toBe("rate_limited");
    expect(overallHealth([{ state: "auth_error" }, { state: "unavailable" }])).toBe("auth_error");
    expect(overallHealth([{ state: "capability_unsupported" }])).toBe("capability_unsupported");
    expect(overallHealth([])).toBe("not_configured");
  });

  test("a rate-limited provider is described as rate-limited, not as missing", () => {
    const sentence = healthSentence("rate_limited", "edit");
    expect(sentence).toContain("rate-limited");
    expect(sentence).not.toContain("Keys tab");
    expect(healthSentence("auth_error", "edit")).toContain("credential");
  });
});

/** A byte buffer that begins with a real image signature. */
function pngBytes(size = 200, width = 1024, height = 768): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

const asciiBytes = (text: string) => new TextEncoder().encode(text);

describe("verification — an operation is not successful unless a real image came back", () => {
  test("accepts a real image and recovers its dimensions", () => {
    const v = verifyImageBytes(pngBytes(400, 1024, 768), "image/png");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.format).toBe("png");
    expect(v.width).toBe(1024);
    expect(v.height).toBe(768);
  });

  test("sniffs the type from the bytes when the provider lies about it", () => {
    const v = verifyImageBytes(pngBytes(), "application/octet-stream");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.mimeType).toBe("image/png");
    expect(verifyImageBytes(pngBytes()).ok).toBe(true);
  });

  test("rejects every non-image body a provider might return", () => {
    expect(verifyImageBytes(null).ok).toBe(false);
    expect(verifyImageBytes(new Uint8Array(0)).ok).toBe(false);
    const tiny = verifyImageBytes(new Uint8Array(MIN_IMAGE_BYTES - 1).fill(0x89));
    expect(tiny.ok).toBe(false);
    if (!tiny.ok) expect(tiny.reason).toContain("too small");

    const html = verifyImageBytes(asciiBytes(`<!DOCTYPE html><html><body>${"x".repeat(200)}`), "image/png");
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.reason).toContain("HTML");

    const json = verifyImageBytes(asciiBytes(`{"error":{"code":429,"message":"${"x".repeat(200)}"}}`), "image/png");
    expect(json.ok).toBe(false);
    if (!json.ok) expect(json.reason).toContain("data payload");
  });

  test("never throws, and unknown formats are reported honestly", () => {
    const junk = verifyImageBytes(new Uint8Array(300).fill(0x7f), "image/webp");
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.reason.length).toBeGreaterThan(0);
  });

  test("format sniffing covers the four transport formats", () => {
    expect(sniffImageFormat(pngBytes())).toBe("png");
    expect(sniffImageFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("jpeg");
    expect(sniffImageFormat(asciiBytes("GIF89a................"))).toBe("gif");
    expect(sniffImageFormat(asciiBytes("RIFF????WEBPVP8 "))).toBe("webp");
  });
});
