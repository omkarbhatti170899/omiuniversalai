import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  BookMarked,
  CheckCircle2,
  FileCheck2,
  FilePlus2,
  Lightbulb,
  Loader2,
  Search,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
} from "lucide-react";

type Status =
  | "draft"
  | "in_review"
  | "approved"
  | "published"
  | "expired"
  | "archived";

const STATUSES: Status[] = [
  "draft",
  "in_review",
  "approved",
  "published",
  "expired",
  "archived",
];

const AUDIENCES = ["agent", "supervisor", "admin", "knowledge_manager"];

const STATUS_TONE: Record<Status, string> = {
  draft: "border-border/60 text-muted-foreground",
  in_review: "border-amber-500/40 text-amber-400",
  approved: "border-sky-500/40 text-sky-400",
  published: "border-emerald-500/40 text-emerald-400",
  expired: "border-destructive/40 text-destructive",
  archived: "border-border/60 text-muted-foreground",
};

function toTs(date: string): number | undefined {
  if (!date) return undefined;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : t;
}

function fromTs(ts: number | undefined): string {
  return ts === undefined ? "" : new Date(ts).toISOString().slice(0, 10);
}

type EditorState = {
  id: Id<"omiKnowledgeArticles"> | null;
  title: string;
  content: string;
  category: string;
  tags: string;
  product: string;
  department: string;
  region: string;
  owner: string;
  audience: string[];
  effectiveDate: string;
  reviewDate: string;
  expirationDate: string;
  sourceType: "internal" | "external";
};

const EMPTY_EDITOR: EditorState = {
  id: null,
  title: "",
  content: "",
  category: "",
  tags: "",
  product: "",
  department: "",
  region: "",
  owner: "",
  audience: [],
  effectiveDate: "",
  reviewDate: "",
  expirationDate: "",
  sourceType: "internal",
};

