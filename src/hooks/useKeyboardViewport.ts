import { useEffect, useState } from "react";
import {
  deviceClassForWidth,
  keyboardStateFromViewport,
  readSafeAreaInsets,
  type DeviceClass,
  type KeyboardState,
} from "@/lib/mobileLayout";

export type KeyboardViewport = KeyboardState & {
  /** Tailwind-ish class the shell uses to size the mobile top bar. */
  deviceClass: DeviceClass;
  /** True below the `sm` breakpoint — where the mobile layout applies. */
  isNarrow: boolean;
  safeArea: { top: number; right: number; bottom: number; left: number };
};

const IDLE: KeyboardViewport = {
  inset: 0,
  open: false,
  deviceClass: "desktop",
  isNarrow: false,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
};

function readViewport(): KeyboardViewport {
  if (typeof window === "undefined") return IDLE;
  const vv = window.visualViewport;
  const probe: { getPropertyValue: (p: string) => string } | null =
    typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
  return {
    ...keyboardStateFromViewport(
      vv?.height,
      window.innerHeight,
      vv?.offsetTop ?? 0,
    ),
    deviceClass: deviceClassForWidth(window.innerWidth),
    isNarrow: window.innerWidth < 640,
    safeArea: readSafeAreaInsets(probe),
  };
}

/**
 * Track the on-screen keyboard and the current device class.
 *
 * Why this exists: on Android the on-screen keyboard shrinks the VISUAL
 * viewport but not the layout viewport, so a fixed bottom composer ends up
 * behind the keyboard and the user cannot see what they are typing. Watching
 * `visualViewport` is the only reliable way to know how much is covered.
 *
 * `visualViewport` is not in every browser, so the hook degrades to
 * `{ open: false, inset: 0 }` rather than assuming anything. It also listens
 * to a `resize` on the visual viewport, which is how Chrome Android and iOS
 * Safari both report the keyboard; the `window.resize` listener covers the
 * virtual-keyboard (resizes-content) path.
 */
export function useKeyboardViewport(): KeyboardViewport {
  const [state, setState] = useState<KeyboardViewport>(readViewport);

  useEffect(() => {
    const update = () => {
      setState((prev) => {
        const next = readViewport();
        // Avoid a re-render when nothing observable changed — this hook sits
        // at the top of the tree and re-renders the whole workspace.
        if (
          prev.inset === next.inset &&
          prev.open === next.open &&
          prev.deviceClass === next.deviceClass &&
          prev.isNarrow === next.isNarrow &&
          prev.safeArea.top === next.safeArea.top &&
          prev.safeArea.bottom === next.safeArea.bottom &&
          prev.safeArea.left === next.safeArea.left &&
          prev.safeArea.right === next.safeArea.right
        ) {
          return prev;
        }
        return next;
      });
    };

    update();
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return state;
}
