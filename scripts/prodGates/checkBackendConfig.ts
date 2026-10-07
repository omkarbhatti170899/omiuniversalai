/**
 * GATE — the pinned production backend must be CONFIGURED, not merely reachable.
 * =============================================================================
 *
 * Why this exists next to the "backend answers" check: a 200 from `/status`,
 * `/health` and `/selftest` says the deployment is deployed. It says nothing
 * about whether it can authenticate a user or call an AI provider. Production
 * was in exactly that state — every endpoint answered, and sign-in returned
 * HTTP 500 because the deployment had no `JWKS`/`JWT_PRIVATE_KEY`. See
 * `backendConfigAudit.ts` for the measured evidence and the severity policy.
 *
 * It reads only unauthenticated public endpoints and prints only booleans,
 * status codes, provider ids and ENV VAR NAMES — never a key, token or value.
 *
 * Usage: bun scripts/prodGates/checkBackendConfig.ts <backendUrl> [--strict|--report]
 *        <backendUrl> may be the .convex.cloud or .convex.site form.
 *
 * Exit codes:
 *   0  configured as far as this audit can tell. Warnings are present unless
 *      `--strict` (see below) — read the output, they name real capability gaps.
 *   1  a blocker (authentication), or, with `--strict`, any warning too.
 *   2  usage error / not a Convex backend URL.
 *
 * `--strict` is used by the post-deploy live-verification job: "the site is
 * published and reachable" is not sufficient there either, because publishing
 * a frontend whose backend cannot sign users in is not a working release.
 *
 * `--report` never fails on findings (usage errors still exit 2) and is used by
 * the pre-deploy build job. This is deliberately NOT `|| true` in the workflow:
 * swallowing a nonzero exit in shell hides real breakage too, so "report only"
 * is an explicit, named mode instead of a suppressed failure.
 */

import {
  auditBackendConfiguration,
  cloudUrlOf,
  formatDeployStamp,
  siteUrlOf,
  summarizeFindings,
  type JwksProbe,
  type StatusSnapshot,
} from "./backendConfigAudit";

const RUNBOOK = "docs/PRODUCTION_BACKEND_CONFIGURATION.md";

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const reportOnly = argv.includes("--report");
const backend = argv.find((arg) => !arg.startsWith("--"));

if (!backend) {
  console.error("usage: checkBackendConfig.ts <backendUrl> [--strict|--report]");
  process.exit(2);
}

const site = siteUrlOf(backend);
if (!site) {
  console.error(
    `::error::${JSON.stringify(backend)} is not a Convex deployment URL (*.convex.cloud / *.convex.site)`,
  );
  process.exit(2);
}

/** Never throws: a transport failure is itself a finding-shaped observation.
 *  The FULL body is returned — `/status` must be parsed as JSON end to end, and
 *  truncating it would silently yield an empty snapshot, i.e. a fabricated
 *  "nothing is configured" report against a perfectly configured backend.
 *  Bodies are trimmed only where they are printed as a message. */
async function get(path: string): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(`${site}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 0, body: detail };
  }
}

async function probeJwks(): Promise<JwksProbe> {
  const { status, body } = await get("/.well-known/jwks.json");
  let keyCount: number | null = null;
  if (status === 200) {
    try {
      const parsed = JSON.parse(body) as { keys?: unknown };
      keyCount = Array.isArray(parsed.keys) ? parsed.keys.length : null;
    } catch {
      keyCount = null;
    }
  }
  return { status, keyCount, body: body.slice(0, 400) };
}

async function readStatus(): Promise<StatusSnapshot> {
  const { body } = await get("/status");
  try {
    return JSON.parse(body) as StatusSnapshot;
  } catch {
    // An unreadable /status is reported as "nothing is configured", which is
    // the conservative direction for an audit whose job is to catch gaps.
    return {};
  }
}

/**
 * When this deployment's functions were last built — on the `.convex.cloud`
 * origin, where `/version` is served. Pure context (never a finding): it is
 * what lets a reader distinguish "stale deploy" from "missing env vars", the
 * two hypotheses that look identical from the outside.
 */
async function probeDeployStamp(): Promise<string> {
  const cloud = cloudUrlOf(backend);
  if (!cloud) return "unknown";
  try {
    const response = await fetch(`${cloud}/version`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return `unknown (HTTP ${response.status})`;
    return (await response.text()).trim().slice(0, 120);
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const slug = backend.replace(/^https:\/\//, "").split(".")[0];
  console.log(`# production backend configuration audit — ${slug}`);
  console.log(`# ${site}`);
  console.log("");

  const [jwks, status, deployStamp] = await Promise.all([
    probeJwks(),
    readStatus(),
    probeDeployStamp(),
  ]);
  console.log(
    `jwks.json:            HTTP ${jwks.status}` +
      (jwks.keyCount === null ? "" : ` (${jwks.keyCount} signing key(s))`),
  );
  console.log(
    `status ai.configured: ${status.ai?.configured === true} ` +
      `(activeProvider: ${status.ai?.activeProvider ?? "none"})`,
  );
  console.log(`status vision:        ${status.vision?.available === true}`);
  const keyed = (status.andromeda?.sources ?? []).filter(
    (source) => source.requiresKey === true,
  );
  console.log(
    `keyed search sources: ${keyed.length - keyed.filter((s) => s.configured === true).length}` +
      `/${keyed.length} unconfigured (${keyed.map((s) => s.id).join(", ") || "none"})`,
  );
  console.log(
    `functions last built: ${formatDeployStamp(deployStamp)} ` +
      `(env vars resolve at request time, so this never gates the audit)`,
  );
  console.log("");

  const findings = auditBackendConfiguration({ backend, jwks, status });
  const { blockers, warnings, envVars } = summarizeFindings(findings);

  for (const finding of findings) {
    const annotation = finding.level === "blocker" ? "::error::" : "::warning::";
    const needs =
      finding.envVars.length > 0 ? ` [set: ${finding.envVars.join(", ")}]` : "";
    console.log(`${annotation}${finding.code}${needs} — ${finding.detail}`);
  }

  if (findings.length === 0) {
    console.log(
      `ok ${slug} is configured: authentication, AI synthesis, vision and every keyed search source are live`,
    );
  } else {
    console.log("");
    console.log(
      `${blockers} blocker(s), ${warnings} warning(s).`,
    );
    console.log(
      `Env vars to set on the '${slug}' deployment (names only — never in this repository): ` +
        `${envVars.join(", ")} — see ${RUNBOOK}.`,
    );
  }

  const failed = !reportOnly && (blockers > 0 || (strict && warnings > 0));
  if (failed) {
    if (strict && blockers === 0) {
      console.log(
        `::error::--strict: ${warnings} configuration warning(s) on '${slug}' — the production backend is reachable but not fully configured.`,
      );
    }
    process.exit(1);
  }
}

void main();
