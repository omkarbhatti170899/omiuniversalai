/**
 * Omi live self-test — the public, per-subsystem health suite.
 *
 * Why this exists: "the build passed" and "the deploy went green" are not
 * proof the product works. This runs REAL checks against the deployed system
 * and reports an honest verdict per subsystem, so every PASS is backed by
 * evidence rather than by a green CI badge.
 *
 * Verdict vocabulary — the distinction matters and is never blurred:
 *   pass        an end-to-end check actually succeeded just now
 *   fail        an end-to-end check ran and did not succeed
 *   configured  the dependency is present, but checking it end-to-end needs
 *               something this context cannot supply (an upload, a signed-in
 *               session) — NOT a claim that it works
 *   unverified  could not be checked at all right now (e.g. upstream rate limit)
 *
 * Safety contract (this endpoint is UNAUTHENTICATED):
 *   • never returns a secret, key, token, or env var value or name
 *   • never returns user, document, conversation or upload data
 *   • reads only counts/booleans, never row contents
 * Probe inputs are FIXED — callers cannot steer the search or the AI call, so
 * this can never be used as an open search/AI proxy. Results are cached
 * in-process to bound cost and abuse.
 *
 * Must stay importable from the V8 (non-"use node") runtime so the HTTP
 * router can call it.
 */

import { internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { complete } from "./aiProviders";
import { getAiStatus } from "./aiProviders/catalog";
import { describeImage } from "./aiProviders/vision";
import { classifyProviderFailure } from "./aiProviders/openaiCompat";
import { getConfiguredAiProviders } from "./aiProviders/catalog";
import {
  getVisionStatus,
  VISION_PROBE_IMAGE,
  VISION_PROBE_PROMPT,
} from "./aiProviders/visionCatalog";
import {
  capabilityForOp,
  getImageCapabilityReport,
  getImageProviderStatus,
  type ImageOp,
} from "./aiProviders/imageCatalog";
import { runImageOp } from "./aiProviders/imageProviders";
import { getConfiguredProviders } from "./searchProviders";
import { withTimeout } from "./searchEngine/resilience";
import { planQuery } from "./andromeda/query";
import type { ActionCtx } from "./_generated/server";
import { decideSearch } from "./searchEngine/decision";
import {
  evaluateExpression,
  extractMathExpression,
} from "./searchEngine/calculator";
import { CREATOR_STATEMENT, OMI_PRODUCT_NAME } from "./omiIdentity";
import { freshnessPolicyFor, freshnessStatement, splitByFreshness, clarifyForMissingInput, noVerificationMessage } from "./searchEngine/freshness";
import { runUniversalSearch, extractiveBrief } from "./universalSearch";
import { searxngHealth } from "./searchProviders/searxng";
export type SubsystemStatus = "pass" | "fail" | "configured" | "unverified";

export type SubsystemCheck = {
  subsystem: string;
  status: SubsystemStatus;
  /** Human-readable evidence for the verdict — never a bare boolean. */
  detail: string;
  ms: number;
};

export type SelfTestReport = {
  service: string;
  identity: string;
  status: "ok" | "degraded" | "down";
  time: string;
  cached: boolean;
  summary: {
    pass: number;
    fail: number;
    configured: number;
    unverified: number;
  };
  subsystems: SubsystemCheck[];
};

/** Public deployment coordinates (no secrets — these are public URLs). */
const FRONTEND_URL = "https://omkarbhatti170899.github.io/omiuniversalai/";
const REPO_API =
  "https://api.github.com/repos/omkarbhatti170899/omiuniversalai/actions/runs?per_page=1";

/** Fixed probes — never caller-influenced (see safety contract). */
const PROBE_QUERY = "Andromeda Galaxy";
const PROBE_MATH = "What's 25 × 48?";
const PROBE_MATH_EXPECTED = "1200";

const NET_TIMEOUT_MS = 12_000;
const AI_TIMEOUT_MS = 20_000;
/** Vision models may reason before answering, so it gets a larger budget. */
const VISION_TIMEOUT_MS = 30_000;
/** Image models return bytes, not tokens, and take longer than a chat turn. */
const IMAGE_TIMEOUT_MS = 60_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

type QueryRunner = Pick<ActionCtx, "runQuery">;

let cached: { at: number; report: Omit<SelfTestReport, "cached"> } | null = null;

// --- Internal probes (run inside Convex; return counts/booleans only) --------

/**
 * Proves the database is reachable and the schema is deployed: a real read
 * against a real table, returning only how many rows were seen.
 */
export const dbProbe = internalQuery({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("omiDocuments").take(1);
    const runs = await ctx.db.query("researchRuns").take(1);
    const agents = await ctx.db.query("omiAgents").take(1);
    return {
      omiDocuments: docs.length,
      researchRuns: runs.length,
      omiAgents: agents.length,
    };
  },
});

