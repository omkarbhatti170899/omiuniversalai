/**
 * Error recovery (Phase 9).
 *
 * Every external dependency in Omi — AI providers, Andromeda search, image
 * generation, Convex, file parsing, the network — can fail. This module is the
 * single place that turns a raw failure into something a person can act on.
 *
 * The contract, enforced by unit tests:
 *
 *   • WHAT HAPPENED      — plain language, never raw server jargon.
 *   • WHAT TO DO NEXT    — at least one concrete, user-side action.
 *   • retryable          — whether pressing the same button can work.
 *   • retryAfterMs       — how long to wait, when waiting is the fix.
 *
 * Nothing here throws, and nothing here can return an empty explanation: a
 * UI that calls it always has something to show, so no surface can get stuck.
 */

export type Dependency =
  | "ai"
  | "search"
  | "knowledge"
  | "image"
  | "files"
  | "database"
  | "auth"
  | "network"
  | "upload"
  | "unknown";

export type FailureCode =
  | "auth"
  | "forbidden"
  | "rate_limited"
  | "quota_exhausted"
  | "credit_exhausted"
  | "timeout"
  | "network"
  | "offline"
  | "provider_unavailable"
  | "server_error"
  | "not_found"
  | "invalid_request"
  | "invalid_file"
  | "file_too_large"
  | "unsupported_file"
  | "parse_failed"
  | "storage_full"
  | "cancelled"
  | "unknown";

export type Recovery = {
  code: FailureCode;
  /** Human title for the problem. */
  title: string;
  /** WHAT HAPPENED — no stack traces, no provider names, no status codes. */
  whatHappened: string;
  /** WHAT TO DO NEXT — concrete, user-side, at least one option. */
  whatToDoNext: string;
  /** Whether simply retrying can plausibly succeed. */
  retryable: boolean;
  /** Suggested wait before retrying, when waiting is the remedy. */
  retryAfterMs?: number;
  /** Severity for UI tone: neutral / warning / critical. */
  tone: "neutral" | "warning" | "critical";
};

export type ClassifyInput = {
  dependency: Dependency;
  error?: unknown;
  statusCode?: number;
  /** Override the classification entirely (e.g. user pressed Stop). */
  code?: FailureCode;
};

/**
 * Every code the classifier can return. Exported so tests can assert the
 * union is fully covered — a new code without a recovery block would
 * otherwise fail only at runtime, on a user's screen.
 */
export const RECOVERY_CODES: readonly FailureCode[] = [
  "auth",
  "forbidden",
  "rate_limited",
  "quota_exhausted",
  "credit_exhausted",
  "timeout",
  "network",
  "offline",
  "provider_unavailable",
  "server_error",
  "not_found",
  "invalid_request",
  "invalid_file",
  "file_too_large",
  "unsupported_file",
  "parse_failed",
  "storage_full",
  "cancelled",
  "unknown",
] as const;

function textOf(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    const parts = [e.message, e.code, e.status, e.name, e.type];
    if (typeof e.cause === "string") parts.push(e.cause);
    return parts.filter((p) => typeof p === "string").join(" ");
  }
  return String(error);
}

const DEP_LABEL: Record<Dependency, string> = {
  ai: "the AI provider",
  search: "web search",
  knowledge: "your knowledge base",
  image: "the image provider",
  files: "file reading",
  database: "Omi's database",
  auth: "your session",
  network: "the network",
  upload: "the upload",
  unknown: "this feature",
};

