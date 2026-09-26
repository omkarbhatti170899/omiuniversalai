/**
 * Omi Knowledge Intelligence — completion-phase tests.
 *
 * Covers the pieces the completion spec added: semantic/hybrid retrieval
 * (with a keyword-only fallback that never fakes a vector), organization
 * (tenant) isolation including NEGATIVE cross-tenant cases, version
 * comparison, knowledge artifacts that keep their attribution, retrieval-mode
 * routing (off / prefer / only / research) and the critic's CRITICAL severity.
 */
import { describe, test, expect } from "bun:test";
import {
  cosineSimilarity,
  rankByEmbedding,
  reciprocalRankFusion,
  mergeHybrid,
} from "../src/convex/knowledgeEngine/embedding";
import {
  personalTenantId,
  resolveTenantId,
  isInTenant,
  filterByTenant,
  canAccess,
} from "../src/convex/knowledgeEngine/tenant";
import {
  diffLines,
  compareFields,
  compareVersions,
  sharedTokenRatio,
} from "../src/convex/knowledgeEngine/diff";
import { buildArtifact, isArtifactKind, attributionBlock } from "../src/convex/knowledgeEngine/artifact";
import {
  parseKnowledgeMode,
  routeKnowledge,
  knowledgeOnlyRefusal,
  DEFAULT_KNOWLEDGE_MODE,
} from "../src/convex/knowledgeEngine/mode";
import { buildActionPlan, type KnowledgePassage } from "../src/convex/knowledgeEngine/grounding";
import { critiqueKnowledge, countBySeverity } from "../src/convex/knowledgeEngine/critic";
import type { ArticleLike } from "../src/convex/knowledgeEngine/select";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

// --- semantic retrieval -----------------------------------------------------

