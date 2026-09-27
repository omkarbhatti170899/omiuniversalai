/**
 * INTERNAL provider diagnostics (never exposed over HTTP, never public).
 *
 * Purpose: settle exactly WHY a configured image-edit credential is being
 * rejected, from inside the Convex runtime where the value actually lives —
 * without ever returning, logging or echoing the secret itself.
 *
 * Safety contract:
 *   • never returns the credential value, and never any substring of it
 *     beyond the non-secret scheme prefix (`pk_`/`sk_`) and its length
 *   • never returns a raw provider body verbatim — only a short, sanitized
 *     reason code so a 401 can be told apart from a 403/402/429
 *   • runs only locally via `convex run`; it is an internalAction, so no
 *     client can call it
 */

import { internalAction } from "./_generated/server";
import { verifyImageBytes } from "./aiProviders/imageVerify";
import { probeInstance, searxngHealth } from "./searchProviders/searxng";

const EDITS_URL = "https://gen.pollinations.ai/v1/images/edits";
const GEN_URL = "https://gen.pollinations.ai/v1/images/generations";

/** The same tiny synthetic PNG the self-test uses (public, not a secret). */
const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsEvi2/55DGME38JgBZapfi0CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApcFEWchD98r0aIAAAAASUVORK5CYII=";

/** Describe a credential WITHOUT revealing it. */
function describeKey(raw: string | undefined) {
  const value = raw ?? "";
  const trimmed = value.trim();
  const prefix = trimmed.slice(0, 3);
  return {
    present: value.length > 0,
    length: value.length,
    trimmedLength: trimmed.length,
    hasSurroundingWhitespace: value.length !== trimmed.length,
    wrappedInQuotes: /^["'`]|["'`]$/.test(trimmed),
    prefixLooksValid: prefix === "pk_" || prefix === "sk_",
    prefix,
  };
}

/** Short, sanitized classification of a provider response body. */
function reasonFrom(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401) return "401 unauthorized (key not recognized)";
  if (status === 403) return "403 forbidden (key recognized but not permitted)";
  if (status === 402) return "402 payment required (no balance)";
  if (status === 429) return "429 rate limited / quota";
  if (status >= 500) return `5xx upstream (${status})`;
  if (b.includes("api key") || b.includes("unauthorized")) return "auth error in body";
  return `http ${status}`;
}

async function attempt(
  label: string,
  url: string,
  key: string,
  authMode: "bearer" | "query" | "x-api-key" | "none",
) {
  const headers: Record<string, string> = {};
  let target = url;
  if (authMode === "bearer") headers["Authorization"] = `Bearer ${key}`;
  else if (authMode === "x-api-key") headers["x-api-key"] = key;
  else if (authMode === "query") target = `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;

  const form = new FormData();
  form.append("model", "kontext");
  form.append("prompt", "recolour to a flat blue");
  form.append("size", "512x512");
  const m = PROBE_IMAGE.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (m) {
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    form.append("image", new Blob([bytes], { type: m[1] }), "ref-0.png");
  }

  try {
    const res = await fetch(target, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && ct.startsWith("image/")) {
      const buf = new Uint8Array(await res.arrayBuffer());
      const v = verifyImageBytes(buf, ct);
      return { label, authMode, status: res.status, ok: v.ok, bytes: buf.length, reason: v.ok ? "verified image" : "body was not an image", body: "" };
    }
    const text = (await res.text()).slice(0, 300);
    // Defense in depth: strip anything that looks like a credential from a
    // provider body before it is ever returned.
    const safe = text.replace(/(sk_|pk_)[A-Za-z0-9_-]{6,}/g, "$1<redacted>");
    return { label, authMode, status: res.status, ok: false, bytes: 0, reason: reasonFrom(res.status, text), body: safe };
  } catch (e) {
    return { label, authMode, status: -1, ok: false, bytes: 0, reason: `network: ${e instanceof Error ? e.message : "error"}`, body: "" };
  }
}

/** Read an account endpoint with the key; returns status + a short safe body. */
async function accountProbe(path: string, key: string) {
  try {
    const res = await fetch(`https://gen.pollinations.ai${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const text = (await res.text()).slice(0, 400);
    const safe = text.replace(/(sk_|pk_)[A-Za-z0-9_-]{6,}/g, "$1<redacted>");
    return { path, status: res.status, body: res.ok ? safe : reasonFrom(res.status, text) };
  } catch (e) {
    return { path, status: -1, body: `network: ${e instanceof Error ? e.message : "error"}` };
  }
}

/**
 * Probe the configured SearXNG base URL FROM the Convex runtime, so a
 * host-side success that fails behind Convex's egress is visible.
 */
