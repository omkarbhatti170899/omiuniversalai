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
  Activity,
  AlertTriangle,
  BookMarked,
  CheckCircle2,
  FileCheck2,
  FilePlus2,
  GitCompare,
  Info,
  Lightbulb,
  Loader2,
  Save,
  Search,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TrendingUp,
} from "lucide-react";

/** Structured provenance returned alongside a grounded answer (§8). */
type WhyThisAnswer = {
  sources: Array<{
    articleId: string;
    title: string;
    version: number;
    status: string;
    sourceType: "internal" | "external";
    effectiveDate?: number;
    score: number;
  }>;
  conflicts: string[];
  grounded: boolean;
  retrieval: "hybrid" | "keyword";
};


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
  const dashboard = useQuery(api.omiKnowledgeIntelligence.dashboard, {});
  const articles = useQuery(api.omiKnowledgeIntelligence.listArticles, {});
  const gaps = useQuery(api.omiKnowledgeIntelligence.listGaps);
  const artifacts = useQuery(api.omiKnowledgeIntelligence.listArtifacts);
  const findings = useQuery(api.omiKnowledgeIntelligence.listFindings, { status: "open" });

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
  const setFindingStatus = useMutation(api.omiKnowledgeIntelligence.setFindingStatus);
  const removeArtifact = useMutation(api.omiKnowledgeIntelligence.removeArtifact);
  const saveArtifact = useAction(api.omiKnowledgeIntelligence.saveArtifact);
  const runCriticNow = useAction(api.omiKnowledgeIntelligence.runCriticNow);
  const [compareIds, setCompareIds] = useState<{
    beforeId: Id<"omiKnowledgeArticles">;
    afterId: Id<"omiKnowledgeArticles">;
    title: string;
  } | null>(null);
  const comparison = useQuery(
    api.omiKnowledgeIntelligence.compareVersionsQuery,
    compareIds ? { beforeId: compareIds.beforeId, afterId: compareIds.afterId } : "skip",
  );

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
  const [why, setWhy] = useState<WhyThisAnswer | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [savingArtifact, setSavingArtifact] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<
    { title: string; markdown: string } | null
  >(null);
  const [criticRunning, setCriticRunning] = useState(false);

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
      setWhy(res.why);
      setShowWhy(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Knowledge lookup failed.");
    } finally {
      setAsking(false);
    }
  };

  /** §5 — turn the grounded answer into a Procedure/Checklist/SOP/etc. */
  const handleSaveArtifact = async (kind: string) => {
    const q = question.trim();
    if (q.length < 2) {
      toast.error("Ask a question first.");
      return;
    }
    setSavingArtifact(true);
    try {
      await saveArtifact({ question: q, kind });
      toast(`Saved a ${kind} with its source attribution.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the artifact.");
    } finally {
      setSavingArtifact(false);
    }
  };

  /** §9 — compare an article against the previous version in its family. */
  const handleCompare = (id: Id<"omiKnowledgeArticles">) => {
    const current = (articles ?? []).find((a) => a._id === id);
    if (!current) return;
    const previous = (articles ?? [])
      .filter((a) => a.familyId === current.familyId && a.version < current.version)
      .sort((a, b) => b.version - a.version)[0];
    if (!previous) {
      toast.error("No previous version to compare with.");
      return;
    }
    setCompareIds({ beforeId: previous._id, afterId: id, title: current.title });
  };

  const handleRunCritic = async () => {
    setCriticRunning(true);
    try {
      const res = await runCriticNow({});
      toast(`Critic ran — ${res.count ?? 0} finding(s). Flags only, nothing was changed.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Critic run failed.");
    } finally {
      setCriticRunning(false);
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

                {/* §8 — "Why this answer?" — provenance, never chain-of-thought. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="cursor-pointer"
                  aria-expanded={showWhy}
                  onClick={() => setShowWhy((v) => !v)}
                >
                  <Info className="mr-1 size-3.5" /> Why this answer?
                </Button>
              </div>

              {showWhy && why && (
                <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Why this answer
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Retrieval: {why.retrieval === "hybrid" ? "keyword + semantic" : "keyword (no embedding provider configured)"} ·{" "}
                    {why.grounded ? "evidence met the confidence floor" : "no evidence met the floor, so nothing was asserted"}
                  </p>
                  {why.sources.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No approved source matched.</p>
                  ) : (
                    <ul className="space-y-1">
                      {why.sources.map((s) => (
                        <li key={s.articleId} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-medium">{s.title}</span>
                          <Badge variant="secondary" className="text-[10px]">v{s.version}</Badge>
                          <Badge variant="outline" className="text-[10px]">{s.status}</Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {s.sourceType === "internal" ? "INTERNAL" : "EXTERNAL"}
                          </Badge>
                          <span className="text-muted-foreground">score {s.score.toFixed(2)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {why.conflicts.length > 0 && (
                    <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                      Conflicting approved knowledge: {why.conflicts.join(" ")}
                    </p>
                  )}
                </div>
              )}

              {/* §5 — turn the answer into a durable artifact, attribution kept. */}
              {answer.answered && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-xs text-muted-foreground">Save as:</span>
                  {(["procedure", "checklist", "sop", "training", "report"] as const).map((kind) => (
                    <Button
                      key={kind}
                      size="sm"
                      variant="outline"
                      className="cursor-pointer capitalize"
                      disabled={savingArtifact}
                      onClick={() => void handleSaveArtifact(kind)}
                    >
                      <Save className="mr-1 size-3.5" /> {kind}
                    </Button>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="library">
        <TabsList>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="gaps">Gaps</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
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
                          <Button size="sm" variant="outline" className="cursor-pointer" onClick={() => handleCompare(a._id)}>
                            <GitCompare className="mr-1.5 size-3.5" /> What changed?
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
                <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <TrendingUp className="size-4 text-primary" /> Knowledge Critic
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {dashboard.flagCounts.critical} critical · {dashboard.flagCounts.high} high
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      className="cursor-pointer"
                      disabled={criticRunning}
                      onClick={() => void handleRunCritic()}
                    >
                      {criticRunning ? (
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                      ) : (
                        <Activity className="mr-1.5 size-3.5" />
                      )}
                      Run critic now
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    Retrieval: {dashboard.embeddingProviderConfigured ? "keyword + semantic" : "keyword only (no embedding provider configured)"}. The critic flags only — it never edits, merges or publishes.
                  </p>
                  {dashboard.flags.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No problems detected in the live critique.
                    </p>
                  ) : (
                    dashboard.flags.slice(0, 20).map((f, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <AlertTriangle
                          className={`mt-0.5 size-3.5 shrink-0 ${
                            f.severity === "critical" || f.severity === "high"
                              ? "text-destructive"
                              : f.severity === "medium"
                                ? "text-amber-400"
                                : "text-muted-foreground"
                          }`}
                        />
                        <span className="text-muted-foreground">
                          <span className="mr-1 font-medium uppercase text-foreground">
                            {f.severity}
                          </span>
                          {f.message}
                        </span>
                      </div>
                    ))
                  )}

                  {/* Persisted findings from the scheduled sweep (§3). */}
                  {(findings ?? []).length > 0 && (
                    <div className="space-y-1.5 border-t border-border/60 pt-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Open findings (persisted)
                      </p>
                      {(findings ?? []).slice(0, 20).map((f) => (
                        <div key={f._id} className="flex items-start gap-2 text-xs">
                          <Badge
                            variant="outline"
                            className={`text-[10px] uppercase ${
                              f.severity === "critical"
                                ? "border-destructive/40 text-destructive"
                                : ""
                            }`}
                          >
                            {f.severity}
                          </Badge>
                          <span className="flex-1 text-muted-foreground">{f.message}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 cursor-pointer px-2 text-[10px]"
                            onClick={() =>
                              void run(
                                () => setFindingStatus({ id: f._id, status: "acknowledged" }),
                                "Finding acknowledged.",
                              )
                            }
                          >
                            Acknowledge
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* §16 — the requested health-dashboard counts. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "Critical findings", value: dashboard.flagCounts.critical },
                  { label: "High findings", value: dashboard.flagCounts.high },
                  { label: "In review", value: dashboard.analytics.byStatus.in_review },
                  { label: "Expired", value: dashboard.analytics.expired },
                  { label: "No-answer rate", value: `${Math.round(dashboard.analytics.noAnswerRate * 100)}%` },
                  { label: "Failed searches", value: dashboard.analytics.failedSearches.length },
                  { label: "Feedback", value: Object.values(dashboard.analytics.feedback).reduce((a, b) => a + b, 0) },
                  { label: "Artifacts", value: (artifacts ?? []).length },
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

        {/* Artifacts (§5) — grounded answers saved as durable documents. */}
        <TabsContent value="artifacts" className="space-y-3">
          {artifacts === undefined ? (
            <Skeleton className="h-20 w-full" />
          ) : artifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No artifacts yet. Ask a question above and use “Save as” to turn the
              grounded answer into a procedure, checklist, SOP, training guide or
              report — the source attribution is always kept.
            </p>
          ) : (
            artifacts.map((a) => (
              <Card key={a._id} className="bg-card/60">
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold capitalize">{a.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.kind}
                      {a.articleTitle ? ` · ${a.articleTitle}` : ""}
                      {a.version !== undefined ? ` · v${a.version}` : ""}
                      {" · "}
                      {new Date(a.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="cursor-pointer"
                      onClick={() => setArtifactPreview({ title: a.title, markdown: a.markdown })}
                    >
                      View
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="cursor-pointer text-destructive"
                      onClick={() => void run(() => removeArtifact({ id: a._id }), "Artifact deleted.")}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>

      {/* §9 — version comparison (“What changed?”) */}
      <Dialog open={compareIds !== null} onOpenChange={(open) => !open && setCompareIds(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              What changed{compareIds ? ` — ${compareIds.title}` : ""}
            </DialogTitle>
          </DialogHeader>
          {comparison === undefined ? (
            <Skeleton className="h-32 w-full" />
          ) : comparison === null ? (
            <p className="text-sm text-muted-foreground">
              This comparison isn't available for your role or these versions.
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                v{comparison.fromVersion} → v{comparison.toVersion}
                {comparison.toEffective
                  ? ` · effective ${fromTs(comparison.toEffective)}`
                  : ""}
              </p>
              {comparison.fields.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Metadata
                  </p>
                  {comparison.fields.map((f) => (
                    <p key={f.field} className="text-xs">
                      <span className="font-medium capitalize">{f.field}</span>:{" "}
                      <span className="text-muted-foreground line-through">{f.from}</span> →{" "}
                      <span>{f.to}</span>
                    </p>
                  ))}
                </div>
              )}
              {comparison.lines.changed.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Changed
                  </p>
                  {comparison.lines.changed.map((c, i) => (
                    <div key={i} className="space-y-0.5 text-xs">
                      <p className="rounded bg-destructive/10 px-2 py-1 text-destructive line-through">
                        {c.from}
                      </p>
                      <p className="rounded bg-emerald-500/10 px-2 py-1 text-emerald-400">
                        {c.to}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {comparison.lines.added.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Added
                  </p>
                  {comparison.lines.added.map((l, i) => (
                    <p key={i} className="rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-400">
                      + {l}
                    </p>
                  ))}
                </div>
              )}
              {comparison.lines.removed.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Removed
                  </p>
                  {comparison.lines.removed.map((l, i) => (
                    <p key={i} className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
                      − {l}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Artifact preview */}
      <Dialog
        open={artifactPreview !== null}
        onOpenChange={(open) => !open && setArtifactPreview(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="capitalize">{artifactPreview?.title}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/30 p-3 text-xs">
            {artifactPreview?.markdown}
          </pre>
          <DialogFooter>
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => {
                if (artifactPreview) void navigator.clipboard.writeText(artifactPreview.markdown);
                toast("Copied.");
              }}
            >
              Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
