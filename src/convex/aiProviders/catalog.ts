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

export type ProviderId = "vly" | "groq" | "openai" | "deepseek";

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

/**
 * Registered providers in priority order:
 *   1. VLY workspace gateway (provided with the workspace, no marginal cost)
 *   2. Groq free tier (zero cost, rate-limited)
 *   3. OpenAI (optional metered adapter — off unless a key exists)
 *
 * To add a provider (e.g. a self-hosted Ollama/vLLM endpoint later), add a
 * descriptor here plus an adapter in index.ts. No call site changes.
 */
export const AI_PROVIDERS: ProviderDescriptor[] = [
  {
    id: "vly",
    label: "Workspace gateway",
    envKeys: ["VLY_INTEGRATION_KEY"],
    cost: "included with workspace",
    taskModels: {
      conversational: "gpt-4o-mini",
      reasoning: "gpt-4o-mini",
      summarization: "gpt-4o-mini",
      extraction: "gpt-4o-mini",
      classification: "gpt-4o-mini",
      coding: "gpt-4o-mini",
      research: "gpt-4o-mini",
    },
    fallbackModels: [],
    hint: "Provided automatically with the workspace — nothing to set up.",
  },
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
    // Groq retires models periodically — gpt-oss → llama fallbacks keep the
    // provider usable even mid-transition.
    fallbackModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    hint: "Add a free GROQ_API_KEY (console.groq.com → API Keys) in the project's API Keys tab.",
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

export function providerConfigured(p: ProviderDescriptor): boolean {
  return p.envKeys.every((k) => Boolean(process.env[k]));
}

export function getConfiguredAiProviders(): ProviderDescriptor[] {
  return AI_PROVIDERS.filter(providerConfigured);
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
