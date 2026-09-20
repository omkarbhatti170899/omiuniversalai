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
import { useState } from "react";

type Citation = {
  title: string;
  url: string;
  snippet?: string;
};

type WebSearch = {
  _id: Id<"webSearches">;
  userId: Id<"users">;
  query: string;
  answer: string;
  citations: Citation[];
  _creationTime: number;
};

type ProviderStatus = {
  providers: Array<{
    id: string;
    label: string;
    configured: boolean;
    hint: string;
  }>;
  activeId: string | null;
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

export function OmiSearchPanel() {
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  const providerStatus = useQuery(api.searchStatus.status);
  const history = useQuery(api.searchHistory.listMine);
  const searches = history ?? [];

  const searchWeb = useAction(api.search.searchWeb);
  const removeSearch = useMutation(api.searchHistory.remove);

  const searchReady =
    providerStatus !== undefined &&
    providerStatus.providers.some((p) => p.configured);
  const needsSetup = providerStatus !== undefined && !searchReady;
  const missingHints =
    providerStatus?.providers
      .filter((p) => !p.configured)
      .map((p) => p.hint)
      .join(" ") ?? "";

  const handleSearch = async () => {
    if (query.trim().length < 2 || isSearching) return;
    setIsSearching(true);
    try {
      await searchWeb({ query });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Omi Search failed. Try again.",
      );
    } finally {
      setIsSearching(false);
    }
  };

  const handleDelete = async (id: Id<"webSearches">) => {
    try {
      await removeSearch({ id });
      toast("Search removed.");
    } catch {
      toast.error("Couldn't remove that search.");
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
              Omi Universal Search
            </span>
          </div>
          <h2 className="mt-2 text-center text-2xl font-bold tracking-tight sm:text-3xl">
            Ask Omi anything
          </h2>
          <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">
            Live web answers with citations — any question, any topic.
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
                  Connect a web-search provider
                </CardTitle>
                <CardDescription>
                  Omi Search is provider-independent — connect one key and it
                  goes live.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                {missingHints ||
                  "Add EXA_API_KEY in the project's API Keys tab to enable live web search."}
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                Exa free tier: sign up at exa.ai → API Keys → copy the key.
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
