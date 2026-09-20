import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  ExternalLink,
  Globe,
  History,
  Link2,
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
  // Split on [1]-style citations and make them small superscript-ish chips
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

  const history = useQuery(api.searchHistory.listMine);
  const searches = history ?? [];
  const searchWeb = useAction(api.search.searchWeb);
  const removeSearch = useMutation(api.searchHistory.remove);

  const handleSearch = async () => {
    if (query.trim().length < 2 || isSearching) return;
    setIsSearching(true);
    try {
      await searchWeb({ query });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Omi Search failed. Try again.");
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
      {/* Search bar */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Globe className="size-5" />
            </div>
            <div>
              <CardTitle>Omi Search</CardTitle>
              <CardDescription>
                Live web answers with citations — powered by Omi.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask anything — Omi searches the live web…"
                className="pl-9"
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
              className="cursor-pointer"
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
                  Search with Omi
                </>
              )}
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLE_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                className="max-w-full truncate rounded-full border border-border/70 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                onClick={() => setQuery(q)}
                disabled={isSearching}
              >
                {q}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

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
          {!history && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {history && history.length > 0 && (
            <Badge variant="secondary">{history.length} saved</Badge>
          )}
          {history && history.length === 0 && (
            <Badge variant="secondary">0</Badge>
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
                Ask your first question above — Omi will search the live web and
                save every answer with its citations here.
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
                              <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
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
