import axios from "axios";
import {
  MissingKeyError,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderResult,
  type WebCitation,
} from "./types";
import {
  buildEngineScopedQuery,
  normalizeEngineName,
  recordSearxResponse,
  searxEngineSuspended,
  suspendedSearxEngines,
} from "./searxngEngineHealth";

/**
 * SearXNG — self-hosted metasearch engine. PRIMARY search source for Omi.
 * Zero per-search cost: results come from your own instance (or a
 * community instance you point Omi at), never a metered API.
 *
 * Configure with a single env var:
 *   SEARXNG_BASE_URL = https://your-searxng-instance.example.com
 *
 * Self-host in one command (JSON format must be enabled in settings.yml):
 *   docker run -d -p 8080:8080 searxng/searxng
 *   settings.yml → search.formats: [html, json]
 *
 * When SEARXNG_BASE_URL is not set, Omi falls back to well-known public
 * SearXNG instances that expose the JSON API, so the feature still works
 * at zero cost before your own instance is up.
 */

const SEARX_ENDPOINT = "/search";

/**
 * WALL-CLOCK BUDGETS for one provider call — deliberately NOT per-attempt.
 *
 * MEASURED DEFECT this replaces: the adapter looped `for base { for attempt(2)
 * { for range(ladder up to 5) { fetch(30 s) } } }` with no ceiling on the
 * TOTAL time. The worst case was therefore 2 x 5 x 30 s = 300 s of sequential
 * waiting, and the observed diagnostic run took ~46 s — long past the fan-out's
 * own 30 s ceiling, so SearXNG was recorded as a timeout on turns where it had
 * already produced usable results. Retrying is only worth its cost when a
 * retry can plausibly succeed; against a slow-but-alive metasearch host it just
 * multiplies the wait.
 *
 * So: a bounded walk of the date-filter ladder, each rung bounded by whatever
 * is LEFT of a single total budget, at most two passes, partial results
 * returned as soon as the instance answers, and — MEASURED follow-up — the
 * ladder is NOT widened after a timeout, because a host that never replied
 * will not reply for a wider window either. A slow engine can no longer hold up
 * the whole search because it cannot extend the budget.
 *
 * MEASURED 2026-09-29 (round 7): the flaky public instance answers JSON in
 * ~4.4–5.0 s per request, so 12–15 s telemetry rows were "three slow rungs", not
 * a hung call — and a 30 s fan-out slot let it hold a pipeline slot while faster
 * providers finished. Owner direction: 20–30 s searches are not acceptable and
 * the ceiling must NOT be raised to chase them. The defaults are now 10 s total
 * (covers two rungs at the measured latency, or a hung host plus one fallback
 * attempt) and 5 s per rung. A self-hosted instance answers in well under 1 s,
 * where these budgets are ample; env overrides exist for edge deployments.
 */
export const SEARXNG_TOTAL_BUDGET_MS = 10_000;
/** A single rung's ceiling. Bounded further by whatever budget remains. */
export const SEARXNG_PER_TRY_TIMEOUT_MS = 5_000;

/**
 * TWO DIFFERENT KNOBS, DELIBERATELY SEPARATE.
 *
 *   SEARXNG_TIMEOUT_MS        — ONE request. This is the name that already
 *                               existed and it keeps its meaning exactly:
 *                               deployments that set it (this one sets it to
 *                               roughly 11 s) are not silently reinterpreted.
 *   SEARXNG_TOTAL_BUDGET_MS   — the WHOLE provider call, new, and the thing
 *                               that was missing. Defaults to a value above the
 *                               measured worst single request, and below the
 *                               fan-out's own ceiling so the adapter stops
 *                               before the fan-out has to cut it off.
 */
function positiveEnvNumber(name: string): number | null {
  const raw = Number(process.env[name] ?? NaN);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}
/** Below this there is no point starting another request. */
const MIN_ATTEMPT_MS = 1_500;
/**
 * The least time a fallback base is given, even if the preferred instance ate
 * the budget. A healthy instance answers in well under a second, so a few
 * seconds is enough to tell "this fallback works" from "this fallback is also
 * dead" — and it guarantees the fallback is actually tried.
 */
const BASE_FLOOR_MS = 4_000;

/** Upstream engines this process has seen answer, newest-first, bounded. */
const observedEngines: string[] = [];
function rememberEngines(engines: string[]): void {
  for (const e of engines) {
    const id = e.trim().toLowerCase();
    if (!id) continue;
    const at = observedEngines.indexOf(id);
    if (at !== -1) observedEngines.splice(at, 1);
    observedEngines.unshift(id);
  }
  if (observedEngines.length > 12) observedEngines.length = 12;
}

/** The engines that have answered and are not currently suspended. */
export function healthyObservedEngines(): string[] {
  return observedEngines.filter((e) => !searxEngineSuspended(e));
}

/**
 * Public instances that have historically served JSON. The router tries
 * each in order and moves on at the first failure — instances rate-limit
 * aggressively, so this list is a floor, not a dependency.
 */
