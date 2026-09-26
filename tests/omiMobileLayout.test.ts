import { describe, expect, it } from "bun:test";
import {
  BREAKPOINTS,
  KEYBOARD_OPEN_THRESHOLD,
  MIN_TOUCH_TARGET,
  auditTouchTarget,
  composerBottomInset,
  deviceClassForWidth,
  initialThreadBudget,
  isTouchPrimary,
  keyboardStateFromViewport,
  nextThreadBudget,
  readSafeAreaInsets,
  threadHeightFor,
  windowThread,
} from "@/lib/mobileLayout";

// A message stand-in with a stable key, like the real chat shape.
type Msg = { id: string; streaming?: boolean };
const msgs = (n: number, streaming = false): Msg[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, streaming: streaming && i === n - 1 }));
const keyOf = (m: Msg): string => m.id;

describe("mobile layout — device classification (Phase 1/2)", () => {
  it("maps the real device widths the QA matrix covers", () => {
    expect(deviceClassForWidth(320)).toBe("compact"); // small Android
    expect(deviceClassForWidth(360)).toBe("phone"); // mid-range Android
    expect(deviceClassForWidth(390)).toBe("phone"); // iPhone 14
    expect(deviceClassForWidth(412)).toBe("phone"); // large Android
    expect(deviceClassForWidth(768)).toBe("tablet"); // iPad portrait
    expect(deviceClassForWidth(1024)).toBe("tablet"); // iPad landscape
    expect(deviceClassForWidth(1440)).toBe("desktop");
  });

  it("breakpoints match the Tailwind defaults the UI already uses", () => {
    expect(BREAKPOINTS.small).toBe(640);
    expect(BREAKPOINTS.tablet).toBe(768);
    expect(BREAKPOINTS.desktop).toBe(1024);
  });

  it("isTouchPrimary is false when there is no window (SSR / tests)", () => {
    expect(typeof isTouchPrimary()).toBe("boolean");
  });
});

describe("mobile layout — touch targets (Phase 2)", () => {
  it("accepts the composer and header controls the app actually uses", () => {
    for (const cls of [
      // OmiAssistantPanel composer buttons: 44px on a phone, 36px on desktop.
      "flex size-11 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 sm:size-9",
      "flex size-11 cursor-pointer items-center justify-center rounded-lg transition-colors sm:size-9",
      "flex h-11 w-full items-center gap-3 rounded-lg",
      // shadcn Button size="icon" — the whole app's icon-button target.
      "inline-flex size-9 max-sm:size-11",
    ]) {
      const audit = auditTouchTarget(cls, "control");
      expect(`${cls} → ${audit.reason}`).toContain("meets");
    }
  });

  it("flags the pre-fix composer button that was 36px on every device", () => {
    // This is the regression the audit exists to catch: a bare size-9 with no
    // small-screen override is a mis-tap on a phone.
    expect(auditTouchTarget("flex size-9 cursor-pointer items-center justify-center").ok).toBe(false);
    expect(auditTouchTarget("flex size-9 cursor-pointer max-sm:size-11").ok).toBe(true);
  });

  it("rejects a 24px icon button — the classic mis-tap regression", () => {
    const a = auditTouchTarget("flex size-6 cursor-pointer items-center justify-center");
    expect(a.ok).toBe(false);
    expect(a.reason).toContain(`${MIN_TOUCH_TARGET}px`);
    expect(a.height).toBe(24);
  });

  it("rejects a thin tappable row even when it is full width", () => {
    const a = auditTouchTarget("w-full cursor-pointer py-1 text-xs");
    expect(a.ok).toBe(false);
  });

  it("ignores non-interactive elements", () => {
    expect(auditTouchTarget("flex items-center gap-2 px-3 py-2").ok).toBe(true);
    expect(auditTouchTarget("flex h-11 w-full items-center gap-3 rounded-lg").ok).toBe(true);
  });
});

