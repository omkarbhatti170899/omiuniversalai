/**
 * Omi Knowledge Intelligence — organization (tenant) isolation (pure).
 *
 * §2 of the completion spec: every knowledge object belongs to an
 * organization, and a user from Organization A must never retrieve
 * Organization B's knowledge. The rule is enforced in exactly one place —
 * here — so it is unit-tested rather than re-derived (and occasionally
 * forgotten) in every query and mutation.
 *
 * A user with no membership still works: their knowledge lives in a personal
 * tenant keyed off their own id, so there is no "unscoped" state and no row
 * can ever be visible across tenants.
 */

export type TenantMembership = { tenantId: string; userId: string };

/** The implicit single-member tenant every user always has. */
export function personalTenantId(userId: string): string {
  return `personal:${userId}`;
}

/**
 * The tenant a viewer's knowledge operations are scoped to. An explicit
 * membership wins (an organization they joined); otherwise the personal
 * tenant. Never returns empty.
 */
export function resolveTenantId(
  memberships: TenantMembership[],
  userId: string,
): string {
  const joined = memberships.find((m) => m.userId === userId);
  return joined?.tenantId ?? personalTenantId(userId);
}

/**
 * True when a row's tenant matches the viewer's. An absent `tenantId` means
 * the row predates multi-tenancy, so it falls back to its owner's personal
 * tenant; a row with NEITHER field belongs to nobody and is never visible
 * (the comparison fails closed rather than defaulting to "everyone").
 */
export function isInTenant(
  row: { tenantId?: string; userId?: string },
  tenantId: string,
): boolean {
  const rowTenant = row.tenantId ?? (row.userId ? personalTenantId(row.userId) : undefined);
  return rowTenant !== undefined && rowTenant === tenantId;
}

/**
 * Hard tenant filter. Applied to EVERY knowledge read (articles, revisions,
 * gaps, feedback, logs, findings) before any other narrowing, so a prompt or a
 * crafted id can never widen the scope — the filter is not reachable from user
 * input.
 */
export function filterByTenant<T extends { tenantId?: string; userId?: string }>(
  rows: T[],
  tenantId: string,
): T[] {
  return rows.filter((r) => isInTenant(r, tenantId));
}

/**
 * Guard for a single row addressed by id (the attack surface for cross-tenant
 * access: an id that belongs to someone else must fail exactly as a missing id
 * does, leaking nothing about its existence).
 */
export function canAccess(
  row: { tenantId?: string; userId?: string } | null,
  tenantId: string,
): boolean {
  if (!row) return false;
  return isInTenant(row, tenantId);
}
