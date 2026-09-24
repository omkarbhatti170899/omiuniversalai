/**
 * Image provider router — capability-based selection, pure and testable.
 *
 * The rule this module exists to enforce (the production bug it fixes):
 *
 *   A request for EDITING must NEVER be routed to a text-to-image provider.
 *
 * Before this, an edit request could reach Pollinations/Sana, which has no
 * image input, and the user received a brand-new random image that looked
 * like a (bad) edit. The router now selects a provider ONLY when it declares
 * the exact capability and — for edit-family ops — genuinely accepts image
 * input. Fallback happens between providers of the SAME capability class and
 * never crosses from editing to generation.
 *
 * Everything here is metadata-only: no fetch, no env value read (only
 * presence), so it is safe to unit-test and to call from the status query.
 */

import {
  IMAGE_OP_META,
  IMAGE_PROVIDERS,
  providerConfigured,
  type ImageOp,
  type ImageProviderDescriptor,
} from "./imageCatalog";

/**
 * Health vocabulary. A key that EXISTS is not a key that WORKS — a configured
 * Gemini key returning 429 is `rate_limited`, not `available`.
 */
export type ProviderHealth =
  | "available"
  | "unavailable"
  | "not_configured"
  | "rate_limited"
  | "auth_error"
  | "capability_unsupported";

export type CapabilityClass = "generation" | "edit";

/** Generation-class ops never require input; every other op is edit-class. */
export function capabilityClass(op: ImageOp): CapabilityClass {
  return IMAGE_OP_META[op].needsImageInput ? "edit" : "generation";
}

/**
 * Providers eligible to serve `op`, in router priority order.
 *
 * An eligible provider: is not deployment-disabled, declares the op, is
 * configured, and — when the request carries input images — accepts image
 * input. `hasInput` is passed explicitly because a variation may arrive with
 * or without an input image.
 */
export function providersForOp(op: ImageOp, hasInput: boolean): ImageProviderDescriptor[] {
  const meta = IMAGE_OP_META[op];
  return IMAGE_PROVIDERS.filter((p) => {
    if (isDisabled(p.id)) return false;
    if (!p.ops.includes(op)) return false;
    if ((hasInput || meta.needsImageInput) && !p.supportsImageInput) return false;
    if (meta.needsMultipleInputs && !p.supportsImageInput) return false;
    if (!providerConfigured(p)) return false;
    return true;
  });
}

/**
 * Providers that declare `op` and accept input but require a credential that
 * is missing right now — used to explain WHY an edit op is unavailable
 * ("Gemini declares image editing; its key is not configured yet").
 */
export function capableButUnconfigured(op: ImageOp): ImageProviderDescriptor[] {
  const meta = IMAGE_OP_META[op];
  return IMAGE_PROVIDERS.filter(
    (p) =>
      !isDisabled(p.id) &&
      p.ops.includes(op) &&
      (p.supportsImageInput || !meta.needsImageInput) &&
      !providerConfigured(p),
  );
}

/**
 * The honest reason an operation cannot run, when no eligible provider exists.
 * Never generic: it names the capability and what is missing.
 */
export function describeUnavailable(op: ImageOp): string {
  const meta = IMAGE_OP_META[op];
  const declared = IMAGE_PROVIDERS.filter((p) => p.ops.includes(op) && !isDisabled(p.id));
  if (declared.length === 0) {
    return `${meta.capability} is not supported by any provider Omi can use right now.`;
  }
  const unconfigured = declared.filter((p) => !providerConfigured(p));
  if (unconfigured.length === declared.length) {
    const names = declared.map((p) => p.label).join(", ");
    return `${meta.capability} is currently unavailable because no configured provider supports it. Providers that do (${names}) need an API key added in the Keys tab.`;
  }
  // Declared + configured, but none accepts image input where input is needed.
  if (meta.needsImageInput) {
    return `${meta.capability} needs a provider that accepts an image input; none of the configured providers does. Add a GEMINI_API_KEY or OPENAI_API_KEY in the Keys tab.`;
  }
  return `${meta.capability} is currently unavailable — no eligible provider could be selected.`;
}

/** Deployment-level kill switch (mirrors the text-provider convention). */
function isDisabled(id: string): boolean {
  const raw = (process.env.OMI_DISABLE_PROVIDERS ?? "").trim().toLowerCase();
  if (raw.length === 0) return false;
  return raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .includes(id.toLowerCase());
}

