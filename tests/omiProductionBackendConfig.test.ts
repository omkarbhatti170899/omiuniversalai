/**
 * PRODUCTION BACKEND CONFIGURATION GATE — contract + drift protection.
 * =====================================================================
 *
 * Context: production was reachable-but-unconfigured. Every endpoint answered
 * 200, every existing gate passed, and sign-in still failed with HTTP 500
 * because the pinned deployment had no `JWKS`/`JWT_PRIVATE_KEY` — while AI,
 * vision and the two keyed search sources were simply absent. Nothing measured
 * configuration, so nothing could fail on it. `scripts/prodGates/backendConfigAudit.ts`
 * is that measurement; this test pins its behaviour.
 *
 * Two failure modes matter here, and both are guarded:
 *
 *   1. FALSE NEGATIVES — a real gap that goes unreported (the defect itself):
 *      auth missing must be a blocker, and every unconfigured capability must
 *      name the env vars that would fix it.
 *   2. FALSE POSITIVES — reporting a configured backend as broken, which is
 *      how a gate gets deleted. A fully configured snapshot must produce zero
 *      findings, and the env-var tables must stay equal to the REAL provider
 *      catalogs (the single source of truth), so renaming a provider or its
 *      key can never make the audit name a variable that no longer exists.
 *
 * No network: every input is a literal snapshot, so this is deterministic in CI.
 */

import { describe, expect, test } from "bun:test";
import {
  AI_ENV_BY_PROVIDER,
  SEARCH_ENV_BY_PROVIDER,
  VISION_ENV_BY_PROVIDER,
  auditBackendConfiguration,
  cloudUrlOf,
  formatDeployStamp,
  siteUrlOf,
  summarizeFindings,
  type ConfigFinding,
  type JwksProbe,
  type StatusSnapshot,
} from "../scripts/prodGates/backendConfigAudit";
import { AI_PROVIDERS } from "../src/convex/aiProviders/catalog";
import { VISION_PROVIDERS } from "../src/convex/aiProviders/visionCatalog";
import { getProviderStatus } from "../src/convex/searchProviders";

const BACKEND = "https://majestic-turtle-372.convex.cloud";

const JWKS_OK: JwksProbe = { status: 200, keyCount: 1, body: '{"keys":[{}]}' };
const JWKS_BROKEN: JwksProbe = {
  status: 500,
  keyCount: null,
  body: '{"code":"Server Error"}',
};

/** Everything configured: the shape a healthy production deployment returns. */
const HEALTHY: StatusSnapshot = {
  ai: {
    configured: true,
    activeProvider: "groq",
    providers: [{ id: "groq", configured: true }],
  },
  vision: { available: true, providers: [{ id: "groq", configured: true }] },
  andromeda: {
    sources: [
      { id: "searxng", enabled: true, configured: true, requiresKey: true },
      { id: "langsearch", enabled: true, configured: true, requiresKey: true },
      { id: "wikipedia", enabled: true, configured: true, requiresKey: false },
    ],
  },
};

/** The measured production defect: deployed, reachable, nothing configured. */
const UNCONFIGURED: StatusSnapshot = {
  ai: {
    configured: false,
    activeProvider: null,
    providers: [
      { id: "groq", configured: false },
      { id: "gemini", configured: false },
      { id: "openai", configured: false },
      { id: "deepseek", configured: false },
    ],
  },
  vision: {
    available: false,
    providers: [
      { id: "groq", configured: false },
      { id: "gemini", configured: false },
      { id: "openai", configured: false },
    ],
  },
  andromeda: {
    sources: [
      { id: "searxng", enabled: true, configured: false, requiresKey: true },
      { id: "langsearch", enabled: true, configured: false, requiresKey: true },
      { id: "wikipedia", enabled: true, configured: true, requiresKey: false },
      { id: "gdelt", enabled: false, configured: false, requiresKey: false },
    ],
  },
};

const codes = (findings: ConfigFinding[]) => findings.map((f) => f.code).sort();

