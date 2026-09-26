/**
 * Omi Knowledge Intelligence — governance rules (pure).
 *
 * The single rule this module protects: only APPROVED/PUBLISHED knowledge is
 * ever treated as authoritative, and nothing moves between lifecycle states
 * along a path the workflow does not allow. An AI draft can never silently
 * become trusted knowledge — publishing requires a prior approval.
 *
 * Pure (no Convex, no I/O) so the whole lifecycle is unit-tested rather than
 * enforced ad hoc in each mutation.
 */

export type KnowledgeStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "published"
  | "expired"
  | "archived";

export const KNOWLEDGE_STATUSES: KnowledgeStatus[] = [
  "draft",
  "in_review",
  "approved",
  "published",
  "expired",
  "archived",
];

/** Allowed lifecycle transitions. Anything else is rejected. */
const TRANSITIONS: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  draft: ["in_review", "archived"],
  in_review: ["draft", "approved", "archived"],
  approved: ["published", "in_review", "archived"],
  // A published article is re-opened into review for the NEXT version, or
  // retired. It is never edited into a different version in place.
  published: ["expired", "archived", "in_review"],
  expired: ["archived", "in_review"],
  archived: ["draft"],
};

export function canTransition(
  from: KnowledgeStatus,
  to: KnowledgeStatus,
): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Only approved/published knowledge is trusted as evidence. */
export function isAuthoritative(status: KnowledgeStatus): boolean {
  return status === "approved" || status === "published";
}

/**
 * Publishing is gated: it must come from `approved`. This is what stops a
 * draft (or an AI-proposed change) from becoming authoritative without a
 * human approval step.
 */
export function canPublish(from: KnowledgeStatus): boolean {
  return from === "approved";
}

/** A new version number when a family's next draft is published. */
export function nextVersion(currentVersion: number): number {
  return Math.max(1, Math.floor(currentVersion) + 1);
}

// --- Roles ------------------------------------------------------------------

export const KNOWLEDGE_ROLES = [
  "agent",
  "supervisor",
  "admin",
  "knowledge_manager",
] as const;
export type KnowledgeRole = (typeof KNOWLEDGE_ROLES)[number];

/**
 * Map the auth role on `users` to the knowledge roles a viewer holds. Admin
 * holds every role; member is a supervisor; the default user is an agent.
 */
export function rolesForUser(userRole?: string): KnowledgeRole[] {
  switch (userRole) {
    case "admin":
      return ["agent", "supervisor", "admin", "knowledge_manager"];
    case "member":
      return ["agent", "supervisor"];
    case "user":
      return ["agent"];
    default:
      return ["agent"];
  }
}

/** Who may approve/publish/archive — knowledge managers and admins. */
export function canManageKnowledge(roles: KnowledgeRole[]): boolean {
  return roles.includes("knowledge_manager") || roles.includes("admin");
}

/** Fields a revision records when they change. */
export const TRACKED_FIELDS = [
  "title",
  "content",
  "category",
  "tags",
  "product",
  "department",
  "region",
  "owner",
  "status",
  "version",
  "effectiveDate",
  "reviewDate",
  "expirationDate",
  "audience",
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

/** Which tracked fields differ between two article snapshots (pure). */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): TrackedField[] {
  return TRACKED_FIELDS.filter((f) => {
    const a = before[f];
    const b = after[f];
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length !== b.length || a.some((x, i) => x !== b[i]);
    }
    return a !== b;
  });
}
