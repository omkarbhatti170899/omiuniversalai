/**
 * Omi Knowledge Intelligence — version comparison (pure).
 *
 * §9 of the completion spec ("What changed?"). When a family has v4 and v5,
 * a reviewer must be able to see exactly what moved between them: added,
 * removed, changed and the effective date. This is a plain, deterministic
 * diff — no model call — so it can never misreport what an approval would
 * actually change.
 */

export type LineDiff = {
  added: string[];
  removed: string[];
  changed: Array<{ from: string; to: string }>;
};

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Line-level set difference. Lines are trimmed and compared verbatim: an
 * edited line reads as one removed + one added line, which is what a reviewer
 * needs to see. The pairing pass below pairs them so the UI can show a
 * from → to change instead of an unrelated add/remove pair.
 */
export function diffLines(before: string, after: string): LineDiff {
  const b = normalizeLines(before);
  const a = normalizeLines(after);
  const beforeSet = new Set(b);
  const afterSet = new Set(a);

  const removed = b.filter((l) => !afterSet.has(l));
  const added = a.filter((l) => !beforeSet.has(l));

  // Pair an added line with a removed line that shares a strong prefix — a
  // cheap, honest "this line was edited" signal. Unpaired lines stay as plain
  // adds/removes.
  const changed: Array<{ from: string; to: string }> = [];
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  const pairs: Array<{ r: number; a: number; overlap: number }> = [];
  for (let r = 0; r < removed.length; r++) {
    for (let ai = 0; ai < added.length; ai++) {
      const overlap = sharedTokenRatio(removed[r], added[ai]);
      if (overlap >= 0.4) pairs.push({ r, a: ai, overlap });
    }
  }
  for (const p of pairs.sort((x, y) => y.overlap - x.overlap)) {
    if (usedRemoved.has(p.r) || usedAdded.has(p.a)) continue;
    usedRemoved.add(p.r);
    usedAdded.add(p.a);
    changed.push({ from: removed[p.r], to: added[p.a] });
  }

  return {
    added: added.filter((_, i) => !usedAdded.has(i)),
    removed: removed.filter((_, i) => !usedRemoved.has(i)),
    changed,
  };
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "be", "with", "that", "this", "as", "at", "by", "must", "should", "will",
]);

/** Jaccard-ish overlap of significant tokens (0..1). */
export function sharedTokenRatio(a: string, b: string): number {
  const ta = new Set(
    a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)),
  );
  const tb = new Set(
    b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)),
  );
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

export type FieldChange = { field: string; from: string; to: string };

/** Scalar metadata fields worth showing a reviewer when they differ. */
export const COMPARABLE_FIELDS = [
  "title",
  "status",
  "version",
  "category",
  "product",
  "department",
  "region",
  "owner",
] as const;

function render(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (Array.isArray(v)) return v.join(", ") || "—";
  return String(v);
}

export function compareFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of COMPARABLE_FIELDS) {
    const from = render(before[f]);
    const to = render(after[f]);
    if (from !== to) out.push({ field: f, from, to });
  }
  return out;
}

export type VersionComparison = {
  fromVersion: number;
  toVersion: number;
  fromEffective?: number;
  toEffective?: number;
  fields: FieldChange[];
  lines: LineDiff;
};

export function compareVersions(
  before: { version: number; effectiveDate?: number; content: string } & Record<string, unknown>,
  after: { version: number; effectiveDate?: number; content: string } & Record<string, unknown>,
): VersionComparison {
  return {
    fromVersion: before.version,
    toVersion: after.version,
    fromEffective: before.effectiveDate,
    toEffective: after.effectiveDate,
    fields: compareFields(before, after),
    lines: diffLines(before.content ?? "", after.content ?? ""),
  };
}