describe("mobile layout — on-screen keyboard (Phase 2)", () => {
  it("computes the covered strip as layout viewport minus visual viewport", () => {
    // Layout 800, visual 480 when a 320px keyboard is open.
    const s = keyboardStateFromViewport(480, 800);
    expect(s.inset).toBe(320);
    expect(s.open).toBe(true);
  });

  it("ignores the few pixels mobile browsers jitter while animating in", () => {
    // 800 -> 790 is a 10px shrink, far below the 120px threshold.
    const s = keyboardStateFromViewport(790, 800);
    expect(s.inset).toBe(10);
    expect(s.open).toBe(false);
    expect(KEYBOARD_OPEN_THRESHOLD).toBeGreaterThan(50);
  });

  it("treats an exactly-at-threshold shrink as open", () => {
    expect(keyboardStateFromViewport(800 - KEYBOARD_OPEN_THRESHOLD, 800).open).toBe(true);
    expect(keyboardStateFromViewport(800 - KEYBOARD_OPEN_THRESHOLD + 1, 800).open).toBe(false);
  });

  it("accounts for a scrolled page (offsetTop)", () => {
    const s = keyboardStateFromViewport(500, 800, 40);
    expect(s.inset).toBe(260);
  });

  it("never reports a negative inset when the page is scrolled past the top", () => {
    expect(keyboardStateFromViewport(900, 800).inset).toBe(0);
    expect(keyboardStateFromViewport(900, 800, 300).inset).toBe(0);
  });

  it("degrades safely when the browser has no VisualViewport", () => {
    expect(keyboardStateFromViewport(undefined, 800)).toEqual({ inset: 0, open: false });
    expect(keyboardStateFromViewport(0, 800)).toEqual({ inset: 0, open: false });
    expect(keyboardStateFromViewport(null as unknown as number, 800).open).toBe(false);
  });

  it("gives the thread a real height with the keyboard open, and never zero", () => {
    const open = threadHeightFor({ viewportHeight: 800, keyboardInset: 320 });
    const closed = threadHeightFor({ viewportHeight: 800, keyboardInset: 0 });
    expect(open).toBeGreaterThanOrEqual(180);
    expect(open).toBeLessThan(closed);
    // A pathological viewport must not collapse the thread to nothing.
    expect(threadHeightFor({ viewportHeight: 200, keyboardInset: 320 })).toBe(180);
  });

  it("drops the safe-area bottom inset while the keyboard covers it", () => {
    expect(composerBottomInset(34, 0)).toBe(34);
    expect(composerBottomInset(34, 300)).toBe(0);
    expect(composerBottomInset(0, 0)).toBe(0);
  });
});

describe("mobile layout — safe areas (Phase 2/10)", () => {
  it("resolves env() values when the browser exposes them", () => {
    const probe = {
      getPropertyValue: (p: string) =>
        ({ "--omi-safe-top": "47px", "--omi-safe-bottom": "34px" })[p] ?? "0px",
    };
    expect(readSafeAreaInsets(probe)).toEqual({ top: 47, right: 0, bottom: 34, left: 0 });
  });

  it("resolves to zero when env() is unsupported (desktop, old WebView)", () => {
    expect(readSafeAreaInsets(null)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    const empty = { getPropertyValue: () => "" };
    expect(readSafeAreaInsets(empty).bottom).toBe(0);
  });
});

describe("mobile layout — long-conversation windowing (Phase 1/3)", () => {
  it("renders everything for a short thread", () => {
    const w = windowThread({ messages: msgs(12), budget: 30, keyOf });
    expect(w.rendered).toHaveLength(12);
    expect(w.hasEarlier).toBe(false);
    expect(w.hiddenCount).toBe(0);
  });

  it("windows a 50-message thread down to the newest slice", () => {
    const all = msgs(50);
    const w = windowThread({ messages: all, budget: 20, keyOf });
    expect(w.rendered).toHaveLength(20);
    expect(w.hiddenCount).toBe(30);
    expect(w.hasEarlier).toBe(true);
    // The newest message is always visible.
    expect(w.rendered[w.rendered.length - 1].id).toBe("m49");
  });

  it("handles a 500-message thread without exceeding the hard ceiling", () => {
    const w = windowThread({ messages: msgs(500), budget: 400, maxRendered: 80, keyOf });
    expect(w.rendered).toHaveLength(80);
    expect(w.rendered[79].id).toBe("m499");
    expect(w.hiddenCount).toBe(420);
  });

  it("NEVER windows out the streaming reply — the live stream must stay mounted", () => {
    const all = msgs(60, true);
    const streamingId = all[all.length - 1].id;
    const w = windowThread({
      messages: all,
      budget: 15,
      keyOf,
      pinnedKeys: [streamingId],
    });
    expect(w.rendered.some((m) => m.id === streamingId)).toBe(true);
  });

  it("keeps pinned messages in document order when they sit outside the tail", () => {
    const all = msgs(60);
    const w = windowThread({ messages: all, budget: 10, keyOf, pinnedKeys: ["m0"] });
    const ids = w.rendered.map((m) => m.id);
    expect(ids).toContain("m0");
    expect(ids[0]).toBe("m0");
    // Order must be the conversation order, not append order.
    const positions = ids.map((id) => all.findIndex((m) => m.id === id));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(w.rendered).toHaveLength(10);
  });

  it("never returns an empty window, even with a budget of zero", () => {
    const w = windowThread({ messages: msgs(5), budget: 0, keyOf });
    expect(w.rendered.length).toBeGreaterThanOrEqual(1);
  });

  it("an empty thread stays empty", () => {
    const w = windowThread({ messages: [], budget: 20, keyOf });
    expect(w.rendered).toEqual([]);
    expect(w.hasEarlier).toBe(false);
  });

  it("starts smaller on a small screen so first paint is fast", () => {
    expect(initialThreadBudget(320)).toBeLessThan(initialThreadBudget(1440));
    expect(initialThreadBudget(360)).toBe(30);
    expect(initialThreadBudget(1440)).toBe(60);
  });

  it("grows the budget on demand and is bounded", () => {
    const next = nextThreadBudget(30, 390);
    expect(next).toBeGreaterThan(30);
    expect(nextThreadBudget(390, 390)).toBeLessThanOrEqual(400);
    expect(nextThreadBudget(400, 390)).toBe(400);
  });
});