const RECOVERIES: Record<FailureCode, Omit<Recovery, "code">> = {
  auth: {
    title: "Signed out",
    whatHappened: "Omi lost track of your session, so it stopped the request before doing any work.",
    whatToDoNext: "Sign in again — your data is untouched — then repeat what you asked.",
    retryable: true,
    tone: "warning",
  },
  forbidden: {
    title: "Not allowed",
    whatHappened: "This account does not have permission to open that item.",
    whatToDoNext: "Switch to the workspace or project that owns it, or ask an admin for access.",
    retryable: false,
    tone: "warning",
  },
  rate_limited: {
    title: "Too many requests",
    whatHappened: "Omi hit the provider's rate limit and paused rather than queueing work behind your back.",
    whatToDoNext: "Wait a few seconds, then press Retry. Nothing was lost — your request was not sent.",
    retryable: true,
    retryAfterMs: 4000,
    tone: "warning",
  },
  quota_exhausted: {
    title: "Provider quota used up",
    whatHappened: "The free tier of the selected provider is exhausted for this period.",
    whatToDoNext: "Wait for the quota to reset, or add billing to that provider in your keys settings. Other Omi features keep working.",
    retryable: true,
    retryAfterMs: 60_000,
    tone: "warning",
  },
  credit_exhausted: {
    title: "Provider credits exhausted",
    whatHappened: "The selected provider reports no remaining credits, so it refused the request.",
    whatToDoNext: "Add credits or enable billing for that provider, or pick a different provider in Settings. Omi will not fabricate a result instead.",
    retryable: false,
    tone: "critical",
  },
  timeout: {
    title: "Took too long",
    whatHappened: "Omi waited for a reply that never arrived and stopped waiting.",
    whatToDoNext: "Retry — this is usually transient. If it repeats, narrow the request (one file, one topic) or choose a faster provider.",
    retryable: true,
    retryAfterMs: 1500,
    tone: "warning",
  },
  network: {
    title: "Connection lost",
    whatHappened: "Omi could not reach the service, most likely a dropped or blocked connection.",
    whatToDoNext: "Check your connection and press Retry. Omi did not send a partial result.",
    retryable: true,
    tone: "warning",
  },
  offline: {
    title: "You are offline",
    whatHappened: "The device reports no network connection, so Omi paused instead of showing a stale answer.",
    whatToDoNext: "Reconnect and press Retry. Anything you typed is still in the composer.",
    retryable: true,
    tone: "warning",
  },
  provider_unavailable: {
    title: "Provider unavailable",
    whatHappened: "Every configured provider for this task failed, so Omi has no answer to give.",
    whatToDoNext: "Try again shortly, or switch provider in Settings → AI. Omi will show the failure rather than invent a substitute answer.",
    retryable: true,
    retryAfterMs: 3000,
    tone: "critical",
  },
  server_error: {
    title: "Service error",
    whatHappened: "The service accepted the request but failed while working on it.",
    whatToDoNext: "Retry once. If it keeps failing, the issue is on the service side — try again later or report it.",
    retryable: true,
    retryAfterMs: 2500,
    tone: "critical",
  },
  not_found: {
    title: "Not found",
    whatHappened: "The item this action refers to no longer exists, or it was never shared with this account.",
    whatToDoNext: "Go back and pick the item from the list — the list only ever shows your own items.",
    retryable: false,
    tone: "neutral",
  },
  invalid_request: {
    title: "Request not understood",
    whatHappened: "Omi rejected the request before sending it because part of it was missing or malformed.",
    whatToDoNext: "Check the required fields and try again. Nothing was sent anywhere.",
    retryable: false,
    tone: "warning",
  },
  invalid_file: {
    title: "File could not be read",
    whatHappened: "Omi could not decode that file — it is damaged, password-protected, or not really the format it claims.",
    whatToDoNext: "Open the file on your device to confirm it opens, then attach it again. PDF, DOCX, XLSX, CSV, TXT, MD, code files and images are supported.",
    retryable: false,
    tone: "warning",
  },
  file_too_large: {
    title: "File too large",
    whatHappened: "That file is above the size Omi accepts in one upload, so it was not sent.",
    whatToDoNext: "Split it, compress it, or send the relevant section. Omi reports this before uploading, so no time was wasted.",
    retryable: false,
    tone: "warning",
  },
  unsupported_file: {
    title: "Unsupported file type",
    whatHappened: "Omi does not know how to read that file format, so it skipped it rather than guessing.",
    whatToDoNext: "Convert it to PDF, DOCX, XLSX, CSV, TXT or Markdown and attach that instead.",
    retryable: false,
    tone: "warning",
  },
  parse_failed: {
    title: "Could not extract text",
    whatHappened: "The file uploaded fine, but Omi could not pull readable text out of it — it is likely a scan without OCR text, or an image-only PDF.",
    whatToDoNext: "Attach an OCR'd version or paste the text directly. Omi will not answer from a file it could not actually read.",
    retryable: false,
    tone: "warning",
  },
  storage_full: {
    title: "Storage full",
    whatHappened: "There is no room left in Omi's file storage, so the upload was not kept.",
    whatToDoNext: "Delete old files from Files, then upload again.",
    retryable: false,
    tone: "critical",
  },
  cancelled: {
    title: "Stopped",
    whatHappened: "You stopped this before it finished, so Omi discarded the partial result instead of saving a half-answer.",
    whatToDoNext: "Press Retry to run it again, or Regenerate for a fresh attempt.",
    retryable: true,
    tone: "neutral",
  },
  unknown: {
    title: "Something went wrong",
    whatHappened: "Omi hit an error it does not recognise and stopped rather than showing you a wrong or empty answer.",
    whatToDoNext: "Try once more. If it keeps happening, open Settings → AI and check the provider status, then report it with the time it occurred.",
    retryable: true,
    retryAfterMs: 2000,
    tone: "warning",
  },
};

/**
 * Map a raw failure to a user-facing recovery. Order matters: the most
 * specific, most actionable signal wins. Always returns a complete object.
 */
