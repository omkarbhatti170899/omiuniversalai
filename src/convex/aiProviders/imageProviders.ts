/**
 * Image generation/editing adapters — the ImageProvider transport layer
 * (mirrors vision.ts conventions). Never throws; reports every attempt.
 *
 * Verified transports (checked live before this module existed):
 *  • Pollinations GET /prompt/{text}?width&height&seed — keyless, returns
 *    image bytes directly. /models serves ["sana"] (text-to-image only).
 *  • Gemini POST /v1beta/models/{model}:generateContent with inline_data
 *    parts — native image-in/image-out on its own free tier.
 *  • OpenAI POST /v1/images/edits|generations — optional paid adapter.
 */

import {
  IMAGE_PROVIDERS,
  type AspectRatio,
  type ImageOp,
} from "./imageCatalog";
import { ASPECT_RATIOS } from "./imageCatalog";
import { GEMINI_URL, isProviderDisabled } from "./catalog";

export type ImageGenResult = {
  ok: boolean;
  /** Raw image bytes (png/jpeg — depends on the provider). */
  bytes: Uint8Array | null;
  mimeType: string;
  provider: string | null;
  model: string | null;
  width: number;
  height: number;
  transparent: boolean;
  attempts: Array<{ provider: string; model: string; error?: string }>;
  error?: string;
};

const TIMEOUT_MS = 90_000;
const POLLINATIONS_URL = "https://image.pollinations.ai/prompt";

const MODEL_BY_PROVIDER: Record<string, string> = {
  pollinations: "sana",
  gemini: "gemini-2.5-flash-image",
  openai: "gpt-image-1",
};

function dimsFor(aspect: AspectRatio): { w: number; h: number } {
  return ASPECT_RATIOS[aspect] ?? ASPECT_RATIOS["1:1"];
}

/**
 * Turn a provider's raw failure into ONE short, human sentence.
 *
 * This is the deepest point in the product where a third party's error text
 * would otherwise reach a user. A 429 body is multi-line JSON, so rendering it
 * verbatim put a wall of escaped braces, a quote cut off mid-string and a
 * vendor billing URL across the middle of Image Studio — seen on a phone. The
 * provider's identity and the actual REASON still reach the caller; the
 * serialized object does not.
 *
 * Deliberately ordered and specific: OpenAI answers "no credits remaining" and
 * Gemini answers "exceeded your current quota … billing details", and both are
 * prefixed "error 429:" by the adapters — so a generic 429 test would describe
 * both as the same problem. Credits are matched on words that only the credits
 * message uses.
 *
 * PURE and exported so the mapping is unit-tested rather than eyeballed.
 */
