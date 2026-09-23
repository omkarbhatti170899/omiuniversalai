/**
 * AI provider catalog — pure metadata + env detection. No SDK imports here:
 * this module is safe to import from reactive queries (aiStatus) as well as
 * "use node" actions (the router in aiProviders/index.ts).
 *
 * Master spec §3 (provider-neutral AI): the runtime contains no
 * provider-specific business logic; providers are environment-configured
 * adapters; production reports which provider is actually active.
 * Master spec §4 (model routing): different tasks get different models —
 * the most expensive model is not assumed for every request.
 */

export type AiTask =
  | "conversational"
  | "reasoning"
  | "summarization"
  | "extraction"
  | "classification"
  | "coding"
  | "research";

export const AI_TASKS: AiTask[] = [
  "conversational",
  "reasoning",
  "summarization",
  "extraction",
  "classification",
  "coding",
  "research",
];

export type ProviderId = "vly" | "groq" | "gemini" | "openai" | "deepseek";

export type ProviderDescriptor = {
  id: ProviderId;
  label: string;
  /** Every env var here must be set for the provider to activate. */
  envKeys: string[];
  /** Honest cost labeling (master spec: "free tier" ≠ unlimited free). */
  cost: string;
  /** Task → model name. Each provider maps tasks to its own catalog. */
  taskModels: Record<AiTask, string>;
  /** Tried in order when the task model is rejected (retired/renamed). */
  fallbackModels: string[];
  /** Setup hint shown when the provider is not configured. */
  hint: string;
};

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
/** Google's OpenAI-compatible surface — same protocol, separate free quota. */
export const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/**
 * Registered providers in priority order:
 *   1. Groq free tier (zero cost, rate-limited) — PRIMARY
 *   2. Gemini free tier (independent quota, OpenAI-compatible endpoint) — SECONDARY
 *   3. OpenAI (optional metered adapter — off unless a key exists)
 *   4. DeepSeek (optional adapter — off unless a key exists)
 *
 * The workspace gateway ("vly") was REMOVED from the registry outright: its
 * platform-injected key is rejected by the gateway itself, so every AI request
 * paid a guaranteed-failed round-trip before reaching a working provider
 * (verified live — /selftest reported "after 1 fallback attempt(s)" on every
 * AI check; after removal: zero fallback attempts). The adapter in index.ts
 * is kept so re-registration is a one-object change if the gateway is ever
 * fixed. Unrelated providers can also be disabled per-deployment without a
 * code change via OMI_DISABLE_PROVIDERS (comma list of IDs).
 *
 * To add a provider (e.g. a self-hosted Ollama/vLLM endpoint later), add a
 * descriptor here plus an adapter in index.ts. No call site changes.
 */
