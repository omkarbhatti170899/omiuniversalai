/**
 * INTERNAL provider benchmark — runs INSIDE Convex, where the keys live.
 * =========================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The first version of this harness ran from a developer shell
 * (`scripts/providerBenchmark.ts`). That was structurally incapable of
 * measuring two of the most important providers: the shell has neither
 * `LANGSEARCH_API_KEY` nor `SEARXNG_BASE_URL`, so both were "unconfigured"
 * and produced no data. Worse, the first run counted that as 0% availability,
 * which would have wrongly implied the production general-web provider was
 * dead. That reporting bug is fixed in the shell harness too.
 *
 * This action runs in the same runtime as production, so it measures the
 * providers exactly as the product does.
 *
 * SAFETY CONTRACT
 *   • internalAction — no client can call it, it is not on any HTTP route
 *   • NEVER returns an env value, a key, or any substring of one. Only
 *     booleans ("is this configured") and measured performance
 *   • only aggregate counts, latencies, and query strings the caller supplied
 *   • read-only: it searches, it does not mutate anything
 *
 * The query set is shared with the shell harness so the two are comparable.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { createSearxProvider, searxngHealth } from "./searchProviders/searxng";
import { createMwmblProvider } from "./searchProviders/mwmbl";
import { createDuckDuckGoInstantProvider } from "./searchProviders/duckduckgoInstant";
import { createLangSearchProvider, createLangSearchEvaluationProvider } from "./searchProviders/langsearch";
import { createWikipediaCurrentEventsProvider } from "./searchProviders/wikipediaCurrentEvents";
import { createGdeltProvider } from "./searchProviders/gdelt";
import { createHackerNewsProvider } from "./searchProviders/hackernews";
import type { SearchProvider, SearchOptions } from "./searchProviders/types";

const TIMEOUT_MS = 30_000;

/** Shared query set. Same shape as scripts/providerBenchmark.ts. */
const CASES: Array<{ category: string; query: string; opts?: SearchOptions }> = [
  { category: "current-news", query: "latest news today", opts: { category: "news", timeRange: "day" } },
  { category: "current-news", query: "breaking news today", opts: { category: "news", timeRange: "day" } },
  { category: "current-news", query: "world news today", opts: { category: "news", timeRange: "day" } },
  { category: "current-news", query: "news from the last hour", opts: { category: "news", timeRange: "hour" } },
  { category: "sports", query: "football match result today" },
  { category: "sports", query: "cricket score live" },
  { category: "finance", query: "USD INR exchange rate" },
  { category: "finance", query: "gold price today" },
  { category: "technology", query: "python programming language" },
  { category: "science", query: "CRISPR gene editing" },
  { category: "india", query: "India cricket team" },
  { category: "india", query: "ISRO mission" },
  { category: "international", query: "European Union policy" },
  { category: "international", query: "climate change policy" },
  { category: "multilingual", query: "dernières nouvelles France" },
  { category: "multilingual", query: "aktuelle Nachrichten Deutschland" },
  { category: "multilingual", query: "最新のニュース 日本" },
  { category: "obscure", query: "Kerguelen Islands flora" },
  { category: "historical", query: "Who won the 2016 Olympics 100m?" },
  { category: "conflicting", query: "India medal tally Asian Games 2026" },
  // 2026-specific: the freshness-critical class that started all of this.
  { category: "freshness-2026", query: "Asian Games 2026 medal tally India", opts: { timeRange: "day" } },
  { category: "freshness-2026", query: "2026 news today", opts: { timeRange: "day" } },
];

