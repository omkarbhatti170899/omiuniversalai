/**
 * Source verification state (spec §4 — "never claim verified when only one
 * source supports a claim").
 *
 * The rule this module exists to enforce:
 *
 *   ONE SOURCE IS NOT VERIFICATION. It is a report.
 *
 * Showing a green "verified" tick beside a claim backed by a single link is
 * the most damaging thing a source UI can do, because the user has no way to
 * tell it apart from genuine cross-checking. So the state is derived from
 * MEASURED facts — how many independent domains, and whether they disagree —
 * and it is deliberately blunt about the difference between "one outlet said
 * so" and "several independent outlets agree".
 *
 * PURE and deterministic, so the label can be unit-tested rather than eyeballed.
 */

export type VerificationState =
  | "cross-checked" // ≥2 independent domains, no conflict
  | "single-source" // exactly one domain — reported, NOT verified
  | "conflicting" // independent sources disagree
  | "undated" // evidence carried no date
  | "none"; // no sources at all

export type VerificationInfo = {
  state: VerificationState;
  /** Short label safe to render in a UI. */
  label: string;
  /** One line explaining what the label does and does not mean. */
  detail: string;
  /** True only for genuine cross-checking. */
  verified: boolean;
  /** Distinct independent domains behind the evidence. */
  independentDomains: number;
};

const COPY: Record<VerificationState, { label: string; detail: string; verified: boolean }> = {
  "cross-checked": {
    label: "Cross-checked",
    detail: "Several independent sources agree.",
    verified: true,
  },
  "single-source": {
    // The wording is the whole point: NOT "verified".
    label: "Single source",
    detail: "Only one source supports this. Reported, not independently confirmed.",
    verified: false,
  },
  conflicting: {
    label: "Sources disagree",
    detail: "Independent sources report different values. Treat this as unconfirmed.",
    verified: false,
  },
  undated: {
    label: "Undated",
    detail: "The supporting sources showed no publication date, so their currency is unknown.",
    verified: false,
  },
  none: {
    label: "No sources",
    detail: "This answer has no supporting source. Do not rely on it.",
    verified: false,
  },
};

/**
 * Derive the verification state for a set of sources.
 *
 * `independentDomains` is counted by DOMAIN, never by link count: one outlet
 * publishing three articles is one source, not three. `conflicts` is the
 * measured output of the cross-check, not an assumption.
 */
export function verificationFor(input: {
  sources: Array<{ domain: string }>;
  /** Measured cross-source conflicts; any conflict wins over agreement. */
  conflicts?: number;
  /** How many sources carried a usable date. */
  datedSources?: number;
}): VerificationInfo {
  const total = input.sources.length;
  const domains = new Set(input.sources.map((s) => s.domain).filter(Boolean));
  const independentDomains = domains.size;
  const conflicts = input.conflicts ?? 0;
  const dated = input.datedSources ?? total;

  let state: VerificationState;
  if (total === 0) state = "none";
  // A conflict is the strongest signal and outranks everything else: agreeing
  // on nothing is still better than silently picking one side.
  else if (conflicts > 0) state = "conflicting";
  else if (dated === 0) state = "undated";
  else if (independentDomains >= 2) state = "cross-checked";
  else state = "single-source";

  const copy = COPY[state];
  return {
    state,
    label: copy.label,
    detail: copy.detail,
    verified: copy.verified,
    independentDomains,
  };
}

/** The exact sentence appended under an answer's source list. */
export function verificationSentence(info: VerificationInfo): string {
  if (info.state === "none") return info.detail;
  const n = info.independentDomains;
  switch (info.state) {
    case "cross-checked":
      return `Cross-checked against ${n} independent sources.`;
    case "single-source":
      return `Based on 1 source only — not independently confirmed.`;
    case "conflicting":
      return `Sources currently report different values across ${n} independent sources. This is unconfirmed.`;
    case "undated":
      return "The supporting sources showed no publication date, so their currency cannot be confirmed.";
  }
}
