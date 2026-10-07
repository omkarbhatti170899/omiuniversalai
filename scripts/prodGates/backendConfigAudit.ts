/**
 * PRODUCTION BACKEND CONFIGURATION AUDIT — pure logic (no I/O).
 * =============================================================================
 *
 * MEASURED DEFECT this turns into a machine check.
 *
 * The GitHub Pages workflow pins one backend literal and proves the published
 * bytes talk to it. Every gate passes: the deployment answers `/status`,
 * `/health` and `/selftest` with 200, the bundle names exactly that one
 * deployment, the commit is reachable. And yet production was unusable, because
 * "the deployment is reachable" and "the deployment is configured" are
 * different facts:
 *
 *   - `GET /.well-known/jwks.json` returned **HTTP 500** on the pinned
 *     deployment (it returns 200 with a key on the configured one). Convex
 *     Auth cannot publish or sign tokens without `JWKS` / `JWT_PRIVATE_KEY`,
 *     so every sign-in on the production site failed. A reachable-but-
 *     unauthenticated backend is strictly worse than an unreachable one:
 *     the landing page renders and the failure surfaces only after a user
 *     commits to signing up.
 *   - `/status` reported `ai.configured: false` with all four providers
 *     unconfigured, `vision.available: false`, and the two keyed search
 *     sources (`searxng`, `langsearch`) unconfigured — while the same
 *     application code on the deployment the platform injects keys into
 *     reported `activeProvider: "groq"`.
 *
 * Neither symptom is visible from an HTTP status code, which is why the
 * existing "the backend answers" gate did not catch it. This audit asks the
 * deployment what it is ACTUALLY configured to do, using only unauthenticated
 * public endpoints (§28 surface), and it never reads a secret value.
 *
 * SEVERITY POLICY — why authentication blocks and capability does not:
 *   • `blocker` — authentication. Without signing keys the product cannot be
 *     used at all: `RequireAuth` sends every visitor to `/auth`, and `/auth`
 *     cannot complete. There is no degraded-but-working mode to fall back on,
 *     so this fails the run.
 *   • `warning` — capability (AI synthesis, vision, keyed search). Omi is
 *     designed to degrade honestly here: it answers from retrieved sources in
 *     extractive mode and says so in `/status` and `/selftest`. That is a
 *     documented owner-side configuration state, not a reason to fake a
 *     failure — but it is also not something a green check may hide. The
 *     workflow surfaces it as an annotation and fails only when invoked with
 *     `--strict`.
 */

import { approvedSlugOf } from "./convexSlugs";

export type FindingLevel = "blocker" | "warning";

export type ConfigFinding = {
  level: FindingLevel;
  /** Stable identifier, so CI output can be grepped/matched. */
  code: string;
  detail: string;
  /** Env vars to set on the deployment to clear this finding. */
  envVars: string[];
};

export type JwksProbe = {
  /** HTTP status of `/.well-known/jwks.json` (0 = transport failure). */
  status: number;
  /** Number of signing keys in the body, or null when unparseable. */
  keyCount: number | null;
  /** Short text of the response body, for the failure message. */
  body: string;
};

/** The subset of `/status` this audit depends on. Extra fields are ignored. */
export type StatusSnapshot = {
  ai?: {
    configured?: boolean;
    activeProvider?: string | null;
    providers?: Array<{ id?: string; configured?: boolean }>;
  };
  vision?: {
    available?: boolean;
    providers?: Array<{ id?: string; configured?: boolean }>;
  };
  andromeda?: {
    sources?: Array<{
      id?: string;
      enabled?: boolean;
      configured?: boolean;
      requiresKey?: boolean;
    }>;
  };
};

/**
 * Env vars each AI provider needs, mirroring `aiProviders/catalog.ts`.
 * `tests/omiProductionBackendConfig.test.ts` asserts this table still equals
 * the catalog's own `envKeys`, so a provider rename cannot silently make this
 * audit name the wrong variable.
 */