const STOP = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are",
  "what", "who", "how", "does", "did", "was", "latest", "today", "current",
  "news", "live", "score", "rate", "price", "now",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .split(/[^a-z0-9À-ɏЀ-ӿ؀-ۿ一-鿿]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/** Lexical-overlap PROXY. Explicitly not a correctness judgement. */
function relevance(query: string, titles: string[]): number {
  if (titles.length === 0) return 0;
  const q = tokens(query);
  if (q.size === 0) return 0;
  let hits = 0;
  for (const t of titles) {
    const tt = tokens(t);
    let overlap = 0;
    for (const tok of q) if (tt.has(tok)) overlap++;
    if (overlap > 0) hits += overlap / q.size;
  }
  return Math.round((hits / titles.length) * 1000) / 1000;
}

type Row = {
  ok: boolean;
  timedOut: boolean;
  latencyMs: number;
  results: number;
  datedResults: number;
  relevance: number;
  error?: string;
};

async function runOne(p: SearchProvider, c: (typeof CASES)[number]): Promise<Row> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      p.search(c.query, 5, c.opts),
      new Promise<never>((_, rej) => {
        // The harness budget must be at least as generous as the slowest
        // provider's own ceiling, or the benchmark measures the HARNESS rather
        // than the provider. It was 15 s while searxng needs 14.7–46.6 s and
        // gdelt 10.3–13.2 s (both MEASURED), so a provider that demonstrably
        // answers was being recorded as `timedOut` and reported as having 0%
        // availability. 30 s matches the production per-provider ceilings.
        timer = setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS);
      }),
    ]);
    const cites = result.citations;
    return {
      ok: cites.length > 0,
      timedOut: false,
      latencyMs: Date.now() - started,
      results: cites.length,
      datedResults: cites.filter((x) => Boolean(x.publishedAt)).length,
      relevance: relevance(c.query, cites.map((x) => x.title)),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      timedOut: /timeout|timed out/i.test(msg),
      latencyMs: Date.now() - started,
      results: 0,
      datedResults: 0,
      relevance: 0,
      error: msg.slice(0, 80),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Why a provider produced no measurement.
 *
 * HONESTY: these are three different situations and collapsing them into one
 * "not configured" string misleads an operator reading the report. A provider
 * with no credential is a setup task; an instance that is configured and was
 * PROBED UNREACHABLE is an outage, and the most urgent of the three. Saying
 * "not configured" about a reachable-config-but-timing-out instance sends
 * someone to set an environment variable that is already set.
 */
function unmeasuredReason(
  id: string,
  envPresence: {
    LANGSEARCH_API_KEY_present: boolean;
    SEARXNG_BASE_URL_present: boolean;
  },
  searxDetail: string,
): string {
  if (id === "langsearch") {
    return envPresence.LANGSEARCH_API_KEY_present
      ? "production adapter reports unconfigured despite a present key — investigate the enable flag"
      : "needs LANGSEARCH_API_KEY (not set)";
  }
  if (id === "searxng") {
    return envPresence.SEARXNG_BASE_URL_present
      ? `configured but PROBED UNREACHABLE — an outage, not a setup gap (${String(searxDetail).slice(0, 160)})`
      : "needs SEARXNG_BASE_URL (not set)";
  }
  if (id === "gdelt") {
    // A DISABLE is a fourth category, distinct from all three above: nothing
    // is missing and nothing is broken — the provider was taken out of the
    // fan-out on measured evidence. Saying "not configured" here would send
    // someone hunting for a credential that does not exist.
    return "disabled by product decision (GDELT_ENABLED=false) after measuring 0% availability from the Convex runtime — set ENABLE_GDELT=true to re-measure";
  }
  return "not configured";
}

export const runProviderBenchmark = internalAction({
  /**
   * Optional narrowing, added because the full run (22 queries x 7 providers)
   * cannot finish inside a single non-interactive command, and an unrunnable
   * benchmark is one nobody runs. `providers` selects a subset; `maxCases`
   * truncates the query set. Both default to the full, comparable run.
   */
  args: {
    providers: v.optional(v.array(v.string())),
    maxCases: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    // Presence booleans only. Never a value, never a length, never a prefix.
    const envPresence = {
      LANGSEARCH_API_KEY_present: Boolean(process.env.LANGSEARCH_API_KEY?.trim()),
      ENABLE_LANGSEARCH: process.env.ENABLE_LANGSEARCH ?? "(unset)",
      SEARXNG_BASE_URL_present: Boolean(process.env.SEARXNG_BASE_URL?.trim()),
    };

    // Constructed once and reused: `isConfigured()` reads live probe state, and
    // the decision below must not flip between building the list and running it.
    const langSearchProduction = createLangSearchProvider();

    const candidates: Array<{
      id: string;
      p: SearchProvider;
      categories?: string[];
      /** Evaluation-only override; never changes the production gate. */
      evalOnly?: SearchProvider;
    }> = [
      { id: "searxng", p: createSearxProvider() },
      // EVALUATION BYPASS, deliberately narrow and now CONDITIONAL.
      //
      // It used to be unconditional whenever a key was present, so every run
      // reported `evaluationOnly: true` and measured a provider that the
      // production pipeline never used. That is the wrong instrument for the
      // question now being asked: LangSearch is ENABLED in production
      // (LANGSEARCH_ENABLED = true in searchProviders/langsearch.ts), so the
      // benchmark must exercise that exact adapter — the production path a user
      // query actually takes.
      //
      // The bypass therefore applies only when the production adapter reports
      // itself unconfigured, i.e. the gate is genuinely closed or the key is
      // genuinely absent. That is the one case where measuring the candidate
      // is still worth doing, and the report labels it `evaluationOnly: true`
      // so it can never be mistaken for a production measurement.
      {
        id: "langsearch",
        p: langSearchProduction,
        evalOnly: langSearchProduction.isConfigured()
          ? undefined
          : createLangSearchEvaluationProvider(),
      },
      { id: "mwmbl", p: createMwmblProvider() },
      { id: "duckduckgo-instant", p: createDuckDuckGoInstantProvider() },
      { id: "wikipedia-current-events", p: createWikipediaCurrentEventsProvider(), categories: ["current-news", "freshness-2026"] },
      { id: "gdelt", p: createGdeltProvider(), categories: ["current-news", "international", "india", "freshness-2026"] },
      { id: "hackernews", p: createHackerNewsProvider(), categories: ["technology"] },
    ];

    const searx = await searxngHealth();

    const wanted = args.providers && args.providers.length > 0 ? new Set(args.providers) : null;
    const maxCases = args.maxCases && args.maxCases > 0 ? args.maxCases : Infinity;

    const out: Array<Record<string, unknown>> = [];
    for (const { id, p, categories, evalOnly } of candidates) {
      if (wanted && !wanted.has(id)) continue;
      const applicable = CASES
        .filter((c) => !categories || categories.includes(c.category))
        .slice(0, maxCases);
      // The evaluation bypass applies ONLY here, inside the diagnostic.
      const toRun = evalOnly ?? p;
      // HONESTY: unconfigured is NOT 0% availability. It is no measurement.
      if (!toRun.isConfigured()) {
        out.push({
          provider: id,
          measured: false,
          reason: unmeasuredReason(id, envPresence, searx.detail),
          n: 0,
        });
        continue;
      }
      const rows: Row[] = [];
      const firstError = { value: "" };
      for (const c of applicable) {
        const row = await runOne(toRun, c);
        if (!row.ok && !firstError.value) firstError.value = row.error ?? "";
        rows.push(row);
      }
      const n = rows.length;
      const okN = rows.filter((r) => r.ok).length;
      const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
      const totalRes = rows.reduce((s, r) => s + r.results, 0);
      const totalDated = rows.reduce((s, r) => s + r.datedResults, 0);
      out.push({
        provider: id,
        measured: true,
        n,
        availability: Math.round((okN / n) * 1000) / 1000,
        timeoutRate:
          Math.round((rows.filter((r) => r.timedOut).length / n) * 1000) / 1000,
        p50ms: lat[Math.floor(n * 0.5)] ?? 0,
        p95ms: lat[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0,
        avgResults: Math.round((totalRes / n) * 10) / 10,
        // The decisive column for a freshness engine.
        freshnessQuality: totalRes === 0 ? 0 : Math.round((totalDated / totalRes) * 1000) / 1000,
        relevanceProxy: Math.round((rows.reduce((s, r) => s + r.relevance, 0) / n) * 1000) / 1000,
        sampleError: firstError.value,
        evaluationOnly: Boolean(evalOnly),
      });
    }

    return {
      envPresence,
      searxngHealth: { healthy: searx.healthy, detail: String(searx.detail).slice(0, 220) },
      queryCount: CASES.length,
      results: out,
      note:
        "relevanceProxy is lexical overlap only and cannot detect a plausible-but-wrong answer. " +
        "freshnessQuality is the share of results carrying a publication date; a provider at 0 " +
        "cannot serve a freshness-gated question regardless of how relevant it looks.",
    };
  },
});