/**
 * Public instances that have historically served JSON. The router tries
 * each in order and moves on at the first failure — instances rate-limit
 * aggressively, so this list is a floor, not a dependency.
 *
 * MEASURED 2026-09-26: every one of these returns HTTP 200 with an HTML body
 * when `format=json` is requested, because SearXNG ships with the JSON format
 * disabled by default. The provider therefore cannot rely on the public
 * floor and must treat "reachable but not JSON" as a hard failure, not as
 * "no results". See `probeInstance` below and `SEARXNG_FLOOR_HEALTHY`.
 */
/**
 * EXPLICIT SELECTION RECORD — answers "which SearXNG is being used, and why"
 * without asking a human to remember env vars. The configured base is chosen
 * FIRST (origin: self-hosted when it is not a known public host),
 * measured-healthy fallbacks follow, and the probe verdict is attached. The
 * operator surface persists this so production configuration is explicit,
 * auditable, and survives restarts.
 */
// Hosts KNOWN to be run by someone else (community/public instances). The
// configured base is compared against this set: a base on it is reported as
// `public` — production must SAY when it depends on someone else's machine.
// Anything else is presumed self-hosted (the deployment goal).
const KNOWN_PUBLIC_HOSTS = new Set<string>([
  ...[
    "https://searx.be",
    "https://search.inetol.net",
    "https://baresearch.org",
    "https://search.hbubli.cc",
  ],
  "https://search.lumy.live", // measured flapping community instance
  "https://searxng.site",
  "https://search.rhscz.eu",
]);

export function describeSearxSelection(): {
  configuredBase: string | null;
  origin: "self-hosted" | "public" | null;
  publicCandidates: string[];
  verifiedInstances: string[];
  lastProbe: { healthy: boolean; checkedAt: number; detail: string } | null;
} {
  const configuredBase = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "") ?? null;
  const origin = configuredBase
    ? KNOWN_PUBLIC_HOSTS.has(configuredBase)
      ? ("public" as const)
      : ("self-hosted" as const)
    : null;
  return {
    configuredBase,
    origin,
    publicCandidates: [...KNOWN_PUBLIC_HOSTS],
    verifiedInstances: [...verifiedInstances],
    lastProbe: lastProbe ? { ...lastProbe } : null,
  };
}

const PUBLIC_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://baresearch.org",
  "https://search.hbubli.cc",
];

/**
 * Set SEARXNG_BASE_URL to your own instance — that is the only configuration
 * in which this provider is expected to work:
 *   docker run -d -p 8080:8080 searxng/searxng
 *   settings.yml → search.formats: [html, json]
 * Without it, Omi probes the public floor once and reports the result
 * honestly instead of claiming to be ready.
 */
const SEARXNG_FLOOR_HEALTHY = false;

/**
 * ADDITIONAL CANDIDATE INSTANCES — a fallback list, not a dependency.
 *
 * MEASURED 2026-09-28: the configured instance (`search.lumy.live`) resolves
 * DNS (71 ms) and accepts TCP 443 (97 ms), but NEVER sends an HTTP response —
 * both `/` and `/search?format=json` time out at 60 s, while a control instance
 * (`searx.be`) answered in 276 ms from the same runtime. That is an
 * instance-side outage, not our egress, DNS, TLS or endpoint configuration.
 *
 * The consequence was worse than "SearXNG is down": with `SEARXNG_BASE_URL`
 * set, the adapter tried THAT base and nothing else, so one dead community host
 * removed general-web breadth from the whole product. A configured instance is
 * now the PREFERRED base, not the only one.
 *
 * These are candidates to PROBE, never to assume: `probeSearxngCandidates`
 * measures each from inside the runtime, and only instances that actually
 * served a JSON `results` array are used. Guessing here would reintroduce the
 * original "reported ready, returned HTML" bug.
 */
export const CANDIDATE_INSTANCES = [
  ...PUBLIC_INSTANCES,
  "https://searxng.site",
  "https://search.rhscz.eu",
  "https://paulgo.io",
  "https://priv.au",
  "https://opnxng.com",
  "https://searx.work",
  "https://search.inetol.net",
];

/** Instances this isolate has PROBED and found serving JSON. */
let verifiedInstances: string[] = [];

/** The probing results of the last `probeSearxngCandidates` run in this isolate. */
export function verifiedSearxngInstances(): string[] {
  return [...verifiedInstances];
}

/**
 * Probe every candidate and remember the ones that actually answered JSON.
 * Never throws; a probe failing is the normal case for most candidates.
 */
export async function probeSearxngCandidates(
  timeoutMs = 8_000,
): Promise<Array<{ base: string; healthy: boolean; ms: number; detail: string }>> {
  const configured = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "");
  const targets = configured
    ? [configured, ...CANDIDATE_INSTANCES.filter((b) => b !== configured)]
    : CANDIDATE_INSTANCES;
  const out: Array<{ base: string; healthy: boolean; ms: number; detail: string }> = [];
  const healthy: string[] = [];
  for (const base of targets) {
    const t0 = Date.now();
    const r = await probeInstance(base, timeoutMs);
    out.push({ base, healthy: r.healthy, ms: Date.now() - t0, detail: String(r.detail).slice(0, 180) });
    if (r.healthy) healthy.push(base);
  }
  // The configured instance keeps its priority when it is healthy; the rest are
  // fallbacks in measured order.
  verifiedInstances = healthy.filter((b) => b !== configured);
  return out;
}