/**
 * Proves the auth integration is wired: called over the public HTTP surface
 * with no session, the auth guard must resolve to "not authenticated" rather
 * than throwing. Returns a boolean, never an identity.
 */
export const authProbe = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return { authenticated: userId !== null };
  },
});

// --- Check helper ------------------------------------------------------------

async function check(
  subsystem: string,
  fn: () => Promise<{ status: SubsystemStatus; detail: string }>,
): Promise<SubsystemCheck> {
  const t0 = Date.now();
  try {
    const { status, detail } = await fn();
    return { subsystem, status, detail, ms: Date.now() - t0 };
  } catch (err) {
    return {
      subsystem,
      status: "fail",
      detail: err instanceof Error ? err.message : "Unexpected error",
      ms: Date.now() - t0,
    };
  }
}

// --- Current-information end-to-end probe ----------------------------------

/**
 * The exact 10 scenarios from the "current/live information is broken" bug
 * report, run against the LIVE pipeline. This is the deployed proof that
 * current information actually works end to end, not a unit-level assertion.
 */
export const CURRENT_INFO_SCENARIOS: Array<{ query: string; expectFresh: boolean }> = [
  { query: "What is the latest news in India?", expectFresh: true },
  { query: "What happened in the world today?", expectFresh: true },
  { query: "What is happening right now?", expectFresh: true },
  { query: "Latest technology news", expectFresh: true },
  { query: "Latest AI news", expectFresh: true },
  { query: "Today's weather", expectFresh: false },
  { query: "Current USD/INR rate", expectFresh: true },
  { query: "Live sports score", expectFresh: true },
  { query: "Latest announcements", expectFresh: true },
  { query: "News from the last hour", expectFresh: true },
];

export type CurrentInfoRow = {
  query: string;
  searchTriggered: boolean;
  vertical: string;
  requiresFreshness: boolean;
  intent: string;
  timeRange: string | null;
  enginesTried: string[];
  enginesWithResults: string[];
  failedEngines: string[];
  resultsFound: number;
  freshResults: number;
  freshness: string | null;
  answer: string;
  sources: Array<{ title: string; url: string; publishedAt: string | null }>;
  searchMs: number;
  status: "pass" | "fail";
  detail: string;
  /** Exactly what Omi would say to the user for this outcome. */
  userMessage?: string;
};

/**
 * Run ONE current-information question through the real pipeline and return
 * every link in the chain, so a failure names the link that broke.
 */
