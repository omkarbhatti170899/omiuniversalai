/**
 * Multi-source verification and conflict detection.
 *
 * THE THIRD PART OF THE REPORTED BUG
 * ----------------------------------
 * When two live sources disagree about a current fact — "38 gold" vs "41
 * gold", two different USD/INR quotes, two different scorelines — the previous
 * behaviour was to let the model pick whichever one it saw first and narrate
 * it confidently. That is the worst possible failure for a live question,
 * because it looks authoritative and is silently wrong.
 *
 * This module makes disagreement a FIRST-CLASS, VISIBLE outcome:
 *
 *   1. Extract comparable claims (a number + its unit) from each source.
 *   2. Group them by metric, and only compare across INDEPENDENT domains —
 *      the same story republished is not corroboration, it is an echo.
 *   3. If independent sources disagree, report the disagreement with each
 *      source, its date and its figure. Never collapse it to one number.
 *
 * PURE and deterministic: no network, no clock beyond an injectable `now`.
 */

import { domainOf } from "./quality";
import { ageInDays, relativeAge, type FreshnessSource } from "./freshness";

/** A single extracted figure, with the source it came from. */
export type Claim = {
  /** The metric this figure measures ("gold medals", "usd/inr", "score"). */
  metric: string;
  /** The normalised value, used for equality comparison. */
  value: string;
  /** Verbatim text the figure was read from, for display. */
  evidence: string;
  domain: string;
  url: string;
  publishedAt?: string;
  ageDays: number | null;
};

export type ConflictingClaim = {
  metric: string;
  /** The distinct values reported, each with the source that reported it. */
  readings: Array<{ value: string; domain: string; url: string; publishedAt?: string; evidence: string }>;
  /** How many independent domains reported each value. */
  independentDomains: number;
};

export type CrossCheckReport = {
  /** Claims found in total. */
  claimCount: number;
  /** Distinct independent domains behind those claims. */
  independentDomains: number;
  /** Metrics where independent sources DISAGREE. */
  conflicts: ConflictingClaim[];
  /** True when every compared metric had full independent agreement. */
  agreed: boolean;
  /** True when there was too little to compare — not the same as "agreed". */
  insufficientEvidence: boolean;
};

/**
 * Metric extractors, ordered by specificity. Each must be anchored to a real
 * unit so "the 2026 Games" is never read as a score of 2026.
 */
const EXTRACTORS: Array<{ metric: string; re: RegExp }> = [
  { metric: "medals", re: /\b(\d{1,3})\s*(?:gold|silver|bronze)\s+medals?\b/gi },
  { metric: "medals", re: /\b(?:total|won|winning)\s+(\d{1,3})\s+medals?\b/gi },
  { metric: "medals", re: /\b(\d{1,3})\s+medals?\b/gi },
  { metric: "score", re: /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b(?!\d)/g },
  { metric: "gold price", re: /\b(?:rs\.?|inr|₹|\$|usd)\s?([\d,]{2,12}(?:\.\d+)?)/gi },
  { metric: "exchange rate", re: /\b([\d,]{1,10}(?:\.\d{1,4})?)\s*(?:rupees?|inr|rs\.?)\s*(?:per|\/|\s+to)\s*(?:a\s+)?(?:usd|dollar|\$)/gi },
  { metric: "seats", re: /\b(\d{1,3})\s*(?:seats?|mp'?s?|members?)\b/gi },
  { metric: "percentage", re: /\b(\d{1,2}(?:\.\d+)?)\s*%/g },
];

/** Pull every comparable figure out of one source. */
export function claimsFromSource(source: FreshnessSource, now = Date.now()): Claim[] {
  const hay = `${source.title ?? ""} — ${source.snippet ?? ""}`;
  const domain = source.domain ?? domainOf(source.url ?? "");
  const out: Claim[] = [];
  for (const { metric, re } of EXTRACTORS) {
    // Each extractor needs its own lastIndex; a shared /g regex would carry
    // state between sources and silently skip matches.
    const rx = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(hay)) !== null) {
      // A score extractor has two groups; everything else has one.
      const value = metric === "score" ? `${m[1]}-${m[2]}` : (m[1] ?? "");
      if (!value) continue;
      out.push({
        metric,
        value: value.replace(/,/g, "").toLowerCase(),
        evidence: m[0].trim(),
        domain,
        url: source.url ?? "",
        publishedAt: source.publishedAt,
        ageDays: ageInDays(source.publishedAt, now),
      });
      if (out.length >= 40) return out; // bounded
    }
  }
  return out;
}

