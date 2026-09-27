/**
 * PROVIDER BENCHMARK — standardized, multi-category, per-provider.
 * =========================================================================
 *
 * Measures each provider DIRECTLY (not through the orchestrator) so a provider
 * cannot be credited or blamed for another one's behaviour. Every number below
 * is measured in this run; nothing is asserted from documentation.
 *
 * CATEGORIES (the brief's list): current news, sports, finance, technology,
 * science, India, international, multilingual, obscure, historical,
 * conflicting-information.
 *
 * WHAT IS RECORDED PER (provider, query)
 *   ok            did the call succeed
 *   latencyMs     wall clock
 *   timedOut      exceeded the budget
 *   results       how many citations came back
 *   datedResults  how many carried a publication date   -> freshness quality
 *   relevant      rough lexical relevance of the top hits (token overlap)
 *   avgSnippet    mean snippet length (a proxy for snippet usefulness)
 *
 * RELATIVE HONESTY NOTE: "relevance" here is a transparent lexical-overlap
 * proxy, NOT a judgement that an answer is correct. It cannot tell a good
 * answer from a plausible-looking wrong one. It is used only to compare
 * providers on the same queries, and it is labelled as a proxy everywhere it
 * appears.
 *
 * Usage: bun scripts/providerBenchmark.ts
 */

import { createMwmblProvider } from "../src/convex/searchProviders/mwmbl";
import { createDuckDuckGoInstantProvider } from "../src/convex/searchProviders/duckduckgoInstant";
import { createLangSearchProvider, isLangSearchConfigured } from "../src/convex/searchProviders/langsearch";
import { createSearxProvider } from "../src/convex/searchProviders/searxng";
import { createWikipediaCurrentEventsProvider } from "../src/convex/searchProviders/wikipediaCurrentEvents";
import { createGdeltProvider } from "../src/convex/searchProviders/gdelt";
import { createHackerNewsProvider } from "../src/convex/searchProviders/hackernews";
import type { SearchProvider, SearchOptions } from "../src/convex/searchProviders/types";

type Category =
  | "current-news" | "sports" | "finance" | "technology" | "science"
  | "india" | "international" | "multilingual" | "obscure"
  | "historical" | "conflicting";

type Case = { category: Category; query: string; opts?: SearchOptions };

const CASES: Case[] = [
  // current news
  { category: "current-news", query: "latest news today", opts: { category: "news", timeRange: "day" } },
  { category: "current-news", query: "breaking news today", opts: { category: "news", timeRange: "day" } },
  { category: "current-news", query: "world news today", opts: { category: "news", timeRange: "day" } },
  { category: "current-news", query: "technology news this week", opts: { category: "news", timeRange: "week" } },
  { category: "current-news", query: "news from the last hour", opts: { category: "news", timeRange: "hour" } },

  // sports
  { category: "sports", query: "football match result today" },
  { category: "sports", query: "cricket score live" },
  { category: "sports", query: "basketball standings 2026" },
  { category: "sports", query: "tennis tournament results" },
  { category: "sports", query: "olympic medal table" },

  // finance
  { category: "finance", query: "stock market today" },
  { category: "finance", query: "USD INR exchange rate" },
  { category: "finance", query: "gold price today" },
  { category: "finance", query: "cryptocurrency market news" },
  { category: "finance", query: "inflation rate latest" },

  // technology
  { category: "technology", query: "python programming language" },
  { category: "technology", query: "kubernetes documentation" },
  { category: "technology", query: "rust vs go comparison" },
  { category: "technology", query: "open source llm models" },
  { category: "technology", query: "web search engine architecture" },

  // science
  { category: "science", query: "photosynthesis explained" },
  { category: "science", query: "CRISPR gene editing" },
  { category: "science", query: "black hole astronomy" },
  { category: "science", query: "quantum computing research" },
  { category: "science", query: "plate tectonics" },

  // India
  { category: "india", query: "Indian monsoon 2026" },
  { category: "india", query: "India cricket team" },
  { category: "india", query: "Indian economy GDP" },
  { category: "india", query: "Delhi air quality" },
  { category: "india", query: "ISRO mission" },

  // international
  { category: "international", query: "European Union policy" },
  { category: "international", query: "United Nations security council" },
  { category: "international", query: "climate change policy" },
  { category: "international", query: "global trade agreements" },
  { category: "international", query: "international space station" },

  // multilingual
  { category: "multilingual", query: "dernières nouvelles France" },
  { category: "multilingual", query: "aktuelle Nachrichten Deutschland" },
  { category: "multilingual", query: "últimas noticias España" },
  { category: "multilingual", query: "最新のニュース 日本" },
  { category: "multilingual", query: "последние новости Россия" },

  // obscure
  { category: "obscure", query: "Zorblatt Quantum Holdings" },
  { category: "obscure", query: "Ptolemaic dynasty coinage" },
  { category: "obscure", query: "Kerguelen Islands flora" },
  { category: "obscure", query: "Wagstaff cipher algorithm" },

  // historical
  { category: "historical", query: "Who won the 2016 Olympics 100m?" },
  { category: "historical", query: "What was the population of Paris in 1900?" },
  { category: "historical", query: "Treaty of Versailles 1919" },
  { category: "historical", query: "fall of the Roman Republic" },

  // conflicting information (a topic with genuinely divergent sources)
  { category: "conflicting", query: "India medal tally Asian Games 2026" },
  { category: "conflicting", query: "does coffee dehydrate you" },
  { category: "conflicting", query: "great pyramid construction method" },
];