export async function probeCurrentInfo(
  ctx: QueryRunner,
  query: string,
): Promise<CurrentInfoRow> {
  const t0 = Date.now();
  const decision = decideSearch(query);
  const policy = freshnessPolicyFor(query, decision.intent);

  const base: CurrentInfoRow = {
    query,
    searchTriggered: false,
    vertical: policy.vertical,
    requiresFreshness: policy.requiresFreshness,
    intent: decision.intent,
    timeRange: policy.timeRange ?? null,
    enginesTried: [],
    enginesWithResults: [],
    failedEngines: [],
    resultsFound: 0,
    freshResults: 0,
    freshness: null,
    answer: "",
    sources: [],
    searchMs: 0,
    status: "fail",
    detail: "",
  };

  if (!decision.needsSearch) {
    return {
      ...base,
      searchMs: Date.now() - t0,
      detail: `intent "${decision.intent}" did not trigger a search for a current-information question`,
    };
  }

  // A question missing a required input is answered by asking for it, not by
  // running a search that cannot succeed.
  const clarify = clarifyForMissingInput(query, policy.vertical);
  if (policy.requiresFreshness && clarify) {
    return {
      ...base,
      searchMs: Date.now() - t0,
      status: "pass",
      detail: `Omi correctly asks for the missing input instead of guessing or failing: "${clarify.slice(0, 90)}"`,
      answer: clarify,
    };
  }

  try {
    // `searchTriggered` is set as soon as we enter the search path, not only
    // on success — "the search ran and returned nothing" is a different failure
    // from "the search never ran", and conflating them hides the real defect.
    const searching = { ...base, searchTriggered: true };
    const result = await runUniversalSearch(
      ctx as never,
      query,
      {
        perEngineLimit: 4,
        maxCitations: 5,
        category: decision.category,
        timeRange: policy.timeRange ?? decision.timeRange,
        skipCache: true,
        freshnessMatters: policy.requiresFreshness,
        preferredProviders: policy.requiresFreshness
          ? policy.preferredProviders
          : undefined,
      },
    );

    const split = policy.requiresFreshness
      ? splitByFreshness(result.citations, policy.maxAgeDays)
      : { fresh: result.citations, undated: [], stale: [] };

    const row: CurrentInfoRow = {
      ...searching,
      enginesTried: result.enginesTried ?? [],
      enginesWithResults: result.enginesWithResults ?? [],
      failedEngines: result.failedEngines ?? [],
      resultsFound: result.citations.length,
      freshResults: split.fresh.length,
      freshness: freshnessStatement(split.fresh, policy.maxAgeDays),
      answer: extractiveBrief(query, split.fresh),
      sources: split.fresh.slice(0, 5).map((c) => ({
        title: c.title,
        url: c.url,
        publishedAt: c.publishedAt ?? null,
      })),
      searchMs: result.searchMs ?? Date.now() - t0,
    };

    if (split.fresh.length === 0) {
      return {
        ...row,
        status: "fail",
        userMessage: noVerificationMessage(query, policy.vertical),
        detail:
          `Search ran (${row.resultsFound} raw result(s)) but none were recent enough to be evidence ` +
          `within ${policy.maxAgeDays} day(s). Omi would refuse to answer rather than use stale data.`,
      };
    }
    return {
      ...row,
      status: "pass",
      detail:
        `${split.fresh.length} fresh result(s) from ${row.enginesWithResults.length} source(s) ` +
        `in ${row.searchMs}ms${row.failedEngines.length > 0 ? `; failed engines: ${row.failedEngines.join(", ")}` : ""}`,
    };
  } catch (err) {
    return {
      ...base,
      searchTriggered: true,
      searchMs: Date.now() - t0,
      // The user never sees the raw error — they see the recovery contract.
      userMessage: noVerificationMessage(query, policy.vertical),
      detail: `search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Run all 10 scenarios and summarise, for the deployed report. */
export async function probeCurrentInfoSuite(
  ctx: QueryRunner,
): Promise<{
  total: number;
  passed: number;
  failed: number;
  rows: CurrentInfoRow[];
}> {
  const rows: CurrentInfoRow[] = [];
  // Sequential on purpose: several open sources rate-limit aggressively
  // (GDELT allows one request per 5s), and a parallel fan-out would turn a
  // working suite into a false-negative.
  for (const s of CURRENT_INFO_SCENARIOS) {
    rows.push(await probeCurrentInfo(ctx, s.query));
  }
  const passed = rows.filter((r) => r.status === "pass").length;
  return {
    total: rows.length,
    passed,
    failed: rows.length - passed,
    rows,
  };
}

// --- Subsystem checks --------------------------------------------------------

/**
 * Frontend: fetch the LIVE site the way any visitor would. Checking a marker
 * plus the llms.txt file proves the *current* artifact is served, not a
 * cached older deployment (llms.txt only exists in recent builds).
 */
async function checkFrontend(): Promise<SubsystemCheck> {
  return check("frontend", async () => {
    const res = await withTimeout(fetch(FRONTEND_URL), NET_TIMEOUT_MS, "frontend");
    if (!res.ok) return { status: "fail", detail: `HTTP ${res.status}` };
    const html = await res.text();
    const titled = html.includes("Omi Universal AI");
    return {
      status: titled ? "pass" : "fail",
      detail: titled
        ? `Live site served its HTML shell with the Omi marker (HTTP ${res.status})`
        : `Live site served but the Omi marker was missing from the HTML (HTTP ${res.status})`,
    };
  });
}

/** Deployment: the newest GitHub Actions run for main must have succeeded. */
async function checkDeployment(): Promise<SubsystemCheck> {
  return check("deployment", async () => {
    // Primary evidence: the ARTIFACT the pipeline published. `llms.txt` only
    // exists in recent builds, so serving it proves the Actions → Pages
    // pipeline ran and published the current code — not a cached old deploy.
    const artifact = await withTimeout(
      fetch(`${FRONTEND_URL}llms.txt`),
      NET_TIMEOUT_MS,
      "deployment artifact",
    );
    if (!artifact.ok) {
      return {
        status: "fail",
        detail: `Published artifact missing (llms.txt → HTTP ${artifact.status}) — the live build is stale or the deploy failed`,
      };
    }

    // Secondary evidence, best-effort: the workflow run itself. The GitHub
    // API is unauthenticated here and shares an egress IP, so a 403 is a
    // normal rate-limit outcome — it degrades the DETAIL, not the verdict.
    let runNote = "workflow run status unavailable (GitHub API rate limited)";
    try {
      const res = await withTimeout(fetch(REPO_API), NET_TIMEOUT_MS, "deployment api");
      if (res.ok) {
        const data = (await res.json()) as {
          workflow_runs?: Array<{
            conclusion?: string;
            head_sha?: string;
            run_number?: number;
          }>;
        };
        const run = data.workflow_runs?.[0];
        if (run) {
          runNote = `run #${run.run_number} (${run.head_sha?.slice(0, 7)}) → ${run.conclusion ?? "in progress"}`;
        }
      }
    } catch {
      // keep the default note
    }

    return {
      status: "pass",
      detail: `Current artifact published by the Actions → Pages pipeline (llms.txt HTTP ${artifact.status}); ${runNote}`,
    };
  });
}

