import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { getAiStatus } from "./aiProviders/catalog";
import { getVisionStatus } from "./aiProviders/visionCatalog";
import { getProviderStatus } from "./searchProviders";
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
 * `/`       → plain-text summary, readable by any agent or browser tool
 * `/health` → minimal liveness probe (status + time)
 * `/status` → full machine-readable capability snapshot
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
  const sources = getProviderStatus();

  return {
    service: OMI_PRODUCT_NAME,
    ecosystem: OMI_ECOSYSTEM,
    creator: OMI_CREATOR,
    identity: CREATOR_STATEMENT,
    status: "ok",
    time: new Date().toISOString(),
    ai: {
      available: ai.activeProvider !== null,
      activeProvider: ai.activeProvider,
      activeLabel: ai.activeLabel,
      providers: ai.providers.map((p) => ({
        id: p.id,
        label: p.label,
        configured: p.configured,
        cost: p.cost,
      })),
    },
    vision: {
      available: vision.available,
      activeProvider: vision.activeProvider,
      providers: vision.providers.map((p) => ({
        id: p.id,
        label: p.label,
        configured: p.configured,
        cost: p.cost,
      })),
    },
    andromeda: {
      sourcesTotal: sources.length,
      sourcesReady: sources.filter((s) => s.ready).length,
      cost: "$0 per query — keyless free/open sources only",
      sources: sources.map((s) => ({
        id: s.id,
        label: s.label,
        ready: s.ready,
        cost: s.cost,
      })),
    },
    capabilities: [
      "Omi Chat with grounded citations",
      "Andromeda research pipeline (search → gates → evidence → synthesis → verification)",
      "Deep Research multi-subquery investigation",
      "Web + URL search across keyless providers",
      "Multimodal attachments (image understanding, PDF, DOCX, XLSX, CSV, TXT)",
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
      `Andromeda sources ready: ${s.andromeda.sourcesReady}/${s.andromeda.sourcesTotal} (${s.andromeda.cost})`,
      "",
      "Capabilities:",
      ...s.capabilities.map((c) => `  - ${c}`),
      "",
      "Andromeda sources:",
      ...ready.map((p) => `  - ${p.label}: ${p.ready ? "ready" : "unavailable"} (${p.cost})`),
      "",
      "Machine-readable status: /health, /status",
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

http.route({
  path: "/status",
  method: "GET",
  handler: httpAction(async () => jsonResponse(statusSnapshot())),
});

// CORS preflight for browser-based agents fetching the routes above.
for (const path of ["/", "/health", "/status"]) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => preflightResponse()) });
}

export default http;
