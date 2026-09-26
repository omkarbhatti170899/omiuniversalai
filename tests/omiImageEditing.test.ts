/**
 * Master spec §7 (image editing) — the routing rule and the free-tier edit path.
 *
 * The cardinal rule: an EDIT request must never reach a text-to-image provider,
 * and when no edit-capable provider is configured the op fails honestly rather
 * than returning an unrelated generated image. These tests pin that rule and
 * exercise the new Pollinations edits adapter (OpenAI Images-Edits-compatible,
 * model `kontext`) against a mocked transport.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { runImageOp } from "../src/convex/aiProviders/imageProviders";
import { providersForOp } from "../src/convex/aiProviders/imageRouter";
import { getImageCapabilityReport } from "../src/convex/aiProviders/imageCatalog";

// A real 32×32 PNG (valid signature + IHDR + IDAT) so byte verification,
// which requires ≥128 bytes and a recognised signature, accepts it.
const PNG_DATA_URL =
  "data:image/png;base64,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";

function pngBytes(): Uint8Array {
  const b64 = PNG_DATA_URL.split(",")[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function useEditProvider() {
  process.env.POLLINATIONS_API_KEY = "test-pollinations";
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

function clearKeys() {
  delete process.env.POLLINATIONS_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearKeys();
});

describe("edit routing never crosses into text-to-image", () => {
  test("the keyless text-to-image provider is not eligible for an edit", () => {
    useEditProvider();
    const ids = providersForOp("edit", true).map((p) => p.id);
    expect(ids).toContain("pollinations-edit");
    expect(ids).not.toContain("pollinations");
  });

  test("capability report marks editing available once an edit key exists", () => {
    useEditProvider();
    const edit = getImageCapabilityReport().find((r) => r.op === "edit");
    expect(edit?.available).toBe(true);
    expect(edit?.providers).toContain("pollinations-edit");
  });
});

describe("Pollinations edits adapter (OpenAI Images-Edits-compatible)", () => {
  test("edit op posts to the edits endpoint and returns a verified image", async () => {
    useEditProvider();
    const calls: string[] = [];
    const bodies: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      bodies.push(init?.body);
      return new Response(pngBytes(), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;

    const res = await runImageOp({
      op: "edit",
      prompt: "replace the sky with a sunset",
      aspectRatio: "1:1",
      transparent: false,
      sources: [PNG_DATA_URL],
    });

    expect(
      calls.some((u) => u.includes("gen.pollinations.ai/v1/images/edits")),
    ).toBe(true);
    expect(bodies[0]).toBeInstanceOf(FormData);
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("pollinations-edit");
    expect(res.mimeType.startsWith("image/")).toBe(true);
  });

  test("an edit with no edit-capable key fails honestly and calls no provider", async () => {
    clearKeys();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const res = await runImageOp({
      op: "edit",
      prompt: "make the background blue",
      aspectRatio: "1:1",
      transparent: false,
      sources: [PNG_DATA_URL],
    });

    expect(res.ok).toBe(false);
    expect(res.provider).toBeNull();
    // The point of the whole rule: no text-to-image generation was attempted.
    expect(calls.length).toBe(0);
  });
});
