/**
 * Mobile layout maths (Phase 2) and long-thread windowing (Phase 3).
 *
 * Both concerns are extracted as pure functions so the behaviour that a real
 * Android device would exercise — on-screen keyboard insets, safe areas, 50+
 * message threads — is verifiable in CI instead of only by hand.
 *
 * No React here on purpose: the hooks in `src/hooks/` are thin wrappers.
 */

/** Breakpoints that match the Tailwind defaults the UI already uses. */
export const BREAKPOINTS = {
  /** Small phones (iPhone SE class, ~320–390 CSS px). */
  small: 640,
  /** Tablets and large phones in landscape. */
  tablet: 768,
  /** Laptop and up. */
  desktop: 1024,
} as const;

export type DeviceClass = "compact" | "phone" | "tablet" | "desktop";

export function deviceClassForWidth(width: number): DeviceClass {
  if (width < 360) return "compact";
  if (width < BREAKPOINTS.small) return "phone";
  if (width < BREAKPOINTS.tablet) return "phone";
  // A 1024–1280px viewport is an iPad in landscape or a small laptop window —
  // both are better served by the tablet layout than by the dense desktop one.
  if (width < 1280) return "tablet";
  return "desktop";
}

export const isTouchPrimary = (): boolean =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches ?? false);

/**
 * Minimum interactive size in CSS pixels. Anything tappable should be at
 * least this tall/wide, which is the WCAG 2.2 target-size floor and roughly
 * what an adult fingertip needs on a mid-range Android screen.
 */
export const MIN_TOUCH_TARGET = 44;

export type TouchTargetAudit = {
  className: string;
  width: number;
  height: number;
  ok: boolean;
  reason: string;
};

/**
 * Audit a utility-className for undersized interactive targets. This is a
 * static, deterministic check over the class strings the app actually uses —
 * it catches the common regressions (a `size-6` icon button, a `py-1` row)
 * without needing a device.
 *
 * A control is accepted if EITHER its base size is at least 44px, OR it
 * carries a small-screen override (`max-sm:size-11`) that raises it there.
 * The second form is how a compact desktop icon button stays comfortable on a
 * phone.
 *
 * `kind` is explicit because a class string alone cannot tell a real
 * `<button>` that never needed `cursor-pointer` from a plain `<div>`.
 */
export function auditTouchTarget(
  className: string,
  kind: "auto" | "control" | "container" = "auto",
): TouchTargetAudit {
  const tokens = className.split(/\s+/).filter(Boolean);
  const isButton =
    kind === "control" ||
    (kind === "auto" && /\b(Button|button)\b|cursor-pointer/.test(className));
  if (!isButton) {
    return {
      className,
      width: 0,
      height: 0,
      ok: true,
      reason: "not an interactive control",
    };
  }
  const px = (t: string | undefined): number => {
    if (!t) return Number.POSITIVE_INFINITY;
    const m = /(\d+)/.exec(t.slice(t.indexOf("-") + 1));
    if (!m) return Number.POSITIVE_INFINITY;
    return Number(m[1]) * 4; // Tailwind spacing scale: 1 unit = 0.25rem = 4px
  };
  const find = (re: RegExp): string | undefined => tokens.find((t) => re.test(t));

  const baseSize = find(/^size-(\d+|\[[^\]]+\])$/);
  const baseH = find(/^h-(\d+|\[[^\]]+\])$/);
  const baseW = find(/^w-(\d+|\[[^\]]+\])$/);
  const baseHeight = baseSize ? px(baseSize) : px(baseH);
  const baseWidth = baseSize ? px(baseSize) : px(baseW);

  // Any small-screen override that reaches 44px satisfies the requirement.
  const responsive = tokens.find(
    (t) =>
      /^(max-sm|max-md|max-lg|sm|md|lg):/.test(t) &&
      /^(size|h)-\d/.test(t.slice(t.indexOf(":") + 1)) &&
      px(t) >= MIN_TOUCH_TARGET,
  );
  if (responsive) {
    return {
      className,
      width: Number.isFinite(baseWidth) ? baseWidth : 0,
      height: Number.isFinite(baseHeight) ? baseHeight : 0,
      ok: true,
      reason: `small-screen override ${responsive} meets the ${MIN_TOUCH_TARGET}px target`,
    };
  }

  if (!Number.isFinite(baseHeight)) {
    return {
      className,
      width: Number.isFinite(baseWidth) ? baseWidth : 0,
      height: 0,
      ok: false,
      reason: `no explicit size or height class — the ${MIN_TOUCH_TARGET}px target cannot be guaranteed`,
    };
  }
  const smallest = Math.min(baseHeight, Number.isFinite(baseWidth) ? baseWidth : baseHeight);
  if (smallest >= MIN_TOUCH_TARGET) {
    return { className, width: baseWidth as number, height: baseHeight, ok: true, reason: "meets the 44px target" };
  }
  return {
    className,
    width: Number.isFinite(baseWidth) ? baseWidth : 0,
    height: baseHeight,
    ok: false,
    reason: `smallest dimension is ${smallest}px, below the ${MIN_TOUCH_TARGET}px minimum`,
  };
}

// ------------------------------------------------------------- keyboard

export type KeyboardState = {
  /** Pixels of the layout viewport hidden behind the on-screen keyboard. */
  inset: number;
  open: boolean;
};

