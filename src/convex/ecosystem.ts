/**
 * Ecosystem status registry (master plan §15–23, §31/§32).
 *
 * PURE module (no Convex, no fetch) — the one honest source of truth for
 * "which technologies from the major ecosystems does Omi actually use, under
 * what license, at what cost?" The Settings UI renders it; a test pins the
 * zero-cost invariant.
 *
 * Classification is deliberately strict (§2):
 *   active        — free/open + keyless + $0, running in Omi TODAY
 *   optional      — free or free-tier, $0 by default, OFF unless a key exists
 *   not-approved  — cannot be included: license, cost, or platform constraint
 *
 * A "not-approved" entry is NOT a promise to add later — several are
 * permanently excluded by license or cost, and the registry says so plainly
 * (§32: if unsuitable, do not add it to the core).
 */

export type EcosystemStatus = "active" | "optional" | "not-approved";

export type EcosystemEntry = {
  ecosystem: string;
  tech: string;
  /** What Omi actually does with it (active) or would do (optional). */
  role: string;
  status: EcosystemStatus;
  license: string;
  cost: string;
  /** Why not-approved — required for that status (§32). */
  reason?: string;
};

export const ECOSYSTEM_ENTRIES: EcosystemEntry[] = [
  // --- Google / Alphabet ------------------------------------------------------
  {
    ecosystem: "Google / Alphabet",
    tech: "Chromium (engine basis)",
    role: "Browser-runtime standards (fetch, Web Speech, DecompressionStream) Omi builds on",
    status: "active",
    license: "BSD-style / open",
    cost: "$0",
  },
  {
    ecosystem: "Google / Alphabet",
    tech: "Wikidata (Freebase successor)",
    role: "CC0 structured knowledge graph in Andromeda",
    status: "active",
    license: "CC0",
    cost: "$0 per query",
  },
  {
    ecosystem: "Google / Alphabet",
    tech: "TensorFlow / MediaPipe / Bazel",
    role: "Native ML runtimes — need local hardware this platform doesn't host",
    status: "not-approved",
    license: "Apache-2.0 (open)",
    cost: "self-hosted compute",
    reason:
      "License-safe but requires self-hosted GPU/CPU infrastructure this platform doesn't provide; nothing mandatory may depend on it (§2/§6).",
  },
  {
    ecosystem: "Google / Alphabet",
    tech: "Google Cloud / Maps / Search APIs",
    role: "—",
    status: "not-approved",
    license: "proprietary ToS",
    cost: "metered",
    reason: "Metered APIs with free tiers are not genuinely free (§2).",
  },

  // --- Meta --------------------------------------------------------------------
  {
    ecosystem: "Meta",
    tech: "React",
    role: "The entire Omi frontend",
    status: "active",
    license: "MIT",
    cost: "$0",
  },
  {
    ecosystem: "Meta",
    tech: "BM25 ranking (Lucene-family algorithm)",
    role: "Knowledge retrieval ranking engine",
    status: "active",
    license: "algorithm (unpatented implementation)",
    cost: "$0",
  },
  {
    ecosystem: "Meta",
    tech: "FAISS",
    role: "Vector similarity search",
    status: "not-approved",
    license: "MIT (open)",
    cost: "self-hosted compute",
    reason:
      "MIT is fine, but needs self-hosted infrastructure; Omi ships the honest in-platform equivalent (BM25 retriever + provider-neutral seam).",
  },
  {
    ecosystem: "Meta",
    tech: "Llama models / SAM / Llama Guard",
    role: "Model weights with community-license conditions",
    status: "not-approved",
    license: "Llama Community License (restrictive)",
    cost: "self-hosted compute",
    reason:
      "Community license imposes use restrictions and compute is self-hosted only (§32). Re-evaluate only with a verified terms change.",
  },

  // --- OpenAI ------------------------------------------------------------------
  {
    ecosystem: "OpenAI",
    tech: "GPT-OSS (via Groq free tier)",
    role: "Reasoning/coding models serving Omi chat and agents",
    status: "active",
    license: "Apache-2.0",
    cost: "$0 (Groq free tier)",
  },
  {
    ecosystem: "OpenAI",
    tech: "tiktoken-style token budgeting",
    role: "Context/prompt budget discipline in evidence packs and prompts",
    status: "active",
    license: "practice (char/word budgets)",
    cost: "$0",
  },
  {
    ecosystem: "OpenAI",
    tech: "Whisper",
    role: "Speech-to-text",
    status: "not-approved",
    license: "MIT (open)",
    cost: "self-hosted compute",
    reason:
      "License-safe; needs self-hosted GPU. Browser Web Speech (on-device) covers STT/TTS at $0 instead.",
  },
  {
    ecosystem: "OpenAI",
    tech: "OpenAI API (GPT-4o etc.)",
    role: "Optional premium adapter",
    status: "optional",
    license: "proprietary ToS",
    cost: "metered — disabled unless a key is added",
  },

  // --- NVIDIA ------------------------------------------------------------------
  {
    ecosystem: "NVIDIA",
    tech: "CUDA-class acceleration (concept)",
    role: "Optional acceleration path",
    status: "not-approved",
    license: "SDK license (proprietary)",
    cost: "self-hosted GPUs",
    reason: "No NVIDIA hardware on this platform; nothing mandatory may depend on it.",
  },

  // --- Apple ---------------------------------------------------------------------
  {
    ecosystem: "Apple",
    tech: "WebKit / Web Speech (Safari engine)",
    role: "On-device mic input and speech output in Omi",
    status: "active",
    license: "browser standard",
    cost: "$0",
  },
  {
    ecosystem: "Apple",
    tech: "MLX",
    role: "Apple-Silicon local inference",
    status: "not-approved",
    license: "MIT (open)",
    cost: "self-hosted Apple hardware",
    reason: "No Apple Silicon on this platform (§2/§6).",
  },

  // --- Amazon / AWS ---------------------------------------------------------------
  {
    ecosystem: "Amazon / AWS",
    tech: "Common Crawl (AWS open data)",
    role: "Open web index metadata for provenance/diversity in Andromeda",
    status: "active",
    license: "open data",
    cost: "$0 per query",
  },
  {
    ecosystem: "Amazon / AWS",
    tech: "OpenSearch",
    role: "Self-hosted full-text/KNN index layer",
    status: "not-approved",
    license: "Apache-2.0 (open)",
    cost: "self-hosted infrastructure",
    reason:
      "Apache-2.0 is fine; infrastructure isn't available here. BM25 + retriever seam is the in-platform equivalent.",
  },
  {
    ecosystem: "Amazon / AWS",
    tech: "Firecracker",
    role: "MicroVM sandboxing for untrusted code",
    status: "not-approved",
    license: "Apache-2.0 (open)",
    cost: "self-hosted infrastructure",
    reason:
      "Needs bare-metal/nested virtualization this platform doesn't expose — which is why no untrusted-code tool exists (§27).",
  },
  {
    ecosystem: "Amazon / AWS",
    tech: "AWS hosting / Bedrock",
    role: "—",
    status: "not-approved",
    license: "proprietary ToS",
    cost: "metered",
    reason: "Paid cloud dependency (§2).",
  },

  // --- Microsoft -------------------------------------------------------------------
  {
    ecosystem: "Microsoft",
    tech: "TypeScript",
    role: "All Omi application code",
    status: "active",
    license: "Apache-2.0",
    cost: "$0",
  },
  {
    ecosystem: "Microsoft",
    tech: "Playwright (concept only)",
    role: "Browser automation",
    status: "not-approved",
    license: "MIT (open)",
    cost: "headless-browser hosting",
    reason:
      "MIT is fine; hosting a browser fleet is not, and an unguarded browser tool is a prompt-injection/SSRF surface (§28).",
  },
  {
    ecosystem: "Microsoft",
    tech: "Semantic Kernel / AutoGen / GraphRAG",
    role: "Agent orchestration frameworks",
    status: "not-approved",
    license: "MIT (open)",
    cost: "self-hosted runtime",
    reason:
      "Omi already owns its provider-neutral orchestration (OMI Core, §44); adding a second framework would duplicate the architecture it forbids.",
  },
  {
    ecosystem: "Microsoft",
    tech: "Azure",
    role: "—",
    status: "not-approved",
    license: "proprietary ToS",
    cost: "metered",
    reason: "Paid cloud dependency (§2).",
  },

  // --- Anthropic --------------------------------------------------------------------
  {
    ecosystem: "Anthropic",
    tech: "Claude API",
    role: "Optional premium adapter (not registered)",
    status: "not-approved",
    license: "proprietary ToS",
    cost: "metered",
    reason:
      "Metered API. May only become an optional adapter after explicit approval (§2/§45-8); it is not registered, so it cannot be reached.",
  },

  // --- DeepSeek ------------------------------------------------------------------------
  {
    ecosystem: "DeepSeek",
    tech: "deepseek-chat / deepseek-reasoner (adapter registered)",
    role: "Optional free-tier adapter in the AI router chain",
    status: "optional",
    license: "MIT code / model license permitting API use",
    cost: "free tier — $0 unless upgraded",
  },

  // --- Oracle -----------------------------------------------------------------------------
  {
    ecosystem: "Oracle",
    tech: "GraalVM / Helidon / OCI",
    role: "—",
    status: "not-approved",
    license: "mixed (GFTC/proprietary)",
    cost: "self-hosted or paid cloud",
    reason:
      "No JVM backend exists in Omi to benefit from it; §23 forbids rewriting the backend just to adopt Oracle technologies.",
  },

  // --- AMD -----------------------------------------------------------------------------------
  {
    ecosystem: "AMD",
    tech: "ROCm / HIP",
    role: "Optional GPU acceleration path",
    status: "not-approved",
    license: "open (MIT/Apache components)",
    cost: "self-hosted AMD GPUs",
    reason: "No AMD hardware on this platform (§2/§6).",
  },

  // --- Salesforce ------------------------------------------------------------------------------
  {
    ecosystem: "Salesforce",
    tech: "CRM APIs / Einstein",
    role: "—",
    status: "not-approved",
    license: "proprietary ToS",
    cost: "subscription",
    reason: "Subscription dependency (§2).",
  },
];

/** Grouped view for the UI. */
export function getEcosystemStatus() {
  const by = new Map<string, EcosystemEntry[]>();
  for (const e of ECOSYSTEM_ENTRIES) {
    const list = by.get(e.ecosystem) ?? [];
    list.push(e);
    by.set(e.ecosystem, list);
  }
  return [...by.entries()].map(([ecosystem, entries]) => ({
    ecosystem,
    entries,
    counts: {
      active: entries.filter((e) => e.status === "active").length,
      optional: entries.filter((e) => e.status === "optional").length,
      notApproved: entries.filter((e) => e.status === "not-approved").length,
    },
  }));
}

/** The zero-cost invariant every test and review can pin. */
export function hasMandatoryPaidDependency(): boolean {
  return ECOSYSTEM_ENTRIES.some(
    (e) => e.status === "active" && /metered|subscription|paid/i.test(e.cost),
  );
}
