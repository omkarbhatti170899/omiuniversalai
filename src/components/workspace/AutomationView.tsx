import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  CircleDashed,
  FileText,
  Loader2,
  Search,
  ShieldCheck,
  TriangleAlert,
  Workflow,
  XCircle,
} from "lucide-react";
import { useState } from "react";

type StepRow = { label: string; status: string; detail?: string };

type WorkflowRun = {
  _id: Id<"omiWorkflows">;
  title: string;
  objective: string;
  status: "running" | "done" | "failed";
  stage?: string;
  steps?: StepRow[];
  result?: string;
  summary?: string;
  citations?: Array<{ title: string; url: string; snippet?: string }>;
  verification?: "pass" | "warnings" | "unverified" | "failed";
  verificationNotes?: string[];
  documentId?: Id<"omiDocuments">;
  error?: string;
  _creationTime: number;
};

function StepIcon({ status }: { status: string }) {
  if (status === "done")
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />;
  if (status === "active")
    return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />;
  if (status === "failed")
    return <XCircle className="size-4 shrink-0 text-red-400" />;
  return <CircleDashed className="size-4 shrink-0 text-muted-foreground/50" />;
}

function VerdictBadge({ verdict }: { verdict: NonNullable<WorkflowRun["verification"]> }) {
  const map = {
    pass: { cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400", label: "✓ Verified" },
    warnings: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-400", label: "⚠ Warnings" },
    unverified: { cls: "border-border bg-muted text-muted-foreground", label: "◌ Not verified" },
    failed: { cls: "border-red-500/30 bg-red-500/10 text-red-400", label: "✗ Failed check" },
  } as const;
  const v = map[verdict];
  return (
    <Badge variant="outline" className={`shrink-0 ${v.cls}`}>
      {v.label}
    </Badge>
  );
}

export function AutomationView() {
  const runs = useQuery(api.omiWorkflowQueries.list);
  const start = useAction(api.omiWorkflows.startResearchReport);

  const [topic, setTopic] = useState("");
  const [focus, setFocus] = useState("");
  const [starting, setStarting] = useState(false);

  const launch = async () => {
    if (starting) return;
    if (topic.trim().length < 8) {
      toast.error("Describe the topic in at least 8 characters.");
      return;
    }
    setStarting(true);
    try {
      await start({ topic: topic.trim(), focus: focus.trim() || undefined });
      toast.success("Workflow started — it keeps running while you watch.");
      setTopic("");
      setFocus("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start the workflow.");
    } finally {
      setStarting(false);
    }
  };

  const running = (runs ?? []).some((r: WorkflowRun) => r.status === "running");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Workflow className="size-6 text-primary" />
          Automation
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Give Omi an outcome, not a task list. The engine plans, searches
          Andromeda, reads sources, synthesizes with citations, verifies
          independently, and files the report in your knowledge base.
        </p>
      </div>

      {/* Launch */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="space-y-1.5">
            <label htmlFor="wf-topic" className="text-sm font-medium">
              Research objective
            </label>
            <Textarea
              id="wf-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder='e.g. "Research the current state of solid-state batteries and prepare a report"'
              maxLength={400}
              className="min-h-20 resize-y"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="wf-focus" className="text-sm font-medium">
              Focus <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="wf-focus"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="e.g. focus on manufacturing challenges"
              maxLength={200}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {running
                ? "A workflow is running — new runs queue behind it."
                : "Zero mandatory cost — runs on Omi's free engines and providers."}
            </p>
            <Button
              onClick={() => void launch()}
              disabled={starting || topic.trim().length < 8}
              className="cursor-pointer"
            >
              {starting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Run workflow
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Runs */}
      {runs === undefined ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : runs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Workflow className="size-8 text-muted-foreground/50" />
            <p className="mt-4 font-semibold">No workflows yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Try: "Research electric vehicle charging standards and prepare a
              report" — Omi handles the whole pipeline and shows every step.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <AnimatePresence initial={false}>
            {(runs as WorkflowRun[]).map((r) => (
              <motion.div
                key={r._id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <Card className="bg-card/60">
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{r.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {r.objective}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {r.verification && <VerdictBadge verdict={r.verification} />}
                        <Badge
                          variant="outline"
                          className={
                            r.status === "done"
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                              : r.status === "running"
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : "border-red-500/30 bg-red-500/10 text-red-400"
                          }
                        >
                          {r.status === "running"
                            ? (r.stage ?? "Running")
                            : r.status === "done"
                              ? "Done"
                              : "Failed"}
                        </Badge>
                      </div>
                    </div>

                    {r.steps && r.steps.length > 0 && (
                      <ol className="space-y-1.5 rounded-lg border border-border/60 p-3">
                        {(r.steps as StepRow[]).map((s, i) => (
                          <li key={`${r._id}-${i}`} className="flex items-start gap-2 text-xs">
                            <StepIcon status={s.status} />
                            <span className="min-w-0">
                              <span
                                className={
                                  s.status === "pending"
                                    ? "text-muted-foreground"
                                    : "font-medium"
                                }
                              >
                                {s.label}
                              </span>
                              {s.detail && (
                                <span className="text-muted-foreground"> — {s.detail}</span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}

                    {r.status === "failed" && r.error && (
                      <p className="flex items-start gap-1.5 text-xs text-red-400">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                        {r.error}
                      </p>
                    )}

                    {r.status === "done" && r.summary && (
                      <p className="text-xs text-muted-foreground">{r.summary}</p>
                    )}

                    {r.status === "done" && r.result && (
                      <details className="rounded-lg border border-border/60 p-3">
                        <summary className="cursor-pointer text-xs font-medium">
                          Report answer
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">
                          {r.result}
                        </p>
                      </details>
                    )}

                    {r.verification === "warnings" && r.verificationNotes && (
                      <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-400/90">
                        {r.verificationNotes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    )}

                    {r.citations && r.citations.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {(r.citations as Array<{ title: string; url: string }>)
                          .slice(0, 6)
                          .map((c, i) => (
                            <a
                              key={i}
                              href={c.url}
                              target="_blank"
                              rel="noreferrer"
                              className="max-w-[220px] truncate rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                            >
                              [{i + 1}] {c.title}
                            </a>
                          ))}
                        {r.citations.length > 6 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{r.citations.length - 6} more sources
                          </span>
                        )}
                      </div>
                    )}

                    {r.status === "done" && r.documentId && (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ShieldCheck className="size-3.5 text-emerald-400" />
                        <FileText className="size-3.5" />
                        Report saved to your knowledge base — searchable and
                        quotable in chat.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
