import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";

type WorkspaceStatusQuery = FunctionReference<"query", "public", {}, {
  backendOk: boolean;
  aiOk: boolean;
  aiActiveProvider: string | null;
  aiCost: string;
  aiConfigured: boolean;
  aiFree: boolean;
  searchOk: boolean;
  searchConfigured: boolean;
  searchReady: boolean;
  searchGeneralWebOk: boolean;
  imageOk: boolean;
  imageConfigured: boolean;
  imageGen: boolean;
  imageGenerationAvailable: boolean;
  recordedAt: number;
}, string | undefined>;
import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Lightbulb,
  RefreshCw,
  Wifi,
} from "lucide-react";
import { cn } from "@/lib/utils";

type BackendRow = {
  label: string;
  ok: boolean;
  detail: string;
  action?: string;
};

type ConvexStatusCardProps = {
  className?: string;
};

export function ConvexStatusCard({ className }: ConvexStatusCardProps) {
  const status = useQuery(api.omiHealth.workspaceStatus as WorkspaceStatusQuery);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div
        className={cn(
          "rounded-xl border border-border/60 bg-card/70 p-4 text-sm",
          className,
        )}
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          <span>Checking workspace backend…</span>
        </div>
      </div>
    );
  }

  const rows = backendRows(status);

  return (
    <div
      className={cn(
        "rounded-xl border bg-card/70 p-4 text-sm shadow-sm",
        className,
      )}
    >
      <div className="mb-3 flex items-center gap-2 text-foreground">
        {status?.backendOk ? (
          <>
            <CheckCircle2 className="size-4 text-primary" />
            <span className="font-medium">Workspace backend online</span>
          </>
        ) : (
          <>
            <AlertCircle className="size-4 text-primary" />
            <span className="font-medium">Workspace backend not ready</span>
          </>
        )}
      </div>

      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.label}
            className="flex items-start gap-2 rounded-md bg-background/40 px-3 py-2 text-xs"
          >
            {r.ok ? (
              <CheckCircle2 className="mt-0.5 shrink-0 size-3.5 text-primary" />
            ) : (
              <AlertCircle className="mt-0.5 shrink-0 size-3.5 text-primary" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{r.label}</p>
              <p className="mt-0.5 text-muted-foreground">{r.detail}</p>
              {r.action && (
                <p className="mt-1 text-muted-foreground">{r.action}</p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {!status?.backendOk && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          <Wifi className="size-3.5" />
          <span>
            Speech output, file reading and memory still work locally. Chat,
            search and image generation wait on the free backend until the
            workspace owner configures it.
          </span>
        </div>
      )}
    </div>
  );
}

function backendRows(status: {
  backendOk: boolean;
  aiOk: boolean;
  aiActiveProvider: string | null;
  aiCost: string;
  aiConfigured: boolean;
  aiFree: boolean;
  searchOk: boolean;
  searchConfigured: boolean;
  searchReady: boolean;
  searchGeneralWebOk: boolean;
  imageOk: boolean;
  imageConfigured: boolean;
  imageGen: boolean;
  imageGenerationAvailable: boolean;
  recordedAt: number;
} | undefined): BackendRow[] {
  if (!status) {
    return [
      {
        label: "Backend connection",
        ok: false,
        detail: "The workspace backend did not reply.",
        action: "Refresh the page or sign in again.",
      },
    ];
  }

  const rows: BackendRow[] = [];

  rows.push({
    label: "Convex backend",
    ok: status.backendOk,
    detail:
      status.backendOk
        ? "Your workspace data is stored on Convex."
        : "The Convex backend did not respond as expected.",
    action: status.backendOk
      ? undefined
      : "Check that the workspace is running and connected.",
  });

  if (status.aiOk) {
    rows.push({
      label: "Free AI provider",
      ok: true,
      detail:
        `Active: ${status.aiActiveProvider ?? "auto"} — chat and reasoning use ` +
        `${status.aiCost === "free" ? "a free-tier provider" : status.aiCost}.`,
      action: status.aiFree
        ? "Free inference is available for this workspace."
        : "Configure a free-tier provider to enable AI answers.",
    });
  } else {
    rows.push({
      label: "Free AI provider",
      ok: false,
      detail:
        status.aiConfigured
          ? "A provider is configured but not answering right now."
          : "No free AI provider is configured for this workspace yet.",
      action:
        status.aiConfigured
          ? "Retry in a moment. If it keeps failing, the free tier may be exhausted or rate-limited."
          : "The workspace owner configures a free provider key in Settings.",
    });
  }

  if (status.searchOk) {
    rows.push({
      label: "General-web search",
      ok: status.searchReady,
      detail:
        status.searchReady
          ? "SearXNG (or the active search backend) is answering."
          : "Search is configured but not answering right now.",
      action:
        status.searchReady
          ? undefined
          : "Retry the search. If it keeps failing, the search backend may be down or rate-limited.",
    });
  } else {
    rows.push({
      label: "General-web search",
      ok: false,
      detail:
        status.searchConfigured
          ? "Search is configured but not answering right now."
          : "No working general-web search backend is configured for this workspace yet.",
      action:
        status.searchConfigured
          ? "Retry the search. If it keeps failing, the search backend may be down."
          : "The workspace owner deploys and configures a free search backend.",
    });
  }

  if (status.imageOk) {
    rows.push({
      label: "Image generation",
      ok: true,
      detail:
        status.imageGen
          ? "Image generation is available from a free provider."
          : "Image generation is configured but not answering right now.",
      action: status.imageGen
        ? undefined
        : "Retry. If it keeps failing, the image provider may be rate-limited.",
    });
  } else {
    rows.push({
      label: "Image generation",
      ok: false,
      detail:
        status.imageConfigured
          ? "An image provider is configured but not answering right now."
          : "No free image provider is configured for this workspace yet.",
      action:
        status.imageConfigured
          ? "Retry. If it keeps failing, the image provider may be rate-limited or quota-exhausted."
          : "Configure a free image provider to enable generation.",
    });
  }

  return rows;
}
