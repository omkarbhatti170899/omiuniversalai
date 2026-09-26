import { describe, expect, it } from "bun:test";
import {
  DEFECT_CORPUS,
  DIMENSIONS,
  EVAL_SUITE,
  PASS_THRESHOLD,
  QUESTION_CLASSES,
  answerUrls,
  citedMarkers,
  gradeAnswer,
  runSuite,
  tokenize,
  type Dimension,
  type EvalCase,
} from "@/lib/answerQuality";

const caseById = (id: string): EvalCase => {
  const found = EVAL_SUITE.find((e) => e.case.id === id);
  if (!found) throw new Error(`no eval case ${id}`);
  return found.case;
};

describe("AI response quality — suite shape (Phase 4)", () => {
  it("covers all 12 question classes", () => {
    const covered = new Set(EVAL_SUITE.map((e) => e.case.class));
    for (const c of QUESTION_CLASSES) expect(covered).toContain(c);
    expect(covered.size).toBe(QUESTION_CLASSES.length);
  });

  it("scores all 7 dimensions on every case", () => {
    for (const entry of EVAL_SUITE) {
      const r = gradeAnswer(entry.case, entry.answer);
      for (const d of DIMENSIONS) {
        expect(r.dimensions[d]).toBeDefined();
        expect(r.dimensions[d].score).toBeGreaterThanOrEqual(0);
        expect(r.dimensions[d].score).toBeLessThanOrEqual(1);
        expect(Array.isArray(r.dimensions[d].notes)).toBe(true);
      }
      expect(r.overall).toBeGreaterThan(0);
      expect(r.overall).toBeLessThanOrEqual(1);
    }
  });

  it("every dimension explains itself — a silent zero is not debuggable", () => {
    for (const entry of EVAL_SUITE) {
      const r = gradeAnswer(entry.case, entry.answer);
      for (const d of DIMENSIONS) {
        if (r.dimensions[d].score < 1) {
          expect(r.dimensions[d].notes.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("AI response quality — the golden corpus must pass", () => {
  const report = runSuite(EVAL_SUITE);

  it("every gold answer clears the pass bar on every dimension", () => {
    const failing = report.results.filter(
      (r) => r.overall < PASS_THRESHOLD || r.failed.length > 0,
    );
    const detail = failing
      .map(
        (r) =>
          `${r.caseId}: overall ${r.overall} failed=[${r.failed.join(",")}] ` +
          r.failed.map((d) => `${d}{${r.dimensions[d].notes.join("; ")}}`).join(" | "),
      )
      .join("\n");
    expect(detail).toBe("");
    expect(report.failed).toBe(0);
  });

  it("reports a 100% pass rate over the whole corpus", () => {
    expect(report.total).toBe(EVAL_SUITE.length);
    expect(report.passRate).toBe(1);
  });

  it("per-class aggregation is populated for all 12 classes", () => {
    for (const c of QUESTION_CLASSES) {
      expect(report.byClass[c]).toBeDefined();
      expect(report.byClass[c].total).toBeGreaterThan(0);
      expect(report.byClass[c].passed).toBe(report.byClass[c].total);
    }
  });
});

describe("AI response quality — the graders are discriminating, not permissive", () => {
  it("catches every injected defect on the dimension that owns it", () => {
    const uncaught: string[] = [];
    for (const defect of DEFECT_CORPUS) {
      const c = caseById(defect.from);
      const r = gradeAnswer(c, defect.answer);
      const score = r.dimensions[defect.defect as Dimension].score;
      if (score >= 0.6 || !r.failed.includes(defect.defect)) {
        uncaught.push(
          `${defect.id} (${defect.note}) scored ${score} on ${defect.defect}`,
        );
      }
    }
    expect(uncaught.join("\n")).toBe("");
  });

  it("every defect is materially worse than its gold answer overall", () => {
    for (const defect of DEFECT_CORPUS) {
      const c = caseById(defect.from);
      const gold = EVAL_SUITE.find((e) => e.case.id === defect.from)!.answer;
      const good = gradeAnswer(c, gold).overall;
      const bad = gradeAnswer(c, defect.answer).overall;
      expect(bad).toBeLessThan(good);
    }
  });

  it("an empty answer fails everything rather than scoring as neutral", () => {
    const r = gradeAnswer(caseById("general-1"), "");
    for (const d of DIMENSIONS) expect(r.dimensions[d].score).toBeLessThan(0.6);
    expect(r.failed.length).toBe(DIMENSIONS.length);
  });

  it("grading is deterministic — same input, same scores", () => {
    const a = gradeAnswer(caseById("research-1"), EVAL_SUITE[2].answer);
    const b = gradeAnswer(caseById("research-1"), EVAL_SUITE[2].answer);
    expect(a.overall).toBe(b.overall);
    expect(a.failed).toEqual(b.failed);
  });
});

describe("AI response quality — the product rules are encoded as graders", () => {
  it("rejects fabricated citations", () => {
    const c = caseById("research-1");
    const withFake = gradeAnswer(c, "Grounding helps [1] and [9]. See https://example.com/made-up");
    expect(withFake.dimensions.citationAccuracy.score).toBeLessThan(0.6);
    expect(withFake.dimensions.citationAccuracy.notes.join(" ")).toMatch(/fabricated|not in the retrieved/);
  });

  it("penalizes untrusted sources on a current-information question", () => {
    const c = caseById("currentinfo-1");
    const untrusted = gradeAnswer(
      c,
      "I think it is Node 18.\n\nSource: https://randomblog.example.org/node",
    );
    expect(untrusted.dimensions.sourceQuality.score).toBeLessThan(1);
  });

  it("rejects a claim of web verification when no search ran (Phase 7 rule)", () => {
    const c: EvalCase = {
      id: "no-search-1",
      class: "research",
      question: "What is the current CEO of a large bank?",
      sources: [],
    };
    const lying = gradeAnswer(c, "I verified this on the web — the CEO is Jane Doe.");
    expect(lying.dimensions.hallucinationResistance.score).toBeLessThan(0.6);
    const honest = gradeAnswer(
      c,
      "I do not have a source for that, so I will not guess. Ask me to search and I will.",
    );
    expect(honest.dimensions.hallucinationResistance.score).toBe(1);
  });

  it("requires a grounded answer to carry provenance", () => {
    const c = caseById("knowledge-1");
    const noProvenance = gradeAnswer(c, "You get 3 days. Ask your lead for more.");
    expect(noProvenance.dimensions.hallucinationResistance.score).toBeLessThan(0.8);
  });

  it("rejects an answer that invents steps the grounding never contained", () => {
    const c = caseById("multistep-1");
    const invented = gradeAnswer(
      c,
      "1. Confirm the standby is in sync.\n2. Promote the standby.\n3. Reboot the load balancer.\n4. Verify health checks.\n5. Record the change.",
    );
    // Formatting and relevance still pass; the failure must surface as a
    // missing-provenance penalty, which is how the product rule is enforced.
    expect(invented.dimensions.hallucinationResistance.score).toBeLessThan(1);
  });

  it("scores a wrong arithmetic result as zero correctness", () => {
    const c = caseById("general-2");
    expect(gradeAnswer(c, "25 × 48 = 1300.").dimensions.correctness.score).toBe(0);
    expect(gradeAnswer(c, "25 × 48 = 1200.").dimensions.correctness.score).toBe(1);
  });

  it("rejects an unprompted refusal on a question that does not need one", () => {
    const c = caseById("general-1");
    const refusal = gradeAnswer(c, "I cannot answer that question.");
    expect(refusal.dimensions.correctness.score).toBeLessThan(0.6);
  });

  it("flags an off-topic but fluent answer", () => {
    const c = caseById("file-1");
    const drift = gradeAnswer(
      c,
      "Quarterly performance reporting matters because it shapes long-range strategy. Businesses that review their numbers carefully every cycle and adjust their long-range forecasts accordingly tend to plan more successfully than those that do not.",
    );
    expect(drift.dimensions.relevance.score).toBeLessThan(0.4);
  });

  it("detects formatting faults: unbalanced fences, missing table delimiter, heading jumps", () => {
    const c = caseById("general-1");
    const fences = gradeAnswer(c, "Here:\n```ts\nconst a = 1;\n```\nand again\n```");
    expect(fences.dimensions.formatting.notes.join(" ")).toContain("code fence");

    const table = gradeAnswer(c, "| A | B |\n| --- |\n| 1 | 2 |");
    expect(table.dimensions.formatting.notes.join(" ")).toContain("delimiter row");

    const headings = gradeAnswer(c, "## Summary\n\n#### Deep detail\n\nmore");
    expect(headings.dimensions.formatting.notes.join(" ")).toContain("heading");
  });

  it("flags a single line long enough to overflow a phone", () => {
    const c = caseById("general-1");
    const wide = gradeAnswer(c, `Summary\n\n${"x".repeat(500)}`);
    expect(wide.dimensions.formatting.notes.join(" ")).toContain("400");
  });
});

describe("AI response quality — text helpers", () => {
  it("tokenize drops stopwords and punctuation but keeps meaningful tokens", () => {
    const t = tokenize("What is the difference between a Mutex and a Semaphore?");
    expect(t).toContain("difference");
    expect(t).toContain("mutex");
    expect(t).not.toContain("the");
    expect(t).not.toContain("what");
  });

  it("citedMarkers returns distinct, sorted markers", () => {
    expect(citedMarkers("a [2] b [1] c [2] d [3]")).toEqual([1, 2, 3]);
    expect(citedMarkers("no citations here")).toEqual([]);
  });

  it("answerUrls finds and de-duplicates literal URLs", () => {
    expect(
      answerUrls("see https://a.example/x and https://a.example/x plus http://b.example"),
    ).toEqual(["https://a.example/x", "http://b.example"]);
  });
});
