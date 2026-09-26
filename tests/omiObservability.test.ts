import { describe, expect, it, beforeEach } from "bun:test";
import {
  REDACTED,
  addTelemetrySink,
  clearTelemetry,
  latencySummary,
  measure,
  recentTelemetry,
  recordSubsystemEvent,
  recordTelemetry,
  redact,
  redactText,
  summarize,
} from "@/lib/observability";

describe("observability — secrets are never captured (Phase 11)", () => {
  it("masks provider API keys of every shape Omi integrates with", () => {
    const samples: Array<[string, string]> = [
      ["key=sk-proj-abcdefghijklmnopqrstuvwxyz012345", "sk-proj-abcdefghijklmno"],
      ["token gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234", "gsk_ABCDEFGHIJKLMNOPQRST"],
      ["google AIzaSyD-1234567890abcdefghijklmnopqrstuv", "AIzaSyD-1234567890abcd"],
      ["hf_abcdefghijklmnopqrstuvwxyz1234", "hf_abcdefghijklmnopqrstu"],
      ["anthropic sk-ant-api03-abcdefghijklmnop", "sk-ant-api03-abcdefgh"],
    ];
    for (const [input, secret] of samples) {
      const out = redactText(input);
      expect(out).toContain(REDACTED);
      // The secret body itself must be gone.
      expect(out).not.toContain(secret);
    }
  });

  it("masks bearer headers and JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP";
    expect(redactText(`Authorization: Bearer ${jwt}`)).not.toContain("eyJhbGci");
    expect(redactText(`token ${jwt}`)).not.toContain("dBjftJeZ4CVP");
    expect(redactText("Basic YWRtaW46cGFzc3dvcmQxMjM=")).toContain(REDACTED);
  });

  it("masks password and secret assignments in free text", () => {
    const out = redactText("login failed: password=hunter2 secret: s3cr3t-value");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("s3cr3t-value");
  });

  it("masks cookie headers and personal email addresses", () => {
    expect(redactText("Cookie: session=abc123def")).not.toContain("abc123def");
    expect(redactText("owner omkar.bhatti@example.com")).toContain(`${REDACTED}:email`);
  });

  it("masks absolute home paths that reveal a username", () => {
    const out = redactText("failed reading /home/omkarbhatti/Documents/notes.pdf");
    expect(out).not.toContain("omkarbhatti");
  });

  it("masks long opaque credential blobs", () => {
    const blob = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    expect(redactText(`token value ${blob}`)).not.toContain(blob);
  });

  it("NEVER mangles ordinary product copy — over-redaction destroys the logs", () => {
    const safe = [
      "Omi could not reach the AI provider. Try again in a moment.",
      "Search returned 3 results in 236 ms via Wikipedia.",
      "Q3 revenue was 210,000, up from 150,000 in Q2.",
      "Visit https://nodejs.org/en/about/previous-releases for the release list.",
      "Free-tier quota is exhausted right now.",
    ];
    for (const s of safe) expect(redactText(s)).toBe(s);
  });
});

describe("observability — payload redaction", () => {
  it("drops sensitive keys entirely rather than masking their values", () => {
    const out = redact({
      userId: "u1",
      apiKey: "sk-live-abcdefghijklmnop",
      password: "hunter2",
      authorization: "Bearer abc",
      sessionToken: "xyz",
      refreshToken: "r1",
      api_key: "sk-abcdefghijklmnop",
      clientSecret: "s",
      ok: true,
    }) as Record<string, unknown>;
    expect(out.userId).toBe("u1");
    expect(out.ok).toBe(true);
    for (const banned of [
      "apiKey",
      "password",
      "authorization",
      "sessionToken",
      "refreshToken",
      "api_key",
      "clientSecret",
    ]) {
      expect(Object.keys(out)).not.toContain(banned);
    }
  });

  it("keeps look-alike safe keys", () => {
    const out = redact({ authFailed: true, authStatus: 401, tokenCount: 3 }) as Record<string, unknown>;
    expect(out.authFailed).toBe(true);
    expect(out.authStatus).toBe(401);
    expect(out.tokenCount).toBe(3);
  });

  it("redacts nested structures, arrays, errors and dates", () => {
    const out = redact({
      providers: [{ name: "groq", api_key: "sk-abcdefghijklmnopqrst" }],
      err: new Error("upstream failed for sk-abcdefghijklmnopqrst"),
      at: new Date("2026-01-01T00:00:00.000Z"),
    }) as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-abcdefghijklmnopqrst");
    expect((out.at as string).startsWith("2026-01-01")).toBe(true);
  });

  it("survives circular references, functions and symbols without throwing", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    circular.fn = () => 1;
    circular.sym = Symbol("x");
    circular.big = 10n;
    expect(() => redact(circular)).not.toThrow();
    const out = redact(circular) as Record<string, unknown>;
    expect(out.fn).toBe("[fn]");
    expect(out.big).toBe("10");
  });
});

