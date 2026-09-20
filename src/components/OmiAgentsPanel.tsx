import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock,
  Loader2,
  Play,
  Plus,
  ScrollText,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";

type Agent = {
  _id: Id<"omiAgents">;
  name: string;
  description: string;
  specialty: string;
};

type TaskStep = {
  _id: Id<"omiTaskSteps">;
  index: number;
  description: string;
  output?: string;
};

type Task = {
  _id: Id<"omiTasks">;
  _creationTime: number;
  agentId: Id<"omiAgents">;
  agentName: string;
  agentSpecialty: string;
  objective: string;
  status: "awaiting_approval" | "running" | "needs_input" | "done" | "failed";
  plan?: string[];
  result?: string;
  error?: string;
  verification?: "pass" | "warnings" | "unverified" | "failed";
  verificationNotes?: string[];
};

type AuditEvent = {
  _id: Id<"omiAuditLog">;
  event: string;
  detail?: string;
  _creationTime: number;
};

const PRESETS = [
  {
    name: "Researcher",
    specialty: "research",
    description:
      "Breaks research questions into steps and synthesizes findings with structure.",
  },
  {
    name: "Analyst",
    specialty: "analysis",
    description:
      "Analyzes data, compares options, and produces decision-ready summaries.",
  },
  {
    name: "Operations",
    specialty: "operations",
    description:
      "Turns messy operational problems into sequenced action plans.",
  },
];

const VERIFICATION_STYLES: Record<string, string> = {
  pass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  warnings: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  unverified: "border-slate-500/40 bg-slate-500/10 text-slate-400",
  failed: "border-red-500/40 bg-red-500/10 text-red-500",
};

const STATUS_STYLES: Record<Task["status"], string> = {
  awaiting_approval: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  running: "bg-blue-500/15 text-blue-500 border-blue-500/30",
  needs_input: "bg-purple-500/15 text-purple-500 border-purple-500/30",
  done: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  failed: "bg-red-500/15 text-red-500 border-red-500/30",
};

