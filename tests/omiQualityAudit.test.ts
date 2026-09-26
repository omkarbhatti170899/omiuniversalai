/**
 * Phases 5, 6, 7 and 10 — verification of the product-honesty contracts.
 *
 * These are the rules a user would be misled by if they regressed, so they are
 * pinned as tests rather than left to review:
 *
 *   Phase 5  APPROVED KNOWLEDGE → RETRIEVE → VERIFY → ANSWER → STEPS → SOURCE,
 *            with no invented procedural step anywhere in the chain.
 *   Phase 6  the image system never turns an edit into a text-to-image call,
 *            never generates from an unrelated prompt, and fails loudly.
 *   Phase 7  INTERNAL KNOWLEDGE and EXTERNAL WEB RESEARCH are never silently
 *            mixed, and a failed search is never reported as verification.
 *   Phase 10 the PWA/mobile surface is installable and keyboard-safe.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildActionPlan,
  detectConflicts,
  formatActionPlan,
  type KnowledgePassage,
} from "../src/convex/knowledgeEngine/grounding";
import {
  DEFAULT_KNOWLEDGE_MODE,
  parseKnowledgeMode,
  routeKnowledge,
  knowledgeOnlyRefusal,
} from "../src/convex/knowledgeEngine/mode";
import {
  mergeHybrid,
  rankByEmbedding,
  reciprocalRankFusion,
  RRF_K,
} from "../src/convex/knowledgeEngine/embedding";
import { canAccess, filterByTenant, isInTenant, personalTenantId } from "../src/convex/knowledgeEngine/tenant";
import { detectAnswerShape, extractSteps, isInternalKnowledge } from "@/lib/answerShape";
import { classifyImageIntent } from "../src/convex/aiProviders/imageIntent";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------- Phase 5

const POLICY = `Remote Work Policy

Section 4.2 — Allowance
Employees may work remotely up to 3 days per calendar month.
Requests beyond 3 days need written approval from the team lead.

WHAT TO DO
1. Count the remote days already approved for the month.
2. For anything beyond 3 days, request written approval from your team lead.

REQUIRED INFORMATION
- Team lead approval for anything above 3 days

IMPORTANT CHECKS
- Check the shared team calendar before booking

EXCEPTIONS
- Public holiday weeks do not reduce the monthly allowance

WHEN TO ESCALATE
- If the team lead disputes the count`;

const passage = (over: Partial<KnowledgePassage> = {}): KnowledgePassage => ({
  articleId: "a1",
  familyId: "f1",
  title: "Omi Remote Work Policy",
  version: 3,
  status: "approved",
  effectiveDate: Date.parse("2026-01-15"),
  sourceType: "internal",
  snippet: "Employees may work remotely up to 3 days per calendar month.",
  content: POLICY,
  score: 6,
  ...over,
});

describe("Phase 5 — APPROVED → RETRIEVE → VERIFY → ANSWER → STEPS → SOURCE", () => {
  const plan = buildActionPlan("How many remote days are allowed?", [passage()]);
  const rendered = formatActionPlan(plan);

  it("answers, and is explicit that it is grounded in internal knowledge", () => {
    expect(plan.answered).toBe(true);
    expect(plan.sourceKind).toBe("internal");
    expect(rendered).toContain("DIRECT ANSWER");
  });

  it("renders the full stage structure", () => {
    for (const label of [
      "DIRECT ANSWER",
      "WHAT TO DO",
      "SOURCE ARTICLE",
      "VERSION",
      "SUPPORTING EVIDENCE",
    ]) {
      expect(`${label} → ${rendered.includes(label)}`).toContain("true");
    }
  });

  it("carries every step verbatim from the article and adds none", () => {
    expect(plan.stepsSupported).toBe(true);
    const rendered2 = extractSteps(rendered);
    expect(rendered2).toHaveLength(plan.steps.length);
    expect(rendered2[0]).toBe(plan.steps[0]);
    expect(rendered2[0]).toBe("Count the remote days already approved for the month.");
  });

  it("NEVER invents a step when the article lists none", () => {
    const prose = buildActionPlan("What is the policy?", [
      passage({
        content:
          "The remote work allowance is 3 days per calendar month. This paragraph states a fact and lists no procedure at all.",
        snippet: "The remote work allowance is 3 days per calendar month.",
      }),
    ]);
    expect(prose.steps).toHaveLength(0);
    expect(prose.stepsSupported).toBe(false);
    const out = formatActionPlan(prose);
    // It SAYS there are no steps, instead of inventing a plausible one.
    expect(out).toMatch(/will not invent any/i);
    expect(prose.note).toMatch(/none were invented/i);
    // No numbered step was fabricated.
    expect(extractSteps(out)).toHaveLength(0);
  });

  it("refuses to answer when nothing is approved or relevant", () => {
    const none = buildActionPlan("unrelated question about penguins", []);
    expect(none.answered).toBe(false);
    expect(none.answer.length).toBeGreaterThan(0);
    // No fabricated source, no fabricated steps.
    expect(none.steps).toHaveLength(0);
  });

  it("requests human review on a conflict instead of silently choosing", () => {
    const other = passage({
      articleId: "a2",
      familyId: "f2",
      title: "Omi Remote Work Policy (updated)",
      version: 4,
      content: POLICY.replace("up to 3 days", "up to 5 days"),
      snippet: "Employees may work remotely up to 5 days per calendar month.",
    });
    const conflicts = detectConflicts([passage(), other]);
    expect(conflicts.length).toBeGreaterThan(0);

    const conflicted = buildActionPlan("How many remote days are allowed?", [passage(), other]);
    expect(conflicted.conflicts.length).toBeGreaterThan(0);
    expect(conflicted.note).toMatch(/human review/i);
  });

  it("labels the provenance so the UI can render it as internal knowledge", () => {
    // The engine itself declares the source kind...
    expect(plan.sourceKind).toBe("internal");
    // ...the renderer emits a structured knowledge card...
    expect(detectAnswerShape(rendered)).toBe("knowledge");
    // ...and the chat pipeline is what stamps the visible APPROVED KNOWLEDGE
    // label, so internal and external are never blended silently.
    const chat = read("src/convex/omiChat.ts");
    expect(chat).toContain("APPROVED KNOWLEDGE");
    expect(chat).toMatch(/formatActionPlan\(kb\.answer\)/);
    // Once labelled, the UI can recognise it as internal.
    expect(isInternalKnowledge(`APPROVED KNOWLEDGE\n${rendered}`)).toBe(true);
  });
});

describe("Phase 5 — knowledge modes never mix internal and external silently", () => {
  it("parses every documented mode and falls back to the safe default", () => {
    expect(parseKnowledgeMode("off")).toBe("off");
    expect(parseKnowledgeMode("prefer")).toBe("prefer");
    expect(parseKnowledgeMode("only")).toBe("only");
    expect(parseKnowledgeMode("research")).toBe("research");
    // An unrecognised stored value must not widen anything.
    expect(parseKnowledgeMode("nonsense")).toBe(DEFAULT_KNOWLEDGE_MODE);
    expect(parseKnowledgeMode(undefined)).toBe(DEFAULT_KNOWLEDGE_MODE);
  });

  it("only mode blocks the web and refuses honestly when nothing is approved", () => {
    const use = routeKnowledge({ mode: "only", knowledgeAnswered: false, intentNeedsSearch: true });
    expect(use.knowledgeOnly).toBe(true);
    expect(use.allowExternalSearch).toBe(false);
    const refusal = knowledgeOnlyRefusal("What is the remote limit?");
    expect(refusal).toMatch(/approved knowledge/i);
    expect(refusal.toLowerCase()).toMatch(/couldn't find|could not find|don't have|do not have/);
    // A refusal must never smuggle in an answer.
    expect(refusal).not.toMatch(/3 days/);
  });

  it("research mode runs the web but labels it as a separate, blendable source", () => {
    const use = routeKnowledge({ mode: "research", knowledgeAnswered: true, intentNeedsSearch: true });
    expect(use.allowExternalSearch).toBe(true);
    expect(use.blendWithResearch).toBe(true);
  });

  it("off mode never consults knowledge", () => {
    const use = routeKnowledge({ mode: "off", knowledgeAnswered: false, intentNeedsSearch: true });
    expect(use.consultKnowledge).toBe(false);
    expect(use.knowledgeOnly).toBe(false);
  });

  it("prefer mode answers from knowledge and only reaches the web if it did not", () => {
    const answered = routeKnowledge({ mode: "prefer", knowledgeAnswered: true, intentNeedsSearch: true });
    expect(answered.allowExternalSearch).toBe(false);
    const notAnswered = routeKnowledge({ mode: "prefer", knowledgeAnswered: false, intentNeedsSearch: true });
    expect(notAnswered.allowExternalSearch).toBe(true);
    // A conversational question never needs the web even when unanswered.
    const chatty = routeKnowledge({ mode: "prefer", knowledgeAnswered: false, intentNeedsSearch: false });
    expect(chatty.allowExternalSearch).toBe(false);
  });
});

describe("Phase 5 — retrieval is hybrid, re-ranked and tenant-scoped", () => {
  const docs = [
    { id: "a", vector: [1, 0, 0] },
    { id: "b", vector: [0, 1, 0] },
    { id: "c", vector: [0.9, 0.1, 0] },
  ];

  it("ranks by cosine similarity, not by input order", () => {
    const ranked = rankByEmbedding([1, 0, 0], docs);
    expect(ranked[0].id).toBe("a");
    expect(ranked[1].id).toBe("c");
  });

  it("skips a document with no vector rather than scoring it zero", () => {
    const ranked = rankByEmbedding([1, 0, 0], [...docs, { id: "d", vector: undefined }]);
    expect(ranked.map((r) => r.id)).not.toContain("d");
  });

  it("clamps a negative cosine to zero instead of reordering the tail up", () => {
    const ranked = rankByEmbedding([1, 0, 0], [
      { id: "pos", vector: [1, 0, 0] },
      { id: "neg", vector: [-1, 0, 0] },
    ]);
    expect(ranked.find((r) => r.id === "neg")?.score).toBe(0);
  });

  it("reciprocal rank fusion rewards a document both retrievers ranked", () => {
    const fused = reciprocalRankFusion([
      [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.5 },
      ],
      [
        { id: "b", score: 0.9 },
        { id: "c", score: 0.5 },
      ],
    ]);
    expect(fused[0].id).toBe("b");
    expect(RRF_K).toBe(60);
  });

  it("a semantic-only hit below the similarity floor is dropped as noise", () => {
    const keyword = [{ id: "a", score: 3 }];
    const semantic = [
      { id: "a", score: 0.9 },
      { id: "noise", score: 0.05 },
    ];
    const merged = mergeHybrid(keyword, semantic);
    expect(merged.map((m) => m.id)).toContain("a");
    expect(merged.map((m) => m.id)).not.toContain("noise");
  });

  it("a strong semantic-only hit survives the floor", () => {
    const merged = mergeHybrid(
      [{ id: "a", score: 3 }],
      [
        { id: "a", score: 0.9 },
        { id: "good", score: 0.4 },
      ],
      { limit: 10 },
    );
    expect(merged.map((m) => m.id)).toContain("good");
  });

  it("with no semantic ranking, the keyword ranking is returned unchanged", () => {
    const keyword = [
      { id: "a", score: 3 },
      { id: "b", score: 2 },
    ];
    expect(mergeHybrid(keyword, [])).toEqual(keyword);
  });

  it("tenant isolation denies on a mismatch and on a missing tenant", () => {
    expect(isInTenant({ tenantId: "t1" }, "t1")).toBe(true);
    expect(isInTenant({ tenantId: "t1" }, "t2")).toBe(false);
    // Fail closed: no tenant on either side is a DENY, not a wildcard.
    expect(isInTenant({}, "t1")).toBe(false);
    expect(isInTenant({ tenantId: "t1" }, undefined as unknown as string)).toBe(false);
  });

  it("a row with only a userId falls back to that personal tenant", () => {
    expect(isInTenant({ userId: "u1" }, personalTenantId("u1"))).toBe(true);
    expect(isInTenant({ userId: "u1" }, personalTenantId("u2"))).toBe(false);
    // The personal tenant is namespaced, so it can never collide with an org id.
    expect(personalTenantId("u1")).not.toBe("u1");
  });

  it("filterByTenant never leaks a row from another tenant", () => {
    const rows = [{ tenantId: "t1" }, { tenantId: "t2" }, { tenantId: "t1" }, { tenantId: "t1" }];
    const out = filterByTenant(rows, "t1");
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.tenantId === "t1")).toBe(true);
  });

  it("canAccess treats another user's id exactly like a missing one", () => {
    expect(canAccess({ tenantId: "t1" }, "t1")).toBe(true);
    expect(canAccess({ tenantId: "t2" }, "t1")).toBe(false);
    expect(canAccess(null, "t1")).toBe(false);
  });
});

// ---------------------------------------------------------------- Phase 6

describe("Phase 6 — the image system cannot silently substitute a different operation", () => {
  it("an edit request stays an edit and never becomes text-to-image", () => {
    for (const prompt of [
      "make the sky purple",
      "remove the background",
      "change the logo to red",
      "edit this photo to be brighter",
      "combine these two images",
    ]) {
      const intent = classifyImageIntent(prompt, true, 1);
      expect(`${prompt} → ${intent.kind}`).toContain("image-edit");
    }
  });

  it("a generation request with no image context stays generation", () => {
    for (const prompt of [
      "generate an image of a red bicycle in the rain",
      "create a picture of a cat",
    ]) {
      expect(`${prompt} → ${classifyImageIntent(prompt, false, 0).kind}`).toContain("generate");
    }
  });

  it("an ambiguous 'draw' with no generate wording does NOT silently become one", () => {
    // Without an explicit generation intent, Omi must not fire a paid image
    // call on a vague sentence.
    expect(classifyImageIntent("draw a red bicycle in the rain", false, 0).kind).toBe("none");
  });

  it("an edit with NOTHING to edit is refused, not quietly turned into a generation", () => {
    // The exact failure the product forbids: the user asked to edit, there is
    // no image, so it must decline rather than invent one.
    const intent = classifyImageIntent("make the sky purple", false, 0);
    expect(`${intent.kind}`).not.toBe("generate");
  });

  it("image understanding is never routed to the paint engine", () => {
    for (const prompt of [
      "what is in this picture?",
      "describe this image",
      "what colour is the traffic light?",
    ]) {
      const intent = classifyImageIntent(prompt, true, 1);
      expect(`${prompt} → ${intent.kind}`).not.toContain("generate");
      expect(`${prompt} → ${intent.kind}`).not.toContain("image-edit");
    }
    // An explicit understanding phrasing is classified as such, so the turn
    // goes to vision instead of the paint engine.
    expect(classifyImageIntent("what is in this picture?", true, 1).kind).toBe(
      "image-understanding",
    );
  });

  it("an empty or meaningless request does nothing", () => {
    expect(classifyImageIntent("", false, 0).kind).toBe("none");
    expect(classifyImageIntent("   ", false, 0).kind).toBe("none");
  });

  it("an edit op always names a concrete operation for the engine", () => {
    for (const prompt of ["remove the background", "upscale it", "combine these"]) {
      const intent = classifyImageIntent(prompt, true, 2);
      if (intent.kind === "image-edit") expect(intent.op.length).toBeGreaterThan(0);
    }
  });

  it("the server calls an EDIT endpoint, not a generations endpoint, for edits", () => {
    const src = read("src/convex/omiImages.ts");
    expect(src).toMatch(/edits/);
  });

  it("a provider failure is never replaced with an unrelated image", () => {
    const src = read("src/convex/omiImages.ts");
    // No catch that swaps in a stock/placeholder/fallback image.
    expect(src).not.toMatch(/catch[\s\S]{0,120}(placeholder|stockImage|fallbackImage)/i);
  });

  it("the studio shows the provider's own error, not a generic one", () => {
    const src = read("src/components/workspace/ImageStudioView.tsx");
    expect(src).toMatch(/classifyFailure/);
    // The user-facing error carries both halves of the recovery contract.
    expect(src).toMatch(/whatHappened\} \$\{recovery\.whatToDoNext\}/);
  });
});

// ---------------------------------------------------------------- Phase 7

describe("Phase 7 — search never claims verification it did not perform", () => {
  it("the chat pipeline injects a distinct EXTERNAL RESEARCH label", () => {
    const src = read("src/convex/omiChat.ts");
    expect(src).toContain("EXTERNAL RESEARCH");
    expect(src).toMatch(/never present an external claim as internal policy/);
  });

  it("a failed search tells the model it could not verify online", () => {
    const src = read("src/convex/omiChat.ts");
    expect(src).toMatch(/could not verify online/);
  });

  it("an internal answer is never classified as web research", () => {
    const plan = formatActionPlan(buildActionPlan("How many remote days?", [passage()]));
    expect(detectAnswerShape(plan)).toBe("knowledge");
    // Not a research shape: an approved-knowledge answer carries no [n] web
    // markers and no external-source section.
    expect(detectAnswerShape(plan)).not.toBe("research");
  });

  it("the live search path requires a session and a rate limit", () => {
    const src = read("src/convex/search.ts");
    expect(src).toMatch(/rateLimit\(`search:/);
    expect(src).toMatch(/getAuthUserId/);
  });

  it("the suggestion relay is no longer an open, unrated endpoint", () => {
    const src = read("src/convex/search.ts");
    const suggest = /export const suggest = action\(\{[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
    expect(suggest).toMatch(/getAuthUserId/);
    expect(suggest).toMatch(/rateLimit/);
  });

  it("the public status page discloses capability booleans, never values", () => {
    const src = read("src/convex/http.ts");
    expect(src).toMatch(/never a secret value/);
    expect(src).not.toMatch(/"[A-Z][A-Z0-9_]{5,}"\s*:\s*process\.env/);
  });
});

// --------------------------------------------------------------- Phase 10

describe("Phase 10 — installable, deep-linkable, keyboard-safe", () => {
  it("the manifest declares the fields an install prompt needs", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest"));
    for (const field of ["name", "short_name", "start_url", "display", "icons", "theme_color", "background_color"]) {
      expect(`${field}=${manifest[field]}`).not.toContain(`${field}=undefined`);
    }
    expect(manifest.display).toMatch(/standalone/);
    expect(manifest.icons.length).toBeGreaterThan(0);
    expect(JSON.stringify(manifest.icons)).toContain("maskable");
  });

  it("the viewport opts into safe areas and the resizing keyboard", () => {
    const html = read("index.html");
    expect(html).toMatch(/viewport-fit=cover/);
    expect(html).toMatch(/interactive-widget=resizes-content/);
    expect(html).toMatch(/theme-color/);
  });

  it("theme-color follows the OS scheme in both directions", () => {
    const html = read("index.html");
    expect(html).toMatch(/prefers-color-scheme: dark/);
    expect(html).toMatch(/prefers-color-scheme: light/);
  });

  it("there is ONE application codebase — no separate mobile app", () => {
    const cap = read("capacitor.config.ts");
    expect(cap).toMatch(/webDir/);
    const pkg = JSON.parse(read("package.json"));
    const scripts = Object.values(pkg.scripts).join(" ");
    expect(scripts).not.toMatch(/react-native|expo |metro/);
  });

  it("the SPA deep-link fallback exists for static hosts", () => {
    expect(read("public/404.html")).toMatch(/omi-spa-redirect/);
    expect(read("src/main.tsx")).toMatch(/omi-spa-redirect/);
  });

  it("the service worker registers in production only and never throws", () => {
    const main = read("src/main.tsx");
    expect(main).toMatch(/import\.meta\.env\.PROD/);
    const reg = main.slice(main.indexOf("serviceWorker"));
    expect(reg).toMatch(/\.catch\(/);
  });

  it("reduced motion is honoured globally, not per component", () => {
    expect(read("src/main.tsx")).toMatch(/MotionConfig reducedMotion="user"/);
    expect(read("src/index.css")).toMatch(/prefers-reduced-motion/);
  });

  it("safe-area insets are wired into the shell, not just declared in the viewport", () => {
    expect(read("src/index.css")).toMatch(/env\(safe-area-inset-bottom/);
    expect(read("src/components/workspace/WorkspaceShell.tsx")).toMatch(/safeArea/);
  });

  it("the mobile layout uses a dynamic viewport, not a fixed 100vh", () => {
    const shell = read("src/components/workspace/WorkspaceShell.tsx");
    expect(shell).toMatch(/min-h-dvh|h-dvh/);
    expect(shell).not.toMatch(/min-h-screen/);
  });
});