/**
 * Classify a raw attempt failure into a health state. Pure; the mapping is
 * what makes a 429 show as `rate_limited` and a rejected key as `auth_error`
 * rather than both reading "unavailable".
 */
export function classifyFailure(raw: string | undefined): ProviderHealth {
  const text = (raw ?? "").toLowerCase();
  if (text.length === 0) return "unavailable";
  if (text.startsWith("op not supported") || text.includes("does not support")) {
    return "capability_unsupported";
  }
  if (/no credits remaining|insufficient (credits?|funds|balance)|no credit/.test(text)) {
    return "unavailable";
  }
  if (/quota|rate limit|429|too many requests|resource_exhausted|overloaded/.test(text)) {
    return "rate_limited";
  }
  if (/401|403|unauthorized|invalid api key|api key not valid|permission denied|forbidden/.test(text)) {
    return "auth_error";
  }
  if (/timed out|timeout|aborted|deadline exceeded/.test(text)) {
    return "unavailable";
  }
  return "unavailable";
}

/**
 * The overall health of an operation given every attempt made this run.
 * If at least one provider was rate-limited and the rest unsupported, the
 * honest summary is `rate_limited` — the capability exists, the quota is
 * spent — rather than a flat "unavailable".
 */
export function overallHealth(
  attempts: Array<{ state?: ProviderHealth; error?: string }>,
): ProviderHealth {
  const states = attempts.map((a) => a.state ?? classifyFailure(a.error));
  if (states.includes("rate_limited")) return "rate_limited";
  if (states.includes("auth_error")) return "auth_error";
  if (states.length > 0 && states.every((s) => s === "capability_unsupported")) {
    return "capability_unsupported";
  }
  return states.length > 0 ? "unavailable" : "not_configured";
}

/**
 * How long a recorded attempt stays meaningful. A run from last week does not
 * describe the provider right now, and a stale "rate limited" would be just as
 * dishonest as a green check nobody verified.
 */
export const HEALTH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Is a recorded health observation still recent enough to show? (pure) */
export function isHealthFresh(
  updatedAt: number | undefined,
  now: number,
  maxAgeMs: number = HEALTH_MAX_AGE_MS,
): boolean {
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return false;
  const age = now - updatedAt;
  return age >= 0 && age <= maxAgeMs;
}

export type HealthTone = "ok" | "warn" | "bad" | "muted";

/**
 * The label a provider badge may honestly show, given whether a credential
 * exists and what the LAST REAL attempt did. Pure and unit-tested: this is the
 * difference between "a key is present" and "this capability works".
 *
 *  configured + available            → verified working   (ok)
 *  configured + rate_limited         → rate limited       (warn)
 *  configured + auth_error           → credential rejected(bad)
 *  configured + unavailable          → unavailable        (bad)
 *  configured + capability_unsupported → capability unsupported (muted)
 *  configured + no fresh observation → configured, untested (muted)
 *  no credential                     → not configured     (muted)
 */
export function providerHealthLabel(
  configured: boolean,
  health: ProviderHealth | undefined,
): { label: string; tone: HealthTone } {
  if (!configured) return { label: "not configured", tone: "muted" };
  switch (health) {
    case "available":
      return { label: "verified working", tone: "ok" };
    case "rate_limited":
      return { label: "rate limited", tone: "warn" };
    case "auth_error":
      return { label: "credential rejected", tone: "bad" };
    case "unavailable":
      return { label: "unavailable", tone: "bad" };
    case "capability_unsupported":
      return { label: "capability unsupported", tone: "muted" };
    default:
      return { label: "configured, not tested yet", tone: "muted" };
  }
}

/** One-line, user-facing summary for a failed operation. */
export function healthSentence(health: ProviderHealth, op: ImageOp): string {
  const cap = IMAGE_OP_META[op].capability;
  switch (health) {
    case "not_configured":
    case "capability_unsupported":
      return describeUnavailable(op);
    case "rate_limited":
      return `The provider for ${cap} is rate-limited or out of quota right now — retry later or enable billing for the configured key.`;
    case "auth_error":
      return `The provider for ${cap} rejected the configured credential.`;
    default:
      return `No provider could complete ${cap} right now.`;
  }
}
