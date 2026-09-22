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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  BrainCircuit,
  Brain,
  ChevronDown,
  History,
  Loader2,
  MessageSquarePlus,
  Mic,
  MicOff,
  Paperclip,
  FileImage,
  Pencil,
  Plus,
  Send,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { useSpeechOutput } from "@/hooks/useSpeechOutput";
import { useConvexClient } from "@/hooks/useConvexClient";
import {
  MAX_ATTACHMENTS,
  isImageFile,
  uploadAttachment,
  validateForUpload,
  type AttachmentState,
} from "@/lib/attachmentUpload";
import { FolderKanban } from "lucide-react";

type OmiMessage = {
  _id: Id<"omiMessages">;
  role: "user" | "omi";
  content: string;
  reasoning?: string;
  status?: "streaming" | "final";
  attachments?: Array<{
    documentId: string;
    title: string;
    kind: "image" | "file";
  }>;
  _creationTime: number;
};

type Conversation = {
  _id: Id<"omiConversations">;
  title: string;
  _creationTime: number;
  /** §5 Projects: set when the chat belongs to a project. */
  projectId?: Id<"omiProjects">;
};

type Memory = {
  _id: Id<"omiMemories">;
  content: string;
  source: "user" | "omi";
};

export function OmiAssistantPanel({
  initialDraft,
  /** §5 Projects: when set, new chats belong to this project and ground ONLY from its files + instructions. */
  projectId,
}: {
  initialDraft?: string;
  projectId?: Id<"omiProjects"> | null;
} = {}) {
  const conversations = useQuery(api.omiConversations.listMine);
  const memories = useQuery(api.omiMemories.listMine);
  // §5 Projects: project name for the in-chat banner (ownership-checked read).
  const project = useQuery(
    api.omiProjects.listMine,
    projectId ? {} : "skip",
  )?.find((p) => p._id === projectId);

  const [activeId, setActiveId] = useState<Id<"omiConversations"> | null>(null);
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [isSending, setIsSending] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<Id<"omiMemories"> | null>(
    null,
  );

  const messages = useQuery(
    api.omiMessages.listByConversation,
    activeId ? { conversationId: activeId } : "skip",
  );

  const createConversation = useMutation(api.omiConversations.create);
  const removeConversation = useMutation(api.omiConversations.remove);
  const sendMessage = useAction(api.omiChat.send);
  const createMemory = useMutation(api.omiMemories.create);
  const updateMemory = useMutation(api.omiMemories.update);
  const removeMemory = useMutation(api.omiMemories.remove);
  const voice = useVoiceInput();
  const tts = useSpeechOutput();
  const convex = useConvexClient();

  // --- Attachments (PRIORITY 1: upload → extract → knowledge → answer) ---
  const [attachments, setAttachments] = useState<AttachmentState[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadQueue = useRef(0);
  const [uploadingCount, setUploadingCount] = useState(0);

  const pendingAttachments = attachments.filter((a) => a.state === "ready");
  const hasUploading = uploadingCount > 0;

  const handleFilesChosen = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      toast.error(`Omi reads up to ${MAX_ATTACHMENTS} attachments per message.`);
      return;
    }
    const chosen = Array.from(list).slice(0, room);
    if (Array.from(list).length > room) {
      toast.error(`Only the first ${room} file${room === 1 ? "" : "s"} were added — ${MAX_ATTACHMENTS} max per message.`);
    }
    for (const file of chosen) {
      const check = validateForUpload(file);
      if (!check.ok) {
        toast.error(check.error);
        continue;
      }
      const kind = isImageFile(file) ? "image" : "file";
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
      setAttachments((prev) => [
        ...prev,
        { localId, state: "uploading", name: file.name, size: file.size, kind, previewUrl },
      ]);
      setUploadingCount((c) => c + 1);
      uploadAttachment(file, { api, convex })
        .then(({ documentId, truncated }) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === localId
                ? { ...a, state: "ready" as const, documentId, truncated }
                : a,
            ),
          );
        })
        .catch((err) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === localId
                ? {
                    ...a,
                    state: "failed" as const,
                    error: err instanceof Error ? err.message : "Upload failed.",
                  }
                : a,
            ),
          );
          toast.error(err instanceof Error ? err.message : `Couldn't upload "${file.name}".`);
        })
        .finally(() => {
          setUploadingCount((c) => Math.max(0, c - 1));
          uploadQueue.current = Math.max(0, uploadQueue.current - 1);
        });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => {
      const a = prev.find((x) => x.localId === localId);
      if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return prev.filter((x) => x.localId !== localId);
    });
  };
  // --- end attachments ---

  // §5 Projects: the sidebar shows only conversations in the current scope —
  // a project's chats never mix with personal ones.
  const visibleConversations = (conversations ?? []).filter((c) =>
    projectId ? c.projectId === projectId : c.projectId === undefined,
  );

  // Auto-select the newest conversation on first load.
  useEffect(() => {
    if (visibleConversations.length > 0 && !activeId) {
      setActiveId(visibleConversations[0]._id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, activeId]);

  const handleNewConversation = async () => {
    try {
      const id = await createConversation({ projectId: projectId ?? undefined });
      setActiveId(id);
    } catch {
      toast.error("Couldn't start a new conversation.");
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || isSending) return;
    if (hasUploading) {
      toast.error("Hold on — Omi is still reading your attachment(s).");
      return;
    }
    let convId = activeId;
    if (!convId) {
      try {
        convId = await createConversation({
          title: text.slice(0, 60),
          projectId: projectId ?? undefined,
        });
        setActiveId(convId);
      } catch {
        toast.error("Couldn't start a conversation.");
        return;
      }
    }
    setIsSending(true);
    const ready = attachments.filter((a) => a.state === "ready");
    const documentIds = ready.map((a) => a.documentId as never);
    try {
      await sendMessage({ conversationId: convId, message: text, documentIds: documentIds.length > 0 ? documentIds : undefined });
      setDraft("");
      // Attachments sent: clear chips (their docs stay in the knowledge base).
      setAttachments((prev) => {
        for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        return [];
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Omi couldn't respond.");
    } finally {
      setIsSending(false);
    }
  };

  const handleSaveMemory = async () => {
    const text = memoryDraft.trim();
    if (text.length < 2) {
      toast.error("Memory needs at least a few characters.");
      return;
    }
    try {
      if (editingMemoryId) {
        await updateMemory({ id: editingMemoryId, content: text });
        toast("Memory updated.");
      } else {
        await createMemory({ content: text });
        toast("Memory saved — Omi will use it.");
      }
      setMemoryDraft("");
      setEditingMemoryId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save memory.");
    }
  };

  const handleDeleteMemory = async (id: Id<"omiMemories">) => {
    try {
      await removeMemory({ id });
      toast("Memory deleted.");
    } catch {
      toast.error("Couldn't delete memory.");
    }
  };

  const handleDeleteConversation = async (id: Id<"omiConversations">) => {
    try {
      await removeConversation({ id });
      if (activeId === id) {
        const remaining = (conversations ?? []).filter((c) => c._id !== id);
        setActiveId(remaining.length > 0 ? remaining[0]._id : null);
      }
    } catch {
      toast.error("Couldn't delete conversation.");
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      {/* Sidebar: conversations + memory */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BrainCircuit className="size-4 text-primary" />
              Omi Assistant
            </CardTitle>
            <CardDescription className="text-xs">
              Reasoning-first AI with memory
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button
              className="w-full cursor-pointer"
              onClick={() => void handleNewConversation()}
            >
              <MessageSquarePlus className="mr-2 size-4" />
              New chat
            </Button>
            <Button
              variant="outline"
              className="w-full cursor-pointer"
              onClick={() => setMemoryOpen(true)}
            >
              <Brain className="mr-2 size-4" />
              Memory
              {memories && memories.length > 0 && (
                <Badge variant="secondary" className="ml-auto">
                  {memories.length}
                </Badge>
              )}
            </Button>
          </CardContent>
        </Card>

        <div>
          <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <History className="size-3.5" />
            {projectId ? "Project conversations" : "Conversations"}
          </p>
          {conversations === undefined ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : visibleConversations.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              {projectId
                ? "No conversations in this project yet."
                : "No conversations yet."}
            </p>
          ) : (
            <div className="space-y-1.5">
              {visibleConversations.map((c: Conversation) => (
                <div
                  key={c._id}
                  className={`group flex items-center rounded-lg border px-3 py-2 text-sm transition-colors ${
                    activeId === c._id
                      ? "border-primary/50 bg-primary/10"
                      : "border-border/60 hover:border-primary/30"
                  }`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer truncate text-left"
                    onClick={() => setActiveId(c._id)}
                  >
                    {c.title}
                    {c.projectId !== undefined && (
                      <span
                        className="ml-2 inline-flex items-center rounded-full border border-border/70 px-1.5 py-0.5 align-middle text-[10px] text-muted-foreground"
                        title="This conversation belongs to a project"
                      >
                        project
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    className="ml-1 cursor-pointer text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    onClick={() => void handleDeleteConversation(c._id)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Chat thread */}
      <Card className="flex min-h-[520px] flex-col">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {activeId
              ? ((conversations ?? []).find((c) => c._id === activeId)?.title ??
                "Conversation")
              : "Start a conversation"}
          </CardTitle>
          <CardDescription>
            {project ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <FolderKanban className="size-3.5 text-primary" />
                Grounded in project “{project.name}” — its instructions and
                files only.
              </span>
            ) : (
              "Omi plans, reasons, and explains — grounded in your approved memory."
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {messages === undefined && activeId ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-3/4" />
                <Skeleton className="ml-auto h-12 w-2/3" />
              </div>
            ) : !messages || messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                <BrainCircuit className="size-10 text-muted-foreground/40" />
                <p className="mt-4 font-semibold">Talk to Omi</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Ask anything. Omi breaks down the problem, reasons through it,
                  and shows you a "Why this answer" trail.
                </p>
              </div>
            ) : (
              (messages as OmiMessage[]).map((m) => (
                <motion.div
                  key={m._id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className={
                    m.role === "user" ? "flex justify-end" : "flex justify-start"
                  }
                >
                  <div
                    className={`max-w-[85%] rounded-xl border px-4 py-3 text-sm leading-relaxed ${
                      m.role === "user"
                        ? "border-primary/40 bg-primary/10"
                        : m.status === "streaming"
                          ? "border-primary/40 bg-primary/5"
                          : "border-border/60 bg-muted/40"
                    }`}
                  >
                    {m.role === "user" && m.attachments && m.attachments.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {m.attachments.map((att) => (
                          <span
                            key={att.documentId}
                            className="flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {att.kind === "image" ? (
                              <FileImage className="size-3" />
                            ) : (
                              <Paperclip className="size-3" />
                            )}
                            {att.title}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap">
                      {m.status === "streaming" && (
                        <span className="mr-2 inline-flex size-2 animate-pulse rounded-full bg-primary align-middle" />
                      )}
                      {m.content}
                    </p>
                    {m.role !== "user" && tts.supported && (
                      <button
                        type="button"
                        onClick={() => (tts.speaking ? tts.stop() : tts.speak(m.content))}
                        className="mt-2 flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                        title="Read aloud (on-device, free)"
                      >
                        {tts.speaking ? (
                          <>
                            <Square className="size-3" /> Stop
                          </>
                        ) : (
                          <>
                            <Volume2 className="size-3" /> Listen
                          </>
                        )}
                      </button>
                    )}
                    {m.reasoning && (
                      <Collapsible className="mt-3 border-t border-border/60 pt-2">
                        <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-xs font-medium text-primary">
                          <ChevronDown className="size-3.5" />
                          Why this answer
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                            {m.reasoning}
                          </p>
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </div>
                </motion.div>
              ))
            )}
          </div>

          <div className="mt-4 border-t border-border/60 pt-4">
            {/* Attachment chips */}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div
                    key={a.localId}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                      a.state === "failed"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : a.state === "ready"
                          ? "border-primary/40 bg-primary/10"
                          : "border-border/60 bg-muted/40"
                    }`}
                    title={a.state === "failed" ? a.error : a.name}
                  >
                    {a.previewUrl ? (
                      <img src={a.previewUrl} alt="" className="size-7 rounded object-cover" />
                    ) : (
                      <Paperclip className="size-3.5 shrink-0" />
                    )}
                    <span className="max-w-40 truncate font-medium">{a.name}</span>
                    {a.state === "uploading" && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> reading…
                      </span>
                    )}
                    {a.state === "ready" && a.truncated && (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">truncated</Badge>
                    )}
                    {a.state === "failed" && <span>failed</span>}
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                      onClick={() => removeAttachment(a.localId)}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask Omi anything — attach files or images with the paperclip"
              className="min-h-20 resize-y"
              maxLength={4000}
              disabled={isSending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                ⌘/Ctrl + Enter to send
              </span>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.json,.log,.html,.pdf,.docx,.xlsx,.ts,.tsx,.js,.py,.sh,.yml,.yaml,.xml"
                  className="hidden"
                  onChange={(e) => handleFilesChosen(e.target.files)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  title="Attach files or images (read on-device, stored privately)"
                  disabled={isSending || attachments.length >= MAX_ATTACHMENTS}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="mr-1.5 size-4" />
                  Attach
                </Button>
                {voice.supported && (
                  <Button
                    variant={voice.listening ? "default" : "outline"}
                    size="sm"
                    className="cursor-pointer"
                    title={
                      voice.listening
                        ? "Stop listening"
                        : "Speak to Omi (on-device, free)"
                    }
                    onClick={() => {
                      if (voice.listening) {
                        voice.stop();
                      } else {
                        voice.start((text) => setDraft(text));
                      }
                    }}
                  >
                    {voice.listening ? (
                      <>
                        <Mic className="mr-1.5 size-4 animate-pulse" />
                        Listening…
                      </>
                    ) : (
                      <MicOff className="size-4" />
                    )
                    }
                  </Button>
                )}
                <Button
                  className="cursor-pointer"
                  onClick={() => void handleSend()}
                  disabled={isSending || draft.trim().length === 0}
                >
                  {isSending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 size-4" />
                  )}
                  Send
                </Button>
              </div>
            </div>
            {voice.error && (
              <p className="mt-1 text-right text-xs text-red-500">{voice.error}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Memory manager */}
      <Dialog open={memoryOpen} onOpenChange={setMemoryOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Omi memory</DialogTitle>
            <DialogDescription>
              Context Omi remembers across every conversation and device. You
              control it: add, edit, or delete anything.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="memory-content">
              {editingMemoryId ? "Edit memory" : "New memory"}
            </Label>
            <Textarea
              id="memory-content"
              value={memoryDraft}
              onChange={(e) => setMemoryDraft(e.target.value)}
              placeholder="e.g. I lead support for the EMEA region. I prefer concise answers with bullet points."
              maxLength={500}
            />
            <div className="flex gap-2">
              <Button
                className="cursor-pointer"
                onClick={() => void handleSaveMemory()}
              >
                <Plus className="mr-2 size-4" />
                {editingMemoryId ? "Update memory" : "Save memory"}
              </Button>
              {editingMemoryId && (
                <Button
                  variant="ghost"
                  className="cursor-pointer"
                  onClick={() => {
                    setEditingMemoryId(null);
                    setMemoryDraft("");
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Saved memories ({memories?.length ?? 0})
            </p>
            {memories === undefined ? (
              <Skeleton className="h-16 w-full" />
            ) : memories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No memories yet. Add preferences, projects, or context Omi
                should always know.
              </p>
            ) : (
              <div className="space-y-2">
                {(memories as Memory[]).map((mem) => (
                  <div
                    key={mem._id}
                    className="flex items-start gap-2 rounded-lg border border-border/60 p-3"
                  >
                    <p className="min-w-0 flex-1 text-sm">{mem.content}</p>
                    <button
                      type="button"
                      aria-label="Edit memory"
                      className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => {
                        setEditingMemoryId(mem._id);
                        setMemoryDraft(mem.content);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete memory"
                      className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
                      onClick={() => void handleDeleteMemory(mem._id)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => setMemoryOpen(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