/**
 * Compare claims across sources and surface every genuine disagreement.
 *
 * A disagreement requires ≥2 INDEPENDENT DOMAINS reporting different values for
 * the same metric. One domain repeating itself is noise, not a conflict.
 */
export function crossCheckClaims(
  sources: FreshnessSource[],
  now = Date.now(),
): CrossCheckReport {
  const claims = sources.flatMap((s) => claimsFromSource(s, now));
  const domains = new Set(claims.map((c) => c.domain));
  const byMetric = new Map<string, Claim[]>();
  for (const c of claims) {
    if (!byMetric.has(c.metric)) byMetric.set(c.metric, []);
    byMetric.get(c.metric)!.push(c);
  }

  const conflicts: ConflictingClaim[] = [];
  let comparedMetrics = 0;

  for (const [metric, group] of byMetric) {
    // Group by value, then by domain, so one domain cannot manufacture a
    // conflict by publishing the same figure twice.
    const byValue = new Map<string, Claim[]>();
    for (const c of group) {
      if (!byValue.has(c.value)) byValue.set(c.value, []);
      byValue.get(c.value)!.push(c);
    }

    // A metric counts as COMPARED once two INDEPENDENT domains have reported
    // it — agreeing or not. Counting only disagreements would make full
    // agreement report as "no evidence", which is exactly backwards: two
    // independent sources saying the same figure is a positive result.
    const metricDomains = new Set(group.map((c) => c.domain));
    if (metricDomains.size < 2) continue; // echo, not a comparison
    comparedMetrics += 1;
    if (byValue.size < 2) continue; // compared, and they agree — no conflict

    // Only keep values that at least one DOMAIN actually stands behind.
    const readings = [...byValue.entries()]
      .map(([value, cs]) => {
        const domainsForValue = new Set(cs.map((c) => c.domain));
        return { value, claims: cs, domainCount: domainsForValue.size };
      })
      .filter((r) => r.domainCount > 0)
      .sort((a, b) => b.domainCount - a.domainCount);

    const involvedDomains = new Set(readings.flatMap((r) => r.claims.map((c) => c.domain)));
    if (involvedDomains.size < 2) continue; // echo, not a conflict

    conflicts.push({
      metric,
      independentDomains: involvedDomains.size,
      readings: readings.map((r) => {
        const best = r.claims[0];
        return {
          value: r.value,
          domain: best.domain,
          url: best.url,
          publishedAt: best.publishedAt,
          evidence: best.evidence,
        };
      }),
    });
  }

  return {
    claimCount: claims.length,
    independentDomains: domains.size,
    conflicts,
    agreed: comparedMetrics > 0 && conflicts.length === 0,
    // "No claims found" must not read as "sources agreed".
    insufficientEvidence: comparedMetrics === 0,
  };
}

/**
 * The exact sentence Omi must show when live sources disagree.
 *
 * It never picks a winner. Each reading keeps its source, its date and its
 * reported figure, so the user can judge — which is the whole point of
 * checking more than one source.
 */
export function conflictNotice(report: CrossCheckReport, now = Date.now()): string | null {
  if (report.conflicts.length === 0) return null;
  const lines: string[] = ["Sources currently report different values for this, so Omi is not picking one:"];
  for (const c of report.conflicts) {
    lines.push(`\n${c.metric.toUpperCase()}:`);
    for (const r of c.readings.slice(0, 4)) {
      const when = relativeAge(r.publishedAt, now);
      lines.push(`• ${r.value} — ${r.domain} (${when}) — "${r.evidence}"`);
    }
  }
  lines.push(
    "\nTreat these as unconfirmed and check the official source before relying on a figure.",
  );
  return lines.join("\n");
}
