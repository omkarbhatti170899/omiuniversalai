/**
 * FRESHNESS MATRIX — the brief's recency classes, measured end to end.
 * =========================================================================
 *
 * The reported freshness problem is not "is the ranking right" but "does a
 * current question actually get current, DATED evidence, and is the timestamp
 * exposed to the user". This exercises every recency class the brief lists
 * against the DEPLOYED probe and reports the newest source's age.
 *
 * Freshness here is judged on the same rule the product uses: the NEWEST
 * acceptable source, not "some source somewhere in the set".
 *
 * Usage: bun scripts/freshnessMatrix.ts
 */

// Production backend is the default so this harness can never silently probe a
// retired deployment. Override OMI_BACKEND to test another one deliberately.
const BACKEND =
  process.env.OMI_BACKEND ?? "https://majestic-turtle-372.convex.site";
const BASE = `${BACKEND}/currentinfo`;

type Case = { group: string; query: string };

const CASES: Case[] = [
  // the seven recency classes the brief names
  { group: "latest", query: "latest news today" },
  { group: "today", query: "what happened today" },
  { group: "current", query: "what is the current situation in the world today" },
  { group: "live", query: "live updates right now" },
  { group: "breaking", query: "breaking news today" },
  // 2026-specific — the class that started this
  { group: "year-2026", query: "India medal tally Asian Games 2026" },
  { group: "year-2026", query: "latest news 2026" },
  // multilingual / global — the class that was silently broken
  { group: "multilingual", query: "dernières nouvelles France" },
  { group: "multilingual", query: "aktuelle Nachrichten Deutschland" },
  { group: "multilingual", query: "日本の最新ニュース" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  query: string;
  status: string;
  requiresFreshness: boolean;
  vertical: string;
  resultsFound: number;
  freshResults: number;
  freshness: string | null;
  enginesWithResults: string[];
  detail: string;
}

function ageOf(freshness: string | null): string {
  if (!freshness) return "none";
  const m = freshness.match(/newest: ([^)]+)\)/i);
  return m ? m[1] : freshness.slice(0, 40);
}

async function main() {
  console.log(`# FRESHNESS MATRIX — deployed probe, ${CASES.length} queries\n`);
  let pass = 0;
  let fail = 0;
  const problems: string[] = [];

  for (const c of CASES) {
    let row: Row;
    try {
      const res = await fetch(`${BASE}?query=${encodeURIComponent(c.query)}`);
      row = (await res.json()) as Row;
    } catch (e) {
      console.log(`ERR  [${c.group}] ${c.query} — ${String(e).slice(0, 60)}`);
      fail++;
      problems.push(`${c.group}: ${c.query} — request failed`);
      await sleep(9000);
      continue;
    }

    // The freshness contract: a current question must come back with dated
    // evidence. Undated is NOT acceptable for these classes.
    const ok = row.status === "pass" && row.requiresFreshness === true;
    if (ok) pass++;
    else fail++;

    console.log(
      `${ok ? "PASS" : "FAIL"} [${c.group.padEnd(12)}] ${c.query.slice(0, 44).padEnd(46)}` +
        `fresh=${String(row.freshResults).padStart(2)}/${String(row.resultsFound).padStart(2)}` +
        ` reqFresh=${String(row.requiresFreshness).padEnd(5)}` +
        ` ${ageOf(row.freshness).padEnd(12)} ${row.enginesWithResults.join("+").slice(0, 46)}`,
    );
    if (!ok) {
      problems.push(
        `${c.group}: "${c.query}" -> status=${row.status} fresh=${row.freshResults}/${row.resultsFound} requiresFreshness=${row.requiresFreshness}`,
      );
      console.log(`       ${String(row.detail).slice(0, 150)}`);
    }
    await sleep(9000);
  }

  console.log(`\n# ${pass} pass / ${fail} fail`);
  if (problems.length) {
    console.log(`\n# PROBLEMS (each names the broken link):`);
    for (const p of problems) console.log(`#  - ${p}`);
  } else {
    console.log(`\n# Every recency class returned dated, current evidence.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
