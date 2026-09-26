import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { format } from "date-fns";
import {
  BookOpen,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

type KnowledgeDoc = {
  _id: Id<"omiDocuments">;
  title: string;
  wordCount: number;
  _creationTime: number;
};

type Passage = {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
};

export function KnowledgeView() {
  const documents = useQuery(api.omiKnowledge.listMine);
  const createDoc = useMutation(api.omiKnowledge.create);
  const removeDoc = useMutation(api.omiKnowledge.remove);
  const clearDocs = useMutation(api.omiKnowledge.clearAll);
  const renameDoc = useMutation(api.omiKnowledge.rename);

  // Add-document form
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  // "Clear all" + inline rename (user-controlled organisation).
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [renamingId, setRenamingId] = useState<Id<"omiDocuments"> | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Search: committed on submit so typing doesn't spam reactive queries.
  const [searchInput, setSearchInput] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const results = useQuery(
    api.omiKnowledge.search,
    committedQuery.length >= 2
      ? { query: committedQuery, limit: 6 }
      : { query: "", limit: 6 },
  );

  const handleSave = async () => {
    if (title.trim().length < 1 || content.trim().length < 20) {
      toast.error("Add a title and at least a sentence or two of content.");
      return;
    }
    setSaving(true);
    try {
      await createDoc({ title, content });
      toast("Document saved — Omi can now use it as context.");
      setTitle("");
      setContent("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save document.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: Id<"omiDocuments">) => {
    try {
      await removeDoc({ id });
      toast("Document deleted.");
    } catch {
      toast.error("Couldn't delete document.");
    }
  };

  const handleClearAll = async () => {
    try {
      const removed = await clearDocs({});
      toast(removed > 0 ? `Cleared ${removed} documents.` : "Nothing to clear.");
    } catch {
      toast.error("Couldn't clear your knowledge base.");
    } finally {
      setConfirmingClear(false);
    }
  };

  const handleRename = async (id: Id<"omiDocuments">) => {
    try {
      await renameDoc({ id, title: renameDraft });
      toast("Renamed.");
      setRenamingId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename it.");
    }
  };

  const handleSearch = () => {
    const q = searchInput.trim();
    if (q.length < 2) {
      toast.error("Type at least a couple of characters to search.");
      return;
    }
    setCommittedQuery(q);
  };

  const totalWords =
    documents?.reduce((sum, d) => sum + d.wordCount, 0) ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <BookOpen className="size-6 text-primary" />
            Knowledge
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your private knowledge base. Save documents once — Omi retrieves the
            relevant passages locally (zero cost) and grounds its answers in them.
          </p>
          {documents !== undefined && documents.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {documents.length} document{documents.length === 1 ? "" : "s"} ·{" "}
              {totalWords.toLocaleString()} words indexed
            </p>
          )}
        </div>
        {(documents?.length ?? 0) > 0 &&
          (confirmingClear ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-destructive">Delete everything?</span>
              <Button
                variant="destructive"
                size="sm"
                className="cursor-pointer"
                onClick={() => void handleClearAll()}
              >
                Yes, clear all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer"
                onClick={() => setConfirmingClear(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer text-destructive hover:text-destructive"
              onClick={() => setConfirmingClear(true)}
            >
              <Trash2 className="mr-1.5 size-4" />
              Clear all
            </Button>
          ))}
      </div>

      {/* Search */}
      <Card>
        <CardContent className="space-y-4 p-5">
          <Label htmlFor="knowledge-search">
            Search your knowledge base
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="knowledge-search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
                placeholder="e.g. refund policy timeline"
                className="pl-10"
                maxLength={300}
              />
            </div>
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={handleSearch}
              disabled={searchInput.trim().length < 2}
            >
              <Search className="mr-2 size-4" />
              Search
            </Button>
          </div>

          {committedQuery.length >= 2 && (
            <div className="space-y-2">
              {results === undefined ? (
                <Skeleton className="h-16 w-full" />
              ) : results.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No passages matched “{committedQuery}”.
                </p>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-2"
                >
                  {results.map((p: Passage, i: number) => (
                    <div
                      key={`${p.documentId}-${i}`}
                      className="rounded-lg border border-border/60 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                          <FileText className="size-4 shrink-0 text-primary" />
                          <span className="truncate">{p.title}</span>
                        </p>
                        <Badge variant="secondary" className="shrink-0">
                          relevance {p.score}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                        {p.snippet}
                      </p>
                    </div>
                  ))}
                </motion.div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add document */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <Label htmlFor="knowledge-title">Add a document</Label>
          <Input
            id="knowledge-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Document title — e.g. Product roadmap 2026"
            maxLength={200}
          />
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste or write the document content. Omi chunks it into passages and retrieves what's relevant per question."
            rows={6}
            maxLength={60000}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {content.length.toLocaleString()}/60,000
            </span>
            <Button
              className="cursor-pointer"
              onClick={() => void handleSave()}
              disabled={saving || content.trim().length < 20}
            >
              {saving ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Plus className="mr-2 size-4" />
              )}
              Save document
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Document list */}
      {documents === undefined ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : documents.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <BookOpen className="size-8 text-muted-foreground/50" />
            <p className="mt-4 font-semibold">No documents yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Save notes, specs, policies or research here — Omi quotes them
              before searching the web, so your own material always wins.
            </p>
          </CardContent>
        </Card>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="space-y-2"
        >
          {documents.map((d: KnowledgeDoc) => (
            <Card key={d._id} className="bg-card/60">
              <CardContent className="flex items-start gap-3 p-4">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  {renamingId === d._id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        maxLength={200}
                        aria-label="New document name"
                        className="h-8"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename(d._id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                      />
                      <Button
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => void handleRename(d._id)}
                      >
                        Save
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 cursor-pointer"
                        aria-label="Cancel rename"
                        onClick={() => setRenamingId(null)}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : (
                    <p className="truncate text-sm font-semibold">{d.title}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {d.wordCount.toLocaleString()} words ·{" "}
                    {format(new Date(d._creationTime), "MMM d, yyyy")}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Rename document"
                  className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => {
                    setRenamingId(d._id);
                    setRenameDraft(d.title);
                  }}
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Delete document"
                  className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                  onClick={() => void handleDelete(d._id)}
                >
                  <Trash2 className="size-4" />
                </button>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      )}
    </div>
  );
}
