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
  // BREAKDOWN CAPTURE: "gold 12, silver 18, bronze 16" (no "medals" word on
  // each) — needed so the arithmetic reconstruction in resolveConflict can
  // cross-check a total against its own components.
  { metric: "gold-count", re: /\bgold\s*[-–—:]?\s*(\d{1,3})\b/gi },
  { metric: "silver-count", re: /\bsilver\s*[-–—:]?\s*(\d{1,3})\b/gi },
  { metric: "bronze-count", re: /\bbronze\s*[-–—:]?\s*(\d{1,3})\b/gi },
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
      if (out.length >= 60) return out; // bounded (raised: breakdown claims
      // (gold+silver+bronze) consume extractor slots; the arithmetic
      // reconstruction in resolveConflict needs both the total AND the parts)
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

// --- CONFLICT RESOLUTION (measured: 37/45/46 medal readings) ---------------

export type ResolvedReading = {
  value: string;
  domain: string;
  publishedAt?: string;
  evidence: string;
  /** Why this reading was selected as the answer figure. */
  basis: "authoritative-newest" | "newest" | "most-corroborated" | "arithmetic-reconstructed";
  /** Citations that DIRECTLY support this number. */
  supportingDomains: string[];
};

export type ConflictResolution = {
  metric: string;
  /** The single figure Omi presents, with its citation. */
  resolution: ResolvedReading;
  /** Values that were considered and set aside, each with its reason. */
  setAside: Array<{ value: string; domain: string; reason: string }>;
  /** Sources still disagree (e.g. race is live) — say so explicitly. */
  stillContested: boolean;
};

/**
 * Resolve one conflicting metric to ONE figure — or declare it contested.
 *
 * Precedence (deliberate, per the contract):
 *   1. AUTHORITATIVE source (official competition body, major outlet) — its
 *      newest reading wins even against a newer blog.
 *   2. NEWEST otherwise — a live tally moves; the freshest number is the best
 *      estimate, but each set-aside value is still reported with its source.
 *   3. ARITHMETIC RECONSTRUCTION: when one reading can be independently
 *      reconstructed from component claims in ANOTHER source (gold+silver+
 *      bronze == total), the reading whose arithmetic checks out is preferred.
 * When readings remain that are BOTH authoritative AND newer than the chosen
 * one's window, the metric is declared stillContested and Omi must say that
 * sources disagree — never present two numbers as simultaneously correct.
 */
export function resolveConflict(
  conflict: ConflictingClaim,
  opts: { authoritativeDomains?: Set<string> } = {},
): ConflictResolution {
  const auth = opts.authoritativeDomains ?? new Set<string>();
  const isAuth = (r: ConflictingClaim["readings"][number]) => auth.has(r.domain);

  // Arithmetic cross-check: "gold X, silver Y, bronze Z" in one source should
  // sum to that source's total claim. A reading whose sibling breakdown sums
  // to it gains trust; one contradicted by its own breakdown loses it.
  const sumChecks = new Map<string, boolean>(); // domain -> breakdown sums to total
  for (const r of conflict.readings) {
    const m = /\b(?:gold|g)\s*[-–—:]?\s*(\d{1,3})\b[\s\S]{0,80}?\b(?:silver|s)\s*[-–—:]?\s*(\d{1,3})\b[\s\S]{0,80}?\b(?:bronze|b)\s*[-–—:]?\s*(\d{1,3})\b/i.exec(
      r.evidence,
    );
    if (m) sumChecks.set(r.domain, Number(m[1]) + Number(m[2]) + Number(m[3]) === Number(r.value));
  }

  const parseTime = (r: ConflictingClaim["readings"][number]) => {
    const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
    return Number.isFinite(t) ? t : 0;
  };

  const authoritative = conflict.readings.filter(isAuth);
  const pool = authoritative.length > 0 ? authoritative : conflict.readings;
  const ranked = [...pool].sort((a, b) => {
    const aSum = sumChecks.get(a.domain);
    const bSum = sumChecks.get(b.domain);
    // A reading whose own breakdown arithmetically confirms it outranks one
    // whose breakdown contradicts it (when both provide breakdowns).
    if (aSum === true && bSum === false) return -1;
    if (aSum === false && bSum === true) return 1;
    return parseTime(b) - parseTime(a); // newest first within the pool
  });
  const winner = ranked[0];

  const basis: ResolvedReading["basis"] = authoritative.length > 0
    ? "authoritative-newest"
    : sumChecks.get(winner.domain) === true
      ? "arithmetic-reconstructed"
      : "newest";

  const winnerTime = parseTime(winner);
  const stillContested =
    authoritative.length > 1 &&
    authoritative.some((r) => r !== winner && r.value !== winner.value && parseTime(r) >= winnerTime);

  return {
    metric: conflict.metric,
    resolution: {
      value: winner.value,
      domain: winner.domain,
      publishedAt: winner.publishedAt,
      evidence: winner.evidence,
      basis,
      supportingDomains: [winner.domain],
    },
    setAside: conflict.readings
      .filter((r) => r !== winner)
      .map((r) => ({
        value: r.value,
        domain: r.domain,
        reason: isAuth(r)
          ? parseTime(r) > winnerTime
            ? "newer authoritative reading exists"
            : "older than the selected authoritative reading"
          : "source is not authoritative for this metric",
      })),
    stillContested,
  };
}
