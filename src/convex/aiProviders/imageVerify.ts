/**
 * Image response verification — pure, zero network, unit-tested.
 *
 * The single rule this enforces: an operation is NOT successful unless a real
 * image came back. Providers occasionally return an HTML error page, a JSON
 * error body, a zero-byte body or a truncated payload with an `image/*`
 * content-type header. Passing any of those to storage as "the result" is how
 * a product shows a broken image (or a fake success) to a user.
 *
 * `verifyImageBytes` inspects the actual bytes:
 *   • rejects empty / suspiciously small bodies
 *   • rejects HTML/JSON/text signatures
 *   • requires a recognised image signature (PNG/JPEG/WebP/GIF) — the header
 *     MIME type is a hint, the magic bytes are the evidence
 *   • recovers real pixel dimensions when the format lets us (PNG/GIF)
 *
 * It never throws: callers get an explicit `{ ok: false, reason }` they can
 * surface honestly.
 */

export type ImageFormat = "png" | "jpeg" | "webp" | "gif";

export type VerifyResult =
  | { ok: true; format: ImageFormat; mimeType: string; width?: number; height?: number; bytes: number }
  | { ok: false; reason: string };

/** Bodies under this size are never a legitimate generated image. */
export const MIN_IMAGE_BYTES = 128;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let out = "";
  for (let i = start; i < start + len && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Detect the image format from the leading bytes. Returns null when the body
 * is not a recognised image (which includes HTML/JSON/text error bodies).
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < 4) return null;
  if (startsWith(bytes, PNG_SIG)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  return null;
}

/**
 * Real pixel dimensions when the format makes them cheap to read without a
 * rasterizer. PNG stores them big-endian at offset 16; GIF stores them
 * little-endian at offset 6. JPEG/WebP return undefined (a full parse is not
 * worth it here — the verification verdict does not depend on dimensions).
 */
export function sniffImageDimensions(
  bytes: Uint8Array,
  format: ImageFormat,
): { width: number; height: number } | undefined {
  if (format === "png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }
  if (format === "gif" && bytes.length >= 10) {
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    if (width > 0 && height > 0) return { width, height };
  }
  return undefined;
}

/**
 * Verify a provider's returned bytes are a genuine image. `claimedMime` is
 * advisory: it is reported in the result but never trusted over the signature.
 */
export function verifyImageBytes(
  bytes: Uint8Array | null | undefined,
  claimedMime?: string,
): VerifyResult {
  if (!bytes || bytes.length === 0) {
    return { ok: false, reason: "the provider returned an empty response" };
  }
  if (bytes.length < MIN_IMAGE_BYTES) {
    return { ok: false, reason: `the provider returned ${bytes.length} bytes — too small to be an image` };
  }

  const format = sniffImageFormat(bytes);
  if (format === null) {
    const head = ascii(bytes, 0, 40).trim();
    const lower = head.toLowerCase();
    if (lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.startsWith("<")) {
      return { ok: false, reason: "the provider returned an HTML page instead of an image" };
    }
    if (head.startsWith("{") || head.startsWith("[")) {
      return { ok: false, reason: "the provider returned a data payload instead of an image" };
    }
    return { ok: false, reason: "the provider response was not a recognised image format" };
  }

  const dims = sniffImageDimensions(bytes, format);
  const claimed = (claimedMime ?? "").split(";")[0].trim().toLowerCase();
  return {
    ok: true,
    format,
    // Prefer the sniffed truth; keep a provider's exact sub-type (e.g.
    // image/jpeg) when it agrees on the family.
    mimeType: claimed.startsWith("image/") ? claimed : MIME_BY_FORMAT[format],
    width: dims?.width,
    height: dims?.height,
    bytes: bytes.length,
  };
}
