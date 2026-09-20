import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  Circle,
  FileText,
  Folder,
  Globe,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";

type AuditEvent = {
  _id: Id<"omiAuditLog">;
  event: string;
  detail?: string;
  _creationTime: number;
};

type Agent = {
  _id: Id<"omiAgents">;
  name: string;
  specialty: string;
  description: string;
};

type Task = {
  _id: Id<"omiTasks">;
  objective: string;
  status: "awaiting_approval" | "running" | "needs_input" | "done" | "failed";
};

const PROMPT_CHIPS = [
  "Analyze this file",
  "Research a topic",
  "Create an agent",
  "Build a plan",
  "Summarize this",
];

const QUICK_ACTIONS = [
  { id: "chat", label: "New chat", icon: MessageSquare },
  { id: "agents", label: "Build an agent", icon: Bot },
  { id: "search", label: "Ask Omi anything", icon: Globe },
  { id: "memory", label: "Manage memory", icon: Brain },
  { id: "emotions", label: "Analyze emotions", icon: Sparkles },
] as const;

const EVENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  task_planned: FileText,
  task_approved: CheckCircle2,
  task_completed: CheckCircle2,
  task_failed: Zap,
  task_cancelled: Circle,
  step_completed: ArrowRight,
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function HomeView({
  onNavigate,
  onAskOmi,
}: {
  onNavigate: (view:
    | "chat"
    | "agents"
    | "research"
    | "memory"
    | "emotions"
    | "search"
    | "tasks") => void;
  onAskOmi: (query: string, mode: "chat" | "search") => void;
}) {
  const audit = useQuery(api.omiAudit.listMine);
  const agents = useQuery(api.omiAgents.listMine);
  const tasks = useQuery(api.omiTasks.listMine);

  const [ask, setAsk] = useState("");

  const derivedProjects = useMemo(() => {
    const list: Array<{
      id: string;
      name: string;
      desc: string;
      status: "Active" | "In Progress";
    }> = [
      {
        id: "workspace",
        name: "Personal Workspace",
        desc: "Chats, memory, and daily work",
        status: "Active",
      },
    ];
    if (agents && agents.length > 0) {
      list.unshift({
        id: "agents",
        name: "Agent Fleet",
        desc: `${agents.length} specialized agent${agents.length === 1 ? "" : "s"}`,
        status: "Active",
      });
    }
    if (tasks && tasks.some((t: Task) => t.status === "running" || t.status === "awaiting_approval")) {
      list.unshift({
        id: "tasks",
        name: "Active Missions",
        desc: "Tasks awaiting approval or running",
        status: "In Progress",
      });
    }
    return list;
  }, [agents, tasks]);

  const handleAsk = (mode: "chat" | "search") => {
    const q = ask.trim();
    if (q.length < 2) return;
    onAskOmi(q, mode);
    setAsk("");
  };

  const pendingTasks = (tasks ?? []).filter(
    (t) => t.status === "awaiting_approval" || t.status === "running",
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
      {/* Main column */}
      <div className="min-w-0 space-y-6">
        {/* Hero */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-b from-primary/15 via-card to-card px-6 py-10 text-center sm:px-10"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(480px circle at 50% -10%, oklch(0.68 0.15 262 / 0.28), transparent 65%)",
            }}
          />
          <div className="relative">
            <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
              Omi Universal AI
            </h1>
            <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground sm:text-base">
              Your intelligence workspace for a smarter tomorrow — one AI that
              reasons, remembers, researches, and executes.
            </p>

            <div className="mx-auto mt-4 flex max-w-md flex-wrap justify-center gap-2">
              {["Think", "Plan", "Research", "Execute", "Remember"].map((c) => (
                <Badge
                  key={c}
                  variant="outline"
                  className="border-border/70 bg-background/50 text-muted-foreground"
                >
                  {c}
                </Badge>
              ))}
            </div>

            {/* Ask-Omi bar */}
            <div className="mx-auto mt-6 max-w-2xl">
              <div className="relative">
                <Sparkles className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-primary" />
                <Input
                  value={ask}
                  onChange={(e) => setAsk(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAsk("chat");
                    }
                  }}
                  placeholder="Ask Omi anything…"
                  className="h-14 rounded-xl border-primary/40 bg-background/70 pl-11 pr-28 text-base shadow-[0_0_24px_oklch(0.68_0.15_262/0.15)]"
                  maxLength={500}
                />
                <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-9 cursor-pointer gap-1 text-xs text-muted-foreground"
                    onClick={() => handleAsk("search")}
                    disabled={ask.trim().length < 2}
                    title="Search the live web with citations"
                  >
                    <Globe className="size-3.5" />
                    Web
                  </Button>
                  <Button
                    size="icon"
                    className="size-9 cursor-pointer rounded-lg"
                    onClick={() => handleAsk("chat")}
                    disabled={ask.trim().length < 2}
                    aria-label="Ask Omi"
                  >
                    <Send className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {PROMPT_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="rounded-full border border-border/70 bg-background/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                    onClick={() => {
                      if (chip === "Research a topic" || chip === "Summarize this") {
                        onNavigate("search");
                      } else if (chip === "Create an agent" || chip === "Build a plan") {
                        onNavigate("agents");
                      } else {
                        onNavigate("chat");
                      }
                    }}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </motion.section>

        {/* Feature cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              {
                id: "search",
                title: "Research",
                desc: "Find, compare and verify information",
                icon: Globe,
                tint: "bg-sky-500/15 text-sky-400",
              },
              {
                id: "agents",
                title: "Agents",
                desc: "Let AI agents work for you",
                icon: Bot,
                tint: "bg-violet-500/15 text-violet-400",
              },
              {
                id: "emotions",
                title: "Emotions AI",
                desc: "Read the human in any message",
                icon: Sparkles,
                tint: "bg-emerald-500/15 text-emerald-400",
              },
              {
                id: "memory",
                title: "Memory",
                desc: "Context Omi always remembers",
                icon: Brain,
                tint: "bg-amber-500/15 text-amber-400",
              },
            ] as const
          ).map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onNavigate(f.id)}
                className="group cursor-pointer rounded-xl border border-border/60 bg-card/60 p-4 text-left transition-all hover:border-primary/50 hover:shadow-[0_0_20px_oklch(0.68_0.15_262/0.12)]"
              >
                <div className="flex items-start justify-between">
                  <span
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg",
                      f.tint,
                    )}
                  >
                    <Icon className="size-5" />
                  </span>
                  <ArrowRight className="size-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                </div>
                <p className="mt-3 text-sm font-semibold">{f.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {f.desc}
                </p>
              </button>
            );
          })}
        </div>

        {/* Recent Activity + Your Projects */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Recent activity */}
          <Card className="bg-card/60">
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
                <p className="text-sm font-semibold">Recent Activity</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="cursor-pointer text-xs text-primary"
                  onClick={() => onNavigate("tasks")}
                >
                  View all
                </Button>
              </div>
              <div className="divide-y divide-border/40">
                {audit === undefined ? (
                  <div className="space-y-3 p-5">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-3/4" />
                    <Skeleton className="h-10 w-5/6" />
                  </div>
                ) : audit.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                    No activity yet — delegate a task to an agent to get
                    started.
                  </p>
                ) : (
                  audit.slice(0, 6).map((e: AuditEvent) => {
                    const Icon = EVENT_ICONS[e.event] ?? FileText;
                    return (
                      <div
                        key={e._id}
                        className="flex items-center gap-3 px-5 py-3"
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Icon className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{e.detail ?? e.event}</p>
                          <p className="text-xs text-muted-foreground">
                            Omi · {timeAgo(e._creationTime)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>

          {/* Projects */}
          <Card className="bg-card/60">
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
                <p className="text-sm font-semibold">Your Projects</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="cursor-pointer text-xs text-primary"
                  onClick={() => onNavigate("agents")}
                >
                  View all
                </Button>
              </div>
              <div className="divide-y divide-border/40">
                {derivedProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      onNavigate(
                        p.id === "agents"
                          ? "agents"
                          : p.id === "tasks"
                            ? "tasks"
                            : "chat",
                      )
                    }
                    className="flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
                      <Folder className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.desc}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0",
                        p.status === "Active"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          : "border-sky-500/30 bg-sky-500/10 text-sky-400",
                      )}
                    >
                      <span
                        className={cn(
                          "mr-1 inline-block size-1.5 rounded-full",
                          p.status === "Active" ? "bg-emerald-400" : "bg-sky-400",
                        )}
                      />
                      {p.status}
                    </Badge>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Right rail */}
      <div className="space-y-4">
        {/* System status */}
        <Card className="bg-card/60">
          <CardContent className="p-5">
            <p className="text-sm font-semibold">System Status</p>
            <div className="mt-3 space-y-2.5 text-sm">
              <StatusRow label="AI Models" value="Online" ok />
              <StatusRow label="Agents" value="Ready" ok />
              <StatusRow label="Search" value="Connected" ok />
              <StatusRow label="Database" value="Healthy" ok />
              <StatusRow label="Uptime" value="99.9%" ok />
            </div>
          </CardContent>
        </Card>

        {/* Pending approvals nudge */}
        {pendingTasks.length > 0 && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="p-5">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-400">
                <Loader2 className="size-4 animate-spin" />
                {pendingTasks.length} task
                {pendingTasks.length === 1 ? "" : "s"} need you
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                A plan is awaiting your approval.
              </p>
              <Button
                size="sm"
                className="mt-3 w-full cursor-pointer"
                onClick={() => onNavigate("tasks")}
              >
                Review now
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Omi insights */}
        <Card className="bg-card/60">
          <CardContent className="p-5">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Brain className="size-4 text-primary" />
              Omi Insights
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {agents === undefined
                ? "Loading your workspace…"
                : agents.length === 0
                  ? "Create your first agent — Omi gets sharper with a fleet."
                  : `${agents.length} agent${agents.length === 1 ? "" : "s"} ready. You're ${agents.length >= 3 ? "running a real fleet" : "on your way to a fleet"}.`}
            </p>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-primary/50"
                style={{ width: `${Math.min(100, (agents?.length ?? 0) * 20)}%` }}
              />
            </div>
          </CardContent>
        </Card>

        {/* Quick actions */}
        <Card className="bg-card/60">
          <CardContent className="p-5">
            <p className="text-sm font-semibold">Quick Actions</p>
            <div className="mt-3 space-y-2">
              {QUICK_ACTIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onNavigate(a.id)}
                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border/50 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    <Icon className="size-4" />
                    {a.label}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span
          className={cn(
            "inline-block size-1.5 rounded-full",
            ok ? "bg-emerald-500" : "bg-amber-500",
          )}
        />
        {label}
      </span>
      <span className={cn("text-xs font-medium", ok ? "text-emerald-400" : "text-amber-400")}>
        {value}
      </span>
    </div>
  );
}