describe("observability — never logs user content, only its shape", () => {
  it("summarize records size and a fingerprint, never the text", () => {
    const secret = "my private medical results and salary are 250000 per year";
    const s = summarize(secret);
    expect(s.length).toBe(secret.length);
    expect(s.words).toBeGreaterThan(0);
    expect(s.hash.length).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain("medical");
  });

  it("summarize is stable for identical input and differs for different input", () => {
    expect(summarize("abc").hash).toBe(summarize("abc").hash);
    expect(summarize("abc").hash).not.toBe(summarize("abd").hash);
  });

  it("summarize tolerates null and undefined", () => {
    expect(summarize(null).length).toBe(0);
    expect(summarize(undefined).hash).toBeTypeOf("string");
  });
});

describe("observability — recording is safe and bounded", () => {
  beforeEach(() => clearTelemetry());

  it("records an event with redacted fields", () => {
    recordTelemetry("search.failed", { query: "sk-live-abcdefghijklmnop", ok: false });
    const [event] = recentTelemetry();
    expect(event.name).toBe("search.failed");
    expect(JSON.stringify(event.fields)).not.toContain("sk-live-abcdefghijklmnop");
  });

  it("buffers newest first and caps at 200 events", () => {
    for (let i = 0; i < 260; i++) recordTelemetry(`e${i}`);
    const events = recentTelemetry(500);
    expect(events.length).toBe(200);
    expect(events[0].name).toBe("e259");
  });

  it("namespaces by subsystem", () => {
    recordSubsystemEvent("image", "provider.fail", { provider: "pollinations" });
    expect(recentTelemetry()[0].name).toBe("image.provider.fail");
  });

  it("ignores an empty event name instead of recording garbage", () => {
    expect(() => recordTelemetry("")).not.toThrow();
    expect(() => recordTelemetry(undefined as unknown as string)).not.toThrow();
    expect(recentTelemetry().length).toBe(0);
  });

  it("records the event even when fields are missing or not an object", () => {
    clearTelemetry();
    expect(() =>
      recordTelemetry("ui.click", undefined as unknown as Record<string, unknown>),
    ).not.toThrow();
    expect(() =>
      recordTelemetry("ui.tap", null as unknown as Record<string, unknown>),
    ).not.toThrow();
    const events = recentTelemetry();
    // Newest first: the event still happened, only its payload was lost.
    expect(events[0].name).toBe("ui.tap");
    expect(events[0].fields).toEqual({});
  });

  it("a throwing sink cannot break the app or the other sinks", () => {
    const seen: string[] = [];
    const off1 = addTelemetrySink(() => {
      throw new Error("sink is broken");
    });
    const off2 = addTelemetrySink((e) => seen.push(e.name));
    expect(() => recordTelemetry("still.recorded")).not.toThrow();
    off1();
    off2();
    expect(seen).toEqual(["still.recorded"]);
  });

  it("unsubscribing removes a sink", () => {
    const seen: string[] = [];
    const off = addTelemetrySink((e) => seen.push(e.name));
    recordTelemetry("a");
    off();
    recordTelemetry("b");
    expect(seen).toEqual(["a"]);
  });
});

describe("observability — latency", () => {
  it("records duration and success, and returns the value", async () => {
    clearTelemetry();
    const out = await measure("ai.first_token", async () => 42);
    expect(out).toBe(42);
    const [event] = recentTelemetry();
    expect(event.fields.ok).toBe(true);
    expect(typeof event.fields.ms).toBe("number");
  });

  it("records the failure, redacts it, and re-throws so caller handling still runs", async () => {
    clearTelemetry();
    await expect(
      measure("ai.send", async () => {
        throw new Error("upstream rejected sk-live-abcdefghijklmnop");
      }),
    ).rejects.toThrow();
    const [event] = recentTelemetry();
    expect(event.fields.ok).toBe(false);
    expect(String(event.fields.error)).not.toContain("sk-live-abcdefghijklmnop");
  });

  it("latencySummary reports count, p50, p95 and max over finite samples", () => {
    const s = latencySummary([10, 20, 30, 40, 50, Number.NaN, -5]);
    expect(s.count).toBe(5);
    expect(s.max).toBe(50);
    expect(s.p50).toBeGreaterThanOrEqual(10);
    expect(s.p95).toBeGreaterThanOrEqual(s.p50);
    expect(latencySummary([]).count).toBe(0);
  });
});
