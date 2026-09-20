// TEMPORARY PROBE — deleted right after the check.
// If the Convex data model is healthy, Doc<"users"> is a real object type and
// assigning it to `string` is an error (TS2322). If the model collapsed to
// `any`, this file compiles silently.
import type { Doc } from "./_generated/dataModel";

export const probeCheck: string = {} as Doc<"users">;
