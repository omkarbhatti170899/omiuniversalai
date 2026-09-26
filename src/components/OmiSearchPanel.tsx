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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  ExternalLink,
  Globe,
  History,
  KeyRound,
  Loader2,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { ShieldCheck, Workflow } from "lucide-react";
import { useState } from "react";
import { classifyFailure, recoveryToast } from "@/lib/failureRecovery";
import { recordSubsystemEvent, summarize } from "@/lib/observability";

// --- Andromeda full-pipeline card (deep research mode) -----------------------

type PipelineResult = {
  answer: string;
  summary: string;
  plan?: { kind: string };
  citations: Array<{ idx: number; title: string; url: string; domain: string }>;
  sourcesFooter: string;
  verification: { verdict: string; notes: string[] };
  usedAi: boolean;
  confidence?: { level: "high" | "moderate" | "low" | "unverified"; reason: string };
  followUps?: Array<{ question: string; why: string }>;
  stages: Array<{ stage: string; detail: string; ms: number }>;
  gates: {
    accepted: number;
    rejected: number;
    independentDomains: number;
    warnings: string[];
  };
  rawCount: number;
  dedupedCount: number;
  pagesRead: number;
  totalMs: number;
};

function AndromedaPipelineCard() {
  const research = useAction(api.andromeda.actions.research);
  const [question, setQuestion] = useState("");
  const [focus, setFocus] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineResult | null>(null);

  const run = async () => {
    if (running || question.trim().length < 8) return;
    setRunning(true);
    setResult(null);
    const startedAt = Date.now();
    try {
      const r = (await research({
        query: question.trim(),
        focus: focus.trim() || undefined,
      })) as PipelineResult;
      setResult(r);
      // Phase 11 — never the query text, only its shape.
      recordSubsystemEvent("search", "research", {
        ms: Date.now() - startedAt,
        query: summarize(question),
        citations: r?.citations?.length ?? 0,
      });
    } catch (e) {
      // Phase 7/9 — a failed search must never read like a verified answer.
      const recovery = classifyFailure({ dependency: "search", error: e });
      recordSubsystemEvent("search", "research.failed", { code: recovery.code });
      toast.error(recoveryToast(recovery), { duration: 7000 });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="border-primary/30 bg-gradient-to-b from-primary/10 via-card to-card">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Workflow className="size-5" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base">Andromeda Pipeline — deep research</CardTitle>
            <CardDescription>
              Query plan → 11 sources → dedupe → quality/freshness gates →
              reading → cited synthesis → independent verification. Your own
              documents are searched first.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Research question (e.g. Compare vector databases for on-prem use)"
            maxLength={400}
            className="h-11"
            disabled={running}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
          />
          <Button
            className="h-11 cursor-pointer px-5"
            onClick={() => void run()}
            disabled={running || question.trim().length < 8}
          >
            {running ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
            {running ? "Running pipeline…" : "Run"}
          </Button>
        </div>
        <Input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="Optional focus — e.g. focus on licensing and self-hosting"
          maxLength={120}
          className="h-9 text-xs"
          disabled={running}
        />

        {result && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                {result.plan?.kind ?? "research"}
              </Badge>
              <Badge variant="outline">
                {result.rawCount} raw → {result.dedupedCount} unique
              </Badge>
              <Badge variant="outline">
                gates: {result.gates.accepted} accepted · {result.gates.rejected} held ·{" "}
                {result.gates.independentDomains} domains
              </Badge>
              <Badge variant="outline">{result.pagesRead} pages read</Badge>
              <Badge variant="outline">{(result.totalMs / 1000).toFixed(1)}s</Badge>
              {result.verification.verdict === "pass" && (
                <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                  ✓ verified
                </Badge>
              )}
              {result.verification.verdict === "warnings" && (
                <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-400">
                  ⚠ warnings
                </Badge>
              )}
              {result.verification.verdict === "unverified" && (
                <Badge variant="outline" className="text-muted-foreground">◌ not verified</Badge>
              )}
              {result.verification.verdict === "failed" && (
                <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-400">
                  ✗ failed check
                </Badge>
              )}
            </div>

            {result.gates.warnings.length > 0 && (
              <ul className="list-inside list-disc rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-400/90">
                {result.gates.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="rounded-lg border border-border/60 p-3 text-sm leading-relaxed">
              <p className="whitespace-pre-wrap">{result.answer}</p>
              {result.confidence && (
                <p
                  className={`mt-3 border-t border-border/60 pt-2 text-[11px] ${
                    result.confidence.level === "high"
                      ? "text-emerald-400"
                      : result.confidence.level === "moderate"
                        ? "text-sky-400"
                        : result.confidence.level === "low"
                          ? "text-amber-400"
                          : "text-muted-foreground"
                  }`}
                  title={result.confidence.reason}
                >
                  Confidence: {result.confidence.level} — {result.confidence.reason}
                </p>
              )}
            </div>

            {result.followUps && result.followUps.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">
                  Deepen this research
                </p>
                {result.followUps.map((f) => (
                  <button
                    key={f.question}
                    type="button"
                    className="block w-full cursor-pointer rounded-md border border-border/60 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-primary/50 hover:text-foreground"
                    title={f.why}
                    onClick={() => {
                      setQuestion(f.question);
                      void run();
                    }}
                  >
                    {f.question}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => {
                  const md = [
                    `# Andromeda Research: ${question.trim()}`,
                    "",
                    result.answer,
                    "",
                    "## Sources",
                    ...result.citations.map((c) => `${c.idx}. [${c.title}](${c.url}) — ${c.domain}`),
                    "",
                    `Verification: ${result.verification.verdict}`,
                    result.confidence ? `Confidence: ${result.confidence.level} — ${result.confidence.reason}` : "",
                  ].join("\n");
                  void navigator.clipboard.writeText(md);
                  toast("Markdown report copied to clipboard.");
                }}
              >
                Copy as Markdown
              </Button>
            </div>

            {result.citations.length > 0 && (
              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <ShieldCheck className="size-3.5" /> Sources
                </p>
                {result.citations.map((c) => (
                  <a
                    key={c.idx}
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  >
                    [{c.idx}] {c.title} — {c.domain}
                  </a>
                ))}
              </div>
            )}

            <details className="rounded-lg border border-border/60 p-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Pipeline stage audit ({result.stages.length} stages)
              </summary>
              <ol className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                {result.stages.map((s, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span>
                      {s.stage} — {s.detail}
                    </span>
                    <span className="shrink-0 tabular-nums">{s.ms}ms</span>
                  </li>
                ))}
              </ol>
            </details>
          </motion.div>
        )}
      </CardContent>
    </Card>
  );
}

type Citation = {
  title: string;
  url: string;
  snippet?: string;
  providers?: string[];
};

type WebSearch = {
  _id: Id<"webSearches">;
  userId: Id<"users">;
  query: string;
  answer: string;
  citations: Citation[];
  _creationTime: number;
};

const EXAMPLE_QUERIES = [
  "What are customers saying about our competitors' support quality?",
  "Latest AI trends for customer support teams",
  "Best practices for de-escalating angry customers",
];

function renderAnswer(answer: string) {
  const parts = answer.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      return (
        <span
          key={i}
          className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary"
        >
          {match[1]}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function OmiSearchPanel({
  initialQuery,
}: {
  initialQuery?: string;
} = {}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [isSearching, setIsSearching] = useState(false);

  const providerStatus = useQuery(api.searchStatus.status);
  const history = useQuery(api.searchHistory.listMine);
  const searches = history ?? [];

  const searchWeb = useAction(api.search.searchWeb);
  const removeSearch = useMutation(api.searchHistory.remove);

  const searchReady =
    providerStatus !== undefined &&
    providerStatus.some((p) => p.ready);
  // SearXNG is always configured (self-hosted or public floor) — search
  // works with zero cost and zero keys. No premium upgrade card needed.
  const needsSetup = false;
  const missingHints =
    providerStatus
      ?.filter((p) => !p.ready && p.hint)
      .map((p) => p.hint)
      .join(" ") ?? "";

  const handleSearch = async () => {
    if (query.trim().length < 2 || isSearching) return;
    setIsSearching(true);
    const startedAt = Date.now();
    try {
      await searchWeb({ query });
      recordSubsystemEvent("search", "web", {
        ms: Date.now() - startedAt,
        query: summarize(query),
      });
    } catch (err) {
      const recovery = classifyFailure({ dependency: "search", error: err });
      recordSubsystemEvent("search", "web.failed", { code: recovery.code });
      toast.error(recoveryToast(recovery), { duration: 7000 });
    } finally {
      setIsSearching(false);
    }
  };

  const handleDelete = async (id: Id<"webSearches">) => {
    try {
      await removeSearch({ id });
      toast("Search removed.");
    } catch (err) {
      toast.error(
        recoveryToast(classifyFailure({ dependency: "database", error: err })),
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Hero ask bar */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-b from-primary/15 via-card to-card p-6 sm:p-8"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(420px circle at 50% -20%, oklch(0.68 0.15 262 / 0.25), transparent 65%)",
          }}
        />
        <div className="relative">
          <div className="flex items-center justify-center gap-2">
            <Globe className="size-4 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-widest text-primary">
              Andromeda · Universal Meta-Search
            </span>
          </div>
          <h2 className="mt-2 text-center text-2xl font-bold tracking-tight sm:text-3xl">
            Ask Andromeda anything
          </h2>
          <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">
            Parallel retrieval across SearXNG, Wikipedia, arXiv, OpenAlex, Open
            Library, Hacker News and more — deduplicated, ranked, cited. $0
            per search, no API keys required.
          </p>

          <div className="mx-auto mt-6 flex max-w-2xl flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search anything… (topics, news, research, how-tos)"
                className="h-12 rounded-xl pl-11 text-base"
                disabled={isSearching}
                maxLength={500}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSearch();
                  }
                }}
              />
            </div>
            <Button
              size="lg"
              className="h-12 cursor-pointer rounded-xl px-6"
              onClick={() => void handleSearch()}
              disabled={isSearching || query.trim().length < 2}
            >
              {isSearching ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Searching…
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 size-4" />
                  Ask Omi
                </>
              )}
            </Button>
          </div>

          <div className="mx-auto mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
            {EXAMPLE_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                className="max-w-full truncate rounded-full border border-border/70 bg-background/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                onClick={() => setQuery(q)}
                disabled={isSearching}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Andromeda deep-research pipeline (full §4 fabric) */}
      <AndromedaPipelineCard />

      {/* Missing key — graceful setup state */}
      {needsSetup && (
        <Card className="border-primary/40">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <KeyRound className="size-5" />
              </div>
              <div>
                <CardTitle className="text-base">
                  Power up Omi Search
                </CardTitle>
                <CardDescription>
                  Omi is searching with its built-in keyless engine. Connect a
                  premium engine for deeper, cleaner AI answers.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                {missingHints ||
                  "Add TAVILY_API_KEY or EXA_API_KEY in the project's API Keys tab for premium search."}
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                Free tiers: tavily.com or exa.ai → API Keys → copy the key.
              </li>
            </ul>
            <p className="text-xs text-muted-foreground">
              Nothing else to configure — the app detects the key automatically
              and search turns on.
            </p>
          </CardContent>
        </Card>
      )}

      {/* History */}
      <section>
        <div className="flex items-end justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              <History className="size-5 text-muted-foreground" />
              Search history
            </h2>
            <p className="text-sm text-muted-foreground">
              Your last 50 searches, newest first.
            </p>
          </div>
          {history && history.length > 0 && (
            <Badge variant="secondary">{history.length} saved</Badge>
          )}
        </div>

        {history === undefined ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : searches.length === 0 ? (
          <Card className="mt-6 border-dashed">
            <CardContent className="flex flex-col items-center py-12 text-center">
              <Search className="size-8 text-muted-foreground/50" />
              <p className="mt-4 font-semibold">No searches yet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {searchReady
                  ? "Ask your first question above — Omi searches the live web and saves every cited answer here."
                  : "Once a search provider is connected, your cited answers will appear here."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-6 space-y-4">
            {searches.map((s: WebSearch) => (
              <motion.div
                key={s._id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
              >
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <CardTitle className="text-base">{s.query}</CardTitle>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 cursor-pointer text-muted-foreground hover:text-destructive"
                        onClick={() => void handleDelete(s._id)}
                        aria-label="Delete search"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm leading-relaxed">
                      {renderAnswer(s.answer)}
                    </p>

                    {s.citations.length > 0 && (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Sources
                        </p>
                        <div className="space-y-2">
                          {s.citations.map((c, i) => (
                            <a
                              key={`${s._id}-citation-${i}`}
                              href={c.url}
                              target="_blank"
                              rel="noreferrer"
                              className="group flex items-start gap-2.5 rounded-lg border border-border/60 p-2.5 transition-colors hover:border-primary/50"
                            >
                              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                                {i + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="flex items-center gap-1.5 text-sm font-medium group-hover:text-primary">
                                  <span className="truncate">{c.title}</span>
                                  <ExternalLink className="size-3 shrink-0" />
                                </p>
                                {c.snippet && (
                                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                    {c.snippet}
                                  </p>
                                )}
                                {c.providers && c.providers.length > 0 && (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {c.providers.slice(0, 4).map((p) => (
                                      <span
                                        key={p}
                                        className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                                      >
                                        {p}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