export const KEYBOARD_OPEN_THRESHOLD = 120;

/**
 * Derive keyboard state from the VisualViewport.
 *
 * `window.innerHeight` reports the LAYOUT viewport, which on Android does not
 * shrink when the keyboard opens, while `visualViewport.height` does. The
 * difference is exactly the covered strip. A threshold guards against the
 * 3–5px jitter that mobile browsers emit while the keyboard animates in, so
 * the composer does not jump.
 */
export function keyboardStateFromViewport(
  visualViewportHeight: number | undefined,
  layoutViewportHeight: number,
  offsetTop = 0,
  threshold = KEYBOARD_OPEN_THRESHOLD,
): KeyboardState {
  if (typeof visualViewportHeight !== "number" || visualViewportHeight <= 0) {
    return { inset: 0, open: false };
  }
  const raw = layoutViewportHeight - visualViewportHeight - Math.max(0, offsetTop);
  const inset = Math.max(0, Math.round(raw));
  return { inset, open: inset >= threshold };
}

/**
 * Height available to the chat thread once the keyboard is open, the header
 * and the composer have taken their share. Never negative, so the thread can
 * never collapse to zero and look broken.
 */
export function threadHeightFor({
  viewportHeight,
  keyboardInset,
  headerHeight = 56,
  composerHeight = 132,
  minHeight = 180,
}: {
  viewportHeight: number;
  keyboardInset: number;
  headerHeight?: number;
  composerHeight?: number;
  minHeight?: number;
}): number {
  const usable = viewportHeight - keyboardInset - headerHeight - composerHeight;
  return Math.max(minHeight, Math.round(usable));
}

/** Bottom inset the composer must respect: the safe area plus keyboard cover. */
export function composerBottomInset(
  safeAreaBottom: number,
  keyboardInset: number,
): number {
  // When the keyboard is open it already covers the home-indicator strip, so
  // adding the safe area would push the composer off-screen.
  return keyboardInset > 0 ? 0 : Math.max(0, safeAreaBottom);
}

// ---------------------------------------------------------- safe areas

/**
 * Resolve CSS `env(safe-area-inset-*)` values at runtime. Returns zeros when
 * the environment does not expose them (desktop browsers, older WebViews).
 */
export function readSafeAreaInsets(
  probe: { getPropertyValue: (p: string) => string } | null | undefined,
): { top: number; right: number; bottom: number; left: number } {
  if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 };
  const read = (name: string): number => {
    const raw = probe.getPropertyValue(name).trim();
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    top: read("--omi-safe-top"),
    right: read("--omi-safe-right"),
    bottom: read("--omi-safe-bottom"),
    left: read("--omi-safe-left"),
  };
}

// ---------------------------------------------------------- thread window

export type ThreadWindowInput<T> = {
  messages: T[];
  /** Messages currently allowed to render. Grows as the user scrolls up. */
  budget: number;
  /** Hard ceiling so a 5000-message thread cannot lock the main thread. */
  maxRendered?: number;
  /** Ids (or keys) that must never be windowed out. */
  pinnedKeys?: string[];
  keyOf: (message: T) => string;
};

export type ThreadWindow<T> = {
  /** The slice to render, oldest → newest. */
  rendered: T[];
  /** How many older messages are hidden behind the "show earlier" control. */
  hiddenCount: number;
  /** True when the user can load more history. */
  hasEarlier: boolean;
};

/**
 * Window a long chat thread.
 *
 * Requirements, in order of importance:
 *   1. NEVER window out a streaming reply — the live token stream must stay
 *      mounted or the stream appears to stall.
 *   2. Never render more than `maxRendered`, so a 200-message thread cannot
 *      turn into a multi-second layout.
 *   3. Always keep the newest messages; older ones load on demand.
 */
export function windowThread<T>({
  messages,
  budget,
  maxRendered = 80,
  pinnedKeys = [],
  keyOf,
}: ThreadWindowInput<T>): ThreadWindow<T> {
  const limit = Math.max(1, Math.min(Math.floor(budget), Math.floor(maxRendered)));
  if (messages.length <= limit) {
    return { rendered: messages, hiddenCount: 0, hasEarlier: false };
  }
  // Reserve room for every pinned message so the live stream is never cut.
  const pins = new Set(pinnedKeys);
  const pinnedAtBottom = messages.filter((m) => pins.has(keyOf(m)));
  const tailCount = Math.max(1, limit - pinnedAtBottom.length);
  const start = Math.max(0, messages.length - tailCount);
  const tail = messages.slice(start);
  const missingPins = pinnedAtBottom.filter((m) => !tail.includes(m));
  const rendered = [...tail, ...missingPins].sort(
    (a, b) => messages.indexOf(a) - messages.indexOf(b),
  );
  return {
    rendered,
    hiddenCount: messages.length - rendered.length,
    hasEarlier: start > 0,
  };
}

/** Starting budget: small screens render fewer messages to stay smooth. */
export function initialThreadBudget(width: number): number {
  if (width < 360) return 20;
  if (width < BREAKPOINTS.small) return 30;
  if (width < BREAKPOINTS.tablet) return 40;
  return 60;
}

/** How many more messages to reveal when the user taps "show earlier". */
export function nextThreadBudget(current: number, width: number): number {
  return Math.min(
    400,
    Math.max(current + 20, Math.round(current * 1.6), initialThreadBudget(width) + 20),
  );
}
