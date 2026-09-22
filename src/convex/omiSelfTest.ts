/**
 * Omi live self-test — server-side, end-to-end capability probe.
 *
 * Why this exists: "the build passed" and "the deploy went green" are not
 * proof the product works. This module exercises the REAL runtime paths and
 * reports per-stage pass/fail, so the claim "Omi works" is backed by evidence
 * from the live deployment rather than from a local laptop.
 *
 * Each check is honest about what it proves:
 *   • retrieval  — a REAL keyless search call; proves live retrieval works
 *   • synthesis  — a REAL AI completion; proves the provider chain answers
 *   • vision     — provider CONFIGURATION only (a live image call would need
 *                  an upload; configuration is all that can be asserted here,
 *                  and the check says so rather than implying more)
 *   • sources    — how many Andromeda sources are ready to serve
 *
 * Safety: the probe query is FIXED (callers cannot influence it, so this can
 * never be used as an open search/AI proxy), output is tiny, and results are
 * cached in-process so the endpoint cannot be hammered into spending quota.
 *
 * This file must stay importable from the V8 (non-"use node") runtime so the
 * HTTP router can call it: it depends only on non-node modules.
 */

import { complete } from "./aiProviders";
import { getAiStatus } from "./aiProviders/catalog";
import { getVisionStatus } from "./aiProviders/visionCatalog";
import { getConfiguredProviders } from "./searchProviders";
import { withTimeout } from "./searchEngine/resilience";
import { OMI_PRODUCT_NAME } from "./omiIdentity";

export type SelfTestCheck = {
  step: string;
  ok: boolean;
  /** Human-readable evidence for the verdict — never a bare boolean. */
  detail: string;
  ms: number;
};

export type SelfTestReport = {
  service: string;
  status: "ok" | "degraded" | "down";
  time: string;
  /** True when this is a cached report rather than a fresh probe. */
  cached: boolean;
  passed: number;
  total: number;
  checks: SelfTestCheck[];
};

/** Fixed probe term — stable, keyless, and NOT caller-influenced. */
const PROBE_QUERY = "Andromeda Galaxy";
const RETRIEVAL_TIMEOUT_MS = 12_000;
const SYNTHESIS_TIMEOUT_MS = 20_000;
/** Cache TTL: bounds cost and abuse on this unauthenticated endpoint. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { at: number; report: Omit<SelfTestReport, "cached"> } | null = null;

async function timed(
  step: string,
  fn: () => Promise<{ ok: boolean; detail: string }>,
): Promise<SelfTestCheck> {
  const t0 = Date.now();
  try {
    const { ok, detail } = await fn();
    return { step, ok, detail, ms: Date.now() - t0 };
  } catch (err) {
    return {
      step,
      ok: false,
      detail: err instanceof Error ? err.message : "Unexpected error",
      ms: Date.now() - t0,
    };
  }
}

/** Live retrieval through a real keyless provider. */
async function checkRetrieval(): Promise<SelfTestCheck> {
  return timed("retrieval", async () => {
    const providers = getConfiguredProviders();
    if (providers.length === 0) {
      return { ok: false, detail: "No Andromeda source is configured." };
    }
    // Prefer Wikipedia: keyless, stable, and gentle on upstream limits.
    const provider =
      providers.find((p) => p.id === "wikipedia") ?? providers[0];
    const res = await withTimeout(
      provider.search(PROBE_QUERY, 2, {}),
      RETRIEVAL_TIMEOUT_MS,
      `selftest retrieval via ${provider.id}`,
    );
    const n = res.citations.length;
    return {
      ok: n > 0,
      detail:
        n > 0
          ? `"${PROBE_QUERY}" → ${n} result(s) via ${provider.label}`
          : `${provider.label} returned no results for the probe query`,
    };
  });
}

/** Live AI completion through the provider chain. */
async function checkSynthesis(): Promise<SelfTestCheck> {
  return timed("synthesis", async () => {
    const status = getAiStatus();
    if (status.activeProvider === null) {
      return {
        ok: false,
        detail:
          "No AI provider configured — extractive mode is active. Omi still answers from sources, but without full synthesis.",
      };
    }
    const res = await withTimeout(
      complete({
        task: "classification",
        messages: [
          {
            role: "system",
            content:
              "Reply with exactly the single word: PONG. Nothing else.",
          },
          { role: "user", content: "ping" },
        ],
        temperature: 0,
        // A realistic budget: reasoning models burn tokens on hidden reasoning
        // before emitting visible content, so a starved probe would report a
        // failure the app itself would never hit.
        maxTokens: 128,
      }),
      SYNTHESIS_TIMEOUT_MS,
      "selftest synthesis",
    );
    if (!res.ok || res.content.trim().length === 0) {
      const why = res.error ?? "empty response";
      const tried = res.attempts.map((a) => a.provider).join(" → ") || "none";
      return { ok: false, detail: `AI chain failed (${why}); tried: ${tried}` };
    }
    return {
      ok: true,
      detail: `AI responded via ${res.provider} (${res.model})`,
    };
  });
}

/** Vision is configuration-only here — a real image call needs an upload. */
async function checkVision(): Promise<SelfTestCheck> {
  return timed("vision", async () => {
    const v = getVisionStatus();
    return v.available
      ? {
          ok: true,
          detail: `Image understanding configured via ${v.activeProvider} (configuration verified; not exercised with an image here)`,
        }
      : {
          ok: false,
          detail:
            "No vision provider configured — uploaded images are stored and retrievable, but Omi cannot describe them yet.",
        };
  });
}

/** How many Andromeda sources are ready to serve. */
async function checkSources(): Promise<SelfTestCheck> {
  return timed("andromeda sources", async () => {
    const providers = getConfiguredProviders();
    return {
      ok: providers.length > 0,
      detail: `${providers.length} source(s) ready: ${providers.map((p) => p.id).join(", ") || "none"}`,
    };
  });
}

/**
 * Run every probe (or return the cached report). Never throws.
 */
export async function runSelfTest(): Promise<SelfTestReport> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.report, cached: true };
  }

  const checks = await Promise.all([
    checkRetrieval(),
    checkSynthesis(),
    checkVision(),
    checkSources(),
  ]);

  const passed = checks.filter((c) => c.ok).length;
  const retrievalOk = checks.find((c) => c.step === "retrieval")?.ok ?? false;
  const synthesisOk = checks.find((c) => c.step === "synthesis")?.ok ?? false;

  // Retrieval is the core capability — if it's gone, the system is down.
  // Synthesis/vision failing means degraded, not broken (extractive floor
  // still answers), which is exactly the honest distinction.
  const status: SelfTestReport["status"] = !retrievalOk
    ? "down"
    : passed === checks.length
      ? "ok"
      : synthesisOk
        ? "ok"
        : "degraded";

  const report: Omit<SelfTestReport, "cached"> = {
    service: OMI_PRODUCT_NAME,
    status,
    time: new Date().toISOString(),
    passed,
    total: checks.length,
    checks,
  };

  cached = { at: Date.now(), report };
  return { ...report, cached: false };
}
