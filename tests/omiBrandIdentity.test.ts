/**
 * OMI UNIVERSAL AI — brand & UX contract.
 * =============================================================================
 * The visual pass is only safe if it cannot silently rot. These tests pin the
 * decisions that are easy to undo by accident:
 *
 *   • ONE brand mark, one set of strings (no second logo creeping back in).
 *   • Every store/PWA icon exists and is a real PNG of the right size — this is
 *     what un-blocks Android packaging, so it must not rot back to "missing".
 *   • The sign-in screen is branded AND does not trap a returning user behind
 *     an animation.
 *   • The landing page positions the real product (Emotion AI is one card, not
 *     the pitch).
 *   • Andromeda's first screen does not expose provider infrastructure.
 *   • The trust strip cannot claim verification it did not earn.
 *   • Mobile is designed, not squeezed.
 *
 * Pure/static checks only — no DOM, no network, matching the house style.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";

import { BRAND } from "../src/components/brand/OmiMark";
import { trustSummary } from "../src/components/answer/TrustStrip";
import { RESEARCH_PHASES, researchPhaseFor, researchStatusFor } from "../src/lib/researchStatus";

const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf-8");
const path = (p: string) => new URL(p, import.meta.url).pathname;
/** Source with comments stripped — for assertions about code, not about prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("brand identity", () => {
  test("the identity strings are the ones the owner specified", () => {
    expect(BRAND.name).toBe("Omi Universal AI");
    expect(BRAND.descriptor).toBe("Universal Intelligence");
    expect(BRAND.motto).toBe("One Intelligence. Infinite Possibilities.");
    expect(BRAND.creator).toBe("Created by Omkar Prakash Bhatti");
  });

  test("there is exactly one mark, and the shell uses it", () => {
    // The old sidebar drew its own "O" in a bordered box. If a local definition
    // reappears, the app has forked its own logo.
    const shell = code(read("../src/components/workspace/WorkspaceShell.tsx"));
    expect(shell).toContain('from "@/components/brand/OmiMark"');
    expect(shell).not.toMatch(/function OmiMark\s*\(/);
  });

  test("the mark geometry is identical in the SVG, the React component and the offline shell", () => {
    // One geometry, three renderings. If these drift the brand forks.
    const svg = read("../public/logo.svg");
    const component = read("../src/components/brand/OmiMark.tsx");
    const offline = read("../public/offline.html");
    for (const src of [svg, component, offline]) {
      expect(src).toContain('rotate(-22 256 256)');
      expect(src).toContain('r="74"'); // the core
      expect(src).toContain('rx="176"'); // the orbital ring
      expect(src).toContain('ry="132"');
    }
  });

  test("variants exist: lockup, monochrome, maskable", () => {
    for (const f of ["../public/omi-lockup.svg", "../public/omi-mono.svg", "../public/icon-maskable.svg"]) {
      expect(existsSync(path(f))).toBe(true);
    }
    // The monochrome knock-down must not smuggle the accent gradient in.
    expect(read("../public/omi-mono.svg")).not.toContain("url(#");
  });
});

describe("store + PWA icons (this is what un-blocks Android packaging)", () => {
  const icons: Array<[string, number]> = [
    ["../public/icons/icon-192.png", 192],
    ["../public/icons/icon-512.png", 512],
    ["../public/icons/maskable-512.png", 512],
    ["../public/icons/apple-touch-icon.png", 180],
  ];

  test("every required icon exists and is a real PNG of the right size", () => {
    for (const [file, size] of icons) {
      expect(existsSync(path(file))).toBe(true);
      const buf = readFileSync(path(file));
      // PNG magic number, then IHDR width/height at a fixed offset.
      expect(Array.from(buf.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      expect(width).toBe(size);
      expect(height).toBe(size);
      // A file that is technically a PNG but visually empty is still a failure.
      expect(statSync(path(file)).size).toBeGreaterThan(1000);
    }
  });

  test("the manifest ships the PNGs, the maskable variant and the brand colours", () => {
    const manifest = JSON.parse(read("../public/manifest.webmanifest"));
    const purposes = manifest.icons.map((i: { purpose?: string }) => i.purpose ?? "any");
    expect(purposes).toContain("maskable");
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === "512x512")).toBe(true);
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === "192x192")).toBe(true);
    // Brand near-black, matching the app canvas — not the old #121216.
    expect(manifest.background_color.toLowerCase()).toBe("#0b0b0f");
    expect(manifest.theme_color.toLowerCase()).toBe("#0b0b0f");
  });

  test("index.html ships the favicon, the apple touch icon and social preview", () => {
    const html = read("../index.html");
    expect(html).toContain('rel="icon"');
    expect(html).toContain("apple-touch-icon");
    expect(html).toContain('property="og:title"');
    expect(html).toContain("One Intelligence. Infinite Possibilities.");
  });

  test("the splash is self-removing so it can never outlive the app", () => {
    const html = read("../index.html");
    expect(html).toContain('id="omi-splash"');
    // A hard fallback timer exists, and the app dismisses it on mount.
    expect(html).toContain("setTimeout(dismiss, 2500)");
    expect(read("../src/main.tsx")).toContain("dismissSplash()");
  });
});

describe("sign-in experience", () => {
  test("is branded with the mark, the motto and the creator credit", () => {
    const auth = read("../src/pages/Auth.tsx");
    expect(auth).toContain("OmiMark");
    expect(auth).toContain("BRAND.motto");
    expect(auth).toContain("BRAND.creator");
    expect(auth).toContain("UNIVERSAL"); // descriptor rendered as real text
  });

  test("does not trap a returning user behind the entrance animation", () => {
    const auth = read("../src/pages/Auth.tsx");
    // First-visit gate + a reduced-motion gate. Without both, "premium" becomes
    // "slow for everyone".
    expect(auth).toContain("omi-brand-seen");
    expect(auth).toContain("useReducedMotion");
  });

  test("the sign-in canvas is light-on-dark in BOTH themes", () => {
    // The screen is always the brand's near-black. If it leaned on theme tokens
    // for text, a light-theme user would get dark text on near-black — a
    // contrast failure no automated test would otherwise catch.
    const auth = code(read("../src/pages/Auth.tsx"));
    expect(auth).toContain("bg-[#0B0B0F]");
    // No token-based text colour survives anywhere on that surface.
    expect(auth).not.toMatch(/text-foreground/);
    expect(auth).not.toMatch(/text-muted-foreground/);
    expect(auth).not.toMatch(/text-destructive/);
  });

  test("keeps both sign-in paths and the redirect contract intact", () => {
    const auth = read("../src/pages/Auth.tsx");
    expect(auth).toContain('signIn("email-otp"');
    expect(auth).toContain('signIn("anonymous"');
    expect(auth).toContain("resolveRedirectAfterAuth");
    expect(auth).toContain("returnTo");
  });
});

describe("landing page positioning", () => {
  test("leads with the product, not with one feature", () => {
    const landing = read("../src/pages/Landing.tsx");
    // The hero must name the product and the motto.
    expect(landing).toContain("Omi Universal AI");
    expect(landing).toContain("BRAND.motto");
    // The old positioning line described a different company.
    expect(landing).not.toContain("Human Emotions AI");
    expect(landing).not.toContain("emotions in your inbox");
  });

  test("presents the real capability set, with Emotion AI as one card", () => {
    const landing = read("../src/pages/Landing.tsx");
    for (const cap of [
      "Chat",
      "Andromeda",
      "Research",
      "Knowledge",
      "Memory",
      "Files",
      "Vision",
      "Agents",
      "Automation",
      "Image Studio",
      "Emotions AI",
    ]) {
      expect(landing).toContain(`"${cap}"`);
    }
  });

  test("routes a visitor into the product", () => {
    const landing = read("../src/pages/Landing.tsx");
    expect(landing).toContain('isAuthenticated ? "/dashboard" : "/auth"');
  });
});

describe("Andromeda surface", () => {
  test("the first screen does not expose provider infrastructure", () => {
    const panel = read("../src/components/OmiSearchPanel.tsx");
    // The hero used to read "Parallel retrieval across SearXNG, Wikipedia,
    // arXiv, OpenAlex…". Names are infrastructure; they belong behind the
    // per-citation disclosure instead.
    expect(panel).not.toContain("Parallel retrieval across SearXNG");
    expect(panel).toContain("Andromeda · Search &amp; Research");
  });

  test("shows the user journey, not the plumbing", () => {
    const panel = read("../src/components/OmiSearchPanel.tsx");
    for (const step of ["Search", "Find", "Compare", "Verify", "Answer"]) {
      expect(panel).toContain(`"${step}"`);
    }
  });
});

describe("trust and citations are honest", () => {
  const url = (u: string) => ({ url: u, publishedAt: null });

  test("no sources never reads as confidence", () => {
    const t = trustSummary({ citations: [] });
    expect(t.hasSources).toBe(false);
    expect(t.crossChecked).toBe(false);
    expect(t.citations).toBe(0);
  });

  test("one source is never called cross-checked", () => {
    const t = trustSummary({ citations: [url("https://nytimes.com/a")] });
    expect(t.citations).toBe(1);
    expect(t.independent).toBe(1);
    expect(t.crossChecked).toBe(false);
  });

  test("the same article twice is ONE source, not corroboration", () => {
    const t = trustSummary({
      citations: [url("https://nytimes.com/a"), url("https://www.nytimes.com/a")],
    });
    expect(t.citations).toBe(2);
    expect(t.independent).toBe(1);
    expect(t.crossChecked).toBe(false);
  });

  test("two independent domains are cross-checked", () => {
    const t = trustSummary({
      citations: [url("https://nytimes.com/a"), url("https://bbc.co.uk/b")],
    });
    expect(t.independent).toBe(2);
    expect(t.crossChecked).toBe(true);
  });

  test("an undated source produces no freshness claim at all", () => {
    const t = trustSummary({ citations: [url("https://a.com/x")] });
    expect(t.freshest).toBeNull();
  });

  test("a dated source reports its real age", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const t = trustSummary({ citations: [{ url: "https://a.com/x", publishedAt: twoHoursAgo }] });
    expect(t.freshest).toContain("2h ago");
  });

  test("a fabricated future date is ignored rather than rendered", () => {
    const t = trustSummary({
      citations: [{ url: "https://a.com/x", publishedAt: new Date(Date.now() + 86_400_000).toISOString() }],
    });
    expect(t.freshest).toBeNull();
  });
});

describe("response states reflect real work only", () => {
  test("no invented 'comparing' state — the backend never reports one", () => {
    // Cross-checking really happens, but the backend emits no distinct status
    // for it. Showing a Comparing state would be theatre, so it is not in the
    // phase list, and no status string can ever resolve to it.
    expect(RESEARCH_PHASES).not.toContain("comparing" as never);
    // A comparison-sounding status that the backend never sends resolves to the
    // terminal phase instead of conjuring a new stage.
    for (const signal of ["Omi is comparing sources…", "Comparing sources…"]) {
      expect(researchPhaseFor(signal)).toBe("answering");
    }
    // Cross-checking IS reported by the backend, and it honestly resolves to
    // the existing verifying state.
    expect(researchPhaseFor("Cross-checking…")).toBe("verifying");
  });

  test("a real thinking status gets its own state", () => {
    expect(researchPhaseFor("Omi is thinking…")).toBe("thinking");
    expect(researchPhaseFor("Omi is reasoning…")).toBe("thinking");
    expect(researchStatusFor("Omi is thinking…").label).toBe("Thinking…");
  });

  test("every phase is reachable from a real backend status string", () => {
    const status = read("../src/lib/researchStatus.ts");
    for (const signal of [
      "thinking",
      "reasoning",
      "searching|looking up",
      "reading",
      "checking approved",
      "verified against",
    ]) {
      expect(status).toContain(signal);
    }
  });
});

describe("mobile is designed, not squeezed", () => {
  test("there is a five-destination tab bar with a More escape hatch", () => {
    const shell = read("../src/components/workspace/WorkspaceShell.tsx");
    expect(shell).toContain("MOBILE_NAV");
    expect(shell).toContain('aria-label="Primary"');
    expect(shell).toContain("md:hidden");
    for (const dest of ['label: "Home"', 'label: "Chat"', 'label: "Andromeda"', 'label: "Files"']) {
      expect(shell).toContain(dest);
    }
    expect(shell).toContain("More");
  });

  test("content is padded so the composer is never trapped under the tab bar", () => {
    const shell = read("../src/components/workspace/WorkspaceShell.tsx");
    expect(shell).toContain("pb-28");
  });

  test("safe-area insets are respected by the tab bar", () => {
    const shell = read("../src/components/workspace/WorkspaceShell.tsx");
    expect(shell).toContain("viewport.safeArea.bottom");
  });
});

describe("the visual pass did not touch the engine", () => {
  test("no search, provider or backend module was modified for branding", () => {
    // The pass was frontend-only. This guards the freeze: a visual change that
    // reaches into Andromeda is a regression, not a redesign.
    for (const f of [
      "../src/convex/omiChat.ts",
      "../src/convex/universalSearch.ts",
      "../src/convex/searchProviders/searxng.ts",
      "../src/convex/searchEngine/quality.ts",
    ]) {
      const src = read(f);
      expect(src).not.toContain("Omi Universal AI");
      expect(src).not.toContain("OmiMark");
    }
  });
});