const PROVIDERS: Array<{ p: SearchProvider; categories?: Category[] }> = [
  { p: createMwmblProvider() },
  { p: createDuckDuckGoInstantProvider() },
  // The PRODUCTION general-web provider. It was missing from the first
  // benchmark run, which made any "X beats SearXNG" claim unsupportable.
  { p: createSearxProvider() },
  // Temporary evaluation adapter. Skipped (with a printed reason) unless
  // ENABLE_LANGSEARCH=true and LANGSEARCH_API_KEY are both set — the benchmark
  // must never invent numbers for a provider it could not actually call.
  ...(isLangSearchConfigured()
    ? [{ p: createLangSearchProvider() } as { p: SearchProvider; categories?: Category[] }]
    : []),
  { p: createWikipediaCurrentEventsProvider(), categories: ["current-news"] },
  { p: createGdeltProvider(), categories: ["current-news", "international", "india"] },
  { p: createHackerNewsProvider(), categories: ["technology"] },
];

const TIMEOUT_MS = 12_000;

const STOP = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are",
  "what", "who", "how", "does", "did", "was", "latest", "today", "current",
  "news", "today's", "live", "score", "rate", "price",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9À-ɏЀ-ӿ؀-ۿ]+/).filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/** Transparent lexical-overlap proxy. NOT a correctness judgement. */
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
  ok: boolean; timedOut: boolean; latencyMs: number; results: number;
  datedResults: number; relevance: number; avgSnippet: number; error?: string;
};

