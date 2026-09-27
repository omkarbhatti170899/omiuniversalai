import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { clientKeyFrom } from "./searchEngine/limits";
import { consumeFromCtx } from "./rateLimits";
import { auth } from "./auth";
import { getAiStatus } from "./aiProviders/catalog";
import { getVisionStatus } from "./aiProviders/visionCatalog";
import { getImageProviderStatus } from "./aiProviders/imageCatalog";
import { getProviderStatus, warmGeneralWebHealth } from "./searchProviders";
import { runSelfTest, probeCurrentInfo, probeCurrentInfoSuite } from "./omiSelfTest";
import { breakerStatus } from "./searchEngine/resilience";
import { modelDiscoveryStatus } from "./aiProviders/modelDiscovery";
import {
  CREATOR_STATEMENT,
  OMI_CREATOR,
  OMI_ECOSYSTEM,
  OMI_PRODUCT_NAME,
} from "./omiIdentity";

const http = httpRouter();

auth.addHttpRoutes(http);

/**
 * Public status / health surface (master plan §28: health checks — plus the
 * standing product requirement for a shareable status URL).
 *
 * ── Safety contract ────────────────────────────────────────────────────────
 * These routes are UNAUTHENTICATED by design, so they report ONLY booleans and
 * public metadata:
 *   • never a secret value, API key, token, or env var VALUE
 *   • never env var NAMES either — a public page has no reason to name them
 *   • never user, document, conversation, or upload data
 *   • no private volume counts (a count is still user data)
 * The AI/search catalogs already expose `configured: boolean` + public model
 * labels + honest cost strings; that is the maximum disclosed here.
 *
 * `/`         → plain-text summary, readable by any agent or browser tool
 * `/health`   → minimal liveness probe (status + time)
 * `/status`   → full machine-readable capability snapshot
 * `/selftest` → LIVE end-to-end probe (real retrieval + real AI call),
 *               per-stage pass/fail. Cached 5 min; the probe query is fixed
 *               so this is not an open search/AI proxy.
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Live capability snapshot — public metadata only (see safety contract). */
function statusSnapshot() {
  const ai = getAiStatus();
  const vision = getVisionStatus();
  const imageProviders = getImageProviderStatus();
  const sources = getProviderStatus();

  // Which image OPS a configured provider actually declares — capability, not
  // a vendor list. An op missing here is one Omi will refuse honestly rather
  // than pretend to run.
  const imageOps = [
    ...new Set(
      imageProviders.filter((p) => p.configured).flatMap((p) => p.ops),
    ),
  ].sort();

  return {
    service: OMI_PRODUCT_NAME,
    ecosystem: OMI_ECOSYSTEM,
    creator: OMI_CREATOR,
    identity: CREATOR_STATEMENT,
    status: "ok",
    time: new Date().toISOString(),
    ai: {
      // CONFIGURATION only: a provider key can be present and still be
      // rejected upstream (expired key, exhausted quota). /selftest makes a
      // real call and is the only place that reports VERIFIED availability.
      configured: ai.activeProvider !== null,
      verifiedBy: "/selftest",
      available: ai.activeProvider !== null,
      activeProvider: ai.activeProvider,
      activeLabel: ai.activeLabel,
      providers: ai.providers.map((p) => ({
        id: p.id,
        label: p.label,
        configured: p.configured,
        cost: p.cost,
        // Circuit state is process-local and resets on deploy/cold start.
        circuit: breakerStatus()[`ai:${p.id}`] ?? { open: false, failures: 0 },
        // Whether this provider's configured models were found in its live
        // catalogue (modelDiscovery.ts). `verified: false` means the catalogue
        // was unreachable — NOT that the models are missing.
        models: modelDiscoveryStatus()[p.id] ?? {
          verified: false,
          modelCount: null,
        },
      })),
    },
    vision: {
      available: vision.available,
      // Configuration only. The model is published on purpose: a provider
      // retiring it is then visible right here instead of surfacing as a 404
      // the first time somebody uploads a photo. /selftest makes a real call.
      verifiedBy: "/selftest",
      activeProvider: vision.activeProvider,
      models: vision.taskModels,
      providers: vision.providers.map((p) => ({
        id: p.id,
        label: p.label,
        configured: p.configured,
        cost: p.cost,
      })),
    },
    images: {
      // CONFIGURATION + declared capability only; /selftest performs a real
      // edit through the same router a user's request takes.
      verifiedBy: "/selftest",
      operationsAvailable: imageOps,
      providers: imageProviders.map((p) => ({
        id: p.id,
        label: p.label,
        configured: p.configured,
        cost: p.cost,
        ops: p.ops,
        transparentBackground: p.transparentBackground,
      })),
    },
    andromeda: {
      sourcesTotal: sources.length,
      sourcesReady: sources.filter((s) => s.ready).length,
      // Enabled vs configured is reported separately, not folded into `ready`.
      // Collapsing them makes a provider that is switched OFF
      // indistinguishable from one that is on but missing credentials — the
      // single most misleading thing a status page can do. `enabled` is the
      // owner's feature decision, `configured` is "a credential is present",
      // `ready` is "can serve right now".
      sourcesEnabled: sources.filter((s) => s.enabled).length,
      sourcesConfigured: sources.filter((s) => s.configured).length,
      cost: "$0 per query — keyless free/open sources only",
      sources: sources.map((s) => ({
        id: s.id,
        label: s.label,
        enabled: s.enabled,
        configured: s.configured,
        ready: s.ready,
        requiresKey: s.requiresKey,
        cost: s.cost,
      })),
    },
    capabilities: [
      "Omi Chat with grounded citations",
      "Andromeda research pipeline (search → gates → evidence → synthesis → verification)",
      "Deep Research multi-subquery investigation",
      "Web + URL search across keyless providers",
      "Multimodal attachments (image understanding, PDF, DOCX, XLSX, CSV, TXT)",
      "Image Studio — generate, edit, background, enhance, upscale, variations",
      "Human Emotions AI",
      "Agent workflows with human approval + independent verification",
      "Persistent memory and a private knowledge base",
    ],
  };
}

