/**
 * Security layer for the Omi search engine.
 *
 * - SSRF protection: every user- or engine-supplied URL must pass
 *   assertSafeUrl before any network request (including redirect hops).
 * - Input sanitization for queries.
 * - Secret scrubbing for error messages.
 */

const MAX_URL_LENGTH = 2048;
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return true; // malformed → treat as unsafe
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("fe8") || h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("::ffff:")) return isPrivateIPv4(h.slice(7));
  return false;
}

/**
 * Validates a URL is safe to fetch: public http(s) only, no credentials,
 * standard ports, no internal/loopback/link-local/metadata hosts.
 * Throws a plain, user-safe error on violation.
 */
export function assertSafeUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) {
    throw new Error("Invalid or oversized URL.");
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (u.username || u.password) {
    throw new Error("Credentials in URLs are not allowed.");
  }
  if (!ALLOWED_PORTS.has(u.port)) {
    throw new Error("Non-standard ports are not allowed.");
  }
  const host = u.hostname.toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa")
  ) {
    throw new Error("Internal hosts are not allowed.");
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    throw new Error("Private network addresses are blocked (SSRF protection).");
  }
  if (!host.includes(".") && !host.includes(":")) {
    throw new Error("Hostname must be fully qualified.");
  }
  return u;
}

/** Strips control characters and caps length on user queries. */
export function sanitizeQuery(input: string, maxLen = 500): string {
  return input
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Error message safe to show users: capped and with secret shapes redacted. */
export function safeErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/gsk_[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[redacted]")
    .slice(0, 300);
}