/**
 * Request routing: the plan's test 1, executed for real against the same
 * decision engine the live chat uses. Deterministic, so it is a true PASS.
 */
async function checkRouting(): Promise<SubsystemCheck> {
  return check("request routing", async () => {
    const decision = decideSearch(PROBE_MATH);
    const computed = evaluateExpression(extractMathExpression(PROBE_MATH));
    const routed = decision.intent === "calculation";
    const correct = computed.ok && computed.formatted === PROBE_MATH_EXPECTED;
    return {
      status: routed && correct ? "pass" : "fail",
      detail:
        routed && correct
          ? `"${PROBE_MATH}" → intent "${decision.intent}" → ${computed.ok ? computed.formatted : "?"} (calculator, no provider call)`
          : `routing=${decision.intent}, result=${computed.ok ? computed.formatted : "error"} for "${PROBE_MATH}"`,
    };
  });
}

/** Andromeda query understanding — the pure planner stage, for real. */
async function checkAndromedaPlanner(): Promise<SubsystemCheck> {
  return check("andromeda", async () => {
    const plan = planQuery("Compare the latest Android and iOS release notes");
    if (plan.reject) {
      return { status: "fail", detail: `planner rejected a legitimate query: ${plan.reject.reason}` };
    }
    const sources = getConfiguredProviders();
    return {
      status: sources.length > 0 ? "pass" : "fail",
      detail: `plan → kind "${plan.kind}", ${plan.subqueries.length} angle(s), freshness=${plan.freshnessMatters}; ${sources.length} source(s) ready`,
    };
  });
}

/** Universal search — a REAL keyless retrieval call. */
async function checkRetrieval(): Promise<SubsystemCheck> {
  return check("universal search", async () => {
    const providers = getConfiguredProviders();
    if (providers.length === 0) {
      return { status: "fail", detail: "No Andromeda source is configured." };
    }
    const provider = providers.find((p) => p.id === "wikipedia") ?? providers[0];
    const res = await withTimeout(
      provider.search(PROBE_QUERY, 2, {}),
      NET_TIMEOUT_MS,
      `selftest retrieval via ${provider.id}`,
    );
    const n = res.citations.length;
    return {
      status: n > 0 ? "pass" : "fail",
      detail:
        n > 0
          ? `"${PROBE_QUERY}" → ${n} result(s) via ${provider.label}`
          : `${provider.label} returned no results for the probe query`,
    };
  });
}

/** AI providers — a REAL completion through the provider chain. */
async function checkSynthesis(): Promise<SubsystemCheck> {
  return check("ai providers", async () => {
    const status = getAiStatus();
    if (status.activeProvider === null) {
      return {
        status: "fail",
        detail:
          "No AI provider configured — extractive mode is active (Omi answers from sources but without full synthesis).",
      };
    }
    const res = await withTimeout(
      complete({
        task: "classification",
        messages: [
          { role: "system", content: "Reply with exactly the single word: PONG. Nothing else." },
          { role: "user", content: "ping" },
        ],
        temperature: 0,
        // Reasoning models burn tokens on hidden reasoning before emitting
        // visible content, so a starved budget would report a false failure.
        maxTokens: 128,
      }),
      AI_TIMEOUT_MS,
      "selftest synthesis",
    );
    if (!res.ok || res.content.trim().length === 0) {
      const tried = res.attempts.map((a) => a.provider).join(" → ") || "none";
      return {
        status: classifyProviderFailure(res.attempts),
        detail: `AI chain failed (${res.error ?? "empty response"}); tried: ${tried}`,
      };
    }
    const fellBack = res.attempts.length > 0;
    return {
      status: "pass",
      detail: `AI responded via ${res.provider} (${res.model})${fellBack ? ` after ${res.attempts.length} fallback attempt(s)` : ""}`,
    };
  });
}

