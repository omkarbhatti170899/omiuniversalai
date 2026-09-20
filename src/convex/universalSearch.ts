"use node";

/**
 * Universal search core shared by every Omi feature that needs live web
 * knowledge. Multi-engine fan-out with dedupe and domain diversity, plus an
 * extractive fallback brief so Omi can still give a useful source-grounded
 * summary when the AI gateway is unavailable.
 */

import type { WebCitation } from "./searchProviders";
import { getConfiguredProviders } from "./searchProviders";
import { vly } from "../lib/vly-integrations";

export type UniversalResult = {
  query: string;
  citations: WebCitation[];
  engine: string;
  brief: string | null;
};

const PER_ENGINE_LIMIT = 4;
const MAX_CITATIONS = 6;

/**
 * Fans out across every configured engine, merges results with dedupe and
 * domain diversity, and produces either an AI-synthesized brief (preferred)
 * or an extractive brief from the sources themselves.
 */
export async function runUniversalSearch(
  query: string,
  opts?: { perEngineLimit?: number; maxCitations?: number },
): Promise<UniversalResult> {
  const perEngine = opts?.perEngineLimit ?? PER_ENGINE_LIMIT;
  const maxCitations = opts?.maxCitations ?? MAX_CITATIONS;

  const providers = getConfiguredProviders();
  if (providers.length === 0) {
    throw new Error("No search engines are available right now.");
  }

  // Multi-engine fan-out: run every configured engine in parallel, but
  // never let a failing engine break the search.
  const settled = await Promise.allSettled(
    providers.map(async (p) => ({
      engine: p,
      result: await p.search(query, perEngine),
    })),
  );

  const merged: Array<{ c: WebCitation; engine: string }> = [];
  const seenUrls = new Set<string>();
  const enginesUsed: string[] = [];
  const failures: string[] = [];

  for (const s of settled) {
    if (s.status === "rejected") {
      failures.push(
        `${s.reason instanceof Error ? s.reason.message : "engine failed"}`,
      );
      continue;
    }
    const { engine, result } = s.value;
    enginesUsed.push(engine.label);
    for (const c of result.citations) {
      const url = normalizeUrl(c.url);
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      merged.push({ c, engine: engine.label });
    }
    // Leave merged order as-is; domain diversity is applied at selection.
  }

  if (merged.length === 0) {
    throw new Error(
      `All search engines failed for this query. ${failures
        .join(" | ")
        .slice(0, 260)}`,
    );
  }

  // Domain diversity: pick at most 2 citations per domain, preserving
  // engine order so the highest-priority engine's results lead.
  const perDomain = new Map<string, number>();
  const diverse: Array<{ c: WebCitation; engine: string }> = [];
  for (const item of merged) {
    const domain = domainOf(item.c.url);
    const count = perDomain.get(domain) ?? 0;
    if (count >= 2) continue;
    perDomain.set(domain, count + 1);
    diverse.push(item);
    if (diverse.length >= maxCitations) break;
  }

  const citations = diverse.map((d) => d.c);
  const engine =
    enginesUsed.length > 0
      ? enginesUsed.slice(0, 2).join(" + ")
      : "Omi keyless engine";

  // Preferred path: AI-synthesized brief. Falls back to an extractive brief
  // so the answer is still useful when the AI gateway is unavailable.
  const brief =
    (await synthesizeBrief(query, citations)) ?? extractiveBrief(query, citations);

  return {
    query,
    citations,
    engine,
    brief,
  };
}

async function synthesizeBrief(
  query: string,
  citations: WebCitation[],
): Promise<string | null> {
  try {
    const sourcesBlock = citations
      .map(
        (c, i) =>
          `[${i + 1}] ${c.title}\nURL: ${c.url}\nEXCERPT: ${c.snippet ?? ""}`,
      )
      .join("\n\n");

    const completion = await vly.ai.completion({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Omi, the Universal AI inside Ominnovations Intelligence. You just received live web search results. Write a clear, direct answer to the user's question grounded ONLY in the provided excerpts. Cite sources inline using [1], [2] etc. matching the numbered sources. Keep it under 250 words. No preamble, no markdown headings.",
        },
        {
          role: "user",
          content: `Question: ${query}\n\nSources:\n${sourcesBlock}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 500,
    });

    if (!completion.success || !completion.data) return null;
    const content = completion.data.choices?.[0]?.message?.content ?? "";
    return content.trim().length > 0 ? content.trim() : null;
  } catch {
    return null;
  }
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "how", "in", "is", "it", "its", "of", "on", "or", "that", "the", "to", "was",
  "what", "when", "where", "which", "who", "why", "will", "with", "do", "does",
  "did", "can", "could", "should", "would", "me", "my", "your", "you", "i",
]);

/**
 * Relevance-ranked extractive answer: instead of dumping raw citations, pick
 * the sentences from source snippets that best match the question's keywords
 * and compose them into a readable, cited answer. This gives genuinely useful
 * answers even with zero AI providers available.
 */
export function extractiveBrief(query: string, citations: WebCitation[]): string {
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  type Scored = { text: string; idx: number; score: number };
  const sentences: Scored[] = [];

  citations.forEach((c, idx) => {
    if (!c.snippet) return;
    const parts = c.snippet
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 40 && s.length < 400);
    for (const s of parts) {
      const lower = s.toLowerCase();
      let score = 0;
      for (const k of keywords) {
        if (lower.includes(k)) score += 2;
      }
      // Light boost for definitional patterns that usually answer "what is X".
      if (/\b(is|are|means|refers to|defined as)\b/i.test(s)) score += 1;
      if (score > 0) sentences.push({ text: s, idx: idx + 1, score });
    }
  });

  sentences.sort((a, b) => b.score - a.score);

  // Top unique sentences (dedupe near-identical text), max 4, from >=2 sources when possible.
  const picked: Scored[] = [];
  const seenTexts: string[] = [];
  for (const s of sentences) {
    const norm = s.text.toLowerCase().slice(0, 60);
    if (seenTexts.some((t) => t === norm)) continue;
    seenTexts.push(norm);
    picked.push(s);
    if (picked.length >= 4) break;
  }

  if (picked.length === 0) {
    // Nothing scored — fall back to a clean source list.
    const lines = citations
      .map(
        (c, i) =>
          `[${i + 1}] ${c.title}${c.snippet ? ` — ${c.snippet.slice(0, 180)}` : ""}`,
      )
      .join("\n");
    return (
      "Here is what Omi found across the live web for your question:\n\n" +
      lines
    );
  }

  const body = picked
    .map((s) => `${s.text} [${s.idx}]`)
    .join("\n\n");
  const sourceLine = citations
    .slice(0, 4)
    .map((c, i) => `[${i + 1}] ${c.title} (${domainOf(c.url)})`)
    .join(" ");

  return `${body}\n\nSources: ${sourceLine}`;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()];
    for (const k of params) {
      if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
    }
    return (
      u.origin +
      u.pathname.replace(/\/+$/, "") +
      (u.searchParams.toString() ? `?${u.searchParams.toString()}` : "")
    );
  } catch {
    return url;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}