http.route({
  path: "/",
  method: "GET",
  handler: httpAction(async () => {
    const s = statusSnapshot();
    const ready = s.andromeda.sources;
    const lines = [
      `${s.service} — ${s.ecosystem}`,
      s.identity,
      "",
      `status: ${s.status}`,
      `time:   ${s.time}`,
      "",
      `AI synthesis:    ${s.ai.available ? `available via ${s.ai.activeLabel}` : "not configured (extractive floor active — Omi still answers from sources)"}`,
      `Image vision:    ${s.vision.available ? `available via ${s.vision.activeProvider}` : "not configured (uploaded images are stored; description needs a vision key)"}`,
      `Image Studio:    ${s.images.operationsAvailable.length > 0 ? `${s.images.operationsAvailable.join(", ")} (${s.images.operationsAvailable.includes("edit") ? "generation + editing" : "generation only"})` : "no image provider configured"}`,
      `Andromeda sources ready: ${s.andromeda.sourcesReady}/${s.andromeda.sourcesTotal} (${s.andromeda.cost})`,
      "",
      "Capabilities:",
      ...s.capabilities.map((c) => `  - ${c}`),
      "",
      "Andromeda sources:",
      ...ready.map((p) => `  - ${p.label}: ${p.ready ? "ready" : "unavailable"} (${p.cost})`),
      "",
      "Machine-readable status: /health, /status",
      "Live end-to-end self-test: /selftest",
    ];
    return textResponse(lines.join("\n"));
  }),
});

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return jsonResponse({
      status: "ok",
      service: OMI_PRODUCT_NAME,
      time: new Date().toISOString(),
    });
  }),
});

/**
 * CURRENT-INFORMATION END-TO-END PROBE (public, read-only).
 *
 * `/currentinfo?query=…`  — one question, the whole chain, every link named:
 *   current intent → search trigger → provider → results → freshness →
 *   answer → sources.
 *
 * `/currentinfo`           — the full 10-scenario suite.
 *
 * This exists because "current information is not working" is not diagnosable
 * from a boolean. Each row says which engine ran, how many results came back,
 * how many were recent enough to be evidence, what the answer was and which
 * URLs backed it — so a failure names the broken link.
 *
 * The query is a fixed, non-personal probe when omitted, and user-supplied
 * queries are length-capped and never persisted. No auth, no user data.
 */
/**
 * Public, unauthenticated diagnostic route cooldown.
 *
 * The ad-hoc `?query=` form is a genuine open search proxy: anyone on the
 * internet could make Omi issue live searches against GDELT, TheSportsDB,
 * SearXNG and Open-Meteo, spending shared free-tier quota and using Omi's
 * egress IP to hammer third parties. It stays available for debugging, but at
 * a bounded rate. The fixed 10-scenario suite is separately cached.
 *
 * The counter lives in a real Convex TABLE (`rateLimits.ts`), not a module-level
 * array: Convex instances are ephemeral and independently scheduled, so an
 * in-process counter resets on every cold start and can be sidestepped by being
 * routed to a different instance. `ctx.storage` is not a substitute — it
 * rejects arbitrary string keys and only accepts file IDs.
 */
const CURRENT_INFO_ADHOC_MAX = 8;
const CURRENT_INFO_ADHOC_WINDOW_MS = 60_000;

http.route({
  path: "/currentinfo",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const q = url.searchParams.get("query")?.slice(0, 200);
    if (q) {
      const limit = await consumeFromCtx(
        ctx,
        "public-diagnostic",
        clientKeyFrom(request),
        CURRENT_INFO_ADHOC_MAX,
        CURRENT_INFO_ADHOC_WINDOW_MS,
      );
      if (!limit.ok) {
        return jsonResponse(
          {
            error:
              "Too many ad-hoc diagnostic queries. The current-information suite (no ?query=) stays available.",
            retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000),
          },
          429,
        );
      }
      const row = await probeCurrentInfo(ctx, q);
      // Report the limiter's own view alongside the result. A cooldown that
      // silently fails open looks identical to a cooldown that is working, and
      // the only way to tell them apart is to say which one happened.
      return jsonResponse(
        {
          ...row,
          rateLimit: { ok: limit.ok, remaining: limit.remaining, degraded: limit.degraded },
        },
        row.status === "pass" ? 200 : 503,
      );
    }
    const suite = await probeCurrentInfoSuite(ctx);
    return jsonResponse(
      {
        service: `${OMI_PRODUCT_NAME} — current information`,
        time: new Date().toISOString(),
        summary: { total: suite.total, passed: suite.passed, failed: suite.failed },
        scenarios: suite.rows,
      },
      suite.failed === 0 ? 200 : 503,
    );
  }),
});

http.route({
  path: "/status",
  method: "GET",
  handler: httpAction(async () => {
    // Readiness of the general-web floor is MEASURED, not assumed (§3). The
    // probe is cached, so a repeated /status costs one request, not N.
    await warmGeneralWebHealth();
    return jsonResponse(statusSnapshot());
  }),
});

http.route({
  path: "/selftest",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const report = await runSelfTest(ctx);
    return jsonResponse(report, report.status === "down" ? 503 : 200);
  }),
});

// CORS preflight for browser-based agents fetching the routes above.
for (const path of ["/", "/health", "/status", "/selftest", "/currentinfo"]) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => preflightResponse()) });
}

export default http;
