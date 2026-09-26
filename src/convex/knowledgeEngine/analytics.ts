/**
 * Omi Knowledge Intelligence — analytics aggregation (pure).
 *
 * Aggregate-only: counts and rates over the article set, gaps, feedback and
 * the query log. No personal content is surfaced here — the log stores only
 * the query text needed to find documentation gaps (§17).
 */

import { KNOWLEDGE_STATUSES, type KnowledgeStatus } from "./governance";
import type { ArticleLike } from "./select";

export const ANALYTICS_EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type KnowledgeAnalytics = {
  total: number;
  byStatus: Record<KnowledgeStatus, number>;
  expiringSoon: number;
  expired: number;
  openGaps: number;
  gapQuestions: number;
  mostSearched: Array<{ query: string; count: number }>;
  failedSearches: Array<{ query: string; count: number }>;
  searchSuccessRate: number;
  noAnswerRate: number;
  avgLatencyMs: number;
  feedback: Record<string, number>;
};

function tally(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

function topN(counts: Record<string, number>, n: number) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([query, count]) => ({ query, count }));
}

export function summarizeKnowledge(args: {
  articles: ArticleLike[];
  gaps: Array<{ count: number; status: string }>;
  feedback: Array<{ verdict: string }>;
  logs: Array<{ query: string; answered: boolean; latencyMs: number }>;
  now: number;
  expiringWindowMs?: number;
}): KnowledgeAnalytics {
  const window = args.expiringWindowMs ?? ANALYTICS_EXPIRING_WINDOW_MS;
  const live = args.articles.filter((a) => a.status !== "archived");

  const byStatus = Object.fromEntries(
    KNOWLEDGE_STATUSES.map((s) => [s, args.articles.filter((a) => a.status === s).length]),
  ) as Record<KnowledgeStatus, number>;

  const expiringSoon = live.filter(
    (a) =>
      (a.status === "published" || a.status === "approved") &&
      a.expirationDate !== undefined &&
      a.expirationDate > args.now &&
      a.expirationDate - args.now <= window,
  ).length;

  const expired = args.articles.filter((a) => a.status === "expired").length;

  const openGaps = args.gaps.filter((g) => g.status === "open").length;
  const gapQuestions = args.gaps.reduce((s, g) => s + g.count, 0);

  const queryCounts = tally(args.logs.map((l) => l.query.toLowerCase().trim()));
  const failedCounts = tally(
    args.logs.filter((l) => !l.answered).map((l) => l.query.toLowerCase().trim()),
  );

  const answered = args.logs.filter((l) => l.answered).length;
  const total = args.logs.length;

  return {
    total: args.articles.length,
    byStatus,
    expiringSoon,
    expired,
    openGaps,
    gapQuestions,
    mostSearched: topN(queryCounts, 10),
    failedSearches: topN(failedCounts, 10),
    searchSuccessRate: total === 0 ? 0 : answered / total,
    noAnswerRate: total === 0 ? 0 : (total - answered) / total,
    avgLatencyMs:
      total === 0 ? 0 : Math.round(args.logs.reduce((s, l) => s + l.latencyMs, 0) / total),
    feedback: tally(args.feedback.map((f) => f.verdict)),
  };
}