export function humanizeImageError(raw: string): string {
  const text = (raw ?? "").trim();
  if (text.length === 0) return "no response from the provider";

  // Router-produced structural refusals are already human and precise.
  if (text === "op not supported by provider") return text;
  if (text.startsWith("op needs image input")) {
    return "this provider only generates from text, so it cannot edit an image";
  }

  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();

  if (/no credits remaining|insufficient (credits?|funds|balance)|no credit/.test(lower)) {
    return "the account has no remaining credits — billing must be enabled";
  }
  if (/quota|rate limit|429|too many requests|resource_exhausted|overloaded/.test(lower)) {
    return "free-tier quota is exhausted right now — retry later or enable billing";
  }
  if (/401|403|unauthorized|api key not valid|invalid api key|permission denied|forbidden/.test(lower)) {
    return "the provider rejected the configured credential";
  }
  if (/timed out|timeout|aborted|deadline exceeded/.test(lower)) {
    return "the provider timed out";
  }
  if (/safety|content policy|prohibited|blocked/.test(lower)) {
    return "the provider refused this prompt under its content policy";
  }
  if (/not found|does not exist|404|no longer available|deprecated|shut down|decommission/.test(lower)) {
    return "the configured model is no longer available at that provider";
  }

  // Unknown failure: keep the provider's own words, but strip JSON punctuation
  // so it reads as a sentence instead of a serialized object.
  const stripped = text
    .replace(/[{}[\]"]/g, " ")
    .replace(/\b(code|message|error|status|type)\b\s*:?/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/[,;]+\s*$/, "")
    .trim();
  if (stripped.length === 0) return "the provider returned an error";
  return stripped.length > 140 ? `${stripped.slice(0, 140)}…` : stripped;
}

/**
 * Run ONE operation through the provider chain. `sources` are input images
 * (data URLs) for edit-family ops; providers that can't accept image input
 * are skipped by the router, not faked here.
 */
export async function runImageOp(args: {
  op: ImageOp;
  prompt: string;
  aspectRatio: AspectRatio;
  transparent: boolean;
  sources?: string[];
  /** Deterministic seed so "variation" can re-roll honestly. */
  seed?: number;
}): Promise<ImageGenResult> {
  const { op, prompt, aspectRatio, transparent, sources } = args;
  const needsInput = sources !== undefined && sources.length > 0;
  const attempts: ImageGenResult["attempts"] = [];
  const { w, h } = dimsFor(aspectRatio);

  for (const p of IMAGE_PROVIDERS) {
    if (isProviderDisabled(p.id)) continue;
    if (!p.ops.includes(op)) {
      attempts.push({ provider: p.id, model: "—", error: "op not supported by provider" });
      continue;
    }
    if (needsInput && !p.supportsImageInput) {
      attempts.push({ provider: p.id, model: "—", error: "op needs image input, provider is text-to-image only" });
      continue;
    }

    const key = p.envKeys.map((k) => process.env[k] ?? "").find((v) => v.length > 0) ?? "";
    if (p.envKeys.length > 0 && key === "") continue; // silently skip unconfigured

    const model: string = MODEL_BY_PROVIDER[p.id] ?? "unknown";
    const res =
      p.id === "pollinations"
        ? await pollinationsGenerate({ prompt, w, h, seed: args.seed })
        : p.id === "gemini"
          ? await geminiImage({ key, model, prompt, sources })
          : await openaiImage({ key, model, prompt, sources, w, h });

    if (res.ok && res.bytes) {
      return {
        ok: true,
        bytes: res.bytes,
        mimeType: res.mimeType ?? "image/png",
        provider: p.id,
        model,
        width: res.w ?? w,
        height: res.h ?? h,
        transparent: transparent && p.supportsTransparency,
        attempts,
      };
    }
    attempts.push({
      provider: p.id,
      model,
      error: humanizeImageError(res.error ?? "failed"),
    });
  }

  return {
    ok: false,
    bytes: null,
    mimeType: "image/png",
    provider: null,
    model: null,
    width: w,
    height: h,
    transparent: false,
    attempts,
    error:
      attempts
        .map((a) => `${a.provider}: ${a.error}`)
        .join(" | ")
        .slice(0, 400) || "no image provider configured for this operation",
  };
}

type Raw = { ok: boolean; bytes?: Uint8Array; mimeType?: string; w?: number; h?: number; error?: string };

/** Keyless GET → raw bytes. Failure = non-200 or non-image body. */
async function pollinationsGenerate(args: {
  prompt: string;
  w: number;
  h: number;
  seed?: number;
}): Promise<Raw> {
  const url =
    `${POLLINATIONS_URL}/${encodeURIComponent(args.prompt)}` +
    `?width=${args.w}&height=${args.h}&model=sana&nologo=true` +
    (args.seed !== undefined ? `&seed=${args.seed}` : "");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      return { ok: false, error: `error ${res.status}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get("content-type") ?? "image/jpeg";
    if (!mime.startsWith("image/")) {
      return { ok: false, error: "response was not an image" };
    }
    return { ok: true, bytes, mimeType: mime, w: args.w, h: args.h };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Gemini native generateContent: text parts + optional inline_data image
 * parts → returns inline base64 image. Handles edit/combine natively.
 */
async function geminiImage(args: {
  key: string;
  model: string;
  prompt: string;
  sources?: string[];
}): Promise<Raw> {
  try {
    const parts: Array<Record<string, unknown>> = [];
    for (const src of args.sources ?? []) {
      const m = src.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
      if (!m) return { ok: false, error: "source image was not a valid data URL" };
      parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
    }
    parts.push({ text: args.prompt });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": args.key },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const bodyText = await res.text();
    if (!res.ok) return { ok: false, error: `error ${res.status}: ${bodyText.slice(0, 160)}` };

    const parsed = JSON.parse(bodyText) as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
      }>;
    };
    for (const part of parsed.candidates?.[0]?.content?.parts ?? []) {
      const camel = part.inlineData;
      const snake = (part as { inline_data?: { mime_type?: string; data?: string } }).inline_data;
      const img = camel ?? snake;
      if (img?.data) {
        return {
          ok: true,
          bytes: base64ToBytes(img.data),
          mimeType: ("mimeType" in img ? img.mimeType : snake?.mime_type) ?? "image/png",
        };
      }
    }
    return { ok: false, error: "no image in response" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** OpenAI Images API — optional paid adapter (generations + edits). */
async function openaiImage(args: {
  key: string;
  model: string;
  prompt: string;
  sources?: string[];
  w: number;
  h: number;
}): Promise<Raw> {
  try {
    const size = nearestOpenAiSize(args.w, args.h);
    if (args.sources && args.sources.length > 0) {
      const form = new FormData();
      form.append("model", args.model);
      form.append("prompt", args.prompt);
      form.append("size", size);
      let i = 0;
      for (const src of args.sources.slice(0, 4)) {
        const m = src.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
        if (m) {
          const bytes = base64ToBytes(m[2]);
          form.append(
            i === 0 ? "image[]" : `image[${i}]`,
            new Blob([bytes.buffer as ArrayBuffer], { type: m[1] }),
            `ref-${i}.png`,
          );
        }
        i += 1;
      }
      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${args.key}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return await parseOpenAiImages(res, size);
    }
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.key}`,
      },
      body: JSON.stringify({ model: args.model, prompt: args.prompt, size, n: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return await parseOpenAiImages(res, size);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function parseOpenAiImages(res: Response, size: string): Promise<Raw> {
  const bodyText = await res.text();
  if (!res.ok) return { ok: false, error: `error ${res.status}: ${bodyText.slice(0, 160)}` };
  const parsed = JSON.parse(bodyText) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const item = parsed.data?.[0];
  if (item?.b64_json) {
    const [w, h] = size.split("x").map(Number);
    return {
      ok: true,
      bytes: base64ToBytes(item.b64_json),
      mimeType: "image/png",
      w,
      h,
    };
  }
  if (item?.url) {
    const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (imgRes.ok) {
      const [w, h] = size.split("x").map(Number);
      return {
        ok: true,
        bytes: new Uint8Array(await imgRes.arrayBuffer()),
        mimeType: imgRes.headers.get("content-type") ?? "image/png",
        w,
        h,
      };
    }
  }
  return { ok: false, error: "no image in response" };
}

function nearestOpenAiSize(w: number, h: number): string {
  const sizes = ["1024x1024", "1536x1024", "1024x1536"];
  if (w > h) return "1536x1024";
  if (h > w) return "1024x1536";
  return sizes[0];
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