/** For tests: clear the measured fallback list. */
export function resetVerifiedSearxngInstances(): void {
  verifiedInstances = [];
}

/**
 * Shared-secret auth for OUR instance.
 *
 * The self-hosted instance (deploy/searxng) gates its JSON API behind an
 * `X-Omi-Secret` header at the reverse proxy, so a private JSON instance is
 * not a free public API. When `SEARXNG_SHARED_SECRET` is set server-side,
 * every request — probe and search — presents it. Absent (community hosts),
 * nothing is sent and behaviour is unchanged.
 */
function searxngAuthHeaders(): Record<string, string> {
  const secret = process.env.SEARXNG_SHARED_SECRET;
  return secret ? { "X-Omi-Secret": secret } : {};
}

/** Cached reachability verdict, so the status page never probes on a render. */
type ProbeResult = { healthy: boolean; checkedAt: number; detail: string };
let lastProbe: ProbeResult | null = null;
const PROBE_TTL_MS = 5 * 60_000;

/**
 * Per-base health memory — the "stop retrying a dead instance" mechanism.
 *
 * MEASURED: with `SEARXNG_BASE_URL` set, every search paid one full timeout
 * against a host that never answered, because the health verdict existed only
 * for the status surface. `search()` now consults this map BEFORE dialing: a
 * base with a fresh unhealthy probe is skipped outright, a successful search
 * clears its own bad verdict (self-healing — a recovered instance returns to
 * service on its first success, not on the next cron), and an unknown base is
 * always allowed so a cold isolate can still search.
 */
const probeByBase = new Map<string, ProbeResult>();

export function searxngBaseHealthCached(base: string): ProbeResult | null {
  return probeByBase.get(base) ?? null;
}

export function noteSearxngBaseResult(base: string, healthy: boolean, detail: string): void {
  if (!healthy) {
    probeByBase.set(base, { healthy: false, checkedAt: Date.now(), detail });
    return;
  }
  probeByBase.delete(base);
}

/** A fresh unhealthy verdict means "known dead, do not dial". */
function isKnownDead(base: string): boolean {
  const r = probeByBase.get(base);
  return r !== undefined && !r.healthy && Date.now() - r.checkedAt < PROBE_TTL_MS;
}

/**
 * Per-base SLOW memory — "stop paying the slow tax on every call".
 *
 * MEASURED 2026-09-29: the configured public instance answers JSON in
 * ~4.4–5.0 s per request. That is not a failure — health memory correctly kept
 * dialing it — but a three-rung ladder walk at that latency produced the
 * 12–15 s telemetry rows the owner rejected, and a 30 s fan-out slot let it
 * hold a pipeline slot while faster providers had finished. A base whose
 * median ANSWERED latency is at or above SLOW_BASE_MS is DEMOTED: it is tried
 * after non-slow bases, and its first-rung budget slice is capped so it
 * cannot consume more than one measured round-trip before the fallbacks get
 * their share. Unlike the dead-skip memory this never excludes the base — a
 * slow-but-real source still answers; it just stops costing four seconds per
 * rung.
 */
export const SLOW_BASE_MS = 4_000;
const LATENCY_WINDOW_PER_BASE = 6;
const latencyByBase = new Map<string, number[]>();

/** Record one ANSWERED round-trip (failures carry no latency signal). */
export function recordSearxBaseLatency(base: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const arr = latencyByBase.get(base) ?? [];
  arr.push(Math.round(ms));
  if (arr.length > LATENCY_WINDOW_PER_BASE) arr.splice(0, arr.length - LATENCY_WINDOW_PER_BASE);
  latencyByBase.set(base, arr);
}