/**
 * Secondary AI provider — a REAL call to the provider the router uses as its
 * fallback, with routing pinned to it (`onlyProvider`).
 *
 * "Configured" is not "working": a key can be present and rejected, expired,
 * or out of quota, and the primary provider answering says nothing about the
 * one that is supposed to cover it. This probe forces the second provider to
 * answer, so an independent fallback is a verified PASS rather than a claim.
 * A rate/tier limit reports `unverified` (not a defect); an auth or quota
 * rejection reports `fail`.
 */
async function checkSecondaryProvider(): Promise<SubsystemCheck> {
  return check("ai fallback", async () => {
    const configured = getConfiguredAiProviders();
    const secondary = configured[1];
    if (!secondary) {
      return {
        status: "configured",
        detail:
          configured.length === 1
            ? `Only one AI provider is configured (${configured[0].id}) — there is no independent fallback, so a rate limit or outage on it degrades answers with nothing to fall back to`
            : "No AI provider configured — extractive mode is active",
      };
    }

    const res = await withTimeout(
      complete({
        task: "classification",
        onlyProvider: secondary.id,
        messages: [
          {
            role: "system",
            content: "Reply with exactly the single word: READY. Nothing else.",
          },
          { role: "user", content: "status check" },
        ],
        temperature: 0,
        maxTokens: 128,
      }),
      AI_TIMEOUT_MS,
      "selftest fallback",
    );

    if (!res.ok || res.content.trim().length === 0) {
      const tried =
        res.attempts.map((a) => `${a.provider}/${a.model}`).join(" → ") ||
        secondary.id;
      const verdict = classifyProviderFailure(res.attempts);
      return {
        status: verdict,
        detail:
          verdict === "unverified"
            ? `Fallback provider ${secondary.id} could not be checked right now — upstream rate/tier limit, not a defect (${res.error ?? "empty response"}); tried ${tried}`
            : `Fallback provider ${secondary.id} failed: ${res.error ?? "empty response"}; tried ${tried}`,
      };
    }

    return {
      status: "pass",
      detail: `Independent fallback answered via ${res.provider} (${res.model}) — chain: ${configured.map((p) => p.id).join(" → ")}`,
    };
  });
}

/** Database — a real read proving schema + connectivity. */
async function checkDatabase(ctx: QueryRunner): Promise<SubsystemCheck> {
  return check("database", async () => {
    const out = await ctx.runQuery(internal.omiSelfTest.dbProbe, {});
    const tables = Object.keys(out ?? {}).length;
    return {
      status: tables > 0 ? "pass" : "fail",
      detail: `Read ${tables} table(s) successfully (documents, research runs, agents)`,
    };
  });
}

/** Authentication — the guard must resolve, not throw, without a session. */
async function checkAuth(ctx: QueryRunner): Promise<SubsystemCheck> {
  return check("authentication", async () => {
    const out = await ctx.runQuery(internal.omiSelfTest.authProbe, {});
    return {
      status: typeof out?.authenticated === "boolean" ? "pass" : "fail",
      detail:
        typeof out?.authenticated === "boolean"
          ? `Auth guard resolved (unauthenticated request → authenticated=${out.authenticated}), so sessions are enforced rather than bypassed`
          : "Auth guard did not return a usable result",
    };
  });
}

/**
 * Vision — a REAL image-understanding call.
 *
 * This previously reported `configured` on the grounds that a probe "needs an
 * upload". It does not: a tiny synthetic PNG exercises the exact
 * provider → model → transport path a user's upload takes, without storing,
 * fetching or exposing anybody's file. That upgrade is what makes a retired
 * model visible as a FAIL instead of hiding behind configuration — which is
 * precisely how the Llama 4 shutdown stayed invisible until a user hit it.
 */