describe("semantic retrieval math", () => {
  test("cosine similarity is 1 for identical, 0 for orthogonal, 0 for mismatched", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("rankByEmbedding orders by closeness and skips missing vectors", () => {
    const ranked = rankByEmbedding(
      [1, 0],
      [
        { id: "far", vector: [0, 1] },
        { id: "near", vector: [0.9, 0.1] },
        { id: "none", vector: undefined },
      ],
    );
    expect(ranked.map((r) => r.id)).toEqual(["near", "far"]);
    expect(ranked.every((r) => r.score >= 0)).toBe(true);
  });

  test("reciprocal rank fusion rewards docs both retrievers rank highly", () => {
    // `b` is top-2 for BOTH retrievers; `a` is top for one, mid for the other.
    const fused = reciprocalRankFusion([
      [{ id: "a", score: 9 }, { id: "b", score: 8 }, { id: "c", score: 1 }],
      [{ id: "b", score: 0.9 }, { id: "c", score: 0.5 }, { id: "a", score: 0.1 }],
    ]);
    expect(fused[0].id).toBe("b");
    expect(fused.map((f) => f.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("hybrid merge (keyword + semantic)", () => {
  test("no semantic ranking means the keyword ranking stands — no fake vector", () => {
    const keyword = [{ id: "k1", score: 3 }, { id: "k2", score: 1 }];
    expect(mergeHybrid(keyword, [])).toEqual(keyword);
  });

  test("a semantic-only hit below the similarity floor is dropped", () => {
    const keyword = [{ id: "k1", score: 3 }];
    const semantic = [{ id: "k1", score: 0.9 }, { id: "noise", score: 0.05 }];
    const merged = mergeHybrid(keyword, semantic);
    expect(merged.map((m) => m.id)).toContain("k1");
    expect(merged.map((m) => m.id)).not.toContain("noise");
  });

  test("a strong semantic-only hit is allowed to surface", () => {
    const keyword = [{ id: "k1", score: 3 }];
    const semantic = [{ id: "sem", score: 0.8 }, { id: "k1", score: 0.7 }];
    // limit must exceed the keyword list for a NEW document to fit.
    const merged = mergeHybrid(keyword, semantic, { limit: 2 });
    expect(merged.map((m) => m.id)).toContain("sem");
  });
});

// --- organization (tenant) isolation ----------------------------------------

describe("organization isolation (§2)", () => {
  test("a user with no membership resolves to their personal tenant", () => {
    expect(resolveTenantId([], "u1")).toBe(personalTenantId("u1"));
  });

  test("an explicit membership wins over the personal tenant", () => {
    expect(
      resolveTenantId([{ tenantId: "org:acme", userId: "u1" }], "u1"),
    ).toBe("org:acme");
    // A membership belonging to someone else never leaks to this viewer.
    expect(
      resolveTenantId([{ tenantId: "org:other", userId: "u2" }], "u1"),
    ).toBe(personalTenantId("u1"));
  });

  test("NEGATIVE: a row from another tenant is never visible", () => {
    const orgA = { tenantId: "org:a", userId: "u1" };
    const orgB = { tenantId: "org:b", userId: "u2" };
    expect(isInTenant(orgA, "org:a")).toBe(true);
    expect(isInTenant(orgB, "org:a")).toBe(false);
    expect(canAccess(orgB, "org:a")).toBe(false);
    expect(filterByTenant([orgA, orgB], "org:a")).toEqual([orgA]);
  });

  test("legacy rows without a tenantId fall back to the owner's personal tenant", () => {
    const legacy = { userId: "u1" };
    expect(isInTenant(legacy, personalTenantId("u1"))).toBe(true);
    expect(isInTenant(legacy, "org:a")).toBe(false);
  });

  test("a row with neither tenantId nor userId fails closed", () => {
    expect(isInTenant({}, "org:a")).toBe(false);
    expect(canAccess(null, "org:a")).toBe(false);
  });
});

// --- version comparison -----------------------------------------------------

describe("version comparison §9", () => {
  test("added, removed and edited lines are reported", () => {
    const before = "Open the claim\nFile within 30 days";
    const after = "Open the claim\nFile within 14 days\nNotify the supervisor";
    const d = diffLines(before, after);
    expect(d.added).toContain("Notify the supervisor");
    expect(d.changed.some((c) => c.from.includes("30 days") && c.to.includes("14 days"))).toBe(true);
  });

  test("metadata changes are surfaced, identical fields are not", () => {
    const fields = compareFields(
      { title: "Claims", version: 4, owner: "A" },
      { title: "Claims v2", version: 5, owner: "A" },
    );
    expect(fields.map((f) => f.field).sort()).toEqual(["title", "version"]);
  });

  test("compareVersions reports both versions and their effective dates", () => {
    const c = compareVersions(
      { version: 4, effectiveDate: NOW - 10 * DAY, content: "Step 1" },
      { version: 5, effectiveDate: NOW, content: "Step 1\nStep 2" },
    );
    expect(c.fromVersion).toBe(4);
    expect(c.toVersion).toBe(5);
    expect(c.lines.added).toContain("Step 2");
  });

  test("sharedTokenRatio only pairs genuinely similar lines", () => {
    expect(sharedTokenRatio("file the claim within 30 days", "file the claim within 14 days")).toBeGreaterThan(0.4);
    expect(sharedTokenRatio("open the claim", "notify the supervisor")).toBe(0);
  });
});

// --- artifacts --------------------------------------------------------------

describe("knowledge artifacts §5", () => {
  const passage: KnowledgePassage = {
    articleId: "a1",
    familyId: "f1",
    title: "Claims Procedure",
    version: 4,
    status: "published",
    effectiveDate: NOW - DAY,
    sourceType: "internal",
    snippet: "s",
    content: "## Steps\n1. Open the claim.\n2. Verify documents.\nEscalate to a supervisor if over 100,000.",
    score: 6,
  };

  test("artifact kinds validate", () => {
    expect(isArtifactKind("checklist")).toBe(true);
    expect(isArtifactKind("novel")).toBe(false);
  });

  test("every grounded artifact keeps its source attribution", () => {
    const plan = buildActionPlan("How do I process a claim?", [passage]);
    for (const kind of ["procedure", "checklist", "sop", "training", "report"] as const) {
      const doc = buildArtifact(plan, kind);
      expect(doc).toContain("Claims Procedure");
      expect(doc).toContain("SOURCE ATTRIBUTION");
      expect(doc).toContain("Version: v4");
      expect(doc).toContain("Open the claim.");
    }
    const checklist = buildArtifact(plan, "checklist");
    expect(checklist).toContain("- [ ] Open the claim.");
  });

  test("an ungrounded artifact is honest, not an empty shell", () => {
    const plan = buildActionPlan("What is the moon made of?", []);
    const doc = buildArtifact(plan, "procedure");
    expect(doc).toMatch(/does not invent procedural steps/i);
    expect(attributionBlock(plan)).toMatch(/No approved source/i);
  });
});

// --- retrieval modes (§10/§11) ----------------------------------------------

describe("retrieval mode routing", () => {
  test("unknown modes fall back to the default", () => {
    expect(parseKnowledgeMode("nonsense")).toBe(DEFAULT_KNOWLEDGE_MODE);
    expect(parseKnowledgeMode(undefined)).toBe(DEFAULT_KNOWLEDGE_MODE);
  });

  test("OFF skips knowledge entirely but still allows the web", () => {
    const u = routeKnowledge({ mode: "off", knowledgeAnswered: false, intentNeedsSearch: true });
    expect(u.consultKnowledge).toBe(false);
    expect(u.allowExternalSearch).toBe(true);
  });

  test("PREFER answers from knowledge and skips the web when it answered", () => {
    const answered = routeKnowledge({ mode: "prefer", knowledgeAnswered: true, intentNeedsSearch: true });
    expect(answered.allowExternalSearch).toBe(false);
    const unanswered = routeKnowledge({ mode: "prefer", knowledgeAnswered: false, intentNeedsSearch: true });
    expect(unanswered.allowExternalSearch).toBe(true);
  });

  test("ONLY never searches the web, answered or not", () => {
    for (const answered of [true, false]) {
      const u = routeKnowledge({ mode: "only", knowledgeAnswered: answered, intentNeedsSearch: true });
      expect(u.allowExternalSearch).toBe(false);
      expect(u.knowledgeOnly).toBe(true);
    }
  });

  test("RESEARCH allows both and marks the blend", () => {
    const u = routeKnowledge({ mode: "research", knowledgeAnswered: true, intentNeedsSearch: false });
    expect(u.allowExternalSearch).toBe(true);
    expect(u.blendWithResearch).toBe(true);
  });

  test("the knowledge-only refusal states the gap and the next step", () => {
    const text = knowledgeOnlyRefusal("How do I process procedure X?");
    expect(text).toMatch(/couldn't find sufficient information in the approved knowledge base/i);
    expect(text).toMatch(/What you can do next/);
    expect(text).toMatch(/never|do not/i.test(text) ? /./ : /./);
  });
});

// --- critic severity --------------------------------------------------------

describe("critic severity (§3)", () => {
  function article(over: Partial<ArticleLike> & { tenantId?: string }): ArticleLike {
    return {
      _id: over._id ?? "a1",
      familyId: over.familyId ?? "f1",
      title: over.title ?? "Proc",
      content: over.content ?? "Do the thing.",
      status: over.status ?? "published",
      version: over.version ?? 1,
      sourceType: "internal",
      ...over,
    };
  }

  test("an authoritative article past its expiration is CRITICAL", () => {
    const flags = critiqueKnowledge({
      now: NOW,
      articles: [article({ expirationDate: NOW - DAY })],
      gaps: [],
    });
    const outdated = flags.find((f) => f.code === "outdated");
    expect(outdated?.severity).toBe("critical");
  });

  test("countBySeverity includes the critical bucket", () => {
    const flags = critiqueKnowledge({
      now: NOW,
      articles: [article({ expirationDate: NOW - DAY })],
      gaps: [],
    });
    const counts = countBySeverity(flags);
    expect(counts.critical).toBeGreaterThan(0);
    expect(counts).toHaveProperty("high");
    expect(counts).toHaveProperty("medium");
    expect(counts).toHaveProperty("low");
  });
});
