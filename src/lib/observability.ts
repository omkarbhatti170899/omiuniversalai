/**
 * Client-side observability (Phase 11).
 *
 * Rules this module exists to enforce, not just to document:
 *
 *  1. NOTHING SENSITIVE IS EVER CAPTURED. Every field passes through
 *     `redact()` before it reaches a sink. API keys, bearer tokens, JWTs,
 *     passwords, cookies, emails, absolute user paths and long opaque
 *     strings are replaced with a stable marker so a log line can never
 *     become a secret-exfiltration channel.
 *  2. USER CONTENT IS NOT LOGGED BY DEFAULT. Only *shape* metadata
 *     (length, counts, hashes) may leave the client. Callers that want to
 *     record a query pass `summarize()` (length + short hash), never the
 *     raw string.
 *  3. TELEMETRY MUST NEVER BREAK THE APP. Every sink is wrapped; a sink
 *     that throws is dropped, not retried, and never propagates.
 *  4. THE BUFFER IS BOUNDED. A long session cannot grow memory without
 *     limit, so the ring buffer keeps only the newest N events.
 */

/** Marker written in place of a redacted value. */
export const REDACTED = "[redacted]";

/**
 * Field names that are dropped outright (not just masked) when present.
 * Matched against a camelCase-normalised key, so `sessionToken`,
 * `apiKey` and `refresh_token` are all caught — testing the raw string would
 * miss every camelCase spelling, which is how secrets leak.
 */
const SENSITIVE_KEY_RE =
  /(^|_)(password|passwd|pwd|secret|token|apikey|api_key|access_key|private_key|signing_key|client_secret|authorization|auth|cookie|session|credential|refresh|otp|pin|signature|bearer)($|_)/;

/** Insert a separator at every camelCase boundary for key matching. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Keys that merely LOOK sensitive after normalization but are safe counters.
 * `auth_failed` is a telemetry counter, not a credential.
 */
const SAFE_KEY_ALLOWLIST = new Set([
  "auth_failed",
  "auth_status",
  "session_count",
  "token_count",
]);

/**
 * Value-shaped secret patterns. Each one is a real credential format used by
 * a provider Omi actually integrates with, or a generic auth header.
 */
const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Provider API keys: OpenAI sk-…, Groq gsk_…, Google AIza…, Anthropic sk-ant-…
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replacement: `${REDACTED}:anthropic-key` },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: `${REDACTED}:openai-style-key` },
  { re: /\bgsk_[A-Za-z0-9]{16,}/g, replacement: `${REDACTED}:groq-key` },
  { re: /\bAIza[A-Za-z0-9_-]{20,}/g, replacement: `${REDACTED}:google-key` },
  { re: /\bhf_[A-Za-z0-9]{16,}/g, replacement: `${REDACTED}:huggingface-key` },
  { re: /\bpk-[A-Za-z0-9_-]{8,}/g, replacement: `${REDACTED}:publishable-key` },
  // Auth headers: Bearer <jwt|opaque>, Basic <base64>
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
  // JSON Web Tokens (three dot-separated base64url segments)
  {
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g,
    replacement: `${REDACTED}:jwt`,
  },
  // key=value / key: value assignments for sensitive names
  {
    re:
      /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // Cookie-ish header
  { re: /\b(set-)?cookie\s*[:=]\s*[^\s;]+/gi, replacement: `cookie=${REDACTED}` },
  // Email addresses (personal data — not a credential, but never needed in a log)
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: `${REDACTED}:email`,
  },
];

/** Hex/base64 blobs long enough to be an opaque credential or hash. */
const OPAQUE_BLOB_RE = /\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

/** Posix home paths reveal a username. */
const HOME_PATH_RE = /\/(?:home|Users)\/[A-Za-z0-9._-]+/g;

/**
 * Mask secrets inside a free-text string. Non-secret text is returned
 * untouched — redaction must never mangle ordinary product copy, or logs
 * become unreadable and therefore useless.
 */