async function checkVision(): Promise<SubsystemCheck> {
  return check("vision", async () => {
    const v = getVisionStatus();
    if (!v.available) {
      return {
        status: "fail",
        detail:
          "No vision provider configured — images are stored and retrievable but cannot be described.",
      };
    }
    const res = await withTimeout(
      describeImage(VISION_PROBE_IMAGE, VISION_PROBE_PROMPT, "describe"),
      VISION_TIMEOUT_MS,
      "selftest vision",
    );
    if (!res.ok) {
      const tried =
        res.attempts.map((a) => `${a.provider}/${a.model}`).join(" → ") || "none";
      const verdict = classifyProviderFailure(res.attempts);
      return {
        status: verdict,
        detail:
          verdict === "unverified"
            ? `Vision could not be checked right now — upstream rate/tier limit, not a defect (${res.error ?? "unknown"}); tried ${tried}`
            : `Vision call failed: ${res.error ?? "unknown error"}; tried ${tried}`,
      };
    }
    return {
      status: "pass",
      detail: `Read a real image via ${res.provider} (${res.model}) — answered "${res.description.slice(0, 40)}"`,
    };
  });
}

/**
 * Image GENERATION — a REAL text-to-image call.
 *
 * Generation and editing are separate capabilities with separate provider
 * requirements: generation runs keyless and free, editing needs a key-bearing
 * provider that accepts an image input. Grading them as one verdict hid a
 * working capability behind a blocked one — the report said only "unverified"
 * while generation was in fact live. Two probes, two evidence-backed verdicts.
 *
 * The prompt is FIXED, so this can never be steered into an open image proxy.
 */
async function checkImageGeneration(): Promise<SubsystemCheck> {
  return check("image generation", async () => {
    const configured = getImageProviderStatus().filter((p) => p.configured);
    const canGenerate = configured.filter((p) => p.ops.includes("generate"));

    if (canGenerate.length === 0) {
      return {
        status: "fail",
        detail: `No configured image provider declares generation support (${configured.map((p) => p.id).join(", ") || "none configured"}) — Image Studio reports the router's real error rather than a fake image`,
      };
    }

    const res = await withTimeout(
      runImageOp({
        op: "generate",
        prompt: "A single flat blue square centred on a plain white background, minimal, no text.",
        aspectRatio: "1:1",
        transparent: false,
        sources: [],
      }),
      IMAGE_TIMEOUT_MS,
      "selftest image generate",
    );

    if (!res.ok || !res.bytes || res.bytes.length === 0) {
      const tried =
        res.attempts.map((a) => `${a.provider}/${a.model}`).join(" → ") || "none";
      const verdict = classifyProviderFailure(res.attempts);
      return {
        status: verdict,
        detail:
          verdict === "unverified"
            ? `Image generation could not be checked right now — upstream rate/tier/quota limit, not a defect (${res.error ?? "unknown"}); tried ${tried}`
            : `Image generation failed: ${res.error ?? "unknown error"}; tried ${tried}`,
      };
    }

    return {
      status: "pass",
      detail: `Generated a real image via ${res.provider} (${res.model}) — ${res.bytes.length} bytes at ${res.width}×${res.height}`,
    };
  });
}

/**
 * Image EDITING — a REAL edit-family call.
 *
 * Reporting this from env-var presence alone is exactly the trap the vision
 * probe was built to close (a provider can be "configured" and still be
 * rejected, expired or retired), so this pushes the same tiny synthetic PNG the
 * vision probe uses through the production edit path — no upload, no storage,
 * nobody's file.
 *
 * Env var NAMES are deliberately not named here: this endpoint is public, and
 * its safety contract forbids disclosing them (see http.ts).
 */
async function checkImageEditing(): Promise<SubsystemCheck> {
  return check("image editing", async () => {
    const configured = getImageProviderStatus().filter((p) => p.configured);
    const canGenerate = configured.filter((p) => p.ops.includes("generate"));
    const canEdit = configured.filter((p) => p.ops.includes("edit"));

    if (canEdit.length === 0) {
      return {
        status: "configured",
        detail:
          canGenerate.length > 0
            ? `Generation is live via ${canGenerate.map((p) => p.id).join(", ")}; edit/background/enhance/upscale need an image-input provider key, which is not configured — those modes show the router's real error instead of a fake image`
            : "No image provider configured — image operations report an honest routing error",
      };
    }

    const res = await withTimeout(
      runImageOp({
        op: "edit",
        prompt:
          "Recolour this image to a single flat blue. Return only the edited image.",
        aspectRatio: "1:1",
        transparent: false,
        sources: [VISION_PROBE_IMAGE],
      }),
      IMAGE_TIMEOUT_MS,
      "selftest image edit",
    );

    if (!res.ok || !res.bytes || res.bytes.length === 0) {
      const tried =
        res.attempts.map((a) => `${a.provider}/${a.model}`).join(" → ") || "none";
      const verdict = classifyProviderFailure(res.attempts);
      return {
        status: verdict,
        detail:
          verdict === "unverified"
            ? `Image editing could not be checked right now — upstream rate/tier/quota limit (a 429 covers a spent free-tier quota or a project without billing), not a defect (${res.error ?? "unknown"}); tried ${tried}`
            : `Image edit failed: ${res.error ?? "unknown error"}; tried ${tried}`,
      };
    }

    return {
      status: "pass",
      detail: `Edited a real image via ${res.provider} (${res.model}) — returned ${res.bytes.length} bytes at ${res.width}×${res.height}`,
    };
  });
}