async function runOne(
  provider: SearchProvider,
  c: Case,
): Promise<Row> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider.search(c.query, 5, c.opts),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`timeout after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
      }),
    ]);
    const cites = result.citations;
    const snippets = cites.map((x) => (x.snippet ?? "").length);
    return {
      ok: cites.length > 0,
      timedOut: false,
      latencyMs: Date.now() - started,
      results: cites.length,
      datedResults: cites.filter((x) => Boolean(x.publishedAt)).length,
      relevance: relevance(c.query, cites.map((x) => x.title)),
      avgSnippet: snippets.length
        ? Math.round((snippets.reduce((a, b) => a + b, 0) / snippets.length) * 10) / 10
        : 0,
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
      avgSnippet: 0,
      error: msg.slice(0, 60),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

async function main() {
  console.log(`# ANDROMEDA PROVIDER BENCHMARK`);
  console.log(`# ${CASES.length} queries x ${PROVIDERS.length} providers`);
  if (!isLangSearchConfigured()) {
    console.log(
      `# SKIPPED langsearch: needs ENABLE_LANGSEARCH=true and LANGSEARCH_API_KEY.`,
    );
    console.log(
      `#   No number is reported for it rather than a fabricated one. Set the env vars and re-run.`,
    );
  }
  console.log(`# relevance = lexical-overlap PROXY, not a correctness judgement\n`);

  const totals = new Map<string, Row[]>();
  const notConfigured = new Set<string>();

  for (const { p, categories } of PROVIDERS) {
    const applicable = CASES.filter((c) => !categories || categories.includes(c.category));

    // HONESTY FIX: an unconfigured provider is NOT a 0%-availability provider.
    // Reporting MissingKeyError for all N queries as "failures" invents a
    // performance finding that was never measured. The first run of this
    // benchmark did exactly that to SearXNG and would have wrongly implied the
    // production general-web provider was dead.
    if (!p.isConfigured()) {
      notConfigured.add(p.id);
      console.log(
        `${p.id}: `.padEnd(24) +
          "NOT CONFIGURED - not measured (no result recorded)",
      );
      continue;
    }

    const rows: Row[] = [];
    process.stdout.write(`${p.id}: `.padEnd(24));
    for (const c of applicable) {
      const row = await runOne(p, c);
      rows.push(row);
      process.stdout.write(row.ok ? "." : (row.timedOut ? "T" : "x"));
    }
    totals.set(p.id, rows);
    console.log(`  (${rows.length} queries)`);
  }

  console.log(`\n## Per-provider summary\n`);
  const header = [
    "provider", "n", "avail", "timeout", "p50ms", "p95ms",
    "avgRes", "fresh%", "rel(proxy)", "snippet",
  ].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));

  const ranked: Array<{ id: string; avail: number; rel: number; fresh: number }> = [];

  for (const [id, rows] of totals) {
    const n = rows.length;
    const okN = rows.filter((r) => r.ok).length;
    const timeouts = rows.filter((r) => r.timedOut).length;
    const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p50 = lat[Math.floor(n * 0.5)] ?? 0;
    const p95 = lat[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
    const avgRes = rows.reduce((s, r) => s + r.results, 0) / n;
    const totalRes = rows.reduce((s, r) => s + r.results, 0);
    const fresh = totalRes === 0
      ? 0
      : rows.reduce((s, r) => s + r.datedResults, 0) / totalRes;
    const rel = rows.reduce((s, r) => s + r.relevance, 0) / n;
    const snip = rows.reduce((s, r) => s + r.avgSnippet, 0) / n;

    ranked.push({ id, avail: okN / n, rel, fresh });
    console.log(
      [
        id, String(n), pct(okN / n), pct(timeouts / n),
        String(p50), String(p95), avgRes.toFixed(1), pct(fresh),
        rel.toFixed(3), snip.toFixed(0),
      ].join(" | "),
    );
  }

  console.log(`\n## Per-category, providers that returned ANY result\n`);
  const cats = [...new Set(CASES.map((c) => c.category))];
  for (const cat of cats) {
    const inCat = CASES.filter((c) => c.category === cat);
    const hits: string[] = [];
    for (const { p, categories } of PROVIDERS) {
      if (categories && !categories.includes(cat)) continue;
      const rows: Row[] = [];
      for (const c of inCat) rows.push(await runOne(p, c));
      const ok = rows.filter((r) => r.ok).length;
      if (ok > 0) hits.push(`${p.id} ${ok}/${rows.length}`);
    }
    console.log(`  ${cat.padEnd(14)} ${hits.length ? hits.join("  |  ") : "(nobody returned results)"}`);
  }

  console.log(`\n## Interpretation guardrails\n`);
  if (notConfigured.size > 0) {
    console.log(
      `- NOT MEASURED (unconfigured in this environment): ${[...notConfigured].join(", ")}.`,
    );
    console.log(
      `  Excluded from the table entirely. An unconfigured provider has no`,
    );
    console.log(
      `  availability figure - reporting 0% would be a fabricated finding.`,
    );
  }
  console.log(`- "avail" = returned at least one result, NOT "correct".`);
  console.log(`- "rel(proxy)" is lexical overlap only. It cannot detect a`);
  console.log(`  plausible-but-wrong answer, and a high score is NOT evidence`);
  console.log(`  that a provider is better for current information.`);
  console.log(`- "fresh%" is the share of results carrying a publication date.`);
  console.log(`  A provider scoring 0% here cannot serve a freshness-gated`);
  console.log(`  question at all, regardless of how relevant its results look.`);
  console.log(`- Providers were run against DIFFERENT query sets where they are`);
  console.log(`  category-scoped, so rows are not directly comparable across`);
  console.log(`  providers of different scope.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