describe("siteUrlOf", () => {
  test("normalises the .cloud form to the HTTP-actions .site form", () => {
    expect(siteUrlOf("https://majestic-turtle-372.convex.cloud")).toBe(
      "https://majestic-turtle-372.convex.site",
    );
  });

  test("accepts an already-.site URL and a trailing slash", () => {
    expect(siteUrlOf("https://majestic-turtle-372.convex.site")).toBe(
      "https://majestic-turtle-372.convex.site",
    );
    expect(siteUrlOf("https://majestic-turtle-372.convex.cloud/")).toBe(
      "https://majestic-turtle-372.convex.site",
    );
  });

  test("rejects a non-Convex URL rather than probing a foreign host", () => {
    expect(siteUrlOf("https://example.com")).toBeNull();
    expect(siteUrlOf("")).toBeNull();
  });
});

describe("cloudUrlOf — the origin where /version is served", () => {
  test("normalises .site to .cloud and is idempotent on .cloud", () => {
    expect(cloudUrlOf("https://majestic-turtle-372.convex.site")).toBe(
      "https://majestic-turtle-372.convex.cloud",
    );
    expect(cloudUrlOf("https://majestic-turtle-372.convex.cloud")).toBe(
      "https://majestic-turtle-372.convex.cloud",
    );
    expect(cloudUrlOf("https://majestic-turtle-372.convex.cloud/")).toBe(
      "https://majestic-turtle-372.convex.cloud",
    );
  });

  test("rejects a non-Convex URL", () => {
    expect(cloudUrlOf("https://example.com")).toBeNull();
    expect(cloudUrlOf("")).toBeNull();
  });
});

describe("formatDeployStamp — context, never a verdict", () => {
  test("formats a real Convex /version stamp as ISO-8601", () => {
    // The literal shape observed live on 2026-10-07.
    expect(formatDeployStamp("20261006T210904Z-157d34b07ed0")).toBe("2026-10-06T21:09:04Z");
  });

  test("returns 'unknown' instead of throwing on empty or absent input", () => {
    expect(formatDeployStamp("")).toBe("unknown");
    expect(formatDeployStamp("   ")).toBe("unknown");
    expect(formatDeployStamp(null)).toBe("unknown");
    expect(formatDeployStamp(undefined)).toBe("unknown");
  });

  test("passes unrecognised text through truncated rather than inventing a date", () => {
    // Fabricating a deploy time would be worse than saying nothing: an operator
    // must never be shown a timestamp this audit guessed.
    expect(formatDeployStamp("proxy-error-page")).toBe("proxy-error-page");
    expect(formatDeployStamp("x".repeat(200)).length).toBe(60);
  });
});

describe("authentication is the only blocking finding", () => {
  test("a JWKS endpoint that does not publish a key is a blocker naming the auth vars", () => {
    const findings = auditBackendConfiguration({
      backend: BACKEND,
      jwks: JWKS_BROKEN,
      status: UNCONFIGURED,
    });
    const auth = findings.find((f) => f.code === "auth-signing-keys-missing");
    expect(auth).toBeDefined();
    expect(auth?.level).toBe("blocker");
    expect(auth?.envVars).toEqual(["JWKS", "JWT_PRIVATE_KEY"]);
    expect(auth?.detail).toContain("majestic-turtle-372");
    expect(auth?.detail).toContain("sign-in");
  });

  test("200 with no usable key is still a blocker (body must be a key set)", () => {
    const findings = auditBackendConfiguration({
      backend: BACKEND,
      jwks: { status: 200, keyCount: null, body: "not json" },
      status: UNCONFIGURED,
    });
    expect(findings.some((f) => f.level === "blocker")).toBe(true);
  });

  test("capability gaps alone never block — Omi degrades honestly", () => {
    const findings = auditBackendConfiguration({
      backend: BACKEND,
      jwks: JWKS_OK,
      status: UNCONFIGURED,
    });
    expect(findings.some((f) => f.level === "blocker")).toBe(false);
    expect(findings.every((f) => f.level === "warning")).toBe(true);
  });
});