/** Median answered latency for a base, or null with too few samples. */
export function searxBaseMedianLatency(base: string): number | null {
  const arr = latencyByBase.get(base);
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** True when the base's median answered latency has crossed the slow line. */
export function baseIsSlow(base: string): boolean {
  const m = searxBaseMedianLatency(base);
  return m !== null && m >= SLOW_BASE_MS;
}

/** Last time a known-dead base was given its recovery dial, per base. */
const recoveryDialAt = new Map<string, number>();

/** Test/reset hook — latency + recovery memory must not leak between tests. */
export function resetSearxBaseLatency(): void {
  latencyByBase.clear();
  recoveryDialAt.clear();
}

/**
 * One SearXNG attempt, fully parameterized.
 */
type SearxParams = {
  base: string;
  query: string;
  numResults: number;
  opts: SearchOptions;
};

type SearxResultItem = {
  title?: string;
  url?: string;
  content?: string;
  img_src?: string;
  /** The upstream engine that produced this row (either field, per version). */
  engine?: string;
  engines?: string[];
  /**
   * The primary date field. MEASURED 2026-09-27 against the configured
   * instance: on a 28-result payload this was non-empty for 6, and a separate
   * per-engine trace showed every one of those 6 came from `yandex`. So the
   * low date yield is an ENGINE property, not a parsing failure — see
   * `docs/SEARXNG_DATE_ROOT_CAUSE.md`.
   *
   * `pubdate` and `metadata[]` were also measured present in the payload. They
   * were checked for non-empty date values and carried exactly the same 6
   * dates, so reading them would change nothing today. They are still accepted
   * below, because that is a cheap guard against an engine switching which
   * field it populates.
   */
  publishedDate?: string | null;
  pubdate?: string | null;
  metadata?: Array<{ key?: string; value?: string }> | null;
};

/**
 * The `time_range` values SearXNG actually accepts.
 *
 * MEASURED BUG: the adapter forwarded our internal vocabulary verbatim, which
 * includes `"hour"`. SearXNG's own choices are day / week / month / year, so
 * `time_range=hour` is not a finer filter — it is an INVALID value that the
 * instance silently ignores. The caller believed it had asked for the last
 * hour while the engine returned everything, which is the worst possible
 * outcome: a filter that appears to apply and does not.
 *
 * There is no hour granularity upstream, so "hour" is honestly widened to
 * "day" and the freshness TIER (not the engine) does the sub-day work.
 */
const SEARX_TIME_RANGES = new Set(["day", "week", "month", "year"]);

/** Map our vocabulary onto the values the engine will actually honour. */
export function toSearxTimeRange(
  range: "hour" | "day" | "week" | "month" | "year" | undefined,
): string | undefined {
  if (!range) return undefined;
  if (SEARX_TIME_RANGES.has(range)) return range;
  if (range === "hour") return "day";
  return undefined;
}

/**
 * Successively wider fallbacks when a date filter empties the result set.
 *
 * §4's rule — "do not force a day filter on historical questions" — is the
 * mirror image of this: a genuinely current question that happens to have
 * nothing from today must still be answered by yesterday's news, rather than
 * returning nothing at all. Widening is strictly better than returning empty,
 * because the freshness gate downstream still rejects anything too old; this
 * only changes what the ENGINE is allowed to return, never what Omi accepts.
 */
const WIDENING: Record<string, string | undefined> = {
  day: "week",
  week: "month",
  month: "year",
  year: undefined,
};

function buildParams({
  query,
  numResults,
  opts,
  timeRangeOverride,
}: Omit<SearxParams, "base"> & { timeRangeOverride?: string | undefined }): Record<string, string> {
  const params: Record<string, string> = {
    q: query,
    format: "json",
    // SearXNG pages are small (engine fan-out happens server-side); ask for
    // more than requested so dedupe/ranking still yields enough.
    results_on_page: String(Math.min(Math.max(numResults * 2, 10), 30)),
  };
  if (opts.category && opts.category !== "general") {
    params.category_general = "on";
    params[`category_${opts.category}`] = "on";
  }
  if (opts.language) params.language = opts.language;
  const range =
    timeRangeOverride !== undefined ? timeRangeOverride : toSearxTimeRange(opts.timeRange);
  if (range) params.time_range = range;
  if (opts.safeSearch !== undefined) params.safesearch = String(opts.safeSearch);
  if (opts.page && opts.page > 1) params.pageno = String(opts.page);
  return params;
}

/**
 * Search suggestions (autocomplete). SearXNG exposes /autocompleter
 * returning a JSON array of strings. Best-effort: empty on any failure.
 */
export async function searxSuggestions(query: string): Promise<string[]> {
  const configuredBase = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "");
  const bases = configuredBase ? [configuredBase] : PUBLIC_INSTANCES;
  for (const base of bases.slice(0, configuredBase ? 1 : 2)) {
    try {
      const res = await axios.get(base + "/autocompleter", {
        params: { q: query.slice(0, 100), format: "json" },
        timeout: 4_000,
        headers: { Accept: "application/json" },
        validateStatus: (s) => s >= 200 && s < 300,
      });
      const data = res.data;
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.[1])
          ? data[1]
          : [];
      return list
        .filter((s): s is string => typeof s === "string")
        .slice(0, 8);
    } catch {
      // try next base
    }
  }
  return [];
}

/**
 * Actually check whether a base URL serves the JSON API.
 *
 * This exists because the previous version reported SearXNG as "ready"
 * unconditionally (`isConfigured: () => true`) while every call returned
 * HTML — so the status page, the Settings UI and the self-test all reported
 * a working search engine that could never return a result. Reachability is
 * now measured, cached for five minutes, and surfaced honestly.
 */
