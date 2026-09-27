import { useEffect, useState } from "react";

/**
 * Global network status (master plan §18 — Online / Offline / restored).
 *
 * Omi's failures are already explained in place (see `lib/failureRecovery.ts`),
 * but there was no app-wide signal for the one condition a user can do nothing
 * about locally: the device being offline. Without it, a stalled send looks
 * like Omi freezing.
 *
 * This reports only what the browser can actually know — `navigator.onLine`
 * plus the `online`/`offline` events. It deliberately does NOT probe the
 * network to "verify" connectivity: a synthetic ping would be a fake signal,
 * and the real request is the real test.
 */
export type NetworkStatus = {
  online: boolean;
  /**
   * True for a few seconds after connectivity returns, so the UI can confirm
   * recovery ("Back online") instead of silently vanishing — the bar leaving
   * without a word reads as a glitch.
   */
  restored: boolean;
};

export function useNetworkStatus(): NetworkStatus {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const handleOnline = () => {
      setOnline(true);
      setRestored(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRestored(false), 4000);
    };

    const handleOffline = () => {
      setOnline(false);
      setRestored(false);
      if (timer) clearTimeout(timer);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { online, restored };
}
