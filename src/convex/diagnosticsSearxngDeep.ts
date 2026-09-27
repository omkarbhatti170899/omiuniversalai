"use node";

/**
 * DEEP SearXNG DIAGNOSTIC — internal, never exposed over HTTP.
 * =========================================================================
 *
 * Answers, from INSIDE the Convex runtime where the configuration actually
 * lives, the questions that decide whether SearXNG is usable:
 *
 *   A. Which URL is the production runtime really using?
 *   B. Does `/search?format=json` answer JSON, or HTML / a bot challenge?
 *   C. Is `search.formats: json` actually enabled?
 *   D. Which date-bearing fields does the payload really contain?
 *   E. Which individual engines succeed, time out, 403, 429, return a
 *      CAPTCHA, return nothing, or return useful dates?
 *
 * Plus the time_range comparison (day / month / year) needed to decide
 * whether date-aware retrieval is worth wiring.
 *
 * SAFETY CONTRACT
 *   • The base URL is a location, not a credential, but it is still redacted
 *     before being returned: if someone ever pastes a key into the URL's
 *     query string, this diagnostic must not echo it back into a terminal or
 *     a log. Only scheme + host + path survive.
 *   • No credential of any kind is read, requested or returned.
 *   • Result bodies are truncated and are third-party web content, not
 *     secrets; the field-name inventory is the primary output.
 *   • internalAction ⇒ no client can invoke it. It runs only via
 *     `convex run`.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Socket } from "node:net";

const PROBE_QUERY = "Indian contingent medals tally Asian Games 2026";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OmiSearch/1.0";

/** Every field name a SearXNG result item is known to carry. */
const DATE_LIKE_FIELDS = [
  "publishedDate",
  "published",
  "published_date",
  "date",
  "timestamp",
  "updated",
  "modified",
  "pubDate",
  "metadata",
] as const;

/** Keys inside SearXNG's `metadata` array that carry a usable date. */
const METADATA_DATE_KEYS = new Set([
  "published",
  "published_date",
  "publisheddate",
  "date",
  "pubdate",
  "updated",
  "modified",
  "timestamp",
]);

/**
 * Strip anything that could be a credential out of a URL before it is
 * returned. A base URL with a query string is reported as host + path only.
 */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const hasQuery = u.search.length > 0;
    u.search = "";
    u.username = "";
    u.password = "";
    return `${u.toString()}${hasQuery ? "  [query string redacted]" : ""}`;
  } catch {
    return "(unparseable)";
  }
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "(unparseable)";
  }
}

type FieldCounts = Record<string, number>;

/** Count how many results carry each field, and how many carry a usable date. */
function inventory(items: Array<Record<string, unknown>>): {
  results: number;
  fieldCounts: FieldCounts;
  dated: number;
  dateSources: FieldCounts;
  engines: Record<string, { results: number; dated: number }>;
} {
  const fieldCounts: FieldCounts = {};
  const dateSources: FieldCounts = {};
  const engines: Record<string, { results: number; dated: number }> = {};
  let dated = 0;

  for (const item of items) {
    for (const key of Object.keys(item)) {
      fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
    }

    // Which field actually supplied the date, if any.
    let source: string | null = null;
    for (const f of DATE_LIKE_FIELDS) {
      const v = item[f];
      if (typeof v === "string" && v.trim() !== "") {
        source = f;
        break;
      }
      if (Array.isArray(v) && f === "metadata") {
        const hit = (v as Array<Record<string, unknown>>).some((m) => {
          const k = String(m?.key ?? "").toLowerCase();
          return METADATA_DATE_KEYS.has(k) && String(m?.value ?? "").trim() !== "";
        });
        if (hit) {
          source = "metadata[]";
          break;
        }
      }
    }
    if (source) {
      dated += 1;
      dateSources[source] = (dateSources[source] ?? 0) + 1;
    }

    for (const e of enginesOf(item)) {
      const row = engines[e] ?? { results: 0, dated: 0 };
      row.results += 1;
      if (source) row.dated += 1;
      engines[e] = row;
    }
  }

  return { results: items.length, fieldCounts, dated, dateSources, engines };
}

