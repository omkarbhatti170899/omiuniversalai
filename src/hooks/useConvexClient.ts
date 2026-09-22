import { useConvex } from "convex/react";

/**
 * Typed accessor for the raw Convex client. Needed when a plain helper
 * (not a hook) must issue mutations/actions — e.g. the attachment uploader,
 * which runs inside async loops and can't call useMutation per file.
 */
export function useConvexClient() {
  return useConvex();
}
