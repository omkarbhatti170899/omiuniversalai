import { Wifi, WifiOff } from "lucide-react";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { cn } from "@/lib/utils";

/**
 * App-wide connectivity bar (master plan §18).
 *
 * Renders nothing while online — it must never add chrome to a healthy session.
 * While offline it states what is happening AND that nothing is lost; when the
 * connection returns it confirms recovery for a few seconds.
 *
 * A fixed overlay rather than a layout element on purpose: appearing/disappearing
 * in-flow would shift every page under the user's cursor. It is `role="status"`
 * + `aria-live="polite"` so screen readers announce it without stealing focus.
 */
export function NetworkStatusBar() {
  const { online, restored } = useNetworkStatus();
  if (online && !restored) return null;

  const offline = !online;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 px-3 py-1.5",
        "text-xs font-medium shadow-sm supports-[backdrop-filter]:backdrop-blur",
        offline
          ? "bg-amber-500/95 text-amber-950"
          : "bg-emerald-500/95 text-emerald-950",
      )}
    >
      {offline ? (
        <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Wifi className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span>
        {offline
          ? "You're offline — Omi will reconnect automatically. Your work stays saved."
          : "Back online"}
      </span>
    </div>
  );
}
