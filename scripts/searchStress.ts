/**
 * SEARCH STRESS HARNESS (read-only, diagnostic).
 *
 * Drives the DEPLOYED /currentinfo?query= endpoint so each row exercises the
 * real retrieval path: intent -> rewrite -> provider selection -> retrieval ->
 * timestamp extraction -> freshness/authority ranking -> evidence selection.
 *
 * Adversarial cases only. The happy path is already covered by the standing
 * /currentinfo suite; what this adds is the set most likely to break the
 * architecture: ambiguous, unsatisfiable, historical, multilingual and
 * geographically-specific queries.
 *
 * Read-only: it never writes, and never claims a result is correct — only
 * what the pipeline DID with it.
 *
 * Usage: bun scripts/searchStress.ts
 */

// Production backend is the default so this harness can never silently probe a
// retired deployment. Override OMI_BACKEND to test another one deliberately.
const BACKEND =
  process.env.OMI_BACKEND ?? "https://majestic-turtle-372.convex.site";
const BASE = `${BACKEND}/currentinfo`;

type Case = { group: string; q: string };

const CASES: Case[] = [
  // --- ambiguity: no single correct answer without a location/entity ---
  { group: "ambiguous", q: "What is the current temperature?" },
  { group: "ambiguous", q: "Who is the current leader?" },
  { group: "ambiguous", q: "What is the latest score?" },

  // --- unsatisfiable: no answer exists; must refuse, not invent ---
  { group: "no-result", q: "What is the current market cap of Zorblatt Quantum Holdings?" },
  { group: "no-result", q: "Who won the 2099 Intercontinental Cup final?" },

  // --- historical: must NOT be forced into the freshness tier ---
  { group: "historical", q: "Who won the 2016 Olympics men's 100m?" },
  { group: "historical", q: "What was the population of Paris in 1900?" },

  // --- multilingual: intent must survive a non-English query ---
  { group: "multilingual", q: "Quelles sont les dernieres nouvelles en France?" },
  { group: "multilingual", q: "Was ist die aktuelle Wetterlage in Berlin?" },

  // --- geographic: must not assume one country ---
  { group: "geographic", q: "What is the latest news in Brazil today?" },
  { group: "geographic", q: "Current gold price in Tokyo?" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  query: string;
  status: string;
  vertical: string;
  intent: string;
  timeRange: string | null;
  resultsFound: number;
  freshResults: number;
  enginesWithResults: string[];
  failedEngines: string[];
  detail: string;
  freshness: string | null;
}

console.log(`stress: ${CASES.length} adversarial queries\n`);

for (const c of CASES) {
  try {
    const res = await fetch(`${BASE}?query=${encodeURIComponent(c.q)}`);
    const body = (await res.json()) as Row;
    const flag = body.status === "pass" ? "ok  " : "FAIL";
    console.log(
      `${flag} [${c.group}] ${c.q}\n` +
        `        status=${body.status} v=${body.vertical} intent=${body.intent} ` +
        `raw=${body.resultsFound} fresh=${body.freshResults} engines=${body.enginesWithResults.length} failed=${body.failedEngines.length}\n` +
        `        ${String(body.detail).slice(0, 150)}`,
    );
  } catch (err) {
    console.log(`ERR  [${c.group}] ${c.q}\n        ${String(err)}`);
  }
  // The ad-hoc probe is rate limited; stay under it rather than 429-ing.
  await sleep(9000);
}