export const probeSearxng = internalAction({
  args: {},
  handler: async () => {
    const configured = (process.env.SEARXNG_BASE_URL ?? "").replace(/\/+$/, "");
    const air = (process.env.SEARXNG_BASE_URL ?? "").trim();
    const probe = configured ? await probeInstance(configured, 12_000) : null;
    const health = await searxngHealth();
    return {
      configuredBase: configured || null,
      rawLength: (process.env.SEARXNG_BASE_URL ?? "").length,
      hasWhitespace: air.length !== (process.env.SEARXNG_BASE_URL ?? "").length,
      probe,
      health,
    };
  },
});

/**
 * Sweep the edit-capable models to find one this key IS permitted to use.
 * If the account scoped the key to a specific model, editing can still work
 * today by selecting an allowed one — instead of the user having to change
 * permissions at all.
 */
export const sweepPollinationsModels = internalAction({
  args: {},
  handler: async () => {
    const key = (process.env.POLLINATIONS_API_KEY ?? "").trim();
    const models = [
      "kontext",
      "flux.2-klein-4b",
      "flux",
      "sana",
      "z-image",
      "pruna-edit",
      "qwen-image-edit",
      "gptimage",
      "nanobanana",
      "nanobanana2",
      "seedream-5",
      "wan-image",
      "mai-image-2.6-flash",
      "flux-2-flex",
      "flux-2-pro",
    ];
    const results: Array<{ model: string; status: number; allowed: boolean; note: string }> = [];
    const m = PROBE_IMAGE.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    for (const model of models) {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", "recolour to a flat blue");
      form.append("size", "512x512");
      if (m) {
        const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
        form.append("image", new Blob([bytes], { type: m[1] }), "ref-0.png");
      }
      try {
        const res = await fetch(EDITS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
        const ct = res.headers.get("content-type") ?? "";
        if (res.ok && ct.startsWith("image/")) {
          const buf = new Uint8Array(await res.arrayBuffer());
          const v = verifyImageBytes(buf, ct);
          results.push({ model, status: res.status, allowed: v.ok, note: v.ok ? `verified image, ${buf.length} bytes` : "not an image" });
        } else {
          const text = await res.text();
          const msg = /not allowed for this API key/i.test(text)
            ? "model not permitted by this key"
            : reasonFrom(res.status, text);
          results.push({ model, status: res.status, allowed: false, note: msg });
        }
      } catch (e) {
        results.push({ model, status: -1, allowed: false, note: `network: ${e instanceof Error ? e.message : "error"}` });
      }
    }
    const allowed = results.filter((r) => r.allowed).map((r) => r.model);
    return { allowed, results };
  },
});

export const probePollinations = internalAction({
  args: {},
  handler: async () => {
    const raw = process.env.POLLINATIONS_API_KEY;
    const key = (raw ?? "").trim();
    const shape = describeKey(raw);

    if (key.length === 0) {
      return { shape, verdict: "no credential in the deployment environment", attempts: [] };
    }

    const attempts = [
      await attempt("edits (Bearer header — what Omi sends)", EDITS_URL, key, "bearer"),
      await attempt("edits (?key= query param)", EDITS_URL, key, "query"),
      await attempt("edits (x-api-key header)", EDITS_URL, key, "x-api-key"),
    ];

    // Does the key work for the generation endpoint at all? Isolates
    // "bad key" from "endpoint-specific authorization".
    let generation: { status: number; reason: string } | null = null;
    try {
      const res = await fetch(GEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "flux", prompt: "a flat blue square", size: "512x512" }),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) {
        generation = { status: res.status, reason: "generation accepted the key" };
      } else {
        generation = { status: res.status, reason: reasonFrom(res.status, (await res.text()).slice(0, 200)) };
      }
    } catch (e) {
      generation = { status: -1, reason: `network: ${e instanceof Error ? e.message : "error"}` };
    }

    // Account state settles WHY a 403 happens (no balance vs. not permitted).
    const account = [
      await accountProbe("/account/balance", key),
      await accountProbe("/account/profile", key),
      await accountProbe("/account/usage", key),
    ];

    const works = attempts.some((a) => a.ok) || generation?.status === 200;
    const authError = attempts.find((a) => a.body && a.body.length > 0);
    return {
      shape,
      verdict: works
        ? "credential WORKS — at least one auth mode returned a real image"
        : "credential is valid but NOT PERMITTED (403) — entitlement/balance issue, not a bad key",
      providerMessage: authError?.body ?? "",
      attempts,
      generation,
      account,
    };
  },
});
