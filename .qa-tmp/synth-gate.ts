// Synthetic: chat-path gate logic against the measured F1 evidence set.
// Reimplements ONLY the gate composition from omiChat.ts usable filter
// (pure predicates, no Convex) to prove realitytea+NASCAR both drop.
const SPORTS_ENTERTAINMENT_RE = /(?:realitytea|ladbible|the-sun|thesun|dailystar|dailymail|mirror\.co|buzzfeed|unilad|sportskeeda|givemesport|the-sun\.com)/i;
const entityInSource = (c: { title: string; snippet: string; url: string }, entity: string) => {
  const hay = `${c.title} ${c.snippet} ${c.url}`.toLowerCase();
  return entity.split(/\s+/).every((t) => hay.includes(t)) || hay.includes(entity.toLowerCase());
};
const isSportsFactQuestion = true;
const policyEvent = "formula 1";
const evidence = [
  { title: "Kim Kardashian's F1 Dream Gets Lewis Hamilton's Approval — Source", url: "https://www.realitytea.com/x", snippet: "F1 2026 championship..." },
  { title: "Reddick Concedes \"We Got Big Problems\" After Rough Kansas Outing", url: "https://www.si.com/y", snippet: "NASCAR Cup Series Hollywood Casino 400 at Kansas Speedway..." },
];
const usable = evidence.filter((c) =>
  !isSportsFactQuestion ||
  false || // not sports-scores feed
  (!SPORTS_ENTERTAINMENT_RE.test(new URL(c.url).hostname) && (!policyEvent || entityInSource(c, policyEvent))),
);
console.log("usable after gate:", usable.length, usable.map((c) => c.url));
console.log("gate outcome: authoritativeUsable.length === 0 → NO_VERIFIED_RESULTS refusal branch");
