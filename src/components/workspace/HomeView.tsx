import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Bot,
  Code2,
  FolderKanban,
  Files as FilesIcon,
  Globe,
  ImagePlus,
  Loader2,
  MessageSquare,
  Search,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useState } from "react";
import { motion } from "framer-motion";
import type { WorkspaceView } from "@/components/workspace/WorkspaceShell";

type AuditEvent = {
  _id: Id<"omiAuditLog">;
  event: string;
  detail?: string;
  _creationTime: number;
};

type Task = {
  _id: Id<"omiTasks">;
  objective: string;
  status: "awaiting_approval" | "running" | "needs_input" | "done" | "failed";
};

type Capability = {
  id: string;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function HomeView({
  onNavigate,
  onAskOmi,
  onOpenImageStudio,
}: {
  onNavigate: (view: WorkspaceView) => void;
  onAskOmi: (query: string, mode: "chat" | "search") => void;
  onOpenImageStudio: (mode: "generate" | "edit") => void;
}) {
  const audit = useQuery(api.omiAudit.listMine);
  const agents = useQuery(api.omiAgents.listMine);
  const tasks = useQuery(api.omiTasks.listMine);

  const [ask, setAsk] = useState("");

  const handleAsk = (mode: "chat" | "search") => {
    const q = ask.trim();
    if (q.length < 2) return;
    onAskOmi(q, mode);
    setAsk("");
  };

  const capabilities: Capability[] = [
    {
      id: "chat",
      label: "Chat",
      desc: "Ask anything — Omi remembers your context",
      icon: MessageSquare,
      onClick: () => onNavigate("chat"),
    },
    {
      id: "search",
      label: "Search · Andromeda",
      desc: "Live web results with citations",
      icon: Search,
      onClick: () => onNavigate("search"),
    },
    {
      id: "create-image",
      label: "Create image",
      desc: "Text to image in Image Studio",
      icon: ImagePlus,
      onClick: () => onOpenImageStudio("generate"),
    },
    {
      id: "edit-image",
      label: "Edit image",
      desc: "Change, enhance or restyle a picture",
      icon: Wand2,
      onClick: () => onOpenImageStudio("edit"),
    },
    {
      id: "research",
      label: "Research",
      desc: "Multi-source deep research",
      icon: Globe,
      onClick: () => onNavigate("research"),
    },
    {
      id: "code",
      label: "Code",
      desc: "Write, review and debug with Omi",
      icon: Code2,
      onClick: () => onNavigate("chat"),
    },
    {
      id: "files",
      label: "Files",
      desc: "Upload documents Omi can quote",
      icon: FilesIcon,
      onClick: () => onNavigate("files"),
    },
    {
      id: "projects",
      label: "Projects",
      desc: "Keep work and context separate",
      icon: FolderKanban,
      onClick: () => onNavigate("projects"),
    },
  ];

  const pending = ((tasks ?? []) as Task[]).filter(
    (t) => t.status === "awaiting_approval" || t.status === "running",
  );

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      {/* Central ask-Omi experience */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="pt-6 text-center sm:pt-10"
      >
        <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-white/[0.02] px-3 py-1 text-[11px] text-muted-foreground">
          <Sparkles className="size-3 text-primary" />
          Omi Universal AI · created by Mr. Omkar Prakash Bhatti
        </span>

        <h1 className="mt-5 text-2xl font-semibold tracking-tight sm:text-[34px] sm:leading-tight">
          What can Omi do for you?
        </h1>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          One intelligence for chat, search, research, images and files — routed
          through Andromeda to whichever engine fits the job.
        </p>

        <div className="mx-auto mt-7 max-w-2xl">
          <div className="relative">
            <Sparkles className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAsk(e.shiftKey ? "search" : "chat");
                }
              }}
              placeholder="Ask Omi anything, or describe what you want…"
              aria-label="Ask Omi anything"
              className="h-14 rounded-2xl border-border/70 bg-white/[0.03] pl-11 pr-32 text-base shadow-none placeholder:text-muted-foreground/70 focus-visible:border-primary/40"
              maxLength={500}
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-9 cursor-pointer gap-1.5 text-xs text-muted-foreground"
                onClick={() => handleAsk("search")}
                disabled={ask.trim().length < 2}
              >
                <Globe className="size-3.5" />
                Web
              </Button>
              <Button
                size="icon"
                className="size-9 cursor-pointer rounded-xl"
                onClick={() => handleAsk("chat")}
                disabled={ask.trim().length < 2}
                aria-label="Ask Omi"
              >
                <Send className="size-4" />
              </Button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground/70">
            Enter to chat · Shift + Enter to search the web
          </p>
        </div>
      </motion.section>

      {/* Capability shortcuts */}
      <section>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {capabilities.map((c, i) => {
            const Icon = c.icon;
            return (
              <motion.button
                key={c.id}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: i * 0.025 }}
                onClick={c.onClick}
                className="group flex cursor-pointer flex-col items-start gap-3 rounded-xl border border-border/60 bg-white/[0.015] p-4 text-left transition-colors duration-150 hover:border-border hover:bg-white/[0.04]"
              >
                <span className="flex w-full items-center justify-between">
                  <span className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-white/[0.03] text-muted-foreground transition-colors group-hover:text-primary">
                    <Icon className="size-4" />
                  </span>
                  <ArrowRight className="size-3.5 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{c.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {c.desc}
                  </span>
                </span>
              </motion.button>
            );
          })}
        </div>
      </section>

      {/* Quiet status row */}
      <section className="grid gap-3 sm:grid-cols-3">
        <StatusPanel
          label="Agents ready"
          value={agents === undefined ? null : String(agents.length)}
          hint={
            agents && agents.length > 0
              ? "Specialists Omi can delegate to"
              : "Create one in Agents"
          }
          onClick={() => onNavigate("agents")}
        />
        <StatusPanel
          label="Needs you"
          value={tasks === undefined ? null : String(pending.length)}
          hint={
            pending.length > 0
              ? "Plans awaiting your approval"
              : "No approvals pending"
          }
          accent={pending.length > 0}
          onClick={() => onNavigate("tasks")}
        />
        <StatusPanel
          label="Andromeda"
          value={null}
          hint="Search, retrieval and research routing"
          onClick={() => onNavigate("search")}
        />
      </section>

      {/* Recent activity */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Recent activity</p>
          <Button
            variant="ghost"
            size="sm"
            className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onNavigate("tasks")}
          >
            View tasks
          </Button>
        </div>

        {audit === undefined ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : audit.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing yet. Ask Omi something above, or delegate work to an agent.
          </p>
        ) : (
          <ul className="divide-y divide-border/50 rounded-xl border border-border/60 bg-white/[0.01]">
            {(audit as AuditEvent[]).slice(0, 5).map((e) => (
              <li key={e._id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="size-1.5 shrink-0 rounded-full bg-primary/70" />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                  {e.detail ?? e.event}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {timeAgo(e._creationTime)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Pending approvals nudge */}
      {pending.length > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <p className="flex items-center gap-2 text-sm text-amber-400">
            <Loader2 className="size-4 animate-spin" />
            {pending.length} plan{pending.length === 1 ? "" : "s"} awaiting your
            approval
          </p>
          <Button
            size="sm"
            className="cursor-pointer"
            onClick={() => onNavigate("tasks")}
          >
            Review now
          </Button>
        </section>
      )}

      <section className="flex flex-wrap items-center gap-2 pb-2">
        <Badge variant="outline" className="border-border/70 text-muted-foreground">
          <Bot className="mr-1 size-3" />
          Provider-neutral
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          Omi chooses the model; the underlying provider is an implementation
          detail.
        </span>
      </section>
    </div>
  );
}

function StatusPanel({
  label,
  value,
  hint,
  accent,
  onClick,
}: {
  label: string;
  value: string | null;
  hint: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-xl border px-4 py-3 text-left transition-colors",
        accent
          ? "border-amber-500/30 bg-amber-500/5 hover:border-amber-500/50"
          : "border-border/60 bg-white/[0.015] hover:border-border hover:bg-white/[0.04]",
      )}
    >
      <p className="flex items-baseline gap-2">
        <span className="text-lg font-semibold tracking-tight">
          {value === null ? "—" : value}
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground/80">{hint}</p>
    </button>
  );
}
