import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { Brain, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

type Memory = {
  _id: Id<"omiMemories">;
  content: string;
  source: "user" | "omi";
  _creationTime: number;
};

export function MemoryView() {
  const memories = useQuery(api.omiMemories.listMine);
  const createMemory = useMutation(api.omiMemories.create);
  const updateMemory = useMutation(api.omiMemories.update);
  const removeMemory = useMutation(api.omiMemories.remove);
  const clearMemories = useMutation(api.omiMemories.clearAll);

  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<Id<"omiMemories"> | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const handleSave = async () => {
    const text = draft.trim();
    if (text.length < 2) {
      toast.error("Memory needs at least a few characters.");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await updateMemory({ id: editingId, content: text });
        toast("Memory updated.");
      } else {
        await createMemory({ content: text });
        toast("Memory saved — Omi will use it.");
      }
      setDraft("");
      setEditingId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save memory.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: Id<"omiMemories">) => {
    try {
      await removeMemory({ id });
      toast("Memory deleted.");
    } catch {
      toast.error("Couldn't delete memory.");
    }
  };

  const handleClearAll = async () => {
    try {
      const removed = await clearMemories({});
      toast(removed > 0 ? `Cleared ${removed} memories.` : "No memories to clear.");
    } catch {
      toast.error("Couldn't clear memories.");
    } finally {
      setConfirmingClear(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Brain className="size-6 text-primary" />
            Memory
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Context Omi remembers across every conversation and device. You
            control it fully: add, edit, or delete anything.
          </p>
        </div>
        {(memories?.length ?? 0) > 0 &&
          (confirmingClear ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-destructive">Delete all memories?</span>
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

      <Card>
        <CardContent className="space-y-3 p-5">
          <Label htmlFor="memory-new">
            {editingId ? "Edit memory" : "New memory"}
          </Label>
          <Textarea
            id="memory-new"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. I lead support for the EMEA region. I prefer concise answers with bullet points."
            maxLength={500}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{draft.length}/500</span>
            <div className="flex gap-2">
              {editingId && (
                <Button
                  variant="ghost"
                  className="cursor-pointer"
                  onClick={() => {
                    setEditingId(null);
                    setDraft("");
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button
                className="cursor-pointer"
                onClick={() => void handleSave()}
                disabled={saving || draft.trim().length < 2}
              >
                {saving ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 size-4" />
                )}
                {editingId ? "Update memory" : "Save memory"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {memories === undefined ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : memories.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Brain className="size-8 text-muted-foreground/50" />
            <p className="mt-4 font-semibold">No memories yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Add preferences, projects, or context Omi should always know — it
              grounds every reply in what you approve.
            </p>
          </CardContent>
        </Card>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
          {memories.map((m: Memory) => (
            <Card key={m._id} className="bg-card/60">
              <CardContent className="flex items-start gap-3 p-4">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Brain className="size-4" />
                </span>
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm">
                  {m.content}
                </p>
                <button
                  type="button"
                  aria-label="Edit memory"
                  className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => {
                    setEditingId(m._id);
                    setDraft(m.content);
                  }}
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Delete memory"
                  className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                  onClick={() => void handleDelete(m._id)}
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
