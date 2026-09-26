/**
 * Omi Knowledge Intelligence — Knowledge Critic (pure).
 *
 * The critic FLAGS problems for a human; it never publishes, merges or
 * rewrites anything. Every finding here is deterministic (dates, duplicates,
 * version state, recurring gaps) — no model call, so it cannot invent a
 * finding or quietly "fix" knowledge.
 */

import { isAuthoritative } from "./governance";
import { isEffectivelyActive, type ArticleLike } from "./select";

export type CriticCode =
  | "outdated"
  | "expiring_soon"
  | "duplicate"
  | "conflicting_versions"
  | "gap"
  | "missing_review"
  | "stale_draft";

/**
 * Finding severity. CRITICAL is reserved for states that make an ANSWER
 * unsafe right now — an authoritative article past its expiration, or a family
 * with more than one currently-effective version — because those can put an
 * obsolete or ambiguous procedure in front of a user.
 */
export type CriticSeverity = "critical" | "high" | "medium" | "low";

export type CriticFlag = {
  code: CriticCode;
  severity: CriticSeverity;
  message: string;
  articleId?: string;
  familyId?: string;
  gapKey?: string;
};

export const EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const STALE_DRAFT_MS = 60 * 24 * 60 * 60 * 1000;
export const GAP_THRESHOLD = 3;

export type GapLike = {
  key: string;
  question: string;
  count: number;
  status: string;
};

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function critiqueKnowledge(args: {
  articles: ArticleLike[];
  gaps: GapLike[];
  now: number;
  expiringWindowMs?: number;
  staleDraftMs?: number;
  gapThreshold?: number;
}): CriticFlag[] {
  const window = args.expiringWindowMs ?? EXPIRING_WINDOW_MS;
  const staleDraft = args.staleDraftMs ?? STALE_DRAFT_MS;
  const gapThreshold = args.gapThreshold ?? GAP_THRESHOLD;
  const flags: CriticFlag[] = [];
  const live = args.articles.filter((a) => a.status !== "archived");

  for (const a of live) {
    if (isAuthoritative(a.status) && a.expirationDate !== undefined) {
      if (a.expirationDate <= args.now) {
        flags.push({
          code: "outdated",
          severity: "critical",
          message: `"${a.title}" v${a.version} is past its expiration date but still marked ${a.status}.`,
          articleId: a._id,
          familyId: a.familyId,
        });
      } else if (a.expirationDate - args.now <= window) {
        flags.push({
          code: "expiring_soon",
          severity: "medium",
          message: `"${a.title}" v${a.version} expires within ${Math.round(window / 86_400_000)} days.`,
          articleId: a._id,
          familyId: a.familyId,
        });
      }
    }
    if (isAuthoritative(a.status)) {
      if (a.reviewDate === undefined) {
        flags.push({
          code: "missing_review",
          severity: "low",
          message: `"${a.title}" v${a.version} has no review date scheduled.`,
          articleId: a._id,
          familyId: a.familyId,
        });
      } else if (a.reviewDate < args.now) {
        flags.push({
          code: "missing_review",
          severity: "medium",
          message: `"${a.title}" v${a.version} is overdue for review.`,
          articleId: a._id,
          familyId: a.familyId,
        });
      }
    }
    if (a.status === "draft" || a.status === "in_review") {
      const age = a.updatedAt ?? a.createdAt;
      if (age !== undefined && args.now - age > staleDraft) {
        flags.push({
          code: "stale_draft",
          severity: "low",
          message: `"${a.title}" has been ${a.status} for over ${Math.round(staleDraft / 86_400_000)} days without progress.`,
          articleId: a._id,
          familyId: a.familyId,
        });
      }
    }
  }

  // Duplicate titles across live articles.
  const byTitle = new Map<string, ArticleLike[]>();
  for (const a of live) {
    const k = normalizeTitle(a.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), a]);
  }
  for (const [title, group] of byTitle) {
    if (group.length > 1) {
      const families = new Set(group.map((a) => a.familyId));
      if (families.size > 1) {
        flags.push({
          code: "duplicate",
          severity: "medium",
          message: `${group.length} live articles share the title "${title}".`,
        });
      }
    }
  }

  // Conflicting versions: a family whose highest-versioned live article is not
  // authoritative while a lower version is still active.
  const byFamily = new Map<string, ArticleLike[]>();
  for (const a of live) byFamily.set(a.familyId, [...(byFamily.get(a.familyId) ?? []), a]);
  for (const [, group] of byFamily) {
    const active = group.filter((a) => isEffectivelyActive(a, args.now));
    if (active.length > 1) {
      flags.push({
        code: "conflicting_versions",
        severity: "critical",
        message: `A family has ${active.length} currently-effective versions — procedures may be ambiguous.`,
        familyId: group[0].familyId,
      });
      continue;
    }
    const newest = [...group].sort((a, b) => b.version - a.version)[0];
    if (newest && !isAuthoritative(newest.status)) {
      const hasOlderActive = group.some(
        (a) => a._id !== newest._id && isEffectivelyActive(a, args.now),
      );
      if (hasOlderActive) {
        flags.push({
          code: "conflicting_versions",
          severity: "medium",
          message: `v${newest.version} of this family exists as "${newest.status}" while an older version is still effective.`,
          articleId: newest._id,
          familyId: newest.familyId,
        });
      }
    }
  }

  // Recurring knowledge gaps.
  for (const g of args.gaps) {
    if (g.status === "open" && g.count >= gapThreshold) {
      flags.push({
        code: "gap",
        severity: "medium",
        message: `${g.count} questions about "${g.question}" have no approved answer.`,
        gapKey: g.key,
      });
    }
  }

  return flags;
}

export function countBySeverity(flags: CriticFlag[]): {
  critical: number;
  high: number;
  medium: number;
  low: number;
} {
  return {
    critical: flags.filter((f) => f.severity === "critical").length,
    high: flags.filter((f) => f.severity === "high").length,
    medium: flags.filter((f) => f.severity === "medium").length,
    low: flags.filter((f) => f.severity === "low").length,
  };
}

/** Ordering for a "worst first" dashboard. */
export const SEVERITY_ORDER: CriticSeverity[] = ["critical", "high", "medium", "low"];