export function KnowledgeIntelligenceView() {
  const ask = useAction(api.omiKnowledgeIntelligence.ask);
  const dashboard = useQuery(api.omiKnowledgeIntelligence.dashboard);
  const articles = useQuery(api.omiKnowledgeIntelligence.listArticles, {});
  const gaps = useQuery(api.omiKnowledgeIntelligence.listGaps);

  const createDraft = useMutation(api.omiKnowledgeIntelligence.createDraft);
  const updateArticle = useMutation(api.omiKnowledgeIntelligence.updateArticle);
  const submitForReview = useMutation(api.omiKnowledgeIntelligence.submitForReview);
  const approve = useMutation(api.omiKnowledgeIntelligence.approve);
  const publish = useMutation(api.omiKnowledgeIntelligence.publish);
  const archive = useMutation(api.omiKnowledgeIntelligence.archive);
  const newVersion = useMutation(api.omiKnowledgeIntelligence.newVersion);
  const removeArticle = useMutation(api.omiKnowledgeIntelligence.removeArticle);
  const sendFeedback = useMutation(api.omiKnowledgeIntelligence.submitFeedback);
  const setGapStatus = useMutation(api.omiKnowledgeIntelligence.setGapStatus);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{
    answered: boolean;
    sourceKind: "internal" | "external" | "none";
    answer: string;
    source?: { articleId: string; title: string; version: number; status: string; effectiveDate?: number };
    relevantSection?: string;
    evidence: string[];
    exceptions: string[];
    escalateWhen: string[];
    mode: "procedure" | "troubleshooting" | "workflow" | "general";
    steps: string[];
    stepsSupported: boolean;
    requiredInfo: string[];
    checks: string[];
    troubleshooting: Array<{ problem: string; action: string; escalate: boolean }>;
    conflicts: string[];
    note?: string;
  } | null>(null);

  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);

  const manager = dashboard?.manager ?? false;

  const handleAsk = async () => {
    const q = question.trim();
    if (q.length < 2) {
      toast.error("Ask a question first.");
      return;
    }
    setAsking(true);
    try {
      const res = await ask({ question: q });
      setAnswer(res.answer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Knowledge lookup failed.");
    } finally {
      setAsking(false);
    }
  };

  const handleFeedback = async (
    verdict: "correct" | "incorrect" | "outdated" | "missing" | "improvement",
  ) => {
    try {
      await sendFeedback({
        articleId: answer?.source?.articleId as Id<"omiKnowledgeArticles"> | undefined,
        verdict,
        question: question.trim() || undefined,
      });
      toast(
        verdict === "missing"
          ? "Recorded — this becomes a knowledge gap for review."
          : "Thanks — feedback recorded.",
      );
    } catch {
      toast.error("Couldn't record feedback.");
    }
  };

  const openCreate = (prefill?: string) => {
    setEditor({ ...EMPTY_EDITOR, title: prefill ?? "" });
    setEditorOpen(true);
  };

  const openEdit = (a: {
    _id: Id<"omiKnowledgeArticles">;
    title: string;
    content: string;
    category?: string;
    tags?: string[];
    product?: string;
    department?: string;
    region?: string;
    owner?: string;
    audience?: string[];
    effectiveDate?: number;
    reviewDate?: number;
    expirationDate?: number;
    sourceType: "internal" | "external";
  }) => {
    setEditor({
      id: a._id,
      title: a.title,
      content: a.content,
      category: a.category ?? "",
      tags: (a.tags ?? []).join(", "),
      product: a.product ?? "",
      department: a.department ?? "",
      region: a.region ?? "",
      owner: a.owner ?? "",
      audience: a.audience ?? [],
      effectiveDate: fromTs(a.effectiveDate),
      reviewDate: fromTs(a.reviewDate),
      expirationDate: fromTs(a.expirationDate),
      sourceType: a.sourceType,
    });
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (editor.title.trim().length < 2 || editor.content.trim().length < 20) {
      toast.error("Add a title and at least a sentence of content.");
      return;
    }
    setSaving(true);
    try {
      const base = {
        title: editor.title,
        content: editor.content,
        category: editor.category || undefined,
        tags: editor.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        product: editor.product || undefined,
        department: editor.department || undefined,
        region: editor.region || undefined,
        owner: editor.owner || undefined,
        audience: editor.audience,
        effectiveDate: toTs(editor.effectiveDate),
        reviewDate: toTs(editor.reviewDate),
        expirationDate: toTs(editor.expirationDate),
      };
      if (editor.id) {
        await updateArticle({ id: editor.id, ...base });
        toast("Article updated.");
      } else {
        await createDraft({ ...base, sourceType: editor.sourceType });
        toast("Draft created — submit it for review when ready.");
      }
      setEditorOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the article.");
    } finally {
      setSaving(false);
    }
  };

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    }
  };

  const visibleArticles = (articles ?? []).filter((a) =>
    statusFilter === "all" ? true : a.status === statusFilter,
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <BookMarked className="size-6 text-primary" />
          Knowledge Intelligence
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Approved knowledge is the trusted evidence layer. Omi searches,
          retrieves, verifies and cites — it never guesses.
        </p>
      </div>

      {/* Ask */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <Label htmlFor="ki-question">Ask the knowledge base</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="ki-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAsk();
                }}
                placeholder="e.g. How do I file a claim?"
                className="pl-9"
                maxLength={500}
              />
            </div>
            <Button
              className="cursor-pointer"
              onClick={() => void handleAsk()}
              disabled={asking || question.trim().length < 2}
            >
              {asking ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Search className="mr-2 size-4" />}
              Ask
            </Button>
          </div>

          {answer && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-2 rounded-xl border border-border/60 bg-muted/30 p-4"
            >
              <div className="flex items-center gap-2">
                {answer.answered ? (
                  <ShieldCheck className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                  {answer.sourceKind === "internal"
                    ? "INTERNAL KNOWLEDGE"
                    : answer.sourceKind === "external"
                      ? "EXTERNAL RESEARCH"
                      : "NO SOURCE"}
                </Badge>
              </div>
              <p className="text-sm leading-relaxed">{answer.answer}</p>

              {/* What to do — steps are only ever those the article lists. */}
              {answer.mode === "troubleshooting" && answer.troubleshooting.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    What to do
                  </p>
                  <ol className="space-y-1.5">
                    {answer.troubleshooting.map((t, i) => (
                      <li key={i} className="text-sm">
                        <span className="font-medium">{i + 1}. Problem:</span> {t.problem}
                        {t.action && (
                          <span className="block pl-4 text-xs text-muted-foreground">
                            Check / action: {t.action}
                          </span>
                        )}
                        {t.escalate && (
                          <span className="block pl-4 text-xs text-destructive">
                            Escalate — human review required
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : answer.stepsSupported ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    What to do
                  </p>
                  <ol className="ml-4 list-decimal space-y-0.5 text-sm">
                    {answer.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              ) : answer.answered ? (
                <p className="text-xs text-amber-400">
                  The approved article lists no explicit steps, so none were
                  invented — use the evidence below or ask a knowledge owner to add
                  step-by-step instructions.
                </p>
              ) : null}

              {answer.requiredInfo.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Required information / documents
                  </p>
                  <ul className="ml-4 list-disc space-y-0.5 text-xs text-muted-foreground">
                    {answer.requiredInfo.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              {answer.checks.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Important checks
                  </p>
                  <ul className="ml-4 list-disc space-y-0.5 text-xs text-muted-foreground">
                    {answer.checks.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}

              {answer.conflicts.length > 0 && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  {answer.conflicts.join(" ")} Human review required.
                </p>
              )}

              {answer.source && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <dt className="font-medium text-foreground">Source</dt>
                  <dd>{answer.source.title}</dd>
                  <dt className="font-medium text-foreground">Version</dt>
                  <dd>{answer.source.version}</dd>
                  {answer.source.effectiveDate && (
                    <>
                      <dt className="font-medium text-foreground">Effective</dt>
                      <dd>{fromTs(answer.source.effectiveDate)}</dd>
                    </>
                  )}
                  {answer.relevantSection && (
                    <>
                      <dt className="font-medium text-foreground">Section</dt>
                      <dd>{answer.relevantSection}</dd>
                    </>
                  )}
                </dl>
              )}
              {answer.evidence.length > 1 && (
                <ul className="ml-4 list-disc space-y-0.5 text-xs text-muted-foreground">
                  {answer.evidence.slice(1).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              {answer.exceptions.length > 0 && (
                <p className="text-xs">
                  <span className="font-semibold text-foreground">Exceptions:</span>{" "}
                  {answer.exceptions.join(" ")}
                </p>
              )}
              {answer.escalateWhen.length > 0 && (
                <p className="text-xs">
                  <span className="font-semibold text-destructive">Human review required:</span>{" "}
                  {answer.escalateWhen.join(" ")}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">Was this right?</span>
                <Button size="sm" variant="ghost" className="cursor-pointer" onClick={() => void handleFeedback("correct")}>
                  <ThumbsUp className="mr-1 size-3.5" /> Correct
                </Button>
                <Button size="sm" variant="ghost" className="cursor-pointer text-destructive" onClick={() => void handleFeedback("incorrect")}>
                  <ThumbsDown className="mr-1 size-3.5" /> Incorrect
                </Button>
                <Button size="sm" variant="ghost" className="cursor-pointer" onClick={() => void handleFeedback("outdated")}>
                  Outdated
                </Button>
                <Button size="sm" variant="ghost" className="cursor-pointer" onClick={() => void handleFeedback("missing")}>
                  Missing info
                </Button>
              </div>
            </motion.div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="library">
        <TabsList>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="gaps">Gaps</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>

        {/* Library */}
        <TabsContent value="library" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {(["all", ...STATUSES] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    statusFilter === s
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border/60 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s === "all" ? "All" : s.replace("_", " ")}
                </button>
              ))}
            </div>
            <Button size="sm" className="cursor-pointer" onClick={() => openCreate()}>
              <FilePlus2 className="mr-1.5 size-4" /> New article
            </Button>
          </div>

          {articles === undefined ? (
            <Skeleton className="h-24 w-full" />
          ) : visibleArticles.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center py-10 text-center">
                <BookMarked className="size-8 text-muted-foreground/50" />
                <p className="mt-3 font-semibold">No articles here yet</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Create a draft, then submit it for review and publish it. Only
                  published knowledge is treated as authoritative.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {visibleArticles.map((a) => (
                <Card key={a._id} className="bg-card/60">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{a.title}</span>
                      <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[a.status as Status]}`}>
                        {a.status.replace("_", " ")}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">v{a.version}</Badge>
                      {a.audience && a.audience.length > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {a.audience.join(", ")}
                        </Badge>
                      )}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {a.region ?? ""} {a.product ? `· ${a.product}` : ""}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{a.content}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {(a.status === "draft" || a.status === "in_review") && (
                        <Button size="sm" variant="outline" className="cursor-pointer" onClick={() => openEdit(a)}>
                          Edit
                        </Button>
                      )}
                      {a.status === "draft" && (
                        <Button size="sm" className="cursor-pointer" onClick={() => void run(() => submitForReview({ id: a._id }), "Submitted for review.")}>
                          Submit for review
                        </Button>
                      )}
                      {a.status === "in_review" && manager && (
                        <Button size="sm" className="cursor-pointer" onClick={() => void run(() => approve({ id: a._id }), "Approved.")}>
                          <FileCheck2 className="mr-1.5 size-3.5" /> Approve
                        </Button>
                      )}
                      {a.status === "approved" && manager && (
                        <Button size="sm" className="cursor-pointer" onClick={() => void run(() => publish({ id: a._id }), "Published — now authoritative.")}>
                          <CheckCircle2 className="mr-1.5 size-3.5" /> Publish
                        </Button>
                      )}
                      {a.status === "published" && manager && (
                        <>
                          <Button size="sm" variant="outline" className="cursor-pointer" onClick={() => void run(async () => {
                            const id = await newVersion({ id: a._id });
                            toast("New draft version created.");
                            return id;
                          }, "New draft version created.")}>
                            New version
                          </Button>
                          <Button size="sm" variant="outline" className="cursor-pointer" onClick={() => void run(() => archive({ id: a._id }), "Archived.")}>
                            Archive
                          </Button>
                        </>
                      )}
                      {a.status === "draft" && (
                        <Button size="sm" variant="ghost" className="cursor-pointer text-destructive" onClick={() => void run(() => removeArticle({ id: a._id }), "Draft deleted.")}>
                          Delete
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Review */}
        <TabsContent value="review" className="space-y-3">
          {dashboard === undefined || dashboard === null ? (
            <Skeleton className="h-20 w-full" />
          ) : !manager ? (
            <p className="text-sm text-muted-foreground">
              Only knowledge managers can approve and publish.
            </p>
          ) : dashboard.reviewQueue.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting for review.</p>
          ) : (
            dashboard.reviewQueue.map((a) => (
              <Card key={a._id} className="bg-card/60">
                <CardContent className="flex flex-wrap items-center gap-2 p-4">
                  <span className="text-sm font-semibold">{a.title}</span>
                  <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[a.status as Status]}`}>
                    {a.status.replace("_", " ")}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">v{a.version}</Badge>
                  <div className="ml-auto flex gap-1.5">
                    {a.status === "in_review" && (
                      <Button size="sm" className="cursor-pointer" onClick={() => void run(() => approve({ id: a._id }), "Approved.")}>
                        Approve
                      </Button>
                    )}
                    {a.status === "approved" && (
                      <Button size="sm" className="cursor-pointer" onClick={() => void run(() => publish({ id: a._id }), "Published.")}>
                        Publish
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="cursor-pointer" onClick={() => openEdit(a)}>
                      View
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* Gaps */}
        <TabsContent value="gaps" className="space-y-3">
          {gaps === undefined ? (
            <Skeleton className="h-20 w-full" />
          ) : gaps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No knowledge gaps yet. Unanswered questions are logged here
              automatically.
            </p>
          ) : (
            gaps.map((g) => (
              <Card key={g._id} className="bg-card/60">
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <Lightbulb className="size-4 shrink-0 text-amber-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {g.suggestedTitle}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      “{g.question}” · asked {g.count}×
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{g.status.replace("_", " ")}</Badge>
                  <div className="flex gap-1.5">
                    <Button size="sm" className="cursor-pointer" onClick={() => openCreate(g.suggestedTitle)}>
                      Create article
                    </Button>
                    {g.status !== "resolved" && (
                      <Button size="sm" variant="outline" className="cursor-pointer" onClick={() => void run(() => setGapStatus({ key: g.key, status: "resolved" }), "Gap resolved.")}>
                        Resolve
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* Insights */}
        <TabsContent value="insights" className="space-y-4">
          {dashboard === undefined || dashboard === null ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "Articles", value: dashboard.analytics.total },
                  { label: "Published", value: dashboard.analytics.byStatus.published },
                  { label: "Drafts", value: dashboard.analytics.byStatus.draft },
                  { label: "Expiring soon", value: dashboard.analytics.expiringSoon },
                  { label: "Open gaps", value: dashboard.analytics.openGaps },
                  { label: "Questions in gaps", value: dashboard.analytics.gapQuestions },
                  { label: "Answer rate", value: `${Math.round(dashboard.analytics.searchSuccessRate * 100)}%` },
                  { label: "Avg latency", value: `${dashboard.analytics.avgLatencyMs}ms` },
                ].map((m) => (
                  <Card key={m.label} className="bg-card/60">
                    <CardContent className="p-4">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        {m.label}
                      </p>
                      <p className="mt-1 text-xl font-semibold">{m.value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <TrendingUp className="size-4 text-primary" /> Knowledge Critic
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {dashboard.flags.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No problems detected. The critic flags only — it never edits
                      or publishes knowledge.
                    </p>
                  ) : (
                    dashboard.flags.slice(0, 20).map((f, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <AlertTriangle
                          className={`mt-0.5 size-3.5 shrink-0 ${
                            f.severity === "high"
                              ? "text-destructive"
                              : f.severity === "medium"
                                ? "text-amber-400"
                                : "text-muted-foreground"
                          }`}
                        />
                        <span className="text-muted-foreground">{f.message}</span>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              {dashboard.analytics.failedSearches.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Unanswered questions</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {dashboard.analytics.failedSearches.map((f) => (
                      <p key={f.query} className="text-sm text-muted-foreground">
                        {f.query} · {f.count}×
                      </p>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* Editor */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editor.id ? "Edit article" : "New knowledge article"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ki-title">Title</Label>
              <Input
                id="ki-title"
                value={editor.title}
                onChange={(e) => setEditor({ ...editor, title: e.target.value })}
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ki-content">Content</Label>
              <Textarea
                id="ki-content"
                value={editor.content}
                onChange={(e) => setEditor({ ...editor, content: e.target.value })}
                className="min-h-40"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {([
                ["category", "Category"],
                ["product", "Product/process"],
                ["department", "Department"],
                ["region", "Region/jurisdiction"],
                ["owner", "Owner"],
                ["tags", "Tags (comma-separated)"],
              ] as const).map(([field, label]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`ki-${field}`}>{label}</Label>
                  <Input
                    id={`ki-${field}`}
                    value={editor[field]}
                    onChange={(e) => setEditor({ ...editor, [field]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {([
                ["effectiveDate", "Effective"],
                ["reviewDate", "Review"],
                ["expirationDate", "Expires"],
              ] as const).map(([field, label]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`ki-${field}`}>{label}</Label>
                  <Input
                    id={`ki-${field}`}
                    type="date"
                    value={editor[field]}
                    onChange={(e) => setEditor({ ...editor, [field]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label>Visible to roles</Label>
              <div className="flex flex-wrap gap-1.5">
                {AUDIENCES.map((role) => {
                  const on = editor.audience.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() =>
                        setEditor({
                          ...editor,
                          audience: on
                            ? editor.audience.filter((r) => r !== role)
                            : [...editor.audience, role],
                        })
                      }
                      className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        on
                          ? "border-primary/50 bg-primary/10"
                          : "border-border/60 text-muted-foreground"
                      }`}
                    >
                      {role.replace("_", " ")}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Empty = visible to everyone.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="cursor-pointer" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button className="cursor-pointer" onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {editor.id ? "Save changes" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
