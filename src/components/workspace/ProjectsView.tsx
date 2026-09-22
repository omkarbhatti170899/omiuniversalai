/**
 * Omi Projects (§5) — persistent containers that scope conversations, files,
 * instructions and research per project, with original Omi UI.
 *
 * A project is the unit of context isolation: its conversations ground from
 * its documents and follow its standing instructions; nothing leaks across
 * projects. Deleting a project never destroys the data inside it — children
 * are unscoped, not removed (§11 user control).
 */
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  Check,
  FolderKanban,
  FolderPlus,
  Loader2,
  MessageSquare,
  NotebookText,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

type Project = {
  _id: Id<"omiProjects">;
  name: string;
  instructions: string;
  createdAt: number;
  updatedAt: number;
  documentCount: number;
  conversationCount: number;
};

const INSTRUCTIONS_PLACEHOLDER =
  "e.g. Always answer in Spanish. Prefer bullet points. This project tracks our Q3 launch — treat everything here as launch-related.";

export function ProjectsView({
  /** Optional: lets the user jump straight into a chat scoped to a project. */
  onChatInProject,
}: {
  onChatInProject?: (projectId: Id<"omiProjects">) => void;
} = {}) {
  const projects = useQuery(api.omiProjects.listMine);
  const createProject = useMutation(api.omiProjects.create);
  const updateProject = useMutation(api.omiProjects.update);
  const removeProject = useMutation(api.omiProjects.remove);
  const attachDocument = useMutation(api.omiProjects.attachDocument);
  const detachDocument = useMutation(api.omiProjects.detachDocument);
  const moveConversation = useMutation(api.omiProjects.moveConversation);

  const documents = useQuery(api.omiKnowledge.listMine);
  const conversations = useQuery(api.omiConversations.listMine);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<Id<"omiProjects"> | null>(null);
  const [editName, setEditName] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<Id<"omiProjects"> | null>(
    null,
  );
  /** Which project's context panel is open. */
  const [expandedId, setExpandedId] = useState<Id<"omiProjects"> | null>(null);

  const handleCreate = async () => {
    setBusy(true);
    try {
      await createProject({ name, instructions });
      toast("Project created.");
      setCreateOpen(false);
      setName("");
      setInstructions("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create project.");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async (id: Id<"omiProjects">) => {
    try {
      await updateProject({ id, name: editName, instructions: editInstructions });
      toast("Project updated.");
      setEditingId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update project.");
    }
  };

  const handleDelete = async (id: Id<"omiProjects">) => {
    try {
      await removeProject({ id });
      toast("Project deleted — its conversations and files were kept.");
      setConfirmDeleteId(null);
      if (expandedId === id) setExpandedId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete project.");
    }
  };

  const startEdit = (p: Project) => {
    setEditingId(p._id);
    setEditName(p.name);
    setEditInstructions(p.instructions);
  };

  const personalDocs = (documents ?? []).filter((d) => d.projectId === undefined);
  const personalConvs = (conversations ?? []).filter(
    // Conversations predate Projects when projectId is absent from the type.
    (c) => (c as { projectId?: Id<"omiProjects"> }).projectId === undefined,
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <FolderKanban className="size-6 text-primary" />
            Projects
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each project keeps its own conversations, files and standing
            instructions — context never mixes between projects.
          </p>
        </div>
        <Button className="cursor-pointer" onClick={() => setCreateOpen(true)}>
          <FolderPlus className="mr-2 size-4" />
          New project
        </Button>
      </div>

      {projects === undefined ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : projects.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <FolderKanban className="size-8 text-muted-foreground/50" />
            <p className="mt-4 font-semibold">No projects yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Create a project for anything with its own context — a launch, a
              paper, a codebase. Omi keeps its instructions, files and chats
              separate from everything else.
            </p>
            <Button
              variant="outline"
              className="mt-4 cursor-pointer"
              onClick={() => setCreateOpen(true)}
            >
              <FolderPlus className="mr-2 size-4" />
              Create your first project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
          {projects.map((p: Project) => (
            <Card key={p._id} className="bg-card/60">
              <CardContent className="space-y-3 p-4">
                {editingId === p._id ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`edit-name-${p._id}`}>Name</Label>
                      <Input
                        id={`edit-name-${p._id}`}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        maxLength={80}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`edit-instr-${p._id}`}>
                        Standing instructions for Omi
                      </Label>
                      <Textarea
                        id={`edit-instr-${p._id}`}
                        value={editInstructions}
                        onChange={(e) => setEditInstructions(e.target.value)}
                        placeholder={INSTRUCTIONS_PLACEHOLDER}
                        maxLength={4000}
                        rows={4}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        className="cursor-pointer"
                        onClick={() => setEditingId(null)}
                      >
                        <X className="mr-1 size-4" />
                        Cancel
                      </Button>
                      <Button
                        className="cursor-pointer"
                        onClick={() => void handleSaveEdit(p._id)}
                        disabled={editName.trim().length < 2}
                      >
                        <Check className="mr-1 size-4" />
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 cursor-pointer text-left"
                        onClick={() =>
                          setExpandedId(expandedId === p._id ? null : p._id)
                        }
                        aria-expanded={expandedId === p._id}
                      >
                        <h2 className="truncate font-semibold">{p.name}</h2>
                        <p className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <MessageSquare className="size-3" />
                            {p.conversationCount} conversation
                            {p.conversationCount === 1 ? "" : "s"}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <NotebookText className="size-3" />
                            {p.documentCount} file{p.documentCount === 1 ? "" : "s"}
                          </span>
                        </p>
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Edit ${p.name}`}
                          className="cursor-pointer p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => startEdit(p)}
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${p.name}`}
                          className="cursor-pointer p-1.5 text-muted-foreground transition-colors hover:text-destructive"
                          onClick={() => setConfirmDeleteId(p._id)}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </div>

                    {p.instructions.length > 0 && (
                      <p className="whitespace-pre-wrap rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                        {p.instructions}
                      </p>
                    )}

                    {confirmDeleteId === p._id && (
                      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                        <p className="text-xs">
                          Delete “{p.name}”? Its conversations and files are
                          kept — they just leave the project.
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="cursor-pointer"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Keep project
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="cursor-pointer"
                            onClick={() => void handleDelete(p._id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    )}

                    {expandedId === p._id && (
                      <div className="space-y-4 border-t border-border/60 pt-3">
                        {onChatInProject && (
                          <Button
                            size="sm"
                            className="cursor-pointer"
                            onClick={() => onChatInProject(p._id)}
                          >
                            <MessageSquare className="mr-1.5 size-3.5" />
                            Chat inside this project
                          </Button>
                        )}

                        {/* Conversations: move personal ones in, project ones out. */}
                        <div>
                          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                            Conversations
                          </p>
                          {personalConvs.length > 0 && (
                            <select
                              aria-label={`Add a conversation to ${p.name}`}
                              className="mb-2 w-full cursor-pointer rounded-md border border-border bg-transparent px-2 py-1.5 text-xs"
                              defaultValue=""
                              onChange={(e) => {
                                const id = e.target.value;
                                if (!id) return;
                                void moveConversation({
                                  conversationId: id as Id<"omiConversations">,
                                  projectId: p._id,
                                })
                                  .then(() => toast("Conversation moved into project."))
                                  .catch((err: unknown) =>
                                    toast.error(
                                      err instanceof Error ? err.message : "Move failed.",
                                    ),
                                  );
                                e.target.value = "";
                              }}
                            >
                              <option value="" disabled>
                                Add a conversation…
                              </option>
                              {personalConvs.map((c) => (
                                <option key={c._id} value={c._id}>
                                  {c.title}
                                </option>
                              ))}
                            </select>
                          )}
                          {(conversations ?? [])
                            .filter(
                              (c) =>
                                (c as { projectId?: Id<"omiProjects"> }).projectId ===
                                p._id,
                            )
                            .map((c) => (
                              <div
                                key={c._id}
                                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/40"
                              >
                                <span className="truncate">{c.title}</span>
                                <button
                                  type="button"
                                  aria-label={`Remove ${c.title} from project`}
                                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                                  onClick={() =>
                                    void moveConversation({
                                      conversationId: c._id,
                                      projectId: undefined,
                                    })
                                      .then(() => toast("Conversation moved out."))
                                      .catch((err: unknown) =>
                                        toast.error(
                                          err instanceof Error ? err.message : "Move failed.",
                                        ),
                                      )
                                  }
                                >
                                  <X className="size-3.5" />
                                </button>
                              </div>
                            ))}
                        </div>

                        {/* Files: same pattern. */}
                        <div>
                          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                            Files & knowledge
                          </p>
                          {personalDocs.length > 0 && (
                            <select
                              aria-label={`Add a file to ${p.name}`}
                              className="mb-2 w-full cursor-pointer rounded-md border border-border bg-transparent px-2 py-1.5 text-xs"
                              defaultValue=""
                              onChange={(e) => {
                                const id = e.target.value;
                                if (!id) return;
                                void attachDocument({
                                  documentId: id as Id<"omiDocuments">,
                                  projectId: p._id,
                                })
                                  .then(() => toast("File added to project."))
                                  .catch((err: unknown) =>
                                    toast.error(
                                      err instanceof Error ? err.message : "Move failed.",
                                    ),
                                  );
                                e.target.value = "";
                              }}
                            >
                              <option value="" disabled>
                                Add a file…
                              </option>
                              {personalDocs.map((d) => (
                                <option key={d._id} value={d._id}>
                                  {d.title}
                                </option>
                              ))}
                            </select>
                          )}
                          {(documents ?? [])
                            .filter((d) => d.projectId === p._id)
                            .map((d) => (
                              <div
                                key={d._id}
                                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/40"
                              >
                                <span className="truncate">{d.title}</span>
                                <button
                                  type="button"
                                  aria-label={`Remove ${d.title} from project`}
                                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                                  onClick={() =>
                                    void detachDocument({ documentId: d._id })
                                      .then(() => toast("File removed from project."))
                                      .catch((err: unknown) =>
                                        toast.error(
                                          err instanceof Error ? err.message : "Move failed.",
                                        ),
                                      )
                                  }
                                >
                                  <X className="size-3.5" />
                                </button>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </motion.div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Projects scope conversations, files and instructions — Omi keeps
              each project's context separate.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Q3 product launch"
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-instructions">
                Standing instructions for Omi (optional)
              </Label>
              <Textarea
                id="project-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={INSTRUCTIONS_PLACEHOLDER}
                maxLength={4000}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              className="cursor-pointer"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              onClick={() => void handleCreate()}
              disabled={busy || name.trim().length < 2}
            >
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Create project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
