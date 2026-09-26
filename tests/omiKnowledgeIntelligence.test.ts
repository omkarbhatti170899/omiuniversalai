/**
 * Omi Knowledge Intelligence — engine tests.
 *
 * Covers the rules that make the subsystem trustworthy: only approved
 * knowledge is authoritative, the currently-effective version wins (never a
 * mix), visibility honours roles, grounding refuses to invent, the critic
 * flags without auto-publishing, and analytics aggregate honestly.
 */
import { describe, test, expect } from "bun:test";
import {
  canTransition,
  canPublish,
  isAuthoritative,
  nextVersion,
  rolesForUser,
  canManageKnowledge,
  changedFields,
} from "../src/convex/knowledgeEngine/governance";
import {
  isEffectivelyActive,
  selectEffectiveVersions,
  filterVisible,
  filterByMetadata,
  type ArticleLike,
} from "../src/convex/knowledgeEngine/select";
import {
  buildGroundedAnswer,
  normalizeQuestionKey,
  extractExceptions,
  extractEscalations,
  labelSourceKind,
  type KnowledgePassage,
} from "../src/convex/knowledgeEngine/grounding";
import { critiqueKnowledge } from "../src/convex/knowledgeEngine/critic";
import { summarizeKnowledge } from "../src/convex/knowledgeEngine/analytics";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function article(over: Partial<ArticleLike> = {}): ArticleLike {
  return {
    _id: over._id ?? "a1",
    familyId: over.familyId ?? "fam1",
    title: over.title ?? "Procedure",
    content: over.content ?? "Do the thing.",
    status: over.status ?? "published",
    version: over.version ?? 1,
    sourceType: over.sourceType ?? "internal",
    ...over,
  };
}

describe("governance", () => {
  test("only approved/published knowledge is authoritative", () => {
    expect(isAuthoritative("approved")).toBe(true);
    expect(isAuthoritative("published")).toBe(true);
    expect(isAuthoritative("draft")).toBe(false);
    expect(isAuthoritative("in_review")).toBe(false);
  });

  test("publishing requires a prior approval", () => {
    expect(canPublish("approved")).toBe(true);
    expect(canPublish("draft")).toBe(false);
    expect(canPublish("in_review")).toBe(false);
  });

  test("lifecycle transitions are restricted to the workflow", () => {
    expect(canTransition("draft", "in_review")).toBe(true);
    expect(canTransition("in_review", "approved")).toBe(true);
    expect(canTransition("approved", "published")).toBe(true);
    expect(canTransition("published", "expired")).toBe(true);
    // Illegal shortcuts
    expect(canTransition("draft", "published")).toBe(false);
    expect(canTransition("draft", "approved")).toBe(false);
    expect(canTransition("archived", "published")).toBe(false);
  });

  test("version increments never go backwards", () => {
    expect(nextVersion(1)).toBe(2);
    expect(nextVersion(7)).toBe(8);
    expect(nextVersion(0)).toBe(1);
  });

  test("roles map from the auth role", () => {
    expect(rolesForUser("admin")).toContain("knowledge_manager");
    expect(rolesForUser("user")).toEqual(["agent"]);
    expect(canManageKnowledge(rolesForUser("admin"))).toBe(true);
    expect(canManageKnowledge(rolesForUser("user"))).toBe(false);
  });

  test("changedFields detects real edits only", () => {
    const a = { title: "A", content: "x", tags: ["a"] };
    expect(changedFields(a, a)).toEqual([]);
    expect(changedFields(a, { ...a, title: "B" })).toEqual(["title"]);
    expect(changedFields(a, { ...a, tags: ["a", "b"] })).toEqual(["tags"]);
  });
});