export async function probeInstance(
  base: string,
  timeoutMs = 8000,
): Promise<{ healthy: boolean; detail: string }> {
  try {
    const res = await axios.get(base + SEARX_ENDPOINT, {
      params: { q: "omi health probe", format: "json" },
      timeout: timeoutMs,
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OmiSearch/1.0",
        ...searxngAuthHeaders(),
      },
      // 200 is not success: a JSON-disabled instance answers 200 + HTML.
      validateStatus: () => true,
    });
    const contentType = String(res.headers?.["content-type"] ?? "");
    const body = res.data;
    if (typeof body === "object" && body !== null && Array.isArray(body.results)) {
      return {
        healthy: true,
        detail: `JSON API reachable (${(body.results as unknown[]).length} probe results, ${contentType || "unknown content-type"})`,
      };
    }
    if (contentType.includes("json")) {
      return { healthy: false, detail: `JSON API returned ${contentType} without a results array` };
    }
    return {
      healthy: false,
      detail:
        `Endpoint answered ${res.status} with ${contentType || "an unknown content-type"} instead of JSON — ` +
        `this instance has search.formats JSON disabled. Enable it in settings.yml, or set SEARXNG_BASE_URL to an instance that has.`,
    };
  } catch (err) {
    return {
      healthy: false,
      detail: `unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/** Cached, honest reachability verdict for the status surface. */
export async function searxngHealth(): Promise<ProbeResult> {
  if (lastProbe && Date.now() - lastProbe.checkedAt < PROBE_TTL_MS) return lastProbe;
  const configuredBase = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "");
  // The configured base is probed first; the MEASURED fallbacks are probed
  // after it, because "our instance is down" must not mean "no general web".
  const targets = configuredBase
    ? [configuredBase, ...verifiedInstances]
    : PUBLIC_INSTANCES;
  const findings: string[] = [];
  let healthy = false;
  for (const base of targets) {
    // A configured instance that answers JSON but is slow (community hosts
    // frequently take 8-15s) must not be judged broken by an arbitrarily
    // short probe. The public floor keeps the shorter budget; a configured
    // instance gets the same 15s the search path already allows it.
    const r = await probeInstance(base, base === configuredBase ? 15000 : 8000);
    // Feed the same memory the search path consults, so a probe verdict and a
    // search verdict can never disagree about whether a base is worth dialing.
    noteSearxngBaseResult(base, r.healthy, r.detail);
    findings.push(`${base}: ${r.healthy ? "OK" : r.detail}`);
    if (r.healthy) {
      healthy = true;
      break;
    }
  }
  lastProbe = {
    healthy,
    checkedAt: Date.now(),
    detail: findings.join(" | "),
  };
  return lastProbe;
}

/** Synchronous, never-blocking health for the reactive status query. */
export function searxngHealthCached(): ProbeResult | null {
  return lastProbe;
}

type FetchOutcome = {
  citations: WebCitation[];
  /** Per-engine contribution of this payload: results and dated results. */
  resultsByEngine: Map<string, { results: number; dated: number }>;
  /** Raw `unresponsive_engines` from the payload, fed to the engine registry. */
  unresponsive: unknown;
  /** Engines observed on the returned results. */
  engines: string[];
};

/** Which upstream engine(s) produced one row. */
export function enginesOfResult(r: SearxResultItem): string[] {
  if (Array.isArray(r.engines)) {
    return r.engines.filter((e): e is string => typeof e === "string");
  }
  return typeof r.engine === "string" ? [r.engine] : [];
}

async function fetchInstance(
  base: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const res = await axios.get(base + SEARX_ENDPOINT, {
    params,
    timeout: timeoutMs,
    headers: {
      Accept: "application/json",
      // Some fronting proxies gate on UA; a browser-like UA maximizes the
      // chance the JSON API answers instead of a bot challenge.
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OmiSearch/1.0",
      ...searxngAuthHeaders(),
    },
    // Community front-ends sometimes serve self-signed certs; never fail
    // the whole search over TLS validation we cannot act on.
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const json = res.data as {
    results?: SearxResultItem[];
    unresponsive_engines?: unknown;
  };
  const items = Array.isArray(json?.results) ? json.results : null;

  // A 200 with no `results` array is NOT an empty result set — it is almost
  // always an HTML body from an instance with the JSON format disabled. The
  // old code treated it as "no results", moved on, and after every instance
  // failed threw a misleading "missing key" error, so a configuration problem
  // looked like a quota problem.
  if (items === null) {
    const contentType = String(res.headers?.["content-type"] ?? "");
    if (!contentType.includes("json")) {
      throw new Error(
        `${base} answered ${res.status} with ${contentType || "non-JSON"} — its JSON API is disabled ` +
          `(settings.yml → search.formats must include "json"). Set SEARXNG_BASE_URL to an instance that has it.`,
      );
    }
    throw new Error(`${base} returned JSON without a results array`);
  }

  const usable = items.filter(
    (r) => typeof r.url === "string" && r.url.startsWith("http"),
  );
  return {
    citations: usable.map((r) => ({
      title: (r.title ?? r.url ?? "Untitled").slice(0, 300),
      url: r.url as string,
      snippet: r.content ? String(r.content).slice(0, 600) : undefined,
      imageUrl: r.img_src && typeof r.img_src === "string" ? r.img_src : undefined,
      publishedAt: extractSearxDate(r),
    })),
    unresponsive: Array.isArray(json?.unresponsive_engines)
      ? json.unresponsive_engines
      : [],
    engines: [...new Set(usable.flatMap(enginesOfResult))],
    // Per-engine contribution: results produced and how many carried a date —
    // the raw material for the per-engine result-count and freshness metrics.
    resultsByEngine: (() => {
      const m = new Map<string, { results: number; dated: number }>();
      for (const r of usable) {
        for (const e of enginesOfResult(r)) {
          const cur = m.get(normalizeEngineName(e)) ?? { results: 0, dated: 0 };
          cur.results += 1;
          if (extractSearxDate(r)) cur.dated += 1;
          m.set(normalizeEngineName(e), cur);
        }
      }
      return m;
    })(),
  };
}

/**
 * Pull a usable publication date out of one SearXNG result.
 *
 * Ordered by what the payload was MEASURED to carry, most-authoritative first.
 * Every candidate is validated by actually parsing it: a present-but-unparseable
 * date must read as "undated", not as a date the freshness gate will then
 * trust. `Date.parse` accepts a lot of junk, so the value must survive a
 * round-trip to a real ISO instant.
 */
export function extractSearxDate(r: SearxResultItem): string | undefined {
  const candidates: Array<string | null | undefined> = [r.publishedDate, r.pubdate];

  // SearXNG's `metadata` is a list of {key, value} pairs; some engines put a
  // date in there instead of a top-level field.
  if (Array.isArray(r.metadata)) {
    for (const entry of r.metadata) {
      const key = String(entry?.key ?? "").toLowerCase();
      if (/^(published|published_?date|pub_?date|date|updated|modified|timestamp)$/.test(key)) {
        candidates.push(entry?.value);
      }
    }
  }

  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) continue;
    return new Date(parsed).toISOString();
  }
  return undefined;
}

export function createSearxProvider(): SearchProvider {
  const configuredBase = process.env.SEARXNG_BASE_URL?.replace(/\/+$/, "");

  return {
    id: "searxng",
    label: "SearXNG",
    missingKeyHint: configuredBase
      ? ""
      : "Set SEARXNG_BASE_URL to your own SearXNG instance with the JSON format enabled (settings.yml → search.formats: [html, json]). The public instances were measured on 2026-09-26 and all return HTML instead of JSON, so Omi does not count them as a working general-web source.",
    /**
     * HONEST readiness — MEASURED, never inferred from configuration alone.
     *
     * The previous value was `() => true`, which made the status page, the
     * Settings UI and the self-test all report a working general-web engine
     * that could never return a single result. The next version returned true
     * the moment `SEARXNG_BASE_URL` was set — still a lie: a configured
     * instance that answers 403/HTML (every public instance measured
     * 2026-09-27, including the requested searx.tiekoetter.com → 403) is not
     * a working search source, and "a base URL exists" is exactly the
     * "key exists ⇒ READY" trap the self-test is built to avoid.
     *
     * Two DIFFERENT questions, deliberately answered differently:
     *
     *  • "Is SearXNG READY?" (the status surface) — MEASURED only. That is
     *    answered in `searchProviders/index.ts` `getProviderStatus()` from the
     *    cached probe, so the status page never says READY just because
     *    `SEARXNG_BASE_URL` exists.
     *  • "Should the search fan-out try this source?" (this method) — a
     *    CONFIGURED instance is eligible unless a probe has PROVEN it broken.
     *    Excluding it on cold instances (no probe state yet) would silently
     *    drop the general-web floor from real searches, which is worse than
     *    trying a possibly-slow instance — the search call is itself the test.
     *    Without configuration, only a measured-healthy public instance counts
     *    (and the public floor is measured broken).
     */
    isConfigured: () => {
      if (configuredBase !== undefined) return lastProbe?.healthy !== false;
      return SEARXNG_FLOOR_HEALTHY || lastProbe?.healthy === true;
    },

    async search(
      query,
      numResults,
      opts = {},
    ): Promise<SearchProviderResult> {
      // EVERY base we are willing to try, best first. The configured instance
      // is preferred but is NOT the only option: a dead community host once
      // removed general-web breadth from the entire product.
      // ONLY MEASURED FALLBACKS. `verifiedInstances` is filled by
      // `probeSearxngCandidates`, which has to find an instance that actually
      // served JSON. Falling back to the unmeasured public floor would send
      // requests we already know answer HTML — the original "reports ready,
      // returns nothing" bug in a new place.
      //
      // MEASURED 2026-09-28: 0 of 12 public instances serve JSON from this
      // runtime (most answer 200 + HTML because `search.formats` omits `json`;
      // some 403/429; one has a bad certificate). So today this list is empty,
      // the adapter tries the configured base alone, and the general-web floor
      // is honestly absent until a self-hosted instance exists.
      const bases = configuredBase
        ? [configuredBase, ...verifiedInstances.filter((b) => b !== configuredBase)]
        : verifiedInstances.length > 0
          ? verifiedInstances
          : PUBLIC_INSTANCES;
      // STOP RETRYING A DEAD INSTANCE: a base with a fresh unhealthy probe is
      // skipped before any request is made. If EVERY base is known-dead, one
      // base is still attempted (the first) so a recovered instance is never
      // locked out longer than the probe TTL.
      const dialable = bases.filter((b) => !isKnownDead(b));
      // SLOW-BASE DEMOTION (measured 2026-09-29): a base whose median answered
      // latency has crossed the slow line is tried AFTER the others, so a
      // flaky-but-alive configured instance stops costing every search its
      // ~5 s round-trip while fallbacks answer in under a second. Fail-open
      // in the same way as the dead-skip: if EVERY base is slow, order is
      // unchanged (one slow source still beats no source).
      const fast = dialable.filter((b) => !baseIsSlow(b));
      const slow = dialable.filter((b) => baseIsSlow(b));
      const ordered = [...fast, ...slow];
      // RECOVERY DIAL RATE LIMIT (round 8): when EVERY base is known-dead, one
      // base is still attempted so recovery stays possible — but at most once
      // per RECOVERY_DIAL_MIN_MS. Measured cost of skipping this: pass 1 marks
      // the flaky base dead (5 s), the escalation's recovery dial pays the
      // SAME timeout again seconds later (~10 s total for the turn). With the
      // throttle, the second pass fails through immediately; the probe TTL
      // (5 min) still allows a real recovery attempt afterwards.
      const RECOVERY_DIAL_MIN_MS = 30_000;
      let attemptBases: string[];
      if (ordered.length > 0) {
        attemptBases = ordered;
      } else if (bases.length > 0) {
        const first = bases[0];
        const lastRecovery = recoveryDialAt.get(first) ?? 0;
        if (Date.now() - lastRecovery < RECOVERY_DIAL_MIN_MS) {
          throw new Error(
            `SearXNG (${first}) skipped: every base is known-dead and the recovery dial was already attempted within ${RECOVERY_DIAL_MIN_MS / 1000}s — run diagnosticsSearxngDeep:probeSearxngCandidates to re-verify instances`,
          );
        }
        recoveryDialAt.set(first, Date.now());
        attemptBases = [first];
      } else {
        attemptBases = [];
      }
      // MEASURED 2026-09-27 against search.lumy.live: DNS 1 ms, TCP 95 ms,
      // but /search?format=json took 14.7 s (day), 7.5 s (month), 13.1 s
      // (year) and 46.6 s for a plain probe. The real fix is self-hosting
      // (docs/SEARXNG_SELF_HOST_PLAN.md). What this budget fixes is that the
      // adapter previously had NO total ceiling, so those latencies compounded
      // across rungs and retries until the fan-out cut the whole call off.
      // One request, and the whole call. Kept separate so an existing
      // `SEARXNG_TIMEOUT_MS` keeps its per-request meaning.
      const perTryTimeout = configuredBase
        ? (positiveEnvNumber("SEARXNG_TIMEOUT_MS") ?? SEARXNG_PER_TRY_TIMEOUT_MS)
        : 9_000;
      const totalBudgetMs = configuredBase
        ? (positiveEnvNumber("SEARXNG_TOTAL_BUDGET_MS") ?? SEARXNG_TOTAL_BUDGET_MS)
        : 9_000;
      const deadline = Date.now() + totalBudgetMs;

      // Build the ladder of date filters to try, widest last. Starting narrow
      // is deliberate: §4 measured a 21% date yield with NO filter and 100%
      // with time_range, because the filter makes the engine restrict itself to
      // engines that can honour dates. Widen only if the narrow one is empty.
      const requested = toSearxTimeRange(opts.timeRange);
      const ladder: Array<string | undefined> = [];
      if (requested) {
        let cur: string | undefined = requested;
        while (cur !== undefined && !ladder.includes(cur)) {
          ladder.push(cur);
          cur = WIDENING[cur];
        }
      }
      ladder.push(undefined);

      // ENGINE HEALTH. When previous responses named an engine unresponsive
      // ("duckduckgo: timeout"), scope this request to the engines we have
      // actually seen answer, using SearXNG's documented `!engine` syntax —
      // there is no point re-asking a suspended engine and re-waiting for its
      // timeout. Fail-open: if the scoped pass yields nothing, the unscoped
      // query is tried before any empty result is returned.
      const suspended = suspendedSearxEngines();
      const healthy = healthyObservedEngines();
      const scopedQuery =
        suspended.length > 0 && healthy.length > 0
          ? buildEngineScopedQuery(query, healthy.slice(0, 8))
          : query;
      const variants = scopedQuery === query ? [query] : [scopedQuery, query];

      const maxAttempts = (ladder.length + 1) * Math.max(1, bases.length) + 2;
      // BOUNDED RETRY. At most two passes over the plan, and never past the
      // total budget — which is the whole point. One pass is the common case;
      // the second exists so ONE transient failure on a shared instance is
      // survivable, which is the only situation where a repeat request is worth
      // its latency. The old code retried unconditionally, twice, at every
      // rung, with no ceiling: that is what turned an 11 s request timeout into
      // a measured 46 s call.
      const maxPasses = configuredBase ? 2 : 1;
      let attempts = 0;
      let lastError: unknown = null;
      let stop = false;
      // IN-CALL FAILURE MEMORY (round 8): a base that just failed DURING THIS
      // CALL is not re-dialed by the second pass. The old loop re-asked the
      // same timing-out host on pass 2, paying its timeout TWICE within one
      // provider call (~10 s against a flaky base) before the fallbacks were
      // reached. Cross-call recovery stays with the health memory + probe TTL;
      // within one call, one failure is final.
      const failedThisCall = new Set<string>();

      for (let pass = 0; pass < maxPasses && !stop; pass++) {
        for (const q of variants) {
          for (let b = 0; b < attemptBases.length && !stop; b++) {
            const base = attemptBases[b];
            if (failedThisCall.has(base)) continue;
            // EVERY BASE GETS ITS OWN SLICE OF THE BUDGET.
            //
            // Without this, a dead preferred instance would consume the whole
            // total budget and the fallback would never get a chance — which is
            // exactly how one hung community host removed general-web breadth
            // from the product. The first base (the configured one) may use the
            // full per-request ceiling; later bases divide whatever remains.
            const basesLeft = attemptBases.length - b;
            // First-rung slice: the per-try ceiling for every base — the
            // demotion lever is ORDER (slow bases dial last), never starving
            // a slow-but-real source of the one round-trip it needs to
            // answer. Later bases still divide the REMAINING budget as before.
            const slice = perTryTimeout;
            const baseDeadline = Math.min(
              deadline,
              Date.now() +
                (b === 0
                  ? slice
                  : Math.max(BASE_FLOOR_MS, Math.min(slice, Math.floor((deadline - Date.now()) / basesLeft)))),
            );
            // `break` inside this loop moves to the NEXT BASE, which is the
            // desired behaviour for every failure below: running out of one
            // instance's slice must not end the whole call.
            for (const range of ladder) {
              if (attempts >= maxAttempts) {
                stop = true;
                break;
              }
              // TWO CLOCKS, deliberately. `globalRemaining` decides whether a
              // retry is worth starting; `remaining` (this base's slice) is the
              // request timeout. Comparing the retry decision against the
              // per-base slice was a bug: a base whose slice equals the
              // per-request ceiling always looked "too small to bother with" on
              // the second pass, so the bounded retry never ran.
              const globalRemaining = deadline - Date.now();
              if (globalRemaining <= 0) break;
              if (attempts > 0 && globalRemaining < MIN_ATTEMPT_MS) break;
              const remaining = Math.min(baseDeadline, deadline) - Date.now();
              if (remaining <= 0) break;
              attempts += 1;
              try {
                const attemptStarted = Date.now();
                const outcome = await fetchInstance(
                  base,
                  buildParams({ query: q, numResults, opts, timeRangeOverride: range }),
                  Math.min(perTryTimeout, remaining),
                );
                // Record what the INSTANCE said about its own engines, before
                // any decision about the result — that report is the only
                // honest evidence of which engines are down. The call's
                // wall-clock and each engine's per-result contribution feed
                // the per-engine metrics (latency p50, avg results, dated
                // share) that the operator surface reports.
                recordSearxResponse(outcome.unresponsive, outcome.engines, {
                  latencyMs: Date.now() - attemptStarted,
                  resultsByEngine: outcome.resultsByEngine,
                });
                // Feed the per-base slow memory with the ANSWERED round-trip.
                recordSearxBaseLatency(base, Date.now() - attemptStarted);
                rememberEngines(outcome.engines);
                if (outcome.citations.length > 0) {
                  // Self-healing: a success clears any stale bad verdict, so a
                  // recovered instance returns to service immediately.
                  noteSearxngBaseResult(base, true, "answered JSON");
                  return { citations: outcome.citations };
                }
                // Empty result set is a valid answer — but only from a
                // configured (non-gated) instance, on the final, widest rung of
                // the UNSCOPED query. A scoped query returning nothing is the
                // fail-open case that must fall through; and a gated public
                // instance may be serving a challenge.
                if (base === configuredBase && range === undefined && q === query) {
                  noteSearxngBaseResult(base, true, "answered JSON (empty result set)");
                  return { citations: [] };
                }
                lastError = new Error(
                  base === configuredBase
                    ? `no results for time_range=${range}`
                    : `${base} returned no results`,
                );
              } catch (err) {
                lastError = err;
                // Remember the failure so the NEXT search skips this base
                // without paying the timeout again (until the TTL expires and
                // one probe attempt is allowed through) — and so THIS call's
                // second pass does not re-ask the same timing-out host.
                failedThisCall.add(base);
                noteSearxngBaseResult(
                  base,
                  false,
                  err instanceof Error ? err.message.slice(0, 160) : "unknown error",
                );
                // A TIMEOUT OR CONNECTION FAILURE IS NOT A NARROW FILTER.
                // Widening `time_range` only helps when the instance ANSWERED
                // with JSON and simply had nothing inside the window. A host
                // that never replied will not reply for `month` either, so
                // walking the rest of the ladder just multiplies the wait —
                // which is how a dead instance turned into a 46 s call. Move on
                // to the NEXT BASE instead, which is the whole point of having
                // one.
                break;
              }
            }
          }
        }
      }

      if (!configuredBase) {
        throw new MissingKeyError("searxng");
      }
      throw new Error(
        `SearXNG (${configuredBase}) failed: ${
          lastError instanceof Error ? lastError.message : "unknown error"
        }`,
      );
    },
  };
}