export function OmiAgentsPanel() {
  const agents = useQuery(api.omiAgents.listMine);
  const tasks = useQuery(api.omiTasks.listMine);
  const audit = useQuery(api.omiAudit.listMine);
  const taskDetails = useQuery(api.omiTasks.detail);
  const toolRuns = useQuery(api.omiToolRuns.listMine, { limit: 30 });
  const stepsByTask = new Map(
    (taskDetails ?? []).map((d) => [d.task._id, d.steps]),
  );

  const createAgent = useMutation(api.omiAgents.create);
  const removeAgent = useMutation(api.omiAgents.remove);
  const approveTask = useMutation(api.omiTasks.approve);
  const cancelTask = useMutation(api.omiTasks.cancel);
  const removeTask = useMutation(api.omiTasks.remove);
  const planTask = useAction(api.omiAgentRuntime.planTask);
  const runTask = useAction(api.omiAgentRuntime.runTask);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [specialty, setSpecialty] = useState("research");
  const [isCreating, setIsCreating] = useState(false);

  const [objective, setObjective] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<Id<"omiAgents"> | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [runningTaskIds, setRunningTaskIds] = useState<string[]>([]);

  const handleCreateAgent = async () => {
    setIsCreating(true);
    try {
      await createAgent({ name, description, specialty });
      toast("Agent created.");
      setCreateOpen(false);
      setName("");
      setDescription("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create agent.");
    } finally {
      setIsCreating(false);
    }
  };

  const handlePlan = async () => {
    if (!selectedAgentId || objective.trim().length < 4) return;
    setIsPlanning(true);
    try {
      await planTask({ agentId: selectedAgentId, objective });
      setObjective("");
      toast.success("Plan ready — review and approve it below.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Planning failed.");
    } finally {
      setIsPlanning(false);
    }
  };

  const handleApproveAndRun = async (task: Task) => {
    try {
      await approveTask({ id: task._id });
      setRunningTaskIds((prev) => [...prev, task._id]);
      await runTask({ taskId: task._id });
      toast.success("Task finished.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Execution failed.");
    } finally {
      setRunningTaskIds((prev) => prev.filter((id) => id !== task._id));
    }
  };

  const handleCancel = async (id: Id<"omiTasks">) => {
    try {
      await cancelTask({ id });
      toast("Task cancelled.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't cancel.");
    }
  };

  const handleDeleteTask = async (id: Id<"omiTasks">) => {
    try {
      await removeTask({ id });
      toast("Task removed.");
    } catch {
      toast.error("Couldn't remove task.");
    }
  };

  const isLoading =
    agents === undefined ||
    tasks === undefined ||
    audit === undefined ||
    toolRuns === undefined;
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Delegate objective */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Bot className="size-5" />
            </div>
            <div>
              <CardTitle>Delegate a task</CardTitle>
              <CardDescription>
                Omi plans the steps, you approve, then the agent executes —
                every action audited.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto cursor-pointer"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="mr-1.5 size-4" />
              New agent
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 p-6 text-center">
              <p className="font-semibold">No agents yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                Create a specialist (researcher, analyst, operations) and
                delegate your first task to it.
              </p>
              <Button
                className="mt-4 cursor-pointer"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="mr-2 size-4" />
                Create your first agent
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {agents.map((a: Agent) => (
                  <button
                    key={a._id}
                    type="button"
                    onClick={() => setSelectedAgentId(a._id)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                      selectedAgentId === a._id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/70 text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {a.name} · {a.specialty}
                  </button>
                ))}
              </div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <Textarea
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder={
                    selectedAgentId
                      ? "e.g. Research how competitors handle escalations and propose a playbook…"
                      : "Select an agent above first…"
                  }
                  className="min-h-20 flex-1 resize-y"
                  maxLength={1000}
                  disabled={!selectedAgentId || isPlanning}
                />
                <Button
                  className="cursor-pointer sm:self-end"
                  onClick={() => void handlePlan()}
                  disabled={!selectedAgentId || isPlanning || objective.trim().length < 4}
                >
                  {isPlanning ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <ScrollText className="mr-2 size-4" />
                  )}
                  Plan task
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Tasks */}
      <section>
        <h2 className="mb-3 text-xl font-bold tracking-tight">Tasks</h2>
        {tasks.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No tasks yet. Delegate something above.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {tasks.map((t) => {
              const task = t as Task;
              const isRunning = runningTaskIds.includes(task._id) || task.status === "running";
              return (
                <motion.div
                  key={task._id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={STATUS_STYLES[task.status]}
                        >
                          {isRunning ? "running" : task.status.replace("_", " ")}
                        </Badge>
                        <Badge variant="secondary">{task.agentName}</Badge>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {new Date(task._creationTime).toLocaleString()}
                        </span>
                      </div>
                      <CardTitle className="text-base">{task.objective}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {task.plan && task.plan.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Plan
                          </p>
                          <ol className="space-y-1 text-sm">
                            {task.plan.map((step, i) => (
                              <li key={i} className="flex gap-2">
                                <span className="text-primary">{i + 1}.</span>
                                {step}
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}

                      {task.status === "awaiting_approval" && (
                        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                          <ShieldCheck className="size-4 text-amber-500" />
                          <span className="flex-1 text-xs">
                            Human approval required before execution.
                          </span>
                          <Button
                            size="sm"
                            className="cursor-pointer"
                            onClick={() => void handleApproveAndRun(task)}
                          >
                            <Play className="mr-1.5 size-3.5" />
                            Approve & run
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="cursor-pointer"
                            onClick={() => void handleCancel(task._id)}
                          >
                            <X className="mr-1.5 size-3.5" />
                            Deny
                          </Button>
                        </div>
                      )}

                      {isRunning && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" />
                          Agent is working through the plan…
                        </div>
                      )}

                      {(stepsByTask.get(task._id) ?? []).length > 0 && (
                        <div>
                          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Step outputs
                          </p>
                          <div className="space-y-2">
                            {(stepsByTask.get(task._id) ?? []).map((step) => (
                              <div
                                key={step._id}
                                className="rounded-lg border border-border/60 bg-muted/30 p-3"
                              >
                                <p className="text-xs font-semibold text-primary">
                                  Step {step.index + 1}: {step.description}
                                </p>
                                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                                  {step.output}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {task.result && (
                        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-500">
                              <CheckCircle2 className="size-3.5" />
                              Result
                            </p>
                            {task.verification && task.verification !== "pass" && (
                              <Badge
                                variant="outline"
                                className={VERIFICATION_STYLES[task.verification]}
                              >
                                {task.verification === "warnings"
                                  ? "⚠ verified with warnings"
                                  : task.verification === "unverified"
                                    ? "◌ not verified"
                                    : "✖ verification failed"}
                              </Badge>
                            )}
                            {task.verification === "pass" && (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                              >
                                ✓ verified
                              </Badge>
                            )}
                          </div>
                          <p className="whitespace-pre-wrap text-sm">{task.result}</p>
                          {task.verificationNotes && task.verificationNotes.length > 0 && (
                            <ul className="mt-2 space-y-1 border-t border-emerald-500/20 pt-2">
                              {task.verificationNotes.map((n, i) => (
                                <li key={i} className="text-xs text-muted-foreground">
                                  • {n}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      {task.error && (
                        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
                          <CircleAlert className="size-4 shrink-0" />
                          {task.error}
                        </div>
                      )}

                      <div className="flex justify-end">
                        {task.status !== "done" && task.status !== "failed" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer gap-2 text-muted-foreground"
                            onClick={() => void handleCancel(task._id)}
                          >
                            <Clock className="size-4" />
                            Cancel
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer gap-2 text-muted-foreground hover:text-destructive"
                            onClick={() => void handleDeleteTask(task._id)}
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </section>

      {/* Tool activity (OMI Tool Registry — shared by all agents) */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-xl font-bold tracking-tight">
          <Wrench className="size-5 text-muted-foreground" />
          Tool activity
        </h2>
        {toolRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tool runs yet — agents use tools (web search, page reading,
            knowledge lookup, memory) automatically when a step needs them.
          </p>
        ) : (
          <Card>
            <CardContent className="divide-y divide-border/60 py-2">
              {toolRuns.map((run) => {
                const r = run as {
                  _id: Id<"omiToolRuns">;
                  tool: string;
                  ok: boolean;
                  output?: string;
                  error?: string;
                  durationMs: number;
                  _creationTime: number;
                };
                return (
                  <div key={r._id} className="flex items-start gap-3 py-2.5">
                    <span
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                        r.ok ? "bg-emerald-500" : "bg-red-500"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {r.tool}
                        <span className="text-xs font-normal text-muted-foreground">
                          {r.durationMs}ms
                        </span>
                        {!r.ok && r.error && (
                          <span className="truncate text-xs font-normal text-red-500">
                            {r.error}
                          </span>
                        )}
                      </p>
                      {r.ok && r.output && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {r.output}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(r._creationTime).toLocaleTimeString()}
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </section>

      {/* Audit trail */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-xl font-bold tracking-tight">
          <ScrollText className="size-5 text-muted-foreground" />
          Audit trail
        </h2>
        {audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent activity yet.</p>
        ) : (
          <Card>
            <CardContent className="divide-y divide-border/60 py-2">
              {audit.map((e) => {
                const event = e as AuditEvent;
                return (
                  <div key={event._id} className="flex items-start gap-3 py-2.5">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{event.event}</p>
                      {event.detail && (
                        <p className="text-xs text-muted-foreground">{event.detail}</p>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(event._creationTime).toLocaleTimeString()}
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </section>

      {/* Create agent dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create an agent</DialogTitle>
            <DialogDescription>
              Give Omi a specialist it can delegate work to.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className="rounded-full border border-border/70 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                onClick={() => {
                  setName(p.name);
                  setDescription(p.description);
                  setSpecialty(p.specialty);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Escalation Researcher"
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-desc">What it does</Label>
              <Textarea
                id="agent-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe this agent's role…"
                maxLength={300}
                className="min-h-20"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-spec">Specialty</Label>
              <Input
                id="agent-spec"
                value={specialty}
                onChange={(e) => setSpecialty(e.target.value)}
                placeholder="research, analysis, operations…"
                maxLength={40}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              onClick={() => void handleCreateAgent()}
              disabled={isCreating || name.trim().length === 0 || description.trim().length < 3}
            >
              {isCreating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />}
              Create agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