describe("version-aware selection (§8)", () => {
  test("the currently-effective version wins and the old one is dropped", () => {
    const v1 = article({ _id: "v1", familyId: "fam", version: 1, effectiveDate: NOW - 10 * DAY,
      content: "Procedure A" });
    const v2 = article({ _id: "v2", familyId: "fam", version: 2, effectiveDate: NOW - DAY,
      content: "Procedure B" });
    const picked = selectEffectiveVersions([v1, v2], NOW);
    expect(picked).toHaveLength(1);
    expect(picked[0].version).toBe(2);
    expect(picked[0].content).toBe("Procedure B");
  });

  test("a future-effective version is not used yet", () => {
    const current = article({ _id: "c", familyId: "f", version: 1, effectiveDate: NOW - DAY });
    const future = article({ _id: "f", familyId: "f", version: 2, effectiveDate: NOW + DAY });
    const picked = selectEffectiveVersions([current, future], NOW);
    expect(picked[0]._id).toBe("c");
  });

  test("expired and non-authoritative versions are never selected", () => {
    const expired = article({ status: "expired", expirationDate: NOW - 1 });
    const draft = article({ status: "draft" });
    const futureEff = article({ effectiveDate: NOW + DAY });
    expect(isEffectivelyActive(expired, NOW)).toBe(false);
    expect(isEffectivelyActive(draft, NOW)).toBe(false);
    expect(isEffectivelyActive(futureEff, NOW)).toBe(false);
    expect(selectEffectiveVersions([expired, draft, futureEff], NOW)).toHaveLength(0);
  });
});

describe("role-based visibility (§9)", () => {
  test("an article with no audience is visible to everyone", () => {
    expect(filterVisible([article({ audience: [] })], ["agent"])).toHaveLength(1);
  });

  test("restricted articles are hidden from unauthorized roles", () => {
    const restricted = article({ audience: ["admin"] });
    expect(filterVisible([restricted], ["agent"])).toHaveLength(0);
    expect(filterVisible([restricted], ["admin"])).toHaveLength(1);
  });

  test("metadata filters narrow the corpus", () => {
    const docs = [
      article({ _id: "1", region: "US", product: "Claims" }),
      article({ _id: "2", region: "EU", product: "Claims" }),
    ];
    expect(filterByMetadata(docs, { region: "US" })).toHaveLength(1);
    expect(filterByMetadata(docs, { product: "claims" })).toHaveLength(2);
  });
});

describe("grounded answers (§3, §21)", () => {
  const passage = (over: Partial<KnowledgePassage> = {}): KnowledgePassage => ({
    articleId: "a1",
    familyId: "fam1",
    title: "Claims Procedure",
    version: 2,
    status: "published",
    sourceType: "internal",
    snippet: "File within 30 days.",
    content:
      "## Filing\nFile the claim within 30 days of the incident.\nExceptions: catastrophe claims are exempt from the 30-day rule.\nEscalate to a supervisor if the claim exceeds 100,000.",
    score: 5,
    ...over,
  });

  test("insufficient evidence never invents an answer", () => {
    const a = buildGroundedAnswer("What is the refund policy?", []);
    expect(a.answered).toBe(false);
    expect(a.sourceKind).toBe("none");
    expect(a.answer).toMatch(/does not contain sufficient information/i);
  });

  test("an answer below the evidence floor is refused", () => {
    const a = buildGroundedAnswer("question", [passage({ score: 0.2 })]);
    expect(a.answered).toBe(false);
  });

  test("a supported answer cites source, version, evidence, exceptions, escalation", () => {
    const a = buildGroundedAnswer("How do I file a claim within 30 days?", [passage()]);
    expect(a.answered).toBe(true);
    expect(a.source?.title).toBe("Claims Procedure");
    expect(a.source?.version).toBe(2);
    expect(a.evidence[0]).toMatch(/30 days/i);
    expect(a.exceptions.join(" ")).toMatch(/exempt/i);
    expect(a.escalateWhen.join(" ")).toMatch(/supervisor/i);
    expect(a.relevantSection).toBe("Filing");
  });

  test("exceptions and escalation detectors are targeted", () => {
    expect(extractExceptions("Unless the item is fragile, ship normally.")).toHaveLength(1);
    expect(extractEscalations("Refer to a manager for approval.")).toHaveLength(1);
    expect(extractEscalations("This is a normal step.")).toHaveLength(0);
  });

  test("gap keys group equivalent phrasings and separate distinct ones", () => {
    // Stopwords are stripped, so a framed question and its bare topic collapse.
    expect(normalizeQuestionKey("What is the refund policy?")).toBe(
      normalizeQuestionKey("refund policy"),
    );
    expect(normalizeQuestionKey("refund policy")).not.toBe(
      normalizeQuestionKey("claims processing"),
    );
  });

  test("source kinds are labelled explicitly", () => {
    expect(labelSourceKind("internal")).toBe("INTERNAL KNOWLEDGE");
    expect(labelSourceKind("external")).toBe("EXTERNAL RESEARCH");
  });
});

