import { describe, expect, it } from "bun:test";
import {
  classifyFailure,
  dependencyLabel,
  recoveryToast,
  RECOVERY_CODES,
  type Dependency,
  type FailureCode,
} from "@/lib/failureRecovery";

/** Every code the classifier can emit. Listed exhaustively on purpose. */
const ALL_CODES: FailureCode[] = [
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
];

const DEPENDENCIES: Dependency[] = [
  "ai",
  "search",
  "knowledge",
  "image",
  "files",
  "database",
  "auth",
  "network",
  "upload",
  "unknown",
];

describe("error recovery — the contract every surface depends on (Phase 9)", () => {
  it("exposes exactly the codes the tests enumerate", () => {
    expect([...RECOVERY_CODES].sort()).toEqual([...ALL_CODES].sort());
  });

  it("every code yields WHAT HAPPENED and WHAT TO DO NEXT, never empty", () => {
    for (const code of ALL_CODES) {
      const r = classifyFailure({ dependency: "ai", code });
      expect(r.code).toBe(code);
      expect(r.whatHappened.length).toBeGreaterThan(20);
      expect(r.whatToDoNext.length).toBeGreaterThan(20);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  it("every code is retryable or explicitly not, and waiting codes say how long", () => {
    for (const code of ALL_CODES) {
      const r = classifyFailure({ dependency: "ai", code });
      expect(typeof r.retryable).toBe("boolean");
      expect(["neutral", "warning", "critical"]).toContain(r.tone);
      if (code === "rate_limited" || code === "timeout" || code === "server_error") {
        expect(r.retryAfterMs).toBeGreaterThan(0);
      }
    }
  });

  it("never leaks raw server jargon into user-facing copy", () => {
    // Provider names, status codes, stack-ish words and URLs must not appear
    // in the text a user reads.
    const banned = [
      /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|stack|TypeError|undefined is not)\b/i,
      /\b(401|403|429|500|502|503)\b/,
      /\b(groq|gemini|openai|anthropic|pollinations|convex)\b/i,
      /https?:\/\//,
    ];
    for (const code of ALL_CODES) {
      const r = classifyFailure({ dependency: "ai", code });
      const copy = `${r.title} ${r.whatHappened} ${r.whatToDoNext}`;
      for (const re of banned) expect(copy).not.toMatch(re);
    }
  });

  it("never throws for any dependency x any error input", () => {
    const nasty: unknown[] = [
      undefined,
      null,
      "",
      "boom",
      new Error("nope"),
      { message: "x" },
      { message: "x", cause: "y", code: "ENOENT" },
      Symbol("s"),
      42,
      [1, 2, 3],
    ];
    for (const d of DEPENDENCIES) {
      for (const e of nasty) {
        expect(() => classifyFailure({ dependency: d, error: e })).not.toThrow();
      }
    }
  });

  it("always returns a complete recovery, even with no error at all", () => {
    const r = classifyFailure({ dependency: "search" });
    expect(r.code).toBe("unknown");
    expect(r.whatHappened.length).toBeGreaterThan(20);
    expect(r.whatToDoNext.length).toBeGreaterThan(20);
  });
});

describe("error recovery — classification correctness", () => {
  it("separates 'wait for the free tier' from 'add billing' (Phase 6 honesty)", () => {
    const quota = classifyFailure({
      dependency: "image",
      error: "gemini: free-tier quota is exhausted right now — retry later or enable billing",
    });
    expect(quota.code).toBe("quota_exhausted");
    expect(quota.retryable).toBe(true);

    const credits = classifyFailure({
      dependency: "image",
      error: "openai: the account has no remaining credits — billing must be enabled",
    });
    expect(credits.code).toBe("credit_exhausted");
    expect(credits.retryable).toBe(false);
  });

  it("maps session problems to sign-in, not to a generic error", () => {
    expect(classifyFailure({ dependency: "ai", statusCode: 401 }).code).toBe("auth");
    expect(classifyFailure({ dependency: "ai", error: "Unauthorized" }).code).toBe("auth");
    expect(classifyFailure({ dependency: "knowledge", error: "Forbidden" }).code).toBe("forbidden");
    expect(classifyFailure({ dependency: "knowledge", statusCode: 403 }).code).toBe("forbidden");
  });

  it("maps rate limiting before generic server errors", () => {
    expect(classifyFailure({ dependency: "search", statusCode: 429 }).code).toBe("rate_limited");
    expect(classifyFailure({ dependency: "ai", error: "rate limit exceeded" }).code).toBe("rate_limited");
  });

  it("maps transport problems to timeout, then network, then offline", () => {
    expect(classifyFailure({ dependency: "ai", error: "Request timed out" }).code).toBe("timeout");
    expect(classifyFailure({ dependency: "search", error: "fetch failed" }).code).toBe("network");
    expect(classifyFailure({ dependency: "ai", error: "browser is offline" }).code).toBe("offline");
  });

  it("treats an abort as a deliberate stop, not a failure (Stop button)", () => {
    const r = classifyFailure({ dependency: "ai", error: "The operation was aborted" });
    expect(r.code).toBe("cancelled");
    expect(r.retryable).toBe(true);
    expect(r.tone).toBe("neutral");
  });

  it("distinguishes upload size, type and corruption problems", () => {
    expect(classifyFailure({ dependency: "upload", error: "file is too large" }).code).toBe("file_too_large");
    expect(classifyFailure({ dependency: "upload", statusCode: 415 }).code).toBe("unsupported_file");
    expect(classifyFailure({ dependency: "files", error: "the file is password protected" }).code).toBe("invalid_file");
    expect(classifyFailure({ dependency: "files", error: "corrupt pdf" }).code).toBe("invalid_file");
  });

  it("does not blame the file when a text-extraction step is what failed", () => {
    const r = classifyFailure({ dependency: "files", error: "could not extract text from the pdf" });
    expect(r.code).toBe("parse_failed");
    expect(r.retryable).toBe(false);
  });

  it("names the exhausted provider chain rather than pretending a fallback exists", () => {
    const r = classifyFailure({
      dependency: "ai",
      error: "all providers failed; provider chain groq → gemini → openai exhausted",
    });
    expect(r.code).toBe("provider_unavailable");
  });

  it("maps 5xx to a service error and 404 to not-found", () => {
    expect(classifyFailure({ dependency: "database", statusCode: 503 }).code).toBe("server_error");
    expect(classifyFailure({ dependency: "files", statusCode: 404 }).code).toBe("not_found");
  });

  it("never promises a fabricated answer when everything failed (Phase 7 rule)", () => {
    const r = classifyFailure({ dependency: "ai", code: "provider_unavailable" });
    expect(r.whatToDoNext.toLowerCase()).toContain("rather than invent");
  });
});

describe("error recovery — presentation helpers", () => {
  it("toast is title plus the next step, so a toast alone is actionable", () => {
    const toast = recoveryToast(classifyFailure({ dependency: "search", code: "rate_limited" }));
    expect(toast).toContain("Too many requests");
    expect(toast.split(" — ")[1].length).toBeGreaterThan(20);
  });

  it("every dependency has a human label", () => {
    for (const d of DEPENDENCIES) {
      const label = dependencyLabel(d);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/[_-]/);
    }
  });
});
