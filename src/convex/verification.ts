"use node";

/**
 * Verification Intelligence (master plan Phase 7).
 *
 * OMI must not blindly trust its own output. After an agent (or any
 * generator) produces a result, an INDEPENDENT verifier pass reviews it
 * against the concrete evidence (step outputs, tool results). The verifier:
 *
 *   • runs on a DIFFERENT prompt path than generation (separate system
 *     prompt, adversarial framing) — independence where practical
 *   • is honest when it cannot check (verdict "unverified" — never a fake ✓)
 *   • feeds bounded retry: one corrective generation attempt on "failed"
 *
 * Verdicts: pass | warnings | unverified | failed
 *   pass       — claims are supported by the recorded outputs
 *   warnings   — supported overall, but with noted gaps/assumptions
 *   unverified — no AI provider available to check (generation also would
 *                have been heuristic; result is shown, honestly labeled)
 *   failed     — material errors found; triggers one bounded correction
 */

import { complete } from "./aiProviders";

export type VerificationVerdict = "pass" | "warnings" | "unverified" | "failed";

export type VerificationResult = {
  verdict: VerificationVerdict;
  notes: string[];
  usedAi: boolean;
};

type VerifierJson = {
  verdict?: unknown;
  issues?: unknown;
};

function asStringArray(v: unknown, max = 5): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim().slice(0, 300))
    .slice(0, max);
}

const VERIFIER_SYSTEM = `You are Omi's Verification Agent — an independent checker inside Ominnovations Intelligence. You did NOT write the result you are reviewing; your job is to find faults, not to be agreeable.

You receive: an objective, the result produced for it, and the concrete evidence (step outputs and tool results) recorded during the work.

Check:
1. CONTRADICTIONS — does the result state anything the evidence does not support or directly contradicts?
2. COMPLETENESS — does it answer the objective, or dodge part of it?
3. FABRICATION — invented specifics (numbers, names, dates, sources) not present in the evidence?
4. HALLUCINATED CONFIDENCE — unverifiable claims stated as certainties?

Respond with ONLY minified JSON:
{"verdict":"pass|warnings|failed","issues":[...]}
- "pass": everything material is supported; issues may be empty
- "warnings": broadly supported but with gaps or over-claims listed in issues
- "failed": material contradiction or fabrication — describe it in issues
Never invent evidence you were not given. If the evidence is too thin to check anything, return "warnings" with an issue saying so.`;

/**
 * Verify a produced result against the evidence trail. Never throws; when
 * no AI provider is reachable the verdict is honest "unverified".
 */
export async function verifyResult(
  objective: string,
  result: string,
  evidence: string[],
): Promise<VerificationResult> {
  if (result.trim().length === 0) {
    return { verdict: "failed", notes: ["Empty result cannot be verified."], usedAi: false };
  }

  const evidenceBlock =
    evidence.length > 0
      ? evidence.map((e, i) => `--- Evidence ${i + 1} ---\n${e.slice(0, 800)}`).join("\n\n")
      : "(no step outputs or tool results were recorded)";

  try {
    const completion = await complete({
      task: "reasoning",
      messages: [
        { role: "system", content: VERIFIER_SYSTEM },
        {
          role: "user",
          content: `Objective: ${objective.slice(0, 600)}\n\nResult to verify:\n${result.slice(0, 2400)}\n\nEvidence:\n${evidenceBlock.slice(0, 6000)}`,
        },
      ],
      temperature: 0.1,
      maxTokens: 500,
    });

    if (!completion.ok) {
      return { verdict: "unverified", notes: [], usedAi: false };
    }

    const raw = completion.content;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return { verdict: "unverified", notes: [], usedAi: false };
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as VerifierJson;

    const v = parsed.verdict;
    let verdict: VerificationVerdict;
    if (v === "pass" || v === "warnings" || v === "failed") {
      verdict = v;
    } else {
      verdict = "warnings";
    }

    return { verdict, notes: asStringArray(parsed.issues), usedAi: true };
  } catch {
    return { verdict: "unverified", notes: [], usedAi: false };
  }
}

/**
 * Bounded corrective retry: ask the generator to fix the specific issues,
 * once. Returns the corrected text, or null when AI is unavailable.
 */
export async function correctiveRetry(
  objective: string,
  result: string,
  issues: string[],
): Promise<string | null> {
  try {
    const completion = await complete({
      task: "reasoning",
      messages: [
        {
          role: "system",
          content:
            "You are Omi correcting a flawed result. A verifier found concrete problems. Rewrite the result fixing ONLY the listed issues — keep everything else intact, keep it grounded in the evidence already gathered, and do not add new claims. Respond with the corrected result text only, no commentary.",
        },
        {
          role: "user",
          content: `Objective: ${objective.slice(0, 600)}\n\nFlawed result:\n${result.slice(0, 2400)}\n\nVerifier issues to fix:\n${issues.map((i, n) => `${n + 1}. ${i}`).join("\n")}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 700,
    });
    return completion.ok && completion.content.trim().length > 0
      ? completion.content.trim().slice(0, 3000)
      : null;
  } catch {
    return null;
  }
}
