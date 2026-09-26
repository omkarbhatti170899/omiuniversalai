/**
 * Omi Knowledge Intelligence — version-aware selection + visibility (pure).
 *
 * The rule that matters most (§8): when a family has v1 "Procedure A" and
 * v2 "Procedure B", and v2 is the currently-effective published version, Omi
 * must use v2 — never mix the two. `selectEffectiveVersions` is the single
 * place that decision is made, and it is unit-tested.
 */

import { isAuthoritative, type KnowledgeRole, type KnowledgeStatus } from "./governance";

export type ArticleLike = {
  _id: string;
  familyId: string;
  title: string;
  content: string;
  status: KnowledgeStatus;
  version: number;
  effectiveDate?: number;
  expirationDate?: number;
  reviewDate?: number;
  audience?: string[];
  category?: string;
  product?: string;
  department?: string;
  region?: string;
  tags?: string[];
  sourceType: "internal" | "external";
  projectId?: string;
  createdAt?: number;
  updatedAt?: number;
};

/** Authoritative AND inside its effective window at `now`. */
export function isEffectivelyActive(a: ArticleLike, now: number): boolean {
  if (!isAuthoritative(a.status)) return false;
  if (a.effectiveDate !== undefined && a.effectiveDate > now) return false;
  if (a.expirationDate !== undefined && a.expirationDate <= now) return false;
  return true;
}

/** Newer = later effectiveDate, then higher version number. */
function isNewer(a: ArticleLike, b: ArticleLike): boolean {
  const ea = a.effectiveDate ?? 0;
  const eb = b.effectiveDate ?? 0;
  if (ea !== eb) return ea > eb;
  return a.version > b.version;
}

/**
 * One live version per family: among an article's currently-effective
 * versions, the newest wins. An old version is never returned alongside the
 * new one, so procedures cannot be mixed.
 */
export function selectEffectiveVersions(
  articles: ArticleLike[],
  now: number,
): ArticleLike[] {
  const byFamily = new Map<string, ArticleLike>();
  for (const a of articles) {
    if (!isEffectivelyActive(a, now)) continue;
    const current = byFamily.get(a.familyId);
    if (!current || isNewer(a, current)) byFamily.set(a.familyId, a);
  }
  return [...byFamily.values()];
}

/** An article with no audience is visible to everyone. */
export function isVisibleTo(a: ArticleLike, roles: KnowledgeRole[]): boolean {
  if (!a.audience || a.audience.length === 0) return true;
  return a.audience.some((r) => (roles as string[]).includes(r));
}

export function filterVisible<T extends ArticleLike>(
  articles: T[],
  roles: KnowledgeRole[],
): T[] {
  return articles.filter((a) => isVisibleTo(a, roles));
}

export type MetadataFilter = {
  category?: string;
  product?: string;
  department?: string;
  region?: string;
  tag?: string;
};

function eq(a: string | undefined, b: string | undefined): boolean {
  return b === undefined || (a ?? "").toLowerCase() === b.toLowerCase();
}

export function filterByMetadata<T extends ArticleLike>(
  articles: T[],
  f: MetadataFilter,
): T[] {
  return articles.filter(
    (a) =>
      eq(a.category, f.category) &&
      eq(a.product, f.product) &&
      eq(a.department, f.department) &&
      eq(a.region, f.region) &&
      (f.tag === undefined ||
        (a.tags ?? []).some((t) => t.toLowerCase() === f.tag!.toLowerCase())),
  );
}

/**
 * True when a family has more than one currently-authored version at all
 * (regardless of effective window) — a signal worth surfacing to the critic as
 * a possible conflicting-version problem.
 */
export function familiesWithMultipleAuthored(articles: ArticleLike[]): string[] {
  const counts = new Map<string, number>();
  for (const a of articles) {
    if (a.status === "archived") continue;
    counts.set(a.familyId, (counts.get(a.familyId) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}
