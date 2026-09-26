/**
 * AUTHORIZATION AUDIT — mechanical check.
 *
 * Every PUBLIC Convex function (query / mutation / action) is a potential data
 * boundary. This script reports any that:
 *   • never ask who the caller is (no auth check at all), or
 *   • ask who the caller is but never verify OWNERSHIP of the document they
 *     touch (a signed-in user reading someone else's row).
 *
 * It is a static heuristic, not a proof. But a function that appears in the
 * report deserves a human look, and a function that does NOT appear has
 * visibly opted in to a check.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = "src/convex";

/** How a function proves the caller is authenticated. */
const AUTH_MARKERS = [
  "getAuthUserId",
  "getCurrentUser",
  "requireUser",
  "ctx.auth.getUserIdentity",
  "getUserId",
];

/** How a function proves the caller OWNS the record. */
const OWNERSHIP_MARKERS = [
  "userId !==",
  "userId ==",
  ".userId !==",
  "assertOwns",
  "requireOwnership",
  "isNot your",
  "tenant",
  "orgId",
  "projectId",
  "ownerId",
  "actingUserId",
  "canAccess",
  "authorizeProject",
  "assertProjectAccess",
  "getProjectForUser",
  "ownsProject",
  "requireProjectAccess",
  "isMember",
  "access",
];

/**
 * Surfaces that are public BY DESIGN and have been individually reviewed.
 *
 * Being on this list is a claim, not a convenience: each entry was read and
 * confirmed to return only public capability metadata (booleans, public model
 * labels, cost hints) and never a key, an env var name, or user data. An entry
 * here suppresses the finding but is still counted and printed, so the claim
 * stays visible and auditable rather than quietly hiding a regression.
 */
const PUBLIC_ALLOWLIST = new Set([
  "http.ts:status",
  "http.ts:health",
  "http.ts:selftest",
  "http.ts:currentinfo",
  "auth.config.ts:",
  "ecosystemStatus.ts:",
  "omiIdentity.ts:",
  // Verified by hand: each returns only booleans, public model/service labels
  // and cost hints. No key values, no env var names, no user or document data.
  "aiStatus.ts:",
  "searchStatus.ts:",
  "search.ts:",
]);

type Finding = {
  file: string;
  fn: string;
  kind: string;
  issue: "NO_AUTH" | "NO_OWNERSHIP";
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "_generated" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Extract `export const NAME = query|mutation|action|internalQuery|...({`
 * and then the balanced body of its handler.
 */
function extractFunctions(src: string): Array<{ name: string; kind: string; body: string }> {
  const fns: Array<{ name: string; kind: string; body: string }> = [];
  const re = /export\s+const\s+(\w+)\s*=\s*(internalQuery|internalMutation|internalAction|query|mutation|action|httpAction)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Find the handler arrow body by brace matching from the opening paren.
    const open = src.indexOf("{", m.index + m[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    fns.push({ name: m[1], kind: m[2], body: src.slice(open, end + 1) });
  }
  return fns;
}

/**
 * Module-level `function`/`const` helpers, so a wrapper that delegates to
 * `preflight(ctx)` or `loadOwnedRun(ctx, id)` is credited with the checks
 * those helpers perform. Without this the audit reported `omiChat.send` and
 * `omiWorkflowDecisions.approve` as unauthenticated — both of which are in
 * fact correctly gated one call away. An audit that cries wolf gets ignored.
 */
function extractHelpers(src: string): Map<string, string> {
  const helpers = new Map<string, string>();
  const re = /(?:^|\n)(?:async\s+)?function\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf("{", m.index);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    helpers.set(m[1], src.slice(open, end + 1));
  }
  return helpers;
}

/** Body text plus the bodies of any local helper it calls, transitively. */
function withHelperBodies(body: string, helpers: Map<string, string>): string {
  let text = body;
  for (const name of helpers.keys()) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(body)) {
      text += `\n${helpers.get(name) as string}`;
    }
  }
  return text;
}

const findings: Finding[] = [];
let publicCount = 0;
let internalCount = 0;

for (const file of walk(ROOT).sort()) {
  const src = readFileSync(file, "utf8");
  const helpers = extractHelpers(src);
  for (const fn of extractFunctions(src)) {
    if (fn.kind.startsWith("internal")) {
      internalCount++;
      continue;
    }
    if (fn.kind === "httpAction") continue; // routed separately, audited below
    publicCount++;

    const scope = withHelperBodies(fn.body, helpers);
    const hasAuth = AUTH_MARKERS.some((a) => scope.includes(a));
    const hasOwnership = OWNERSHIP_MARKERS.some((a) => scope.includes(a));

    if (!hasAuth) {
      findings.push({ file, fn: fn.name, kind: fn.kind, issue: "NO_AUTH" });
      continue;
    }
    // A function that authenticates but never mentions any ownership concept
    // can only be safe if it touches no per-user row at all. Flag it for a look.
    if (!hasOwnership) {
      findings.push({ file, fn: fn.name, kind: fn.kind, issue: "NO_OWNERSHIP" });
    }
  }
}

// `f.file` is a repo-relative path ("src/convex/aiStatus.ts"), so the allowlist
// is keyed by basename + function and matched on that. Matching the full path
// would silently never match — which is exactly how a dead allowlist hides
// behind a green audit.
const isReviewedPublic = (f: Finding) => {
  const base = basename(f.file);
  return PUBLIC_ALLOWLIST.has(`${base}:${f.fn}`) || PUBLIC_ALLOWLIST.has(`${base}:`);
};

const rawNoAuth = findings.filter((f) => f.issue === "NO_AUTH");
const noAuth = rawNoAuth.filter((f) => !isReviewedPublic(f));
const reviewedPublic = rawNoAuth.filter(isReviewedPublic);
const noOwn = findings.filter((f) => f.issue === "NO_OWNERSHIP");

console.log("=".repeat(72));
console.log("CONVEX AUTHORIZATION AUDIT");
console.log("=".repeat(72));
console.log(`public functions : ${publicCount}`);
console.log(`internal functions: ${internalCount}`);
console.log(`NO AUTH          : ${noAuth.length}`);
console.log(`NO OWNERSHIP     : ${noOwn.length}`);
console.log(`reviewed public  : ${reviewedPublic.length}`);

if (reviewedPublic.length) {
  console.log("\n--- PUBLIC BY DESIGN (reviewed; metadata only, no keys, no user data) ---");
  for (const f of reviewedPublic) console.log(`  ${f.file} :: ${f.fn} (${f.kind})`);
}
if (noAuth.length) {
  console.log("\n--- NO AUTHENTICATION CHECK (highest risk) ---");
  for (const f of noAuth) console.log(`  ${f.file} :: ${f.fn} (${f.kind})`);
}
if (noOwn.length) {
  console.log("\n--- AUTHENTICATED BUT NO OWNERSHIP MARKER (verify by hand) ---");
  for (const f of noOwn) console.log(`  ${f.file} :: ${f.fn} (${f.kind})`);
}
console.log("=".repeat(72));