describe("capability findings name the vars that fix them", () => {
  const findings = auditBackendConfiguration({
    backend: BACKEND,
    jwks: JWKS_BROKEN,
    status: UNCONFIGURED,
  });

  test("reports every missing capability", () => {
    expect(codes(findings)).toEqual(
      [
        "auth-signing-keys-missing",
        "ai-providers-missing",
        "vision-providers-missing",
        "search-source-missing-searxng",
        "search-source-missing-langsearch",
      ].sort(),
    );
  });

  test("AI and vision name the provider keys, in order-independent form", () => {
    const ai = findings.find((f) => f.code === "ai-providers-missing");
    expect(ai?.envVars).toEqual([
      "DEEPSEEK_API_KEY",
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "OPENAI_API_KEY",
    ]);
    const vision = findings.find((f) => f.code === "vision-providers-missing");
    expect(vision?.envVars).toEqual(["GEMINI_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY"]);
  });

  test("each keyed search source names its own credential", () => {
    expect(findings.find((f) => f.code === "search-source-missing-searxng")?.envVars).toEqual([
      "SEARXNG_BASE_URL",
    ]);
    expect(findings.find((f) => f.code === "search-source-missing-langsearch")?.envVars).toEqual([
      "ENABLE_LANGSEARCH",
      "LANGSEARCH_API_KEY",
    ]);
  });

  test("a source switched OFF by the owner is not reported as missing credentials", () => {
    expect(findings.some((f) => f.code.includes("gdelt"))).toBe(false);
  });

  test("keyless sources are never blamed for a missing key", () => {
    expect(findings.some((f) => f.code.includes("wikipedia"))).toBe(false);
  });

  test("summarizeFindings counts levels and unions every env var once", () => {
    const summary = summarizeFindings(findings);
    expect(summary.blockers).toBe(1);
    expect(summary.warnings).toBe(4);
    expect(summary.envVars).toEqual([
      "DEEPSEEK_API_KEY",
      "ENABLE_LANGSEARCH",
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "JWKS",
      "JWT_PRIVATE_KEY",
      "LANGSEARCH_API_KEY",
      "OPENAI_API_KEY",
      "SEARXNG_BASE_URL",
    ]);
  });
});

describe("a configured backend produces zero findings", () => {
  const findings = auditBackendConfiguration({
    backend: BACKEND,
    jwks: JWKS_OK,
    status: HEALTHY,
  });

  test("no blocker and no warning — the gate must not cry wolf", () => {
    expect(findings).toEqual([]);
    expect(summarizeFindings(findings)).toEqual({
      blockers: 0,
      warnings: 0,
      envVars: [],
    });
  });

  test("an empty /status snapshot is reported as gaps, never silently as healthy", () => {
    // A payload this audit cannot read must fail SAFE: the conservative
    // direction for a gap detector is to report, not to bless.
    const unknown = auditBackendConfiguration({
      backend: BACKEND,
      jwks: JWKS_OK,
      status: {},
    });
    expect(unknown.length).toBeGreaterThan(0);
  });
});

describe("drift protection — the tables mirror the real provider catalogs", () => {
  test("AI table equals aiProviders/catalog.ts envKeys", () => {
    for (const provider of AI_PROVIDERS) {
      expect(AI_ENV_BY_PROVIDER[provider.id]).toEqual(provider.envKeys);
    }
    expect(Object.keys(AI_ENV_BY_PROVIDER).sort()).toEqual(
      AI_PROVIDERS.map((p) => p.id).sort(),
    );
  });

  test("vision table equals aiProviders/visionCatalog.ts envKeys", () => {
    for (const provider of VISION_PROVIDERS) {
      expect(VISION_ENV_BY_PROVIDER[provider.id]).toEqual(provider.envKeys);
    }
    expect(Object.keys(VISION_ENV_BY_PROVIDER).sort()).toEqual(
      VISION_PROVIDERS.map((p) => p.id).sort(),
    );
  });

  test("search table covers exactly the registry's requiresKey providers", () => {
    const registry = getProviderStatus();
    const keyed = registry
      .filter((s) => s.requiresKey)
      .map((s) => s.id)
      .sort();
    expect(Object.keys(SEARCH_ENV_BY_PROVIDER).sort()).toEqual(keyed);
  });

  test("each search env var is named by that provider's own missing-key hint", () => {
    // The provider's hint is what the product shows the user, so the audit and
    // the UI must agree on the variable to ask for. A provider that is already
    // configured in this process has an empty hint by design, so the assertion
    // applies only where a hint exists — it must never name something else.
    for (const source of getProviderStatus()) {
      const envVars = SEARCH_ENV_BY_PROVIDER[source.id];
      if (!envVars) continue;
      if (source.hint.length === 0) continue;
      for (const key of envVars) {
        expect(source.hint).toContain(key);
      }
    }
  });
});