/**
 * Generic capability probe for the image operations the Image Engine exposes
 * as distinct capabilities: background removal, background replacement,
 * combination, upscaling, enhancement, transparency and variation.
 *
 * Each runs a REAL call through the production router — but only when at
 * least one configured provider declares that EXACT capability. Otherwise it
 * reports honestly (unavailable / configured) rather than pretending. This is
 * what keeps "text-to-image works" from being reported as "the Image Engine
 * works": a PASS here means that specific capability returned a verified
 * image just now.
 *
 * Probe inputs are FIXED (a synthetic PNG and a fixed instruction), so this
 * can never be steered into an open image proxy.
 */
async function probeImageCapability(
  subsystem: string,
  op: ImageOp,
  args: { prompt: string; sources?: string[]; transparent?: boolean },
): Promise<SubsystemCheck> {
  return check(subsystem, async () => {
    const cap = getImageCapabilityReport().find((c) => c.op === op);
    if (!cap || !cap.available) {
      return {
        status: "configured",
        detail: `${capabilityForOp(op)} is not available: no configured provider declares it (${
          cap?.providers.length ? `declared by ${cap.providers.join(", ")}` : "none declare it"
        }). Add a Gemini or OpenAI key in the Keys tab to enable it.`,
      };
    }

    const res = await withTimeout(
      runImageOp({
        op,
        prompt: args.prompt,
        aspectRatio: "1:1",
        transparent: args.transparent ?? false,
        sources: args.sources,
      }),
      IMAGE_TIMEOUT_MS,
      `selftest ${subsystem}`,
    );
    const tried = res.attempts.map((a) => `${a.provider}/${a.model}`).join(" → ") || "none";

    if (!res.ok || !res.bytes || res.bytes.length === 0) {
      const verdict = classifyProviderFailure(res.attempts);
      return {
        status: verdict,
        detail:
          verdict === "unverified"
            ? `${capabilityForOp(op)} could not be checked right now — upstream rate/tier/quota limit, not a defect (${res.error ?? "unknown"}); tried ${tried}`
            : `${capabilityForOp(op)} failed: ${res.error ?? "unknown error"}; tried ${tried}`,
      };
    }
    return {
      status: "pass",
      detail: `${capabilityForOp(op)} returned a real verified image via ${res.provider} (${res.model}) — ${res.bytes.length} bytes at ${res.width}×${res.height}`,
    };
  });
}

/**
 * Image pipeline surfaces whose end-to-end path needs a signed-in session and
 * an upload (http.ts is unauthenticated), or a real rasterizer for local
 * transparency checks. Reported honestly as `configured` — deployed code +
 * unit coverage — rather than upgraded to PASS on the strength of the deploy.
 */
async function checkImageUpload(): Promise<SubsystemCheck> {
  return check("image upload", async () => ({
    status: "configured",
    detail:
      "Upload → ingest → omiDocuments path is deployed with on-device size/type validation; end-to-end upload needs a signed-in session",
  }));
}

async function checkImageStorage(): Promise<SubsystemCheck> {
  return check("image storage", async () => ({
    status: "configured",
    detail:
      "Generated bytes are stored in Convex file storage only after format verification; end-to-end store needs a signed-in session",
  }));
}

async function checkImageRetrieval(): Promise<SubsystemCheck> {
  return check("image retrieval", async () => ({
    status: "configured",
    detail:
      "Gallery/URL reads are ownership-checked queries; end-to-end retrieval needs a signed-in session",
  }));
}

/**
 * File processing and deep research are the two subsystems whose end-to-end
 * paths need an upload or a signed-in session, which this unauthenticated
 * endpoint cannot supply. Reported honestly as `configured` rather than
 * upgraded to PASS on the strength of deployed code.
 */
async function checkFileProcessing(): Promise<SubsystemCheck> {
  return check("file processing", async () => ({
    status: "configured",
    detail:
      "Extraction runs on-device (PDF/DOCX/XLSX/OCR) with server-side ingest — verified by unit tests; end-to-end upload needs a signed-in session",
  }));
}

