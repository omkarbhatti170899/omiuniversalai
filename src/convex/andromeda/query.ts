/**
 * Andromeda — Query Understanding (master plan §4 pipeline, stage 1).
 *
 * Pure, deterministic, no I/O. Classifies a natural-language research query
 * and decides how the pipeline should run: which sources fit, whether
 * freshness matters, whether corroboration should be enforced, and which
 * synthesis prompt discipline applies. This runs BEFORE any network call —
 * bad or hostile queries are stopped here (§12).
 */

export type AndromedaQueryPlan = {
  /** The cleaned research question used for search + synthesis. */
  cleanedQuery: string;
  /** What kind of question this is — drives source selection. */
  kind: "factual" | "comparative" | "temporal" | "exploratory" | "definitional";
  /** Freshness-sensitive queries skip cache and rank recency higher. */
  freshnessMatters: boolean;
  /** Enforce ≥2 independent domains in the evidence before synthesis. */
  corroborationRequired: boolean;
  /** Extra query angles fanned out in parallel (bounded). */
  subqueries: string[];
  /** Which provider categories fit this question. */
  sourceHints: string[];
  /** How the synthesis prompt should behave. */
  synthesisDiscipline: string;
  /** Rejected queries carry a reason and run nothing. */
  reject?: { reason: string };
};

const MAX_QUERY_CHARS = 400;

const TEMPORAL_RE =
  /\b(latest|newest|current|currently|today|now|2025|2026|this (?:week|month|year)|last (?:week|month|year)|recent(?:ly)?|price|release|update[ds]?|since)\b/i;
const COMPARATIVE_RE =
  /\b(vs\.?|versus|compare|comparison|difference(?:s)? between|better|best|top \d+|alternatives|pros and cons|trade-?offs?)\b/i;
const DEFINITIONAL_RE =
  /^(what is|what are|who is|who was|define|definition of|meaning of)\b/i;
const EXPLORATORY_RE =
  /\b(overview|landscape|state of|how (?:do|does|to)|guide|introduction|learn|architecture|ecosystem|getting started)\b/i;

const HOSTILE_RE =
  /(\bignore (?:all |any )?(?:previous|prior|above) (?:instructions|prompts)\b)|(\bsystem\s*prompt\b)|(\byou are now\b)|(\bdisregard (?:all )?(?:previous|prior)\b)/i;

/**
 * Plan how Andromeda will answer a research query. Never throws, never
 * fetches — pure classification + planning.
 */
export function planQuery(raw: string): AndromedaQueryPlan {
  const q = (raw ?? "").trim();

  if (q.length < 3) {
    return basePlan(q, { reject: { reason: "Query is too short to research." } });
  }
  if (q.length > MAX_QUERY_CHARS) {
    return basePlan(q, {
      reject: { reason: `Query exceeds ${MAX_QUERY_CHARS} characters — split it into smaller questions.` },
    });
  }
  if (HOSTILE_RE.test(q)) {
    return basePlan(q, {
      reject: { reason: "Query contains instruction-injection patterns and was not processed." },
    });
  }

  // Clean: strip leading command phrasing, collapse whitespace.
  const cleanedQuery =
    q
      .replace(/^(?:please\s+)?(?:research|investigate|find(?:\s+out)?|look\s+up|search(?:\s+for)?|tell\s+me\s+about|analyze|analyse)\s+/i, "")
      .replace(/^what(?:'s| is)\s+the\s+/, "what ")
      .replace(/\s+/g, " ")
      .trim() || q;

  const temporal = TEMPORAL_RE.test(q);
  const comparative = COMPARATIVE_RE.test(q);
  const definitional = DEFINITIONAL_RE.test(q);
  const exploratory = !comparative && !temporal && EXPLORATORY_RE.test(q);

  const kind: AndromedaQueryPlan["kind"] = temporal
    ? "temporal"
    : comparative
      ? "comparative"
      : definitional
        ? "definitional"
        : exploratory
          ? "exploratory"
          : "factual";

  const freshnessMatters = temporal;
  // High-stakes question shapes get corroboration: comparative claims and
  // fresh claims are exactly the ones that go stale or get skewed.
  const corroborationRequired = comparative || temporal;

  const subqueries = buildSubqueries(cleanedQuery, kind);
  const sourceHints = buildSourceHints(kind);

  return {
    ...basePlan(cleanedQuery, {}),
    kind,
    freshnessMatters,
    corroborationRequired,
    subqueries,
    sourceHints,
    synthesisDiscipline: synthesisDisciplineFor(kind),
  };
}

function basePlan(
  cleanedQuery: string,
  extra: Partial<AndromedaQueryPlan>,
): AndromedaQueryPlan {
  return {
    cleanedQuery,
    kind: "factual",
    freshnessMatters: false,
    corroborationRequired: false,
    subqueries: [],
    sourceHints: [],
    synthesisDiscipline: synthesisDisciplineFor("factual"),
    ...extra,
  };
}

function buildSubqueries(q: string, kind: AndromedaQueryPlan["kind"]): string[] {
  const subs: string[] = [q];
  if (kind === "comparative") {
    // Each side of a comparison should be researched on its own terms.
    const parts = q.split(/\s+(?:vs\.?|versus|or)\s+/i).filter((p) => p.length > 2);
    if (parts.length > 1) {
      for (const p of parts.slice(0, 3)) subs.push(p.trim());
    } else {
      subs.push(`${q} pros and cons`);
    }
  } else if (kind === "temporal") {
    subs.push(`${q} 2026`);
  } else if (kind === "definitional") {
    subs.push(`${q} explained`);
  } else if (kind === "exploratory") {
    subs.push(`${q} overview`);
  }
  return subs.slice(0, 3); // bounded fan-out (§7: parallel but capped)
}

function buildSourceHints(kind: AndromedaQueryPlan["kind"]): string[] {
  switch (kind) {
    case "definitional":
      return ["wikipedia", "wikidata", "general web"];
    case "comparative":
      return ["official docs", "reviews", "general web"];
    case "temporal":
      return ["news", "official announcements", "general web"];
    case "exploratory":
      return ["wikipedia", "arxiv/openalex", "general web"];
    default:
      return ["general web", "reference"];
  }
}

function synthesisDisciplineFor(kind: AndromedaQueryPlan["kind"]): string {
  switch (kind) {
    case "comparative":
      return "Present each option on its own terms before comparing; surface trade-offs as trade-offs, and never collapse a disagreement into a single verdict.";
    case "temporal":
      return "Date every claim; prefer the newest authoritative source and mark older claims as historical. If sources conflict on recency, say which is newest and why.";
    case "definitional":
      return "Lead with the definition from the highest-authority source; note disputes of definition instead of picking one silently.";
    case "exploratory":
      return "Structure as an overview: landscape, key entities, current debates, and open questions. Flag thin areas as thin.";
    default:
      return "State only what the evidence supports; mark anything uncertain explicitly.";
  }
}