export function redactText(input: string): string {
  if (typeof input !== "string" || input.length === 0) return "";
  let out = input;
  for (const { re, replacement } of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  out = out.replace(HOME_PATH_RE, `${REDACTED}:home`);
  // Only collapse long opaque blobs that are NOT ordinary prose/URLs.
  out = out.replace(OPAQUE_BLOB_RE, (match) => {
    // A bare URL path segment is not a secret.
    if (/^https?:\/\//i.test(match)) return match;
    if (/[.\-_/]/.test(match)) return match; // looks like a word or path piece
    return `${REDACTED}:opaque`;
  });
  return out;
}

/**
 * Redact an arbitrary log payload: sensitive *keys* are dropped, sensitive
 * *values* are masked, functions and symbols are described rather than
 * serialized, and cycles are broken. Never throws.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  // Narrow on `value` itself, not on a cached `typeof` result: TypeScript
  // cannot follow the narrowing through a separate boolean, and would leave
  // the value as `{}`.
  if (typeof value === "string") return redactText(value);
  const t = typeof value;
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function") return "[fn]";
  if (t === "symbol") return "[symbol]";
  if (depth >= 6) return "[depth]";

  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redact(v, depth + 1));
  }
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const norm = normalizeKey(k);
      if (SENSITIVE_KEY_RE.test(norm) && !SAFE_KEY_ALLOWLIST.has(norm)) continue;
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Summarize user-supplied text without recording it: character count, word
 * count and a short non-reversible-ish prefix hash used only for
 * de-duplicating repeated failures.
 */
export function summarize(text: string | null | undefined): {
  length: number;
  words: number;
  hash: string;
} {
  const s = typeof text === "string" ? text : "";
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return {
    length: s.length,
    words: s.length === 0 ? 0 : s.trim().split(/\s+/).length,
    hash: (h >>> 0).toString(36),
  };
}

export type TelemetryEvent = {
  name: string;
  at: number;
  fields: Record<string, unknown>;
};

export type TelemetrySink = (event: TelemetryEvent) => void;

const MAX_EVENTS = 200;
const buffer: TelemetryEvent[] = [];
const sinks = new Set<TelemetrySink>();

/** Register a sink. Returns an unsubscribe function. */
export function addTelemetrySink(sink: TelemetrySink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** Newest events first, for a diagnostics panel. */
export function recentTelemetry(limit = 50): TelemetryEvent[] {
  return buffer.slice(0, Math.max(0, Math.min(limit, MAX_EVENTS)));
}

/** Drop buffered events (tests, sign-out, memory pressure). */
export function clearTelemetry(): void {
  buffer.length = 0;
}

/** Canonical subsystem names, so dashboards group consistently. */
export type Subsystem =
  | "ai"
  | "search"
  | "knowledge"
  | "image"
  | "files"
  | "auth"
  | "ui"
  | "network"
  | "db";

/**
 * Record one telemetry event. `fields` is redacted before it is stored or
 * forwarded. A missing or non-object `fields` is recorded as an empty object
 * rather than dropped, so "the event happened" is never lost. Never throws.
 */
export function recordTelemetry(
  name: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    if (typeof name !== "string" || name.length === 0) return;
    const safeName = redactText(name).slice(0, 80);
    const safeFields =
      fields && typeof fields === "object"
        ? (redact(fields) as Record<string, unknown>)
        : {};
    const event: TelemetryEvent = {
      name: safeName,
      at: Date.now(),
      fields: safeFields,
    };
    buffer.unshift(event);
    if (buffer.length > MAX_EVENTS) buffer.length = MAX_EVENTS;
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        // A broken sink must never surface to the user.
      }
    }
  } catch {
    // Telemetry is best-effort by contract.
  }
}

/** Convenience wrapper that stamps the subsystem automatically. */
export function recordSubsystemEvent(
  subsystem: Subsystem,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  recordTelemetry(`${subsystem}.${event}`, fields);
}

/**
 * Time an async operation and record the outcome. Errors are re-thrown so
 * the caller's own handling still runs — the measurement is a side effect.
 */
export async function measure<T>(
  name: string,
  fn: () => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    recordTelemetry(name, { ...extra, ok: true, ms: Date.now() - started });
    return result;
  } catch (err) {
    recordTelemetry(name, {
      ...extra,
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Rolling percentile summary for latency reporting. */
export function latencySummary(samples: number[]): {
  count: number;
  p50: number;
  p95: number;
  max: number;
} {
  const clean = samples.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const at = (p: number) => clean[Math.min(clean.length - 1, Math.floor(p * clean.length))];
  return { count: clean.length, p50: at(0.5), p95: at(0.95), max: clean[clean.length - 1] };
}
