import { describe, test, expect } from "bun:test";
import {
  detectAnswerShape,
  parseKnowledgeSections,
  extractCitations,
  extractSteps,
  extractChecklist,
  stageForStatus,
  isInternalKnowledge,
  CARD_SECTION_ORDER,
} from "../src/lib/answerShape";

const KNOWLEDGE_ANSWER = `DIRECT ANSWER
File the claim within 30 days of the incident.

WHAT TO DO
1. Open the claim.
2. Verify the required information and documents.
3. Document the action.

REQUIRED INFORMATION / DOCUMENTS
• You must provide the policy number.

IMPORTANT CHECKS
• Check the claimant's identity before proceeding.

EXCEPTIONS / EDGE CASES
• Catastrophe claims are exempt from the 30-day rule.

WHEN TO ESCALATE
• Escalate to a supervisor if the claim exceeds 100,000.

SOURCE ARTICLE
Claims Procedure

VERSION / EFFECTIVE DATE
v4 · effective 2026-09-01

SUPPORTING EVIDENCE
• File the claim within 30 days of the incident.`;

describe("answer-shape detection", () => {
  test("a knowledge/action-plan answer is detected as knowledge", () => {
    expect(detectAnswerShape(KNOWLEDGE_ANSWER)).toBe("knowledge");
  });

  test("prose stays plain", () => {
    expect(detectAnswerShape("Omi is Omi. It answers questions well and carefully.")).toBe("plain");
  });

  test("a numbered procedure is detected", () => {
    expect(
      detectAnswerShape("Here is how:\n1. Open the tool\n2. Run the check\n3. Save the result"),
    ).toBe("procedure");
  });

  test("a checklist is detected", () => {
    expect(detectAnswerShape("- [ ] first item\n- [x] second item")).toBe("checklist");
  });

  test("a markdown table is detected as comparison", () => {
    expect(detectAnswerShape("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("comparison");
  });

  test("web citations are detected as research", () => {
    expect(detectAnswerShape("Fusion output rose [1] and costs fell [2].")).toBe("research");
  });

  test("a human-review headline is detected as warning", () => {
    expect(detectAnswerShape("HUMAN REVIEW REQUIRED — two procedures conflict.")).toBe("warning");
  });
});

describe("knowledge section parsing", () => {
  const parsed = parseKnowledgeSections(KNOWLEDGE_ANSWER)!;

  test("parses every labelled section without bleeding into the next", () => {
    expect(parsed.sections.answer).toBe("File the claim within 30 days of the incident.");
    expect(parsed.sections.steps).toContain("1. Open the claim.");
    expect(parsed.sections.steps).not.toContain("REQUIRED");
    expect(parsed.sections.source).toBe("Claims Procedure");
    expect(parsed.sections.version).toBe("v4 · effective 2026-09-01");
    expect(parsed.sections.escalate).toContain("supervisor");
  });

  test("needs an answer plus another section — a lone SOURCE is not knowledge", () => {
    expect(parseKnowledgeSections("Source\nsome book")).toBeNull();
    expect(parseKnowledgeSections("DIRECT ANSWER\nJust this line.")).toBeNull();
  });

  test("card section order exists for every parsed key", () => {
    for (const key of parsed.order) {
      expect(CARD_SECTION_ORDER.some((s) => s.key === key)).toBe(true);
    }
  });
});

describe("citation + step extraction", () => {
  test("citations are deduped and numbered in order", () => {
    const c = extractCitations("Rose [1] then fell [2], per [1] again. [3] https://example.com/x");
    // [3] is followed only by a URL, so it has no usable label hint and is
    // dropped — chips only render when there is something human-readable.
    expect(c.map((x) => x.n)).toEqual([1, 2]);
    expect(c[0].hint).toContain("then fell");
    expect(c[1].hint).toBe("per");
  });

  test("a citation list from the search block yields clean chips", () => {
    const c = extractCitations("[1] Guardian\nURL: https://g.com\nEXCERPT: x");
    expect(c).toEqual([{ n: 1, hint: "Guardian" }]);
  });

  test("steps are verbatim and capped", () => {
    const steps = extractSteps("1. Open the claim.\n2) Verify docs.\nnot a step");
    expect(steps).toEqual(["Open the claim.", "Verify docs."]);
  });

  test("checklist items keep their checked state", () => {
    const items = extractChecklist("- [ ] todo\n- [x] done");
    expect(items).toEqual([
      { text: "todo", done: false },
      { text: "done", done: true },
    ]);
  });
});

describe("progressive status mapping", () => {
  test("streaming status text maps to the visible stage ladder", () => {
    expect(stageForStatus("Omi is searching the web…")).toBe("SEARCHING");
    expect(stageForStatus("Reading 4 sources…")).toBe("ANALYZING");
    expect(stageForStatus("Omi is checking approved knowledge…")).toBe("VERIFYING");
    expect(stageForStatus("")).toBe("PREPARING ANSWER");
  });
});

describe("provenance labels", () => {
  test("internal knowledge is labelled", () => {
    expect(isInternalKnowledge("APPROVED KNOWLEDGE …")).toBe(true);
    expect(isInternalKnowledge("Here is the answer.")).toBe(false);
  });
});
