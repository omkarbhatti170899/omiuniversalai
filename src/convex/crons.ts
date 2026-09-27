/**
 * Scheduled jobs.
 *
 * The only job today is the Knowledge Critic sweep (§3 of the Knowledge
 * Intelligence completion spec): a daily pass that re-runs the deterministic
 * critic across every user's knowledge and refreshes the persisted finding
 * set. It FLAGS only — it never publishes, merges, expires or rewrites an
 * article, so a human remains the only actor that can change authoritative
 * knowledge.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "knowledge critic sweep",
  { hourUTC: 3, minuteUTC: 15 },
  internal.omiKnowledgeIntelligence.sweepAllUsersInternal,
);

// Measure the general-web floor (SearXNG + DuckDuckGo) on a schedule so their
// readiness verdicts stay live without depending on a /status visit. SearXNG
// readiness is MEASURED (a configured base URL alone is never enough), so a
// self-hosted instance becomes ready within one cycle while a broken one keeps
// reporting honestly.
crons.interval(
  "general web health",
  { minutes: 5 },
  internal.omiHealth.warmWebHealth,
);

export default crons;
