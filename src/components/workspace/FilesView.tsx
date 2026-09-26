import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { format } from "date-fns";
import {
  FileImage,
  FileSpreadsheet,
  FileText,
  Files,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { extractDocx, extractXlsx } from "@/lib/docExtract";
import { extractPdf } from "@/lib/pdfExtract";

type FileDoc = {
  _id: Id<"omiDocuments">;
  title: string;
  wordCount: number;
  fileId?: Id<"_storage">;
  fileType?: string;
  fileSize?: number;
  _creationTime: number;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ACCEPTED =
  ".txt,.md,.markdown,.csv,.json,.log,.html,.htm,.ts,.tsx,.js,.py,.sh,.yml,.yaml,.xml,.docx,.xlsx,.pdf,image/png,image/jpeg,image/webp,image/gif,text/*,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function FilesView() {
  const allDocs = useQuery(api.omiKnowledge.listMine);
  const fileDocs = allDocs?.filter((d) => d.fileId !== undefined);
  const generateUploadUrl = useMutation(api.omiFiles.generateUploadUrl);
  const ingestFile = useAction(api.omiFiles.ingestFile);
  const ingestImage = useAction(api.omiFiles.ingestImage);
  const removeFile = useMutation(api.omiFiles.remove);
  const renameDoc = useMutation(api.omiKnowledge.rename);

  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState("");
  const [renamingId, setRenamingId] = useState<Id<"omiDocuments"> | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (list: FileList | null) => {
    const file = list?.[0];
    if (!file || uploading) return;
    setUploading(true);
    try {
      // DOCX/XLSX: extract text ON THIS DEVICE (zero cost, private — §41).
      // The raw bytes are uploaded only for storage; the text we send is
      // exactly what Omi will quote.
      const lower = file.name.toLowerCase();
      let preExtracted: string | undefined;
      if (lower.endsWith(".docx")) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const out = await extractDocx(bytes, file.name);
        preExtracted = out.text;
      } else if (lower.endsWith(".xlsx")) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const out = await extractXlsx(bytes, file.name);
        preExtracted = out.text;
      } else if (lower.endsWith(".pdf")) {
        // PDF: parsed on-device (pdf.js, Apache-2.0). Scanned/image-only PDFs
        // fail honestly — on-device OCR (tesseract.js) runs as fallback.
        const bytes = new Uint8Array(await file.arrayBuffer());
        const out = await extractPdf(bytes, file.name);
        preExtracted = out.text;
      }

      const url = await generateUploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
      const { storageId } = (await res.json()) as { storageId: string };

      // Images: stored, then described by the VisionProvider chain (needs a
      // free GROQ_API_KEY; the app says so plainly when none is set).
      if (file.type.startsWith("image/")) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Couldn't read that image."));
          reader.readAsDataURL(file);
        });
        const out = await ingestImage({
          storageId: storageId as Id<"_storage">,
          fileName: file.name,
          dataUrl,
        });
        if (!out.ok) {
          // `out.error` names the real cause (missing key, retired model,
          // rate limit…). Don't presume it is a missing key — that guess sent
          // people to add a key they already had.
          toast.error(`${out.error} The image is saved and stays in your files.`);
          return;
        }
        toast("Image understood — its description joined your knowledge base.");
        return;
      }

      const { truncated } = await ingestFile({
        storageId: storageId as Id<"_storage">,
        fileName: file.name,
        preExtracted,
      });
      toast(
        truncated
          ? "File ingested — note: only the first ~60k characters were indexed."
          : "File ingested — Omi can now search and quote it.",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't ingest that file.",
      );
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleDelete = async (id: Id<"omiDocuments">) => {
    try {
      await removeFile({ id });
      toast("File removed.");
    } catch {
      toast.error("Couldn't remove that file.");
    }
  };

  const handleRename = async (id: Id<"omiDocuments">) => {
    try {
      await renameDoc({ id, title: renameDraft });
      toast("File renamed.");
      setRenamingId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename that file.");
    }
  };

  const needle = filter.trim().toLowerCase();
  const visibleFiles = (fileDocs ?? []).filter((d) =>
    needle.length === 0 ? true : d.title.toLowerCase().includes(needle),
  );

  const totalWords = (fileDocs ?? []).reduce((sum, d) => sum + d.wordCount, 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Files className="size-6 text-primary" />
          Files
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload text-based files and Omi extracts their content locally (zero
          cost) into your knowledge base — every file becomes searchable and
          quotable in chat.
        </p>
        {fileDocs !== undefined && fileDocs.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {fileDocs.length} file{fileDocs.length === 1 ? "" : "s"} ingested ·{" "}
            {totalWords.toLocaleString()} words indexed
          </p>
        )}
      </div>

      {/* Upload */}
      <Card>
        <CardContent className="p-5">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload a file"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void handleFiles(e.dataTransfer.files);
            }}
            className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border/70 p-8 text-center transition-colors hover:border-primary/50"
          >
            {uploading ? (
              <Loader2 className="size-8 animate-spin text-primary" />
            ) : (
              <Upload className="size-8 text-muted-foreground" />
            )}
            <p className="mt-3 text-sm font-semibold">
              {uploading ? "Extracting text…" : "Drop a file here or click to upload"}
            </p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Text, Markdown, CSV, JSON, HTML, code, logs, Word (.docx), Excel
              (.xlsx), PDF (text + scanned via on-device OCR), images · up to
              2 MB. Extraction is local — no third-party parsing service.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Search */}
      {(fileDocs?.length ?? 0) > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search your files by name…"
            aria-label="Search your files by name"
            className="pl-9"
          />
        </div>
      )}

      {/* File list */}
      {fileDocs === undefined ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : fileDocs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <Files className="size-8 text-muted-foreground/50" />
            <p className="mt-4 font-semibold">No files yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Upload specs, notes, policies or exports — their text joins your
              knowledge base and Omi quotes them before searching the web.
            </p>
          </CardContent>
        </Card>
      ) : visibleFiles.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No files match “{filter.trim()}”.
        </p>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="space-y-2"
        >
          {visibleFiles.map((d: FileDoc) => (
            <Card key={d._id} className="bg-card/60">
              <CardContent className="flex items-start gap-3 p-4">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  {d.fileType?.startsWith("image/") ? (
                    <FileImage className="size-4" />
                  ) : d.fileType?.includes("sheet") || d.title.toLowerCase().endsWith(".xlsx") ? (
                    <FileSpreadsheet className="size-4" />
                  ) : (
                    <FileText className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  {renamingId === d._id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        maxLength={200}
                        aria-label="New file name"
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
                    {d.fileSize !== undefined && formatBytes(d.fileSize)} ·{" "}
                    {format(new Date(d._creationTime), "MMM d, yyyy")}
                  </p>
                </div>
                {d.fileType && (
                  <Badge variant="secondary" className="shrink-0">
                    {d.fileType.split("/").pop()?.slice(0, 10)}
                  </Badge>
                )}
                <button
                  type="button"
                  aria-label="Rename file"
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
                  aria-label="Delete file"
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