describe("knowledge critic (§5)", () => {
  test("flags outdated, expiring, duplicates, conflicts and gaps", () => {
    const flags = critiqueKnowledge({
      now: NOW,
      articles: [
        article({ _id: "old", title: "Old", status: "published", expirationDate: NOW - DAY }),
        article({ _id: "soon", title: "Soon", status: "published", expirationDate: NOW + 5 * DAY }),
        article({ _id: "d1", familyId: "x", title: "Same Title" }),
        article({ _id: "d2", familyId: "y", title: "Same Title" }),
        article({ _id: "c1", familyId: "conf", version: 2, status: "published" }),
        article({ _id: "c2", familyId: "conf", version: 1, status: "published", effectiveDate: NOW - DAY }),
        article({ _id: "c3", familyId: "conf", version: 2, status: "published", effectiveDate: NOW - DAY }),
      ],
      gaps: [{ key: "procedure x", question: "Procedure X", count: 10, status: "open" }],
    });
    const codes = new Set(flags.map((f) => f.code));
    expect(codes.has("outdated")).toBe(true);
    expect(codes.has("expiring_soon")).toBe(true);
    expect(codes.has("duplicate")).toBe(true);
    expect(codes.has("conflicting_versions")).toBe(true);
    expect(codes.has("gap")).toBe(true);
  });

  test("the critic never mutates or auto-publishes (pure)", () => {
    const before = article({ status: "draft" });
    const copy = JSON.parse(JSON.stringify(before));
    critiqueKnowledge({ now: NOW, articles: [before], gaps: [] });
    expect(before).toEqual(copy);
  });
});

describe("analytics (§17)", () => {
  test("counts, rates and top queries", () => {
    const a = summarizeKnowledge({
      now: NOW,
      articles: [
        article({ _id: "1", status: "published" }),
        article({ _id: "2", status: "draft" }),
        article({ _id: "3", status: "expired" }),
      ],
      gaps: [{ count: 4, status: "open" }],
      feedback: [{ verdict: "incorrect" }, { verdict: "correct" }],
      logs: [
        { query: "refunds", answered: true, latencyMs: 10 },
        { query: "refunds", answered: false, latencyMs: 30 },
        { query: "claims", answered: true, latencyMs: 20 },
      ],
    });
    expect(a.total).toBe(3);
    expect(a.byStatus.published).toBe(1);
    expect(a.openGaps).toBe(1);
    expect(a.gapQuestions).toBe(4);
    expect(a.searchSuccessRate).toBeCloseTo(2 / 3, 5);
    expect(a.noAnswerRate).toBeCloseTo(1 / 3, 5);
    expect(a.avgLatencyMs).toBe(20);
    expect(a.mostSearched[0]).toEqual({ query: "refunds", count: 2 });
    expect(a.failedSearches[0]).toEqual({ query: "refunds", count: 1 });
    expect(a.feedback.incorrect).toBe(1);
  });
});
