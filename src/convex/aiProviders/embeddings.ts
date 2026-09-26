/**
 * Embedding transport for Omi Knowledge Intelligence (master spec §1).
 *
 * Provider-neutral, exactly like the chat router: callers ask for embeddings
 * and this module decides which CONFIGURED provider serves them. No vendor SDK
 * and no vendor model is named outside this file's provider table.
 *
 * The critical contract: this NEVER throws and NEVER fakes a vector. When no
 * embedding provider is configured — or every one fails — it returns null, and
 * knowledge retrieval falls back to BM25 keyword search. Semantic retrieval is
 * an enhancement, never a hard dependency (so Omi keeps working on a
 * free-tier-only deployment with no embedding key).
 */

import { breakerAllow, breakerRecord } from "../searchEngine/resilience";

export type EmbeddingResult = {
  provider: string;
  model: string;
  vectors: number[][];
};

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const GEMINI_EMBEDDINGS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents";

export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const GEMINI_EMBEDDING_MODEL = "text-embedding-004";

/** Providers that can embed, in preference order (free tier first). */
function embeddingProviders(): Array<{
  id: "gemini" | "openai";
  key: string;
  model: string;
}> {
  const out: Array<{ id: "gemini" | "openai"; key: string; model: string }> = [];
  const gemini = process.env.GEMINI_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  if (gemini) out.push({ id: "gemini", key: gemini, model: GEMINI_EMBEDDING_MODEL });
  if (openai) out.push({ id: "openai", key: openai, model: OPENAI_EMBEDDING_MODEL });
  return out;
}

/** True when at least one embedding provider is configured. */
export function hasEmbeddingProvider(): boolean {
  return embeddingProviders().length > 0;
}

// Embeddings are batched: one request per provider per call, capped so a
// large knowledge base cannot produce an unbounded payload.
export const MAX_EMBED_BATCH = 32;
/** Long inputs are truncated — embeddings are for topic similarity, not recall. */
const MAX_INPUT_CHARS = 6000;

function clampInput(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t;
}

async function embedWithProvider(
  provider: { id: "gemini" | "openai"; key: string; model: string },
  texts: string[],
): Promise<number[][] | null> {
  const inputs = texts.map(clampInput);
  try {
    if (provider.id === "openai") {
      const res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.key}`,
        },
        body: JSON.stringify({ model: provider.model, input: inputs }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vectors = (json.data ?? []).map((d) => d.embedding ?? []);
      return vectors.length === inputs.length && vectors.every((v) => v.length > 0)
        ? vectors
        : null;
    }

    const res = await fetch(`${GEMINI_EMBEDDINGS_URL}?key=${encodeURIComponent(provider.key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: inputs.map((text) => ({
          model: `models/${provider.model}`,
          content: { parts: [{ text }] },
        })),
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };
    const vectors = (json.embeddings ?? []).map((e) => e.values ?? []);
    return vectors.length === inputs.length && vectors.every((v) => v.length > 0)
      ? vectors
      : null;
  } catch {
    return null;
  }
}

/**
 * Embed a batch of texts. Tries each configured provider in order and returns
 * the first usable result. null means "no semantic layer right now" — callers
 * fall back to keyword retrieval and say nothing else.
 */
export async function embedTexts(texts: string[]): Promise<EmbeddingResult | null> {
  if (texts.length === 0) return null;
  const batch = texts.slice(0, MAX_EMBED_BATCH);
  for (const p of embeddingProviders()) {
    if (!breakerAllow(`embed:${p.id}`)) continue;
    const vectors = await embedWithProvider(p, batch);
    if (vectors) {
      breakerRecord(`embed:${p.id}`, true);
      return { provider: p.id, model: p.model, vectors };
    }
    breakerRecord(`embed:${p.id}`, false);
  }
  return null;
}

/** Convenience for a single query string. */
export async function embedOne(text: string): Promise<EmbeddingResult | null> {
  return embedTexts([text]);
}