/** SearXNG reports either a single `engine` or an `engines` array. */
function enginesOf(item: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(item.engines)) {
    for (const e of item.engines) if (typeof e === "string") out.push(e);
  } else if (typeof item.engine === "string") {
    out.push(item.engine);
  }
  return out.length > 0 ? out : ["(unnamed)"];
}

type RawFetch = {
  url: string;
  status: number;
  contentType: string;
  ms: number;
  isJson: boolean;
  /** Short, sanitized body prefix — enough to identify HTML vs CAPTCHA. */
  bodyPrefix: string;
  error: string | null;
};

async function rawSearch(
  base: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<{ fetch: RawFetch; items: Array<Record<string, unknown>>; unresponsive: unknown[] }> {
  const qs = new URLSearchParams(params).toString();
  const url = `${base}/search?${qs}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const ms = Date.now() - started;

    let items: Array<Record<string, unknown>> = [];
    let unresponsive: unknown[] = [];
    let isJson = false;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      isJson = true;
      if (Array.isArray(parsed.results)) items = parsed.results as Array<Record<string, unknown>>;
      if (Array.isArray(parsed.unresponsive_engines)) unresponsive = parsed.unresponsive_engines;
    } catch {
      isJson = false;
    }

    return {
      fetch: {
        url,
        status: res.status,
        contentType,
        ms,
        isJson,
        // Enough to tell "HTML settings page" from "bot challenge" from
        // "JSON error object". Truncated hard; this is echoed to a terminal.
        bodyPrefix: isJson ? "" : text.slice(0, 240).replace(/\s+/g, " "),
        error: null,
      },
      items,
      unresponsive,
    };
  } catch (err) {
    return {
      fetch: {
        url,
        status: 0,
        contentType: "",
        ms: Date.now() - started,
        isJson: false,
        bodyPrefix: "",
        error: err instanceof Error ? err.message : String(err),
      },
      items: [],
      unresponsive: [],
    };
  }
}

/**
 * §2A/§2B — separate the layers that "unreachable" conflates.
 *
 * A single timeout cannot distinguish DNS failure, a refused TCP connect, a
 * TLS problem, a host that is simply SLOW, and a host that is down. They have
 * four different fixes — change the hostname, open a port, fix the certificate,
 * raise the timeout, or replace the provider — so they must not be reported as
 * one indistinguishable word. Each layer is therefore probed on its own, and
 * the JSON endpoint is retried with a budget long enough that a slow-but-alive
 * instance cannot be mistaken for a dead one.
 */
export const diagnoseSearxngNetwork = internalAction({
  args: {},
  handler: async () => {
    const base = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "") ?? "";
    if (!base) return { verdict: "SEARXNG_BASE_URL is not set." };

    let host = "";
    try {
      host = new URL(base).host;
    } catch {
      return { verdict: "SEARXNG_BASE_URL is not a parseable URL." };
    }
    const hostname = host.split(":")[0];

    const layers: Record<string, unknown> = { host, hostname };

    // L1. DNS.
    const dnsStart = Date.now();
    try {
      const addrs = await dnsLookup(hostname, { all: true });
      layers.dns = {
        ok: true,
        ms: Date.now() - dnsStart,
        addresses: addrs.map((a) => a.address),
      };
    } catch (err) {
      layers.dns = {
        ok: false,
        ms: Date.now() - dnsStart,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // L2. Bare TCP connect to 443.
    const tcpStart = Date.now();
    try {
      const sock = await connect(hostname, 443, 10_000);
      layers.tcp = { ok: true, ms: Date.now() - tcpStart, note: "TCP 443 accepted" };
      sock.destroy();
    } catch (err) {
      layers.tcp = {
        ok: false,
        ms: Date.now() - tcpStart,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // L3. The instance root — cheap, and answers even when /search is slow.
    layers.root = await timedFetch(`${base}/`, 60_000);

    // L4. The JSON endpoint with a budget long enough for a slow community
    // host. A 60s answer means "slow", not "down".
    layers.json60s = await timedFetch(
      `${base}/search?q=omi+probe&format=json`,
      60_000,
    );

    // L5. A control. If a known public instance is equally unreachable from
    // here, the problem is the RUNTIME's egress, not this host.
    layers.control = await timedFetch(
      "https://searx.be/search?q=omi+probe&format=json",
      25_000,
    );

    const anyOk = [layers.root, layers.json60s].some(
      (r) => (r as { ok?: boolean }).ok,
    );
    layers.verdict = !anyOk
      ? "NO HTTP RESPONSE AT ALL from the configured host. " +
        (layers.dns && (layers.dns as { ok: boolean }).ok
          ? "DNS resolves, so this is a network/routing or instance-down problem, not a typo in the hostname."
          : "DNS itself failed, so the hostname does not resolve from this runtime.")
      : "The host DOES answer — see root/json60s for which endpoint and how slowly.";

    return layers;
  },
});

/** Small typed wrappers over node's net/dns so the handler above stays readable. */
async function connect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  const { createConnection } = await import("node:net");
  return new Promise<Socket>((resolve, reject) => {
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`TCP connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function timedFetch(
  url: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let isJson = false;
    try {
      JSON.parse(text);
      isJson = true;
    } catch {
      isJson = false;
    }
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      ms: Date.now() - started,
      isJson,
      bytes: text.length,
      bodyPrefix: isJson ? "" : text.slice(0, 200).replace(/\s+/g, " "),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      // "aborted due to timeout" is the shape a slow host produces; anything
      // else (ENOTFOUND, ECONNREFUSED, CERT errors) is a different fault.
      timedOut: /timeout|aborted/i.test(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * §3C vs §3B — the decisive test.
 *
 * The field inventory showed `pubdate` and `metadata` present on 15 of 28
 * results, and the production adapter reads ONLY `publishedDate`. That leaves
 * exactly two possibilities, with opposite fixes:
 *
 *   §3B individual engines do not supply dates  -> curate engines, stop hoping
 *   §3C the adapter DROPS supplied dates          -> read the fields, fix parsing
 *
 * They look identical in an aggregate ("only 7 of 28 came out dated") and are
 * separated only by comparing what ARRIVED against what we KEPT. So this dumps
 * every date-bearing field of every result, per engine, with the parser's own
 * verdict on each value.
 */
export const traceSearxngDates = internalAction({
  args: { query: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    const base = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "") ?? "";
    if (!base) return { verdict: "SEARXNG_BASE_URL is not set." };
    const query = args.query ?? "Indian contingent medals tally Asian Games 2026";

    const r = await rawSearch(base, { q: query, format: "json", results_on_page: "30" }, 60_000);
    if (!r.fetch.isJson) return { verdict: "not JSON", raw: r.fetch };

    const rows = r.items.map((item, i) => {
      const engines = enginesOf(item);
      const meta = Array.isArray(item.metadata)
        ? (item.metadata as Array<Record<string, unknown>>).map((m) => ({
            key: String(m?.key ?? ""),
            value: String(m?.value ?? "").slice(0, 40),
          }))
        : null;
      return {
        i,
        engines,
        // Exactly what the payload carried, per field.
        publishedDate: item.publishedDate ?? null,
        pubdate: (item as Record<string, unknown>).pubdate ?? null,
        metadataDateEntries: meta
          ? meta.filter((m) => METADATA_DATE_KEYS.has(m.key.toLowerCase()))
          : null,
        // What the CURRENT adapter would keep.
        keptByAdapter:
          typeof item.publishedDate === "string" && item.publishedDate.trim() !== ""
            ? item.publishedDate
            : null,
      };
    });

    const nonEmpty = (k: "publishedDate" | "pubdate") =>
      rows.filter((x) => typeof x[k] === "string" && String(x[k]).trim() !== "").length;
    const metaDated = rows.filter((x) => (x.metadataDateEntries?.length ?? 0) > 0).length;

    return {
      query,
      ms: r.fetch.ms,
      results: rows.length,
      unresponsiveEngines: r.unresponsive,
      /** What arrived in the payload, per field. */
      arrived: {
        publishedDate: nonEmpty("publishedDate"),
        pubdate: nonEmpty("pubdate"),
        metadataDateEntries: metaDated,
      },
      /** What the production adapter currently keeps. */
      keptByAdapter: rows.filter((x) => x.keptByAdapter !== null).length,
      /** The gap: dates that ARRIVED but are DISCARDED. */
      lostByAdapter: Math.max(nonEmpty("pubdate"), metaDated) > nonEmpty("publishedDate"),
      perEngine: Object.entries(
        rows.reduce<Record<string, { results: number; publishedDate: number; pubdate: number; meta: number }>>(
          (acc, x) => {
            for (const e of x.engines) {
              const a = acc[e] ?? { results: 0, publishedDate: 0, pubdate: 0, meta: 0 };
              a.results += 1;
              if (x.publishedDate) a.publishedDate += 1;
              if (x.pubdate) a.pubdate += 1;
              if ((x.metadataDateEntries?.length ?? 0) > 0) a.meta += 1;
              acc[e] = a;
            }
            return acc;
          },
          {},
        ),
      ),
      rows: rows.slice(0, 12),
    };
  },
});

/**
 * §10 — GDELT has measured 0% availability across three separate sessions.
 * "0% availability" is a SYMPTOM; the brief asks which of six causes it is:
 * network connectivity, endpoint configuration, timeout, DNS, response
 * format, or a production-runtime restriction. They have different fixes, and
 * only the first two are code changes.
 *
 * The layers are probed separately for exactly the reason SearXNG needed it:
 * "error sending request for url" collapses DNS failure, connection refused,
 * TLS, and a slow origin into one indistinguishable sentence.
 */
export const diagnoseGdelt = internalAction({
  args: {},
  handler: async () => {
    const url = "https://api.gdeltproject.org/api/v2/doc/doc";
    const hostname = "api.gdeltproject.org";
    const out: Record<string, unknown> = { url };

    // L1. DNS.
    const dnsStart = Date.now();
    try {
      const addrs = await dnsLookup(hostname, { all: true });
      out.dns = { ok: true, ms: Date.now() - dnsStart, addresses: addrs.map((a) => a.address) };
    } catch (err) {
      out.dns = {
        ok: false,
        ms: Date.now() - dnsStart,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // L2. TCP.
    const tcpStart = Date.now();
    try {
      const sock = await connect(hostname, 443, 10_000);
      out.tcp = { ok: true, ms: Date.now() - tcpStart };
      sock.destroy();
    } catch (err) {
      out.tcp = {
        ok: false,
        ms: Date.now() - tcpStart,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // L3. The documented endpoint, exactly as the adapter calls it.
    const qs = new URLSearchParams({
      query: "india asian games",
      mode: "artlist",
      format: "json",
      maxrecords: "10",
      timespan: "1d",
    }).toString();
    out.call = await timedFetch(`${url}?${qs}`, 30_000);
    // L3b. The same call with a budget long enough for a merely SLOW origin.
    // MEASURED: the TLS handshake alone completes in 10.2 s, and the previous
    // attempt failed at ~10.5 s — close enough to suggest a ceiling somewhere
    // around ten seconds rather than a hard block. A generous budget separates
    // "slow but working" from "never answers", which have opposite verdicts:
    // one is a timeout budget to raise, the other is a provider to disable.
    out.call60s = await timedFetch(`${url}?${qs}`, 60_000);

    // L4. The bare host, to separate "the API is down" from "the API path is
    // wrong". A 404/403 here still proves the runtime can reach the origin.
    out.root = await timedFetch(`https://${hostname}/`, 20_000);

    const reachable = Boolean((out.dns as { ok?: boolean })?.ok);
    out.verdict = !reachable
      ? "DNS fails from the Convex runtime — the origin is not resolvable here. Not fixable in our code."
      : (out.call as { ok?: boolean })?.ok
        ? "The documented endpoint ANSWERS. The 0% availability is in our call, not at GDELT."
        : (out.root as { ok?: boolean })?.ok
          ? "The origin is reachable but /api/v2/doc/doc does not answer — endpoint or parameter problem, not connectivity."
          : "DNS resolves and TCP is attempted but nothing answers — an upstream outage or an egress restriction.";
    return out;
  },
});

/**
 * §10 follow-up — is the GDELT failure TLS or HTTP?
 *
 * MEASURED: DNS resolves (7 ms), raw TCP 443 is accepted (35 ms), yet BOTH
 * `https://api.gdeltproject.org/` and the documented API path fail with the
 * same opaque `fetch failed` at ~10.5 s. TCP succeeding while HTTPS fails
 * localises the fault to the TLS handshake or to an origin that resets
 * immediately after accepting the connection — not to DNS, not to the API
 * path, and not to our query parameters. `fetch` collapses all of those into
 * one word, so the handshake is attempted explicitly here.
 */
export const diagnoseGdeltTls = internalAction({
  args: { host: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    const host = args.host ?? "api.gdeltproject.org";
    const start = Date.now();
    return new Promise((resolve) => {
      const socket = connectTls(host, 443, 15_000)
        .then((s) => {
          const peer = s.getPeerCertificate?.();
          const authorized = s.authorized;
          const authorizationError = String(s.authorizationError ?? "");
          s.destroy();
          resolve({
            host,
            tlsOk: true,
            ms: Date.now() - start,
            authorized,
            authorizationError,
            certSubject: peer?.subject ?? null,
            verdict:
              "TLS handshake SUCCEEDED. The origin speaks HTTPS to this runtime, so the failure is at the HTTP layer (status, block, or path).",
          });
        })
        .catch((err: unknown) => {
          resolve({
            host,
            tlsOk: false,
            ms: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
            verdict:
              "TLS handshake FAILED even though raw TCP connects. The origin accepts the socket and then drops the encrypted handshake — an origin-side block on this datacenter IP, or a cipher/SNI rejection. Nothing in our request can fix this.",
          });
        });
    });
  },
});

/** Explicit TLS connect, so the handshake can fail loudly instead of vanishing. */
async function connectTls(host: string, port: number, timeoutMs: number) {
  const { connect } = await import("node:tls");
  return new Promise<import("node:tls").TLSSocket>((resolve, reject) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export const deepProbeSearxng = internalAction({
  args: { query: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const raw = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "") ?? "";
    const query = args.query ?? PROBE_QUERY;
    const out: Record<string, unknown> = {
      query,
      // A. Which URL is the runtime really using?
      configured: {
        present: raw.length > 0,
        // Host only in the summary; the redacted form carries the full detail.
        host: raw ? hostOf(raw) : null,
        redacted: raw ? redactUrl(raw) : null,
        hasQueryString: raw.includes("?"),
        // A credential in the URL is a configuration bug we should surface,
        // never echo.
        queryStringHoldsSecret: /\b(key|token|apikey|api_key|secret|password)=/i.test(raw),
      },
    };

    if (!raw) {
      out.verdict = "SEARXNG_BASE_URL is not set in the production runtime.";
      return out;
    }

    // B/C/D. The raw JSON question.
    const main = await rawSearch(raw, { q: query, format: "json", results_on_page: "20" }, 60_000);
    out.raw = main.fetch;
    out.unresponsiveEngines = main.unresponsive;
    if (!main.fetch.isJson) {
      out.jsonFormatEnabled = false;
      out.verdict =
        main.fetch.status === 0
          ? `UNREACHABLE: ${main.fetch.error}`
          : `NOT JSON: HTTP ${main.fetch.status} with content-type "${main.fetch.contentType || "none"}". ` +
            `search.formats almost certainly lacks "json". Body began: ${main.fetch.bodyPrefix.slice(0, 160)}`;
      return out;
    }
    out.jsonFormatEnabled = true;
    out.inventory = inventory(main.items);
    // D. One sanitized sample so the real shape is visible, not just counts.
    out.sampleResult = main.items[0]
      ? {
          title: String(main.items[0].title ?? "").slice(0, 120),
          url: String(main.items[0].url ?? "").slice(0, 140),
          content: String(main.items[0].content ?? "").slice(0, 120),
          engine: main.items[0].engine ?? null,
          engines: main.items[0].engines ?? null,
          category: main.items[0].category ?? null,
          publishedDate: main.items[0].publishedDate ?? null,
          metadata: main.items[0].metadata ?? null,
        }
      : null;

    // §4. time_range comparison on the SAME query.
    out.timeRange = {};
    for (const range of ["day", "month", "year"]) {
      const r = await rawSearch(
        raw,
        { q: query, format: "json", results_on_page: "20", time_range: range },
        20_000,
      );
      const inv = inventory(r.items);
      (out.timeRange as Record<string, unknown>)[range] = {
        status: r.fetch.status,
        ms: r.fetch.ms,
        results: inv.results,
        dated: inv.dated,
        dateYield: inv.results === 0 ? 0 : Math.round((inv.dated / inv.results) * 1000) / 1000,
        engines: Object.keys(inv.engines),
      };
    }

    // E. Per-engine health. Uses the instance's own engine list when it will
    // tell us, otherwise the engines observed in the main payload.
    const seen = new Set<string>();
    for (const e of Object.keys(out.inventory ? (out.inventory as { engines: Record<string, unknown> }).engines : {})) {
      if (e !== "(unnamed)") seen.add(e);
    }
    const engineList = [...seen].slice(0, 12);
    out.perEngine = [];
    for (const engine of engineList) {
      const r = await rawSearch(
        raw,
        { q: query, format: "json", results_on_page: "10", engines: engine },
        20_000,
      );
      const inv = inventory(r.items);
      let verdict: string;
      if (r.fetch.status === 0) verdict = `TIMEOUT/UNREACHABLE (${r.fetch.error})`;
      else if (r.fetch.status === 403) verdict = "403 FORBIDDEN — access control, not a bug";
      else if (r.fetch.status === 429) verdict = "429 RATE LIMITED by the upstream engine";
      else if (!r.fetch.isJson) verdict = `NOT JSON (${r.fetch.contentType}) — likely a bot challenge/CAPTCHA`;
      else if (inv.results === 0) verdict = "EMPTY — returned no results for this query";
      else if (inv.dated === inv.results) verdict = `USABLE DATES (${inv.dated}/${inv.results})`;
      else if (inv.dated > 0) verdict = `PARTIAL DATES (${inv.dated}/${inv.results})`;
      else verdict = `NO DATES (0/${inv.results})`;

      (out.perEngine as unknown[]).push({
        engine,
        status: r.fetch.status,
        ms: r.fetch.ms,
        results: inv.results,
        dated: inv.dated,
        verdict,
      });
    }

    // Verdict, computed rather than asserted.
    const inv = out.inventory as { dated: number; results: number };
    out.summary = {
      totalResults: inv.results,
      datedResults: inv.dated,
      dateYield: inv.results === 0 ? 0 : Math.round((inv.dated / inv.results) * 1000) / 1000,
      enginesObserved: engineList.length,
      enginesWithDates: ((out.perEngine as Array<{ dated: number; results: number }>) ?? []).filter(
        (e) => e.dated > 0,
      ).length,
    };
    return out;
  },
});
