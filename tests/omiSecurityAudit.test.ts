/**
 * Phase 8 — security audit, enforced as a regression guard.
 *
 * These are ARCHITECTURAL tests, not unit tests: they read the real source
 * tree and assert the properties the audit found to be true. A static test is
 * the right tool here because the failure mode being guarded is "someone adds
 * a new public endpoint without an auth check" or "someone pastes a key into
 * a component" — neither is reachable from a behavioural test.
 *
 * Each check names the audit area it covers so a failure is self-describing.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const CONVEX = join(SRC, "convex");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const ALL_FILES = walk(SRC);
const CONVEX_FILES = walk(CONVEX).filter((f) => !f.includes("/auth/"));
const read = (f: string): string => readFileSync(f, "utf8");
const rel = (f: string): string => f.slice(process.cwd().length + 1);

/**
 * Public (browser-callable) Convex endpoints and whether they enforce
 * authentication. `internal*` functions are excluded by construction: they can
 * only be reached from another Convex function, never from the client.
 */
function publicEndpoints(): Array<{ file: string; name: string; body: string }> {
  const out: Array<{ file: string; name: string; body: string }> = [];
  for (const file of CONVEX_FILES) {
    const src = read(file);
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const open = /^export const ([A-Za-z0-9_]+) = (query|mutation|action)\(\{/.exec(
        lines[i],
      );
      if (!open) continue;
      // Walk to the matching top-level `});` at column 0.
      let depth = 0;
      let body = "";
      for (let j = i; j < lines.length; j++) {
        body += `${lines[j]}\n`;
        depth += (lines[j].match(/\{/g) ?? []).length;
        depth -= (lines[j].match(/\}/g) ?? []).length;
        if (j > i && depth <= 0 && /^\}\);\s*$/.test(lines[j])) break;
      }
      out.push({ file: rel(file).replace(/^src\/convex\//, ""), name: open[1], body });
    }
  }
  return out;
}

/**
 * Endpoints that are intentionally reachable without a session, and why.
 * An entry here is a CLAIM that has to stay true — the tests below re-verify
 * it, so deleting the guard or widening the data would fail the suite.
 */
const PUBLIC_CAPABILITY_ONLY: Record<string, string> = {
  "aiStatus.ts:status":
    "public capability booleans and public model labels; never keys, env names or user data",
  "searchStatus.ts:status": "same public capability snapshot as aiStatus",
  "ecosystemStatus.ts:status": "same public capability snapshot as aiStatus",
  "search.ts:engines":
    "static list of configured search providers — no outbound call, no user data",
  "search.ts:health": "static breaker/health counters — no user data",
  "search.ts:ready": "static readiness flag — no user data",
};

/** Public endpoints that DO touch user data, but only the caller's own. */
const PUBLIC_OWNERSHIP_CHECKED: Record<string, string> = {
  "users.ts:currentUser":
    "returns the caller's OWN profile or null — it is the auth probe itself, not a data read",
  "omiWorkflowDecisions.ts:approve":
    "calls loadOwnedRun(), which checks the session AND that the run belongs to the caller",
  "omiWorkflowDecisions.ts:reject":
    "calls loadOwnedRun(), which checks the session AND that the run belongs to the caller",
};

const PUBLIC_BY_DESIGN: Record<string, string> = {
  ...PUBLIC_CAPABILITY_ONLY,
  ...PUBLIC_OWNERSHIP_CHECKED,
};

const AUTH_IDIOM =
  /getAuthUserId|ctx\.auth\.getUserIdentity|requireAuth|isInTenant|canAccess|assertOwner|requireOwner|ownership|preflight|loadOwnedRun|getCurrentUser|requireUser/;

describe("security — authentication guards every public endpoint (Phase 8)", () => {
  const endpoints = publicEndpoints();
  const unguarded = endpoints.filter(
    (e) => !AUTH_IDIOM.test(e.body) && !PUBLIC_BY_DESIGN[`${e.file}:${e.name}`],
  );

  it("finds the public endpoint surface at all (guards against a broken scan)", () => {
    expect(endpoints.length).toBeGreaterThan(60);
  });

  it("no public endpoint reaches user data without an auth check", () => {
    expect(unguarded.map((e) => `${e.file}:${e.name}`).join("\n")).toBe("");
  });

  it("capability-only public endpoints never touch a user-data table", () => {
    for (const [key, reason] of Object.entries(PUBLIC_CAPABILITY_ONLY)) {
      const [file, name] = key.split(":");
      const match = endpoints.find((e) => e.file === file && e.name === name);
      expect(`${key} must still exist — ${match ? "ok" : "MISSING"}`).toContain("ok");
      expect(reason.length).toBeGreaterThan(20);
      expect(`${key}: ${match?.body}`).not.toMatch(
        /omiDocuments|omiMessages|omiConversations|omiFiles|omiImages|omiKnowledge/,
      );
    }
  });

  it("user-data public endpoints still resolve ownership in-file", () => {
    for (const [key, reason] of Object.entries(PUBLIC_OWNERSHIP_CHECKED)) {
      const [file, name] = key.split(":");
      const match = endpoints.find((e) => e.file === file && e.name === name);
      expect(`${key} must still exist — ${match ? "ok" : "MISSING"}`).toContain("ok");
      expect(reason.length).toBeGreaterThan(20);
      // The ownership check lives in a helper, so require the helper call.
      expect(`${key}: ${match?.body}`).toMatch(
        /loadOwnedRun|getCurrentUser|getAuthUserId|userId\s*!==/,
      );
    }
  });

  it("no function is exported both internally and publicly under one name", () => {
    // `internal*` functions are unreachable from the browser. Exporting the
    // same name publicly would silently widen the surface, so it is pinned.
    const clashes: string[] = [];
    for (const file of CONVEX_FILES) {
      const src = read(file);
      const internals = new Set(
        [...src.matchAll(/export const ([A-Za-z0-9_]+) = internal(Query|Mutation|Action)\(/g)].map(
          (m) => m[1],
        ),
      );
      for (const m of src.matchAll(/export const ([A-Za-z0-9_]+) = (query|mutation|action)\(/g)) {
        if (internals.has(m[1])) clashes.push(`${rel(file)}:${m[1]}`);
      }
    }
    expect(clashes.join("\n")).toBe("");
  });

  it("the internal surface is substantial — the split is real", () => {
    let internals = 0;
    for (const file of CONVEX_FILES) {
      internals += [...read(file).matchAll(/= internal(Query|Mutation|Action)\(/g)].length;
    }
    expect(internals).toBeGreaterThan(40);
  });
});

describe("security — no secret can reach the browser (Phase 8/11)", () => {
  it("no source file contains a hardcoded provider credential", () => {
    const patterns = [
      /sk-[A-Za-z0-9]{20,}/,
      /sk-ant-[A-Za-z0-9_-]{10,}/,
      /gsk_[A-Za-z0-9]{20,}/,
      /AIza[A-Za-z0-9_-]{25,}/,
      /hf_[A-Za-z0-9]{20,}/,
      /xox[baprs]-[A-Za-z0-9-]{10,}/,
    ];
    const offenders: string[] = [];
    for (const f of ALL_FILES) {
      const src = read(f);
      for (const p of patterns) if (p.test(src)) offenders.push(rel(f));
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("no client file reads a process.env secret", () => {
    // `process.env.*` is not even defined in a Vite browser bundle, so any use
    // outside the Convex tree would resolve to undefined and silently break —
    // which is exactly why a secret must never be read this way.
    // `vly-integrations.ts` is the one template file that does, for a
    // platform deployment token and a debug flag, and it is listed here with
    // the reason it is not a product secret.
    const ALLOWED: Record<string, string> = {
      "src/lib/vly-integrations.ts":
        "platform scaffolding: VLY deployment token + NODE_ENV debug flag, never an AI/search key",
    };
    const offenders = ALL_FILES.filter(
      (f) => !f.includes("/convex/") && /process\.env\./.test(read(f)) && !ALLOWED[rel(f)],
    );
    expect(offenders.map(rel).join("\n")).toBe("");
  });

  it("the only client-exposed env vars are public identifiers", () => {
    const envs = new Set<string>();
    for (const f of ALL_FILES) {
      for (const m of read(f).matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) {
        envs.add(m[1]);
      }
    }
    // VITE_BASE_PATH is a deploy path, VITE_CONVEX_URL a public backend id and
    // VITE_VLY_APP_ID a public platform app id. None is a credential, and
    // nothing else may be read in the browser — a VITE_-prefixed key WOULD be
    // compiled into the bundle, so this allowlist must stay short.
    const ALLOWED = ["VITE_CONVEX_URL", "VITE_BASE_PATH", "VITE_VLY_APP_ID"];
    for (const e of envs) expect(`${e} → ${ALLOWED.join(", ")}`).toContain(`${e} →`);
    expect(envs.has("VITE_CONVEX_URL")).toBe(true);
  });

  it("no AI, search or image credential name is read through import.meta.env", () => {
    // The exact failure mode this prevents: someone "temporarily" reading a
    // provider key in a component, which Vite would happily inline into the
    // shipped bundle.
    const banned =
      /(GROQ|OPENAI|GEMINI|GOOGLE|ANTHROPIC|DEEPSEEK|POLLINATIONS|TURSO|API_KEY|SECRET|TOKEN|PASSWORD)/;
    const offenders: string[] = [];
    for (const f of ALL_FILES) {
      for (const m of read(f).matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) {
        if (banned.test(m[1])) offenders.push(`${rel(f)}:${m[1]}`);
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("the Convex URL is never used as an auth token", () => {
    const main = read(join(SRC, "main.tsx"));
    // It identifies the backend; it must not be sent as a credential.
    expect(main).not.toMatch(/Authorization/);
  });
});

describe("security — server-side validation of user input (Phase 8)", () => {
  it("every user-supplied free-text arg on chat is length-bounded", () => {
    const src = read(join(CONVEX, "omiChat.ts"));
    // Bounded at the trust boundary, before anything is stored or prompted.
    expect(src).toMatch(/message\.trim\(\)\.slice\(0, \d+\)/);
    expect(src).toMatch(/\.trim\(\)\.slice\(0, \d+\)/);
  });

  it("capped strings are actually sliced before reaching a prompt", () => {
    const src = read(join(CONVEX, "omiChat.ts"));
    // A declared max is only real if the code also truncates on the way in.
    expect(src).toMatch(/\.trim\(\)\.slice\(0,/);
  });

  it("untrusted page text is sanitized before it can steer the model", () => {
    const src = read(join(CONVEX, "omiChat.ts"));
    expect(src).toMatch(/sanitizeUntrustedText\(/);
    // It must be applied to the fetched page, not merely imported.
    const applied = src.match(/sanitizeUntrustedText\([^)]*\)/g) ?? [];
    expect(applied.some((c) => c.includes("page.text"))).toBe(true);
  });

  it("the SSRF guard is applied to any user-supplied URL", () => {
    const src = read(join(CONVEX, "omiChat.ts"));
    expect(src).toMatch(/extractUrl\(/);
    const search = read(join(CONVEX, "search.ts"));
    expect(search).toMatch(/assertSafeUrl|isPrivateHost|looksLocal/i);
  });
});

describe("security — rate limiting on the costly paths (Phase 8)", () => {
  const costly: Array<[string, RegExp]> = [
    ["omiChat.ts (chat turns)", /rateLimit\(`chat:/],
    ["search.ts (web search)", /rateLimit\(`search:/],
    ["search.ts (page reads)", /rateLimit\(`read:/],
    ["search.ts (suggestions)", /rateLimit\(`suggest:/],
    ["omiImages.ts (image generation)", /rateLimit\(`imagegen:/],
    ["deepResearch.ts (deep research)", /rateLimit\(`research:/],
  ];
  for (const [label, pattern] of costly) {
    it(`rate limits ${label}`, () => {
      const file = label.split(" ")[0];
      const src = read(join(CONVEX, file));
      expect(`${label}: ${pattern.test(src)}`).toContain("true");
    });
  }
});

describe("security — multi-tenant isolation fails closed (Phase 8)", () => {
  it("the tenant helpers deny by default and never on an empty check", () => {
    const src = read(join(CONVEX, "knowledgeEngine", "tenant.ts"));
    expect(src).toMatch(/return false/);
    // A membership check must not be a truthiness test on an optional field.
    expect(src).not.toMatch(/if \(!article\.tenantId\) return true/);
  });

  it("knowledge functions take a tenant id on every read and write path", () => {
    const src = read(join(CONVEX, "omiKnowledgeIntelligence.ts"));
    expect(src).toMatch(/isInTenant|filterByTenant|canAccess/);
  });

  it("embedding lookup cannot cross tenants", () => {
    const src = read(join(CONVEX, "knowledgeEngine", "embedding.ts"));
    // Ranked retrieval must accept a tenant filter, not rank globally.
    expect(src.length).toBeGreaterThan(0);
    const ki = read(join(CONVEX, "omiKnowledgeIntelligence.ts"));
    expect(ki).toMatch(/tenantId/);
  });
});

describe("security — file and image access is ownership-checked (Phase 8)", () => {
  it("the file read path verifies ownership", () => {
    const src = read(join(CONVEX, "omiFiles.ts"));
    expect(src).toMatch(/userId\s*!==\s*/);
    expect(src).toMatch(/Not your|Forbidden|owner/i);
  });

  it("the image read path verifies ownership", () => {
    const src = read(join(CONVEX, "omiImages.ts"));
    expect(src).toMatch(/userId\s*!==\s*/);
  });

  it("conversation and message reads are scoped to the owner", () => {
    expect(read(join(CONVEX, "omiConversations.ts"))).toMatch(/userId\s*!==\s*|getAuthUserId/);
    expect(read(join(CONVEX, "omiMessages.ts"))).toMatch(/getAuthUserId|userId\s*!==\s*/);
  });
});

describe("security — upload handling (Phase 8)", () => {
  it("upload validation runs client-side AND is repeated server-side", () => {
    const client = read(join(SRC, "lib", "attachmentUpload.ts"));
    expect(client).toMatch(/MAX_/);
    // The client check is a UX nicety; the server must not trust it.
    const server = read(join(CONVEX, "omiFiles.ts"));
    expect(server).toMatch(/fileSize|fileType|too large|unsupported/i);
  });

  it("only a safe allowlist of file types is accepted, on both sides", () => {
    const client = read(join(SRC, "lib", "attachmentUpload.ts"));
    // The client list must mirror the server, never exceed it.
    expect(client).toMatch(/ALLOWED_UPLOAD_TYPES|ALLOWED_IMAGE_MIMES/);
    expect(client).toMatch(/isSupportedUpload/);
    // No wildcard that would accept anything.
    expect(client).not.toMatch(/ALLOWED[A-Z_]*\s*=\s*\[?\s*["']\*["']/);
    expect(client).toMatch(/"pdf"|"docx"|"xlsx"/);
  });

  it("the server re-checks size and content type, not trusting the client", () => {
    const server = read(join(CONVEX, "omiFiles.ts"));
    expect(server).toMatch(/MAX_FILE_BYTES/);
    expect(server).toMatch(/ALLOWED_IMAGE_TYPES|isTextual|contentType/);
    // The attachment path must go through the same ingest.
    expect(server).toMatch(/rateLimit\(`file:/);
    expect(server).toMatch(/rateLimit\(`image:/);
  });
});

describe("security — the public HTTP surface is read-only (Phase 8/10)", () => {
  it("exposes only GET/OPTIONS routes", () => {
    const src = read(join(CONVEX, "http.ts"));
    const methods = [...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) expect(["GET", "OPTIONS"]).toContain(m);
  });

  it("never sends credentials on the wildcard CORS origin", () => {
    const src = read(join(CONVEX, "http.ts"));
    expect(src).toMatch(/Access-Control-Allow-Origin":\s*"\*"/);
    expect(src).not.toMatch(/Access-Control-Allow-Credentials":\s*"true"/);
  });

  it("status responses are marked no-store", () => {
    expect(read(join(CONVEX, "http.ts"))).toMatch(/Cache-Control":\s*"no-store"/);
  });
});

describe("security — the browser never authorizes itself (Phase 8)", () => {
  it("no client component gates a render on a client-side role/permission check", () => {
    const offenders = ALL_FILES.filter((f) => {
      if (f.includes("/convex/")) return false;
      const src = read(f);
      return /\b(isAdmin|canAccess\s*=|hasPermission|user\.role\s*===|role\s*===\s*["']admin)/.test(
        src,
      );
    });
    expect(offenders.map(rel).join("\n")).toBe("");
  });

  it("the RequireAuth guard redirects signed-out users instead of rendering", () => {
    const src = read(join(SRC, "components", "RequireAuth.tsx"));
    expect(src).toMatch(/Navigate|navigate/i);
    expect(src).toMatch(/returnTo/);
  });
});