export const AI_PROVIDERS: ProviderDescriptor[] = [
  {
    id: "groq",
    label: "Groq (free tier)",
    envKeys: ["GROQ_API_KEY"],
    cost: "free tier, rate-limited",
    taskModels: {
      conversational: "openai/gpt-oss-20b",
      reasoning: "openai/gpt-oss-120b",
      summarization: "openai/gpt-oss-20b",
      extraction: "openai/gpt-oss-20b",
      classification: "openai/gpt-oss-20b",
      coding: "openai/gpt-oss-120b",
      research: "openai/gpt-oss-120b",
    },
    // Groq retires models on its own schedule. The previous entries here were
    // llama-3.3-70b-versatile and llama-3.1-8b-instant — both shut down on
    // 2026-08-16, so this list had become guaranteed-404 dead weight and gave
    // no fallback at all. These are the live models Groq's deprecation page
    // names as replacements, and modelDiscovery.ts verifies them against the
    // provider's own /models list before use, so the next retirement is
    // detected rather than fatal.
    fallbackModels: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
    hint: "Add a free GROQ_API_KEY (console.groq.com → API Keys) in the project's API Keys tab.",
  },
  {
    id: "gemini",
    label: "Google Gemini (free tier)",
    envKeys: ["GEMINI_API_KEY"],
    // Independent quota: a separate company and rate budget from Groq, which
    // is the whole point of this slot — one provider's 429 no longer means
    // every capability stalls.
    cost: "free tier, rate-limited",
    // The `-latest` aliases are deliberate. gemini-2.5-flash and
    // gemini-2.5-flash-lite are still LISTED by the API but answer 404 "no
    // longer available to new users" — probed live on 2026-09-23, and the
    // reason the forced-fallback self-test exists (a listing is a superset of
    // what an account may call). gemini-3.8-flash and gemini-flash-lite-latest
    // both answered 200 in the same probe.
    taskModels: {
      conversational: "gemini-flash-latest",
      reasoning: "gemini-flash-latest",
      summarization: "gemini-flash-latest",
      extraction: "gemini-flash-latest",
      classification: "gemini-flash-lite-latest",
      coding: "gemini-3.8-flash",
      research: "gemini-3.8-flash",
    },
    // Verified against the provider's own /models list before use
    // (modelDiscovery.ts), so a retired entry costs zero round-trips.
    fallbackModels: ["gemini-3.8-flash", "gemini-flash-lite-latest"],
    hint: "Add a free GEMINI_API_KEY (aistudio.google.com → Get API key) in the project's API Keys tab.",
  },
  {
    id: "openai",
    label: "OpenAI",
    envKeys: ["OPENAI_API_KEY"],
    cost: "metered (optional adapter)",
    taskModels: {
      conversational: "gpt-4o-mini",
      reasoning: "gpt-4o",
      summarization: "gpt-4o-mini",
      extraction: "gpt-4o-mini",
      classification: "gpt-4o-mini",
      coding: "gpt-4o",
      research: "gpt-4o",
    },
    fallbackModels: ["gpt-4o-mini"],
    hint: "Optional paid adapter — add OPENAI_API_KEY only if you want it.",
  },
  {
    id: "deepseek",
    label: "DeepSeek (free tier, optional adapter)",
    envKeys: ["DEEPSEEK_API_KEY"],
    cost: "free tier, rate-limited (optional adapter)",
    taskModels: {
      conversational: "deepseek-chat",
      reasoning: "deepseek-reasoner",
      summarization: "deepseek-chat",
      extraction: "deepseek-chat",
      classification: "deepseek-chat",
      coding: "deepseek-chat",
      research: "deepseek-reasoner",
    },
    fallbackModels: ["deepseek-chat"],
    hint: "Add a free DEEPSEEK_API_KEY only if you want this adapter — Omi works fully without it.",
  },
];

/**
 * Deployment-level kill switch for providers, e.g. OMI_DISABLE_PROVIDERS=vly.
 * Comma/space separated IDs. Server-side env only — never sent to a client.
 *
 * This is how the rejected workspace gateway left the routing chain: the
 * platform injects VLY_INTEGRATION_KEY automatically (it cannot be deleted
 * from the deployment), so the disable list is the supported way to keep the
 * gateway registered-but-unrouted.
 */
export function isProviderDisabled(id: string): boolean {
  const raw = (process.env.OMI_DISABLE_PROVIDERS ?? "").trim().toLowerCase();
  if (raw.length === 0) return false;
  return raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .includes(id.toLowerCase());
}

export function providerConfigured(p: ProviderDescriptor): boolean {
  return p.envKeys.every((k) => Boolean(process.env[k]));
}

/** Configured = key present AND not explicitly disabled. Drives routing. */
export function getConfiguredAiProviders(): ProviderDescriptor[] {
  return AI_PROVIDERS.filter(
    (p) => providerConfigured(p) && !isProviderDisabled(p.id),
  );
}

export function hasAiProvider(): boolean {
  return getConfiguredAiProviders().length > 0;
}

export function activeAiProvider(): ProviderDescriptor | null {
  return getConfiguredAiProviders()[0] ?? null;
}

/**
 * Status for the UI (spec §3: "production must clearly report which provider
 * is actually active") — active provider plus the per-task model routing map.
 */
export function getAiStatus() {
  const providers = AI_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    configured: providerConfigured(p),
    disabled: isProviderDisabled(p.id),
    cost: p.cost,
    taskModels: p.taskModels,
    hint: p.hint,
  }));
  const active = activeAiProvider();
  const taskRouting = active
    ? (Object.fromEntries(
        AI_TASKS.map((t) => [t, active.taskModels[t]]),
      ) as Record<AiTask, string>)
    : null;
  return {
    activeProvider: active ? active.id : null,
    activeLabel: active ? active.label : null,
    taskRouting,
    providers,
  };
}