export const AI_ENV_BY_PROVIDER: Record<string, string[]> = {
  groq: ["GROQ_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
};

/** Mirrors `aiProviders/visionCatalog.ts`. */
export const VISION_ENV_BY_PROVIDER: Record<string, string[]> = {
  groq: ["GROQ_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

/**
 * Mirrors the providers flagged `requiresKey` in `searchProviders/index.ts`
 * (`KEYED_PROVIDER_IDS`). The drift test cross-checks this against the live
 * registry's `requiresKey` flags and against each provider's own
 * `missingKeyHint`, so the names here are never guesswork.
 */
export const SEARCH_ENV_BY_PROVIDER: Record<string, string[]> = {
  searxng: ["SEARXNG_BASE_URL"],
  langsearch: ["ENABLE_LANGSEARCH", "LANGSEARCH_API_KEY"],
};

/**
 * The HTTP-actions origin of a Convex deployment. `<slug>.convex.site` and
 * `<slug>.convex.cloud` are the same deployment (see convexSlugs.ts), so the
 * audit accepts either form and normalises to `.convex.site`.
 */
export function siteUrlOf(backend: string): string | null {
  if (!approvedSlugOf(backend)) return null;
  return backend.replace(/\.convex\.cloud\/?$/, ".convex.site").replace(/\/$/, "");
}

function missingEnvFor(
  providers: Array<{ id?: string; configured?: boolean }> | undefined,
  table: Record<string, string[]>,
): string[] {
  const missing = new Set<string>();
  for (const provider of providers ?? []) {
    if (provider.configured === true) continue;
    for (const key of table[provider.id ?? ""] ?? []) missing.add(key);
  }
  return [...missing].sort();
}

/**
 * Decide which configuration facts are missing on `backend`.
 *
 * Pure: the caller supplies the `/status` payload and the JWKS probe result, so
 * every branch here is unit-testable without a network or a deployment.
 */
export function auditBackendConfiguration(input: {
  backend: string;
  jwks: JwksProbe;
  status: StatusSnapshot;
}): ConfigFinding[] {
  const { backend, jwks, status } = input;
  const slug = approvedSlugOf(backend) ?? backend;
  const site = siteUrlOf(backend) ?? backend;
  const findings: ConfigFinding[] = [];

  // -------------------------------------------------------------------------
  // 1. Authentication — the only blocking finding.
  // -------------------------------------------------------------------------
  const jwksOk = jwks.status === 200 && (jwks.keyCount ?? 0) > 0;
  if (!jwksOk) {
    const observed =
      jwks.status === 0
        ? `the request failed (${jwks.body.slice(0, 120)})`
        : jwks.status === 200
          ? `it answered 200 but published no usable key (${jwks.body.slice(0, 120)})`
          : `it answered HTTP ${jwks.status} (${jwks.body.slice(0, 120)})`;
    findings.push({
      level: "blocker",
      code: "auth-signing-keys-missing",
      detail:
        `authentication is broken on '${slug}': ${site}/.well-known/jwks.json — ${observed}. ` +
        `Convex Auth cannot issue or publish tokens without JWKS/JWT_PRIVATE_KEY, so ` +
        `every sign-in on the site pointed at this backend fails (RequireAuth sends ` +
        `visitors to /auth, and /auth cannot complete).`,
      envVars: ["JWKS", "JWT_PRIVATE_KEY"],
    });
  }

  // -------------------------------------------------------------------------
  // 2. AI synthesis — honest degradation, reported loudly.
  // -------------------------------------------------------------------------
  if (status.ai?.configured !== true) {
    const envVars = missingEnvFor(status.ai?.providers, AI_ENV_BY_PROVIDER);
    findings.push({
      level: "warning",
      code: "ai-providers-missing",
      detail:
        `no AI provider is configured on '${slug}': Omi answers in extractive mode ` +
        `only — sources are retrieved and quoted, but there is no synthesis, ` +
        `reasoning or summarisation (this is what /selftest reports as ` +
        `"ai providers [fail]").`,
      envVars: envVars.length > 0 ? envVars : ["GROQ_API_KEY"],
    });
  }

  // -------------------------------------------------------------------------
  // 3. Vision — a separate user-visible capability, so reported separately.
  // -------------------------------------------------------------------------
  if (status.vision?.available !== true) {
    const envVars = missingEnvFor(status.vision?.providers, VISION_ENV_BY_PROVIDER);
    findings.push({
      level: "warning",
      code: "vision-providers-missing",
      detail:
        `image understanding is unavailable on '${slug}': uploads are stored and ` +
        `retrievable, but no provider can describe an image.`,
      envVars: envVars.length > 0 ? envVars : ["GROQ_API_KEY"],
    });
  }

  // -------------------------------------------------------------------------
  // 4. Keyed search sources. A source that is switched OFF is an owner
  //    decision and is skipped; a source that is ON but uncredentialed is a
  //    silent hole in every answer, which is exactly what must be reported.
  // -------------------------------------------------------------------------
  for (const source of status.andromeda?.sources ?? []) {
    if (source.requiresKey !== true) continue;
    if (source.enabled === false) continue;
    if (source.configured === true) continue;
    const id = source.id ?? "unknown";
    findings.push({
      level: "warning",
      code: `search-source-missing-${id}`,
      detail:
        `search source '${id}' is enabled on '${slug}' but its credential is not ` +
        `configured, so its results are absent from every answer.`,
      envVars: SEARCH_ENV_BY_PROVIDER[id] ?? [],
    });
  }

  return findings;
}

/** Counts plus the union of env vars every finding asks for. */
export function summarizeFindings(findings: ConfigFinding[]): {
  blockers: number;
  warnings: number;
  envVars: string[];
} {
  const envVars = new Set<string>();
  let blockers = 0;
  let warnings = 0;
  for (const finding of findings) {
    if (finding.level === "blocker") blockers += 1;
    else warnings += 1;
    for (const key of finding.envVars) envVars.add(key);
  }
  return { blockers, warnings, envVars: [...envVars].sort() };
}

/**
 * The Convex origin of a deployment (`.convex.cloud`) — the counterpart of
 * `siteUrlOf`. HTTP actions live on `.convex.site`, but `GET /version`, which
 * reports when this deployment's FUNCTIONS were last built, is served on
 * `.convex.cloud` only, so the audit needs both forms.
 */
export function cloudUrlOf(backend: string): string | null {
  if (!approvedSlugOf(backend)) return null;
  return backend.replace(/\.convex\.site\/?$/, ".convex.cloud").replace(/\/$/, "");
}

/**
 * Format the stamp Convex returns from `GET /version`, e.g.
 * `20261006T210904Z-157d34b07ed0` → `2026-10-06T21:09:04Z`.
 *
 * WHY this is reported at all: "the deployed functions are stale" and "the
 * deployment has no environment variables" look identical from the outside —
 * both surface as "not configured" — yet the fix for each is completely
 * different (redeploy vs set env vars). That ambiguity is exactly what made
 * the original diagnosis hard, so the stamp is printed next to the config
 * report to let an operator rule the staleness hypothesis out in one glance.
 *
 * Note the asymmetry it resolves: env vars are resolved at request time, so an
 * old stamp does NOT mean configuration is invisible — and a fresh stamp does
 * not mean anything is configured. It is context, never a verdict.
 *
 * Returns "unknown" rather than throwing — this is context, not a gate.
 */
export function formatDeployStamp(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "unknown";
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(value);
  if (!match) return value.slice(0, 60);
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}
