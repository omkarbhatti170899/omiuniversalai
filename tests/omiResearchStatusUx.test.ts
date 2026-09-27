/**
 * UX REGRESSION — the calm research status (spec §10–§13).
 *
 * The reported problem was a choppy interface: constantly moving progress
 * bars, restarting animations, layout that jumped while an answer streamed in,
 * and a spinner that could outlive its work.
 *
 * These tests pin the contract that replaces it. They are mostly about
 * *absence* — no fake percentage, no indefinite spinner, no state invented to
 * keep an animation alive — which is the part that quietly regresses.
 */

import { describe, expect, it } from "bun:test";
import {
  researchStatusFor,
  researchPhaseFor,
  parseSourceCount,
  shouldAnimate,
  RESEARCH_PHASES,
} from "../src/lib/researchStatus";

describe("calm research status — real states, not a moving bar", () => {
  it("maps the real backend status text to a phase", () => {
    // These are the strings omiChat actually patches into the live message.
    expect(researchPhaseFor("Omi is looking up live news search…")).toBe("searching");
    expect(researchPhaseFor("Omi is searching the web…")).toBe("searching");
    expect(researchPhaseFor("Reading 12 sources…")).toBe("reading");
    expect(researchPhaseFor("Verified against 3 sources")).toBe("verifying");
    expect(researchPhaseFor("Omi is checking approved knowledge…")).toBe("verifying");
  });

  it("always reaches a terminal state, so no spinner can run forever", () => {
    for (const final of [true, false]) {
      for (const status of [
        "Omi is looking up live news search…",
        "Reading 5 sources…",
        "Verified against 2 sources",
        "Omi is searching the web…",
      ]) {
        const state = researchStatusFor(status, { final });
        expect(RESEARCH_PHASES).toContain(state.phase);
        // A finished turn is always settled.
        if (final) expect(state.settled).toBe(true);
      }
    }
  });

  it("reports the REAL counts the backend measured", () => {
    expect(parseSourceCount("Reading 12 sources…")).toBe(12);
    expect(parseSourceCount("Verified against 3 sources")).toBe(3);
    expect(parseSourceCount("Omi is searching the web…")).toBeUndefined();

    const reading = researchStatusFor("Reading 12 sources…");
    expect(reading.label).toBe("Found 12 sources");

    const verified = researchStatusFor("Verified against 3 sources");
    expect(verified.label).toBe("Verified against 3 sources");
  });

  it("uses correct singular/plural for a single source", () => {
    expect(researchStatusFor("Reading 1 sources…").label).toBe("Found 1 source");
    expect(researchStatusFor("Verified against 1 source").label).toBe(
      "Verified against 1 source",
    );
  });

  it("never invents a percentage or a fake ETA", () => {
    const states = [
      researchStatusFor("Omi is searching the web…"),
      researchStatusFor("Reading 9 sources…"),
      researchStatusFor("Verified against 4 sources", { final: true }),
    ];
    for (const s of states) {
      // The only numeric progress exposed is a step fraction, and it is not
      // rendered as a percentage anywhere in the UI.
      expect(s.label).not.toMatch(/\d+\s*%/);
      expect(s.label.toLowerCase()).not.toMatch(/eta|remaining|about \d+ ?s/);
    }
  });

  it("does not invent a phase for status text it does not recognise", () => {
    // Unknown text resolves to a real terminal-ish phase rather than a new
    // animated stage that would keep restarting.
    const state = researchStatusFor("something unexpected happened here");
    expect(state.phase).toBe("answering");
    expect(RESEARCH_PHASES).toContain(state.phase);
  });

  it("reports a failure as a settled state, not a spinner", () => {
    const state = researchStatusFor("Live search is currently unavailable, so I can't verify this.");
    expect(state.phase).toBe("failed");
    expect(state.settled).toBe(true);
    expect(shouldAnimate(state)).toBe(false);
  });

  it("animates only the single active step, and only while running", () => {
    expect(shouldAnimate(researchStatusFor("Omi is searching the web…"))).toBe(true);
    // Finished, failed and idle are all static.
    expect(shouldAnimate(researchStatusFor("x", { final: true }))).toBe(false);
    expect(shouldAnimate(researchStatusFor("Live search is currently unavailable"))).toBe(false);
    expect(shouldAnimate(researchStatusFor(""))).toBe(false);
  });

  it("keeps the label short enough not to wrap on a phone", () => {
    for (const status of [
      "Omi is looking up live news search…",
      "Reading 1200 sources…",
      "Verified against 300 sources",
    ]) {
      const label = researchStatusFor(status).label;
      expect(label.length).toBeLessThan(40);
    }
  });

  it("is deterministic — the same status always yields the same output", () => {
    const status = "Reading 7 sources…";
    expect(researchStatusFor(status)).toEqual(researchStatusFor(status));
  });

  it("advances monotonically through the known steps", () => {
    const steps = [
      researchStatusFor("Omi is searching the web…").completedSteps,
      researchStatusFor("Reading 7 sources…").completedSteps,
      researchStatusFor("Verified against 3 sources").completedSteps,
    ];
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });
});

describe("UX contract — no decorative animation left in the chat surfaces", () => {
  it("the assistant panel no longer renders the five-step progress ladder", async () => {
    // The ladder caused the page to resize while streaming. The replacement is
    // a single fixed-height line.
    const source = await Bun.file("src/components/OmiAssistantPanel.tsx").text();
    expect(source).not.toContain("PROGRESS_STAGES");
    expect(source).toContain("ResearchStatusLine");
  });

  it("reserves space for streaming content so the bubble does not jump", async () => {
    const source = await Bun.file("src/components/OmiAssistantPanel.tsx").text();
    expect(source).toContain("min-h-[3rem]");
  });

  it("the research status line is a fixed height", async () => {
    const source = await Bun.file("src/components/workspace/ResearchStatus.tsx").text();
    // A fixed row height is what stops everything below it from shifting.
    expect(source).toContain("h-5");
    expect(source).toContain("aria-live");
  });

  it("no element pulses in the chat input or the image gallery", async () => {
    const panel = await Bun.file("src/components/OmiAssistantPanel.tsx").text();
    const studio = await Bun.file("src/components/workspace/ImageStudioView.tsx").text();
    expect(panel).not.toContain("animate-pulse");
    expect(studio).not.toContain("animate-pulse");
  });

  it("image placeholders still reserve their final size", async () => {
    const studio = await Bun.file("src/components/workspace/ImageStudioView.tsx").text();
    // Static, but the aspect ratio is fixed so the grid never reflows.
    expect(studio).toContain("aspect-square");
  });
});