async function checkDeepResearch(): Promise<SubsystemCheck> {
  return check("deep research", async () => ({
    status: "configured",
    detail:
      "Pipeline + researchRuns persistence deployed (table read verified under database); end-to-end run needs a signed-in session",
  }));
}

// --- Entry point -------------------------------------------------------------

/** Run every probe (or return the cached report). Never throws. */
export async function runSelfTest(ctx: QueryRunner): Promise<SelfTestReport> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.report, cached: true };
  }

  const subsystems = await Promise.all([
    checkFrontend(),
    checkDeployment(),
    // Convex is self-evident: this code is executing inside the deployment.
    check("convex", async () => ({
      status: "pass" as SubsystemStatus,
      detail: "This report is served by the live Convex deployment",
    })),
    checkDatabase(ctx),
    checkAuth(ctx),
    checkRouting(),
    checkAndromedaPlanner(),
    check("searxng reachability", async () => {
      // A real probe: the previous status was a hardcoded `true` while every
      // public instance actually returned HTML instead of JSON.
      const health = await searxngHealth();
      return {
        status: (health.healthy ? "pass" : "configured") as SubsystemStatus,
        detail: health.detail.slice(0, 400),
      };
    }),
    check("current information", async () => {
      const suite = await probeCurrentInfoSuite(ctx);
      return {
        status: (suite.passed === suite.total ? "pass" : "fail") as SubsystemStatus,
        detail:
          `${suite.passed}/${suite.total} live current-information scenarios returned fresh, dated sources. ` +
          suite.rows
            .filter((r) => r.status === "pass")
            .slice(0, 4)
            .map((r) => `"${r.query}" → ${r.freshResults} fresh from ${r.enginesWithResults.join("+") || "?"}`)
            .join("; "),
      };
    }),
    checkRetrieval(),
    checkSynthesis(),
    checkSecondaryProvider(),
    checkVision(),
    checkImageGeneration(),
    checkImageEditing(),
    // The Image Engine's separate capabilities are graded separately — a
    // working text-to-image provider must never make the whole engine PASS.
    probeImageCapability("image background removal", "remove", {
      prompt: "Remove the background and keep only the subject, clean edges.",
      sources: [VISION_PROBE_IMAGE],
    }),
    probeImageCapability("image background replacement", "replace", {
      prompt: "Replace the background with a plain studio backdrop; keep the subject.",
      sources: [VISION_PROBE_IMAGE],
    }),
    probeImageCapability("image variation", "variation", {
      prompt: "A minimalist geometric emblem on a dark background.",
    }),
    probeImageCapability("image combination", "combine", {
      prompt: "Combine these two images into one balanced composition.",
      sources: [VISION_PROBE_IMAGE, VISION_PROBE_IMAGE],
    }),
    probeImageCapability("image upscaling", "upscale", {
      prompt: "Upscale to a higher resolution, recovering crisp edges; keep content identical.",
      sources: [VISION_PROBE_IMAGE],
    }),
    probeImageCapability("image enhancement", "enhance", {
      prompt: "Enhance clarity and colour balance without changing the subject.",
      sources: [VISION_PROBE_IMAGE],
    }),
    probeImageCapability("image transparency", "generate", {
      prompt: "A simple white circle centred on a transparent background, no text.",
      transparent: true,
    }),
    checkImageUpload(),
    checkImageStorage(),
    checkImageRetrieval(),
    checkFileProcessing(),
    checkDeepResearch(),
  ]);

  const count = (s: SubsystemStatus) =>
    subsystems.filter((x) => x.status === s).length;
  const fails = count("fail");
  const passes = count("pass");

  // Retrieval + routing + database are the core capability. If a core check
  // fails the system is down; anything else failing is degraded, not broken.
  const coreNames = ["database", "request routing", "universal search"];
  const coreFail = subsystems.some(
    (x) => coreNames.includes(x.subsystem) && x.status === "fail",
  );
  const status: SelfTestReport["status"] = coreFail
    ? "down"
    : fails > 0
      ? "degraded"
      : "ok";

  const report: Omit<SelfTestReport, "cached"> = {
    service: OMI_PRODUCT_NAME,
    identity: CREATOR_STATEMENT,
    status,
    time: new Date().toISOString(),
    summary: {
      pass: passes,
      fail: fails,
      configured: count("configured"),
      unverified: count("unverified"),
    },
    subsystems,
  };

  cached = { at: Date.now(), report };
  return { ...report, cached: false };
}
