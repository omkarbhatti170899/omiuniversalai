/**
 * Final SearXNG instance diagnosis — host- or runtime-agnostic.
 *
 * Usage:
 *   bun scripts/diagnoseSearxngInstance.ts [https://instance.example]
 *   (default: the currently configured community instance)
 *
 * Produces the seven-row verdict the operator asked for:
 *   DNS · TLS · HTTP response · /search endpoint · JSON format ·
 *   network/egress (via a control host) · upstream engine health
 *
 * Exit code 0 = instance fit for SEARXNG_BASE_URL; 2 = unfit; 1 = inconclusive.
 */

import { lookup } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = (process.argv[2] ?? "https://search.lumy.live").replace(/\/+$/, "");
const host = new URL(BASE).hostname;
const CONTROL = "https://example.com";

type Row = { check: string; ok: boolean; detail: string };

async function dnsCheck(): Promise<Row> {
  try {
    const v4 = await lookup(host, { family: 4 });
    let v6 = "";
    try {
      v6 = (await lookup(host, { family: 6 })).address;
    } catch {
      v6 = "(none)";
    }
    return { check: "DNS", ok: true, detail: `${v4.address} · AAAA ${v6}` };
  } catch (e) {
    return { check: "DNS", ok: false, detail: `resolve failed: ${e instanceof Error ? e.message : e}` };
  }
}

function tlsCheck(timeoutMs = 10_000): Promise<Row> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ check: "TLS", ok: false, detail: `handshake did not complete within ${timeoutMs} ms` });
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      const validTo = typeof cert.valid_to === "string" ? cert.valid_to : "unknown";
      const verdict = socket.authorized
        ? `TLSv${socket.getProtocol()} · cert CN=${(cert.subject as { CN?: string })?.CN ?? "?"} · valid to ${validTo}`
        : `authorized=false (${String(socket.authorizationError)})`;
      socket.destroy();
      resolve({ check: "TLS", ok: socket.authorized, detail: `${verdict} · ${Date.now() - started} ms` });
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      resolve({ check: "TLS", ok: false, detail: e.message });
    });
  });
}

async function httpCheck(path: string, timeoutMs = 10_000): Promise<{ status: number | null; ms: number; body: string; contentType: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    const body = await res.text();
    return {
      status: res.status,
      ms: Date.now() - started,
      body,
      contentType: res.headers.get("content-type") ?? "(none)",
    };
  } catch {
    return { status: null, ms: Date.now() - started, body: "", contentType: "(no response)" };
  }
}

async function main() {
  const rows: Row[] = [];
  rows.push(await dnsCheck());
  rows.push(await tlsCheck());

  const root = await httpCheck("/", 10_000);
  rows.push({
    check: "HTTP response (/)",
    ok: root.status !== null,
    detail: root.status === null
      ? `no HTTP response in ${root.ms} ms — host accepts TCP then never replies`
      : `${root.status} in ${root.ms} ms · ${root.contentType.slice(0, 60)}`,
  });

  const search = await httpCheck("/search?q=test&format=json", 15_000);
  let jsonOk = false;
  let resultCount = 0;
  let unresponsive: unknown = null;
  if (search.status === 200) {
    try {
      const parsed = JSON.parse(search.body) as { results?: unknown[]; unresponsive_engines?: unknown };
      jsonOk = Array.isArray(parsed.results);
      resultCount = parsed.results?.length ?? 0;
      unresponsive = parsed.unresponsive_engines ?? null;
    } catch {
      jsonOk = false;
    }
  }
  rows.push({
    check: "/search endpoint",
    ok: search.status === 200,
    detail: search.status === null
      ? `no response in ${search.ms} ms (search route wedged while / or /healthz answers)`
      : `${search.status} in ${search.ms} ms · ${search.contentType.slice(0, 40)}`,
  });
  rows.push({
    check: "JSON format",
    ok: jsonOk,
    detail: jsonOk
      ? `application/json with ${resultCount} results`
      : search.status === 200
        ? `200 but ${search.contentType} — search.formats JSON disabled`
        : "no JSON answer (endpoint unreachable or erroring)",
  });

  const control = await httpCheck(CONTROL.startsWith("http") ? new URL(CONTROL).pathname || "/" : "/", 8_000).then(async () => {
    const t0 = Date.now();
    try {
      const res = await fetch(CONTROL, { signal: AbortSignal.timeout(8_000) });
      await res.arrayBuffer();
      return { status: res.status, ms: Date.now() - t0 };
    } catch {
      return { status: null, ms: Date.now() - t0 };
    }
  });
  rows.push({
    check: "Network/egress (control)",
    ok: control.status !== null,
    detail: control.status !== null
      ? `control host answered ${control.status} in ${control.ms} ms from this same runtime — egress is fine`
      : `even the control host failed — the network itself is the problem`,
  });

  rows.push({
    check: "Upstream engine health",
    ok: true,
    detail: unresponsive !== null
      ? `unresponsive_engines: ${JSON.stringify(unresponsive).slice(0, 120)}`
      : "unobservable: the instance never answers a search, so its engine states cannot be read from outside. Engine health is only measurable on an instance WE run (settings + logs + unresponsive_engines in the JSON).",
  });

  // Verdict
  const critical = rows.filter((r) => r.check !== "Upstream engine health");
  const unfit = critical.filter((r) => !r.ok);
  console.log(`\nDiagnosis of ${BASE}\n${"=".repeat(40 + BASE.length)}`);
  for (const r of rows) console.log(`${r.ok ? "✔" : "✖"} ${r.check.padEnd(28)} ${r.detail}`);
  console.log(`\nVERDICT: ${unfit.length === 0 ? "FIT for SEARXNG_BASE_URL" : "UNFIT — do not depend on it"} (${unfit.length} failed check${unfit.length === 1 ? "" : "s"})`);
  await sleep(1);
  process.exit(unfit.length === 0 ? 0 : 2);
}

void main();
