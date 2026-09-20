"use node";

/**
 * Evidence store + Omi Research Agent (spec §13/§22, master spec §E).
 *
 * Citation integrity is enforced structurally here:
 *   • The synthesis model receives ONLY evidence blocks built from citations
 *     actually returned by the engines (never its own imagination).
 *   • It must cite with [n] markers; post-synthesis verification strips any
 *     [n] that doesn't map to real evidence and reports the verified ratio.
 *   • Conflicts and unverified points are reported, never smoothed over.
 *   • No usable evidence + no AI → caller falls back to the extractive floor.
 */

import type { WebCitation } from "../searchProviders/types";
import { domainOf, sourceTier, type SourceTier } from "./quality";
import { sanitizeUntrustedText } from "./security";
import { complete } from "../aiProviders";

export type EvidenceItem = {
  idx: number; // citation number shown to the user
  url: string;
  title: string;
  domain: string;
  tier: SourceTier;
  excerpt: string; // exactly the text handed to the model
  publishedAt?: string;
};

export type EvidencePack = {
  items: EvidenceItem[];
  block: string; // numbered evidence block for the model prompt
};

/**
 * Build traceable evidence blocks from real citations. Optional retrieved
 * page texts (from the page retriever) deepen the excerpt per source.
 */
export function buildEvidencePack(
  citations: WebCitation[],
  opts?: { perSourceChars?: number; maxSources?: number; pageTexts?: Map<string, string> },
): EvidencePack {
  const perSource = opts?.perSourceChars ?? 700;
  const maxSources = opts?.maxSources ?? 8;
  const pageTexts = opts?.pageTexts;

  const items: EvidenceItem[] = [];
  for (const c of citations.slice(0, maxSources)) {
    const pageText = pageTexts?.get(c.url);
    // Phase 12: snippets/page text are untrusted — sanitized before prompt use.
    const excerpt = sanitizeUntrustedText(
      (pageText ?? c.snippet ?? "").replace(/\s+/g, " ").trim(),
      perSource,
    );
    if (!excerpt && !c.title) continue;
    items.push({
      idx: items.length + 1,
      url: c.url,
      title: c.title || c.url,
      domain: domainOf(c.url),
      tier: sourceTier(c.url).tier,
      excerpt,
      publishedAt: c.publishedAt,
    });
  }

  const block = items
    .map((e) => {
      const date = e.publishedAt ? `\nPUBLISHED: ${e.publishedAt}` : "";
      return `[${e.idx}] ${e.title}\nDOMAIN: ${e.domain} (tier: ${e.tier})${date}\nEXCERPT: ${e.excerpt}`;
    })
    .join("\n\n");

  return { items, block };
}

export type ResearchAnswer = {
  answer: string;
  summary: string;
  findings: string[];
  conflicts: string[];
  unverified: string[];
  /** Fraction of [n] markers in the answer that mapped to real evidence (0..1). */
  verifiedRatio: number;
  usedAi: boolean;
};

/** Tolerant JSON extraction — models sometimes wrap JSON in prose/fences. */
function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asStringArray(v: unknown, max = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim().slice(0, 400))
    .slice(0, max);
}

/**
 * Strip citation markers that do NOT map to real evidence (citation
 * integrity). Returns the cleaned answer and the verified ratio.
 */
export function enforceCitationIntegrity(
  answer: string,
  evidenceCount: number,
): { answer: string; verifiedRatio: number } {
  if (evidenceCount === 0) {
    return { answer: answer.replace(/\s*\[\d+\]/g, ""), verifiedRatio: 0 };
  }
  let valid = 0;
  let invalid = 0;
  const cleaned = answer.replace(/\[(\d{1,2})\]/g, (match, numStr) => {
    const n = Number(numStr);
    if (n >= 1 && n <= evidenceCount) {
      valid += 1;
      return match; // keep real citations
    }
    invalid += 1;
    return ""; // strip fabricated markers
  });
  const total = valid + invalid;
  return {
    answer: cleaned.replace(/[ \t]{2,}/g, " ").trim(),
    verifiedRatio: total === 0 ? 1 : valid / total,
  };
}

/**
 * Omi Research Agent: synthesize a grounded answer from the evidence pack.
 * Returns null when the AI layer is unavailable — callers fall back to the
 * extractive floor. The model is instructed to report conflicts and mark
 * unverifiable points rather than invent content.
 */
export async function synthesizeResearchAnswer(
  query: string,
  pack: EvidencePack,
): Promise<ResearchAnswer | null> {
  if (pack.items.length === 0) return null;
  try {
    // Routed as a research task — synthesis across many sources wants the
    // strongest available model (master spec §4).
    const completion = await complete({
      task: "research",
      messages: [
        {
          role: "system",
          content:
            "You are Omi's Research Agent inside Ominnovations Intelligence. You answer STRICTLY from the numbered evidence blocks provided. " +
            "Rules: (1) Cite every factual claim inline with [n] matching the evidence numbers. (2) NEVER invent facts, numbers, or citations. " +
            "(3) If sources disagree, list the disagreement in 'conflicts' — never silently pick one. (4) If the evidence doesn't cover part of the question, say so in 'unverified'. " +
            "(5) In 'answer', prefix each claim class honestly: verified facts plain, source-reported claims as 'X reports that...', your own synthesis as 'Omi synthesis:'. " +
            "Respond with ONLY minified JSON: {\"answer\": string, \"summary\": string, \"findings\": string[], \"conflicts\": string[], \"unverified\": string[]}. " +
            "answer <= 280 words, summary <= 60 words, findings <= 6 items.",
        },
        {
          role: "user",
          content: `Question: ${query}\n\nEvidence blocks:\n${pack.block}\n\nReturn the JSON object now.`,
        },
      ],
      temperature: 0.2,
      maxTokens: 900,
    });

    if (!completion.ok) return null;
    const raw = completion.content;
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed.answer !== "string" || parsed.answer.trim().length === 0) {
      return null;
    }

    const { answer, verifiedRatio } = enforceCitationIntegrity(
      parsed.answer,
      pack.items.length,
    );

    return {
      answer,
      summary:
        typeof parsed.summary === "string" ? parsed.summary.slice(0, 400) : "",
      findings: asStringArray(parsed.findings),
      conflicts: asStringArray(parsed.conflicts),
      unverified: asStringArray(parsed.unverified),
      verifiedRatio,
      usedAi: true,
    };
  } catch {
    return null;
  }
}

/** Freshness footer per source — "Published / Retrieved" (spec §14). */
export function sourcesFooter(
  pack: EvidencePack,
  retrievedAt: number = Date.now(),
): string {
  const retrieved = new Date(retrievedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return pack.items
    .map((e) => {
      const pub = e.publishedAt ? ` · published ${e.publishedAt.slice(0, 10)}` : "";
      return `[${e.idx}] ${e.title} — ${e.domain} (${e.tier})${pub} · retrieved ${retrieved}`;
    })
    .join("\n");
}
