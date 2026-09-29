import { resolveConflict, conflictResolutionsNotice } from "../src/convex/searchEngine/crossCheck";
import { sourceTier } from "../src/convex/searchEngine/quality";
// The EXACT conflict readings captured from the deployed trace (medal-trace-after.json)
const conflict = {
  metric: "medals",
  independentDomains: 4,
  readings: [
    { value: "45", domain: "news.abplive.com", publishedAt: new Date(Date.now() - 2 * 3600000).toISOString(), evidence: "45 medals", sourceText: "India have 45 medals at the Asian Games" },
    { value: "37", domain: "khelnow.com", publishedAt: new Date(Date.now() - 26 * 3600000).toISOString(), evidence: "37 medals", sourceText: "India's tally reached 37 medals" },
    { value: "4", domain: "freepressjournal.in", publishedAt: new Date(Date.now() - 4 * 3600000).toISOString(), evidence: "4 medals", sourceText: "India won 4 gold medals" },
  ],
};
const authDomains = new Set(
  ["news.abplive.com", "khelnow.com", "freepressjournal.in"].filter((d) => sourceTier(`https://${d}/x`).weight >= 0.85),
);
console.log("authoritative domains (tier>=0.85):", [...authDomains]);
const r = resolveConflict(conflict as never, { authoritativeDomains: authDomains });
console.log("RESOLVED:", JSON.stringify(r.resolution));
console.log("setAside:", JSON.stringify(r.setAside, null, 1));
console.log("stillContested:", r.stillContested);
const notice = conflictResolutionsNotice({ conflicts: [conflict as never] } as never, authDomains, Date.now());
console.log("\nUSER-FACING BLOCK:\n" + notice?.text);
