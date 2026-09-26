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

export default crons;