export function classifyFailure(input: ClassifyInput): Recovery {
  const { dependency, statusCode } = input;
  const raw = textOf(input.error);
  const msg = raw.toLowerCase();
  const label = DEP_LABEL[dependency];

  const pick = (code: FailureCode): Recovery => ({ code, ...RECOVERIES[code] });

  if (input.code) return pick(input.code);

  // 1. Explicit cancellation — the user asked for it, so it is not an error.
  if (msg.includes("abort") || msg.includes("cancelled") || msg.includes("canceled")) {
    return pick("cancelled");
  }

  // 2. Offline / connectivity before anything else.
  if (msg.includes("offline") || msg.includes("no internet") || msg.includes("network is offline")) {
    return pick("offline");
  }

  // 3. Auth / authorization.
  if (
    statusCode === 401 ||
    msg.includes("unauthorized") ||
    msg.includes("not authenticated") ||
    msg.includes("invalid token") ||
    msg.includes("session expired")
  ) {
    return pick("auth");
  }
  if (
    statusCode === 403 ||
    msg.includes("forbidden") ||
    msg.includes("permission denied") ||
    msg.includes("unauthorized access")
  ) {
    return pick("forbidden");
  }

  // 4. Provider money/quota limits — must be distinguished, because one is
  //    "wait for the free tier to reset" and the other is "add billing".
  //    The multi-line chain message that Convex produces mentions BOTH, so the
  //    stronger signal (credits) has to be tested first.
  if (
    msg.includes("no remaining credits") ||
    msg.includes("no credits") ||
    msg.includes("insufficient credits") ||
    msg.includes("billing must be enabled") ||
    msg.includes("insufficient_quota")
  ) {
    return pick("credit_exhausted");
  }
  if (
    msg.includes("quota is exhausted") ||
    msg.includes("quota exceeded") ||
    msg.includes("free-tier quota") ||
    msg.includes("free-tier quota is exhausted") ||
    msg.includes("exceeded your current quota")
  ) {
    return pick("quota_exhausted");
  }

  // 5. Rate limiting.
  if (statusCode === 429 || msg.includes("rate limit") || msg.includes("too many requests")) {
    return pick("rate_limited");
  }

  // 6. Timeouts and transport failures.
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("etimedout") ||
    msg.includes("deadline exceeded")
  ) {
    return pick("timeout");
  }
  if (
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket hang up")
  ) {
    return pick("network");
  }

  // 7. Dependency-specific signals.
  if (dependency === "upload" || dependency === "files") {
    if (statusCode === 413 || msg.includes("too large") || msg.includes("exceeds")) {
      return pick("file_too_large");
    }
    if (statusCode === 415 || msg.includes("unsupported") || msg.includes("mime")) {
      return pick("unsupported_file");
    }
    // A text-extraction failure is NOT a corrupt file: the upload was fine and
    // blaming the user's file would be wrong. Check it first.
    if (
      msg.includes("extract") ||
      msg.includes("parsing") ||
      msg.includes("parse") ||
      msg.includes("no text")
    ) {
      return pick("parse_failed");
    }
    if (
      (msg.includes("password") && msg.includes("protect")) ||
      msg.includes("corrupt") ||
      msg.includes("decode") ||
      msg.includes("malformed")
    ) {
      return pick("invalid_file");
    }
  }
  if (msg.includes("no text") || msg.includes("could not extract")) return pick("parse_failed");

  // 8. Server-side failures.
  if (statusCode === 404) return pick("not_found");
  if (statusCode === 400 || msg.includes("validation") || msg.includes("invalid argument") || msg.includes("invalid_request")) {
    return pick("invalid_request");
  }
  if (statusCode !== undefined && statusCode >= 500) return pick("server_error");
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("internal error") ||
    msg.includes("service unavailable")
  ) {
    return pick("server_error");
  }
  if (msg.includes("all providers") || msg.includes("no provider") || msg.includes("every provider") || msg.includes("provider chain")) {
    return pick("provider_unavailable");
  }
  if (msg.includes("quota") || msg.includes("storage") || msg.includes("no space")) {
    return msg.includes("no space") ? pick("storage_full") : pick("quota_exhausted");
  }

  // 9. Nothing matched: still a complete, honest explanation.
  const base = pick("unknown");
  if (raw.length > 0) {
    // Keep a short, sanitized technical tail for support, but never as the
    // headline and never as the only instruction.
    return { ...base, whatHappened: `${base.whatHappened} (${label} reported an error.)` };
  }
  return base;
}

/** One-line summary suitable for a toast. */
export function recoveryToast(r: Recovery): string {
  return `${r.title} — ${r.whatToDoNext}`;
}

/** The label for this dependency, exported for UI that names subsystems. */
export function dependencyLabel(d: Dependency): string {
  return DEP_LABEL[d];
}
