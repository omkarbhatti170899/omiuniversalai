import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useConvexClient } from "@/hooks/useConvexClient";
import {
  MAX_ATTACHMENTS,
  isImageFile,
  uploadAttachment,
  validateForUpload,
} from "@/lib/attachmentUpload";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Download,
  ImagePlus,
  Layers,
  Loader2,
  Maximize2,
  Scissors,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";

/**
 * Omi Image Studio — the image capability's single UI surface.
 *
 * Reworked so it reads as ONE assistant rather than a set of disconnected
 * tools: the default mode is "Auto", where the user simply types what they
 * want ("make this look like a cinematic K-drama scene") and Omi's intent
 * layer decides whether that is a new image or an edit, which capability it
 * needs, and what must be preserved. The explicit modes remain for control.
 *
 * Honesty rules this screen follows (the backend enforces the same ones):
 *  • No provider is hard-coded here. Ops are sent to Omi's capability router,
 *    which only ever selects a provider that genuinely declares that op.
 *  • A mode is never faked. If no configured provider implements an op, the
 *    router's real reason is shown — including a per-provider breakdown —
 *    rather than a spinner that never resolves or a random replacement image.
 *  • The capability panel shows what is configured BEFORE a run; a live run
 *    can still fail, and says so.
 *  • Everything the user produces lands in their private gallery.
 */

type StudioMode =
  | "auto"
  | "generate"
  | "edit"
  | "background"
  | "enhance"
  | "upscale"
  | "variation"
  | "combine";

type StudioInput = {
  key: string;
  kind: "gallery" | "upload";
  /** omiImages row id, when the input came from the gallery. */
  imageId?: Id<"omiImages">;
  /** omiDocuments row id, once an uploaded image is ingested. */
  documentId?: Id<"omiDocuments">;
  name: string;
  previewUrl?: string;
  status: "uploading" | "ready" | "failed";
  error?: string;
};

/** Every backend op the router understands (mirrors imageCatalog.ImageOp). */
type Op =
  | "generate"
  | "edit"
  | "remove"
  | "replace"
  | "background"
  | "style"
  | "upscale"
  | "enhance"
  | "variation"
  | "combine"
  | "outpaint";

type ModeDef = {
  id: StudioMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Backend op — the router's capability key, not a vendor. Null for auto. */
  op: Op | null;
  needsInput: boolean;
  /** Combine needs two images. */
  minInputs?: number;
  placeholder: string;
  defaultPrompt?: string;
  aspect: boolean;
  transparent?: boolean;
  hint: string;
};

const MODES: ModeDef[] = [
  {
    id: "auto",
    label: "Auto",
    icon: Sparkles,
    op: null,
    needsInput: false,
    placeholder:
      "Just say it — \"create a cyberpunk Mumbai at night\", \"make this photo cinematic\", \"remove the background\", \"combine these two\"…",
    aspect: false,
    hint: "Describe it in your own words. Omi decides whether this is a new image or an edit, picks the capability, and — for edits — states what it will preserve. It never sends an edit to a text-only provider.",
  },
  {
    id: "generate",
    label: "Create",
    icon: Sparkles,
    op: "generate",
    needsInput: false,
    placeholder: "A lone observatory on a graphite ridge at dusk, cinematic light…",
    aspect: true,
    transparent: true,
    hint: "New image from text. Runs on the keyless free provider; Omi's router upgrades to a stronger one when available.",
  },
  {
    id: "edit",
    label: "Edit",
    icon: Wand2,
    op: "edit",
    needsInput: true,
    placeholder: "Make the sky stormy and add light rain, keep everything else identical…",
    aspect: false,
    hint: "Natural-language editing that preserves identity, pose, lighting and composition unless you ask otherwise.",
  },
  {
    id: "background",
    label: "Background",
    icon: Scissors,
    op: "background",
    needsInput: true,
    placeholder: "Put the subject on a clean studio backdrop…",
    aspect: false,
    transparent: true,
    hint: "Remove the background (transparent where the provider supports alpha) or describe a replacement.",
  },
  {
    id: "enhance",
    label: "Enhance",
    icon: Sparkles,
    op: "enhance",
    needsInput: true,
    placeholder: "Optional — what should improve?",
    defaultPrompt:
      "Enhance this image: lift clarity and colour balance, refine fine detail and reduce noise, while keeping the subject, framing and identity identical.",
    aspect: false,
    hint: "Improves clarity, lighting and detail without changing the subject.",
  },
  {
    id: "upscale",
    label: "Upscale",
    icon: Maximize2,
    op: "upscale",
    needsInput: true,
    placeholder: "Optional — any detail to protect?",
    defaultPrompt:
      "Upscale this image to a higher resolution: recover crisp edges and texture, avoid smoothing, and keep the content exactly the same.",
    aspect: false,
    hint: "Higher resolution from the image you provide — not a fresh re-generation.",
  },
  {
    id: "variation",
    label: "Variations",
    icon: Shuffle,
    op: "variation",
    needsInput: false,
    placeholder: "Describe the image again — Omi re-rolls the seed…",
    aspect: true,
    hint: "Re-rolls the same idea into a new take. With an input image it becomes an image-to-image variation.",
  },
  {
    id: "combine",
    label: "Combine",
    icon: Layers,
    op: "combine",
    needsInput: true,
    minInputs: 2,
    placeholder: "How should Omi blend them?",
    aspect: false,
    hint: "Merges two or more images into one composition.",
  },
];

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const MAX_SOURCES = 4;

type GalleryImage = {
  _id: Id<"omiImages">;
  op: string;
  prompt: string;
  provider: string;
  model: string;
  width: number;
  height: number;
  transparent: boolean;
  url: string | null;
  createdAt: number;
};

type Attempt = { provider: string; model: string; error?: string; state?: string };

type ImageOpResult =
  | { ok: true; imageId: string; provider: string; model: string; width: number; height: number }
  | { ok: false; error: string; attempts: Array<Attempt>; health?: string; capability?: string };

type Interpretation =
  | { kind: "none" }
  | { kind: "image-understanding" }
  | {
      kind: "generate";
      op: "generate";
      aspectRatio: string | null;
      transparent: boolean;
      capability: string;
      references: number[];
    }
  | {
      kind: "image-edit";
      op: Op;
      needsImage: boolean;
      needsMultiple: boolean;
      capability: string;
      references: number[];
      normalized: { preserve: string[]; prompt: string };
    };

type ImageCapability = {
  op: string;
  capability: string;
  available: boolean;
  providers: string[];
};

/**
 * Provider status as `aiStatus.status` reports it: static configuration facts
 * PLUS the last-known live health from a real attempt. The two are different
 * things and the badge shows the honest one — a key that exists but returned
 * 429 reads "rate limited", never a green check.
 */
type ImageProviderStatus = {
  id: string;
  label: string;
  configured: boolean;
  ops: string[];
  health: string | null;
  healthLabel: string;
  healthTone: "ok" | "warn" | "bad" | "muted";
  healthError: string | null;
};

/** Badge treatment per honest health tone (metadata only — never a claim). */
const HEALTH_TONE_CLASS: Record<string, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  bad: "border-red-500/30 bg-red-500/10 text-red-400",
  muted: "border-border text-muted-foreground",
};

const OP_LABELS: Record<string, string> = {
  generate: "create a new image",
  edit: "edit this image",
  background: "change the background",
  remove: "remove the background",
  replace: "replace the background",
  style: "apply a style",
  upscale: "upscale",
  enhance: "enhance",
  variation: "make a variation",
  combine: "combine the images",
  outpaint: "extend the image",
};

export function ImageStudioView({
  initialMode = "auto",
}: {
  /** Which mode the studio opens in — Home shortcuts seed this. */
  initialMode?: StudioMode;
}) {
  const runImage = useAction(api.omiImages.run);
  const interpretImage = useAction(api.omiImages.interpret);
  const removeImage = useMutation(api.omiImages.remove);
  const gallery = useQuery(api.omiImages.listMine) as GalleryImage[] | undefined;
  const aiStatus = useQuery(api.aiStatus.status);
  const convex = useConvexClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [modeId, setModeId] = useState<StudioMode>(initialMode);
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<string>("1:1");
  const [transparent, setTransparent] = useState(false);
  const [bgAction, setBgAction] = useState<"remove" | "replace">("remove");
  const [inputs, setInputs] = useState<StudioInput[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Array<Attempt>>([]);
  const [resultId, setResultId] = useState<string | null>(null);
  const [preview, setPreview] = useState<GalleryImage | null>(null);
  const [interpretation, setInterpretation] = useState<Interpretation | null>(null);
  const [interpreting, setInterpreting] = useState(false);

  const mode = useMemo(() => MODES.find((m) => m.id === modeId) ?? MODES[0], [modeId]);

  const readyInputs = inputs.filter((i) => i.status === "ready");
  const readyInputCount = readyInputs.length;
  const sourceImageIds = readyInputs
    .filter((i) => i.kind === "gallery" && i.imageId)
    .map((i) => i.imageId as Id<"omiImages">);
  const sourceDocumentIds = readyInputs
    .filter((i) => i.kind === "upload" && i.documentId)
    .map((i) => i.documentId as Id<"omiDocuments">);
  const hasInputs = readyInputCount > 0;

  const effectivePrompt = useMemo(() => {
    if (modeId === "background") {
      if (bgAction === "remove") {
        return (
          prompt.trim() ||
          "Remove the background completely and keep the subject's edges clean and natural."
        );
      }
      return prompt.trim();
    }
    return prompt.trim() || mode.defaultPrompt || "";
  }, [bgAction, mode.defaultPrompt, modeId, prompt]);

  /** The op the run will use: auto resolves it, explicit modes are fixed. */
  const resolvedOp: Op | null = useMemo(() => {
    // Background has two DIFFERENT capabilities behind one mode. Removal has
    // its own op, so the router receives the real one instead of a generic
    // background edit; replacement maps to `replace`.
    if (modeId === "background") return bgAction === "remove" ? "remove" : "replace";
    if (modeId !== "auto") {
      return mode.op;
    }
    if (interpretation && interpretation.kind === "generate") return "generate";
    if (interpretation && interpretation.kind === "image-edit") return interpretation.op;
    return null;
  }, [bgAction, interpretation, mode.op, modeId]);

  const autoEditNeedsImage =
    modeId === "auto" &&
    interpretation?.kind === "image-edit" &&
    interpretation.needsImage &&
    !hasInputs;
  const autoIsUnderstanding = modeId === "auto" && interpretation?.kind === "image-understanding";
  const autoIsNone = modeId === "auto" && interpretation?.kind === "none";

  const minInputs = mode.minInputs ?? (mode.needsInput ? 1 : 0);
  const missingInput = minInputs > 0 && readyInputCount < minInputs;

  /**
   * Auto mode must never fall through to a guess: if the request could not be
   * classified there is no capability to run, so the button stays disabled and
   * the line above explains why. Silently sending a generic `edit` instead is
   * what produced the confusing "works on an image" error the user hit.
   */
  const autoUnresolved = modeId === "auto" && resolvedOp === null;

  const canRun =
    !running &&
    effectivePrompt.trim().length >= 2 &&
    !missingInput &&
    !autoEditNeedsImage &&
    !autoUnresolved &&
    !inputs.some((i) => i.status === "uploading");

  /** Auto mode: classify the request (pure compute — no provider call). */
  useEffect(() => {
    if (modeId !== "auto") {
      setInterpretation(null);
      return;
    }
    const text = prompt.trim();
    if (text.length < 3) {
      setInterpretation(null);
      return;
    }
    let cancelled = false;
    setInterpreting(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const out = (await interpretImage({
            prompt: text,
            hasImageContext: hasInputs,
            imageCount: readyInputCount,
          })) as Interpretation;
          if (!cancelled) setInterpretation(out);
        } catch {
          if (!cancelled) setInterpretation(null);
        } finally {
          if (!cancelled) setInterpreting(false);
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasInputs, interpretImage, modeId, prompt, readyInputCount]);

  const galleryUrl = (id?: Id<"omiImages">) =>
    gallery?.find((g) => g._id === id)?.url ?? undefined;

  const addInput = (input: StudioInput) => {
    setInputs((prev) => {
      if (prev.length >= MAX_SOURCES) {
        toast.error(`Omi reads up to ${MAX_SOURCES} images per operation.`);
        return prev;
      }
      const dup =
        (input.imageId && prev.some((p) => p.imageId === input.imageId)) ||
        (input.documentId && prev.some((p) => p.documentId === input.documentId));
      return dup ? prev : [...prev, input];
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (!isImageFile(file)) {
        toast.error(`"${file.name}" isn't an image Omi can edit.`);
        continue;
      }
      const check = validateForUpload(file);
      if (!check.ok) {
        toast.error(check.error);
        continue;
      }
      const key = `upload-${Date.now()}-${file.name}`;
      const previewUrl = await new Promise<string | undefined>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(file);
      });
      addInput({ key, kind: "upload", name: file.name, previewUrl, status: "uploading" });

      try {
        const out = await uploadAttachment(file, { api, convex });
        setInputs((prev) =>
          prev.map((i) =>
            i.key === key
              ? { ...i, status: "ready", documentId: out.documentId as Id<"omiDocuments"> }
              : i,
          ),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : "Upload failed.";
        setInputs((prev) =>
          prev.map((i) => (i.key === key ? { ...i, status: "failed", error: message } : i)),
        );
        toast.error(message);
      }
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setAttempts([]);
    try {
      // canRun guarantees an op in every mode; this guard keeps a programmatic
      // call (or a fast mode switch) from sending an unclassified request.
      const op: Op | null = resolvedOp;
      if (op === null) {
        setError(
          "Omi couldn't tell what to do with this request — describe it differently, or pick a mode above.",
        );
        return;
      }
      const res = (await runImage({
        op,
        prompt: effectivePrompt.trim().slice(0, 1000),
        aspectRatio,
        // Transparency is a generation/removal request, independent of which
        // op string the router receives (background removal routes as `remove`).
        transparent: op === "generate" ? transparent : modeId === "background" && bgAction === "remove",
        sourceImageIds: sourceImageIds.length > 0 ? sourceImageIds : undefined,
        sourceDocumentIds: sourceDocumentIds.length > 0 ? sourceDocumentIds : undefined,
        // Multi-turn lineage: the image Omi edits becomes the parent, so the
        // gallery shows how an image evolved across turns.
        parentId: sourceImageIds.length === 1 ? sourceImageIds[0] : undefined,
      })) as ImageOpResult;

      if (res.ok) {
        setResultId(res.imageId);
        // The image Omi just produced becomes the input for the next op, so
        // "now make it night" works without a re-upload.
        setInputs([
          {
            key: `result-${res.imageId}`,
            kind: "gallery",
            imageId: res.imageId as Id<"omiImages">,
            name: "Omi result",
            status: "ready",
          },
        ]);
        toast.success(`Rendered by ${res.provider} · ${res.model}`);
      } else {
        setError(res.error);
        setAttempts(res.attempts ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The image request failed.");
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = async (id: Id<"omiImages">) => {
    try {
      await removeImage({ id });
      setInputs((prev) => prev.filter((i) => i.imageId !== id));
      if (resultId === id) setResultId(null);
      toast.success("Image deleted.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete that image.");
    }
  };

  const download = async (image: GalleryImage) => {
    if (!image.url) return;
    try {
      const res = await fetch(image.url);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `omi-${image.op}-${image._id}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.open(image.url, "_blank", "noopener");
    }
  };

  const result = gallery?.find((g) => g._id === resultId) ?? null;

  const statusShape = aiStatus as
    | {
        imageProviders?: ImageProviderStatus[];
        imageCapabilities?: ImageCapability[];
      }
    | undefined;
  const imageProviders = statusShape?.imageProviders;
  const imageCapabilities = statusShape?.imageCapabilities ?? [];
  const editCapable = imageProviders?.some((p) => p.configured && p.ops.includes("edit"));

  const preservePreview =
    interpretation?.kind === "image-edit" ? interpretation.normalized.preserve : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Image Studio</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            One assistant for every image task. Type naturally and Omi decides the
            operation — then routes it to a provider that genuinely implements it.
          </p>
        </div>
        {imageProviders && (
          <div className="flex flex-wrap items-center gap-1.5">
            {imageProviders.map((p) => (
              <Badge
                key={p.id}
                variant="outline"
                title={p.healthError ?? undefined}
                className={cn(
                  "text-[10px] font-normal",
                  HEALTH_TONE_CLASS[p.healthTone] ?? HEALTH_TONE_CLASS.muted,
                )}
              >
                {p.label} · {p.healthLabel}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {editCapable === false && (
        <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-white/[0.02] px-3 py-2.5 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
          <span>
            Creating an image works today on Omi's keyless free provider. Editing,
            background, enhance and upscale need a provider that accepts an image input —
            add a <span className="text-foreground">GEMINI_API_KEY</span> or{" "}
            <span className="text-foreground">OPENAI_API_KEY</span> in the Keys tab and every
            mode below becomes live automatically.
          </span>
        </div>
      )}

      {/* Mode switcher */}
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = m.id === modeId;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setModeId(m.id);
                setError(null);
                setAttempts([]);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {m.label}
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Composer */}
        <div className="space-y-4">
          <Card className="border-border/70 bg-card/60">
            <CardContent className="space-y-4 p-5">
              <p className="text-xs text-muted-foreground">{mode.hint}</p>

              {/* Input images */}
              {(mode.needsInput || modeId === "variation" || modeId === "auto") && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">
                      {modeId === "combine" ? "Combine these images" : "Input images"}
                      <span className="ml-1 font-normal text-muted-foreground">
                        (up to {MAX_SOURCES} · {MAX_ATTACHMENTS} per upload)
                      </span>
                    </Label>
                    {inputs.length >= MAX_SOURCES && (
                      <span className="text-[10px] text-muted-foreground">limit reached</span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {inputs.map((input) => {
                      const src =
                        input.kind === "gallery"
                          ? galleryUrl(input.imageId)
                          : input.previewUrl;
                      return (
                        <div
                          key={input.key}
                          className="group relative size-20 overflow-hidden rounded-lg border border-border/70 bg-muted/40"
                        >
                          {src ? (
                            <img src={src} alt={input.name} className="size-full object-cover" />
                          ) : (
                            <span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
                              {input.name}
                            </span>
                          )}
                          {input.status === "uploading" && (
                            <span className="absolute inset-0 flex items-center justify-center bg-background/70">
                              <Loader2 className="size-4 animate-spin text-primary" />
                            </span>
                          )}
                          {input.status === "failed" && (
                            <span
                              className="absolute inset-0 flex items-center justify-center bg-background/80 p-1 text-center text-[9px] text-destructive"
                              title={input.error}
                            >
                              failed
                            </span>
                          )}
                          <button
                            type="button"
                            aria-label={`Remove ${input.name}`}
                            className="absolute right-1 top-1 cursor-pointer rounded-md bg-background/80 p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                            onClick={() =>
                              setInputs((prev) => prev.filter((i) => i.key !== input.key))
                            }
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/70 text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                    >
                      <ImagePlus className="size-4" />
                      Upload
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        void handleFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </div>

                  {missingInput && modeId !== "auto" && (
                    <p className="text-[11px] text-amber-400/90">
                      {modeId === "combine"
                        ? "Combine needs two images — add another, or pick from your gallery."
                        : `${mode.label} edits an image — upload one, or pick from your gallery below.`}
                    </p>
                  )}
                </div>
              )}

              {/* Background sub-mode */}
              {modeId === "background" && (
                <div className="flex gap-1.5">
                  {(
                    [
                      { id: "remove", label: "Remove background" },
                      { id: "replace", label: "Replace background" },
                    ] as const
                  ).map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setBgAction(b.id)}
                      className={cn(
                        "cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition-colors",
                        bgAction === b.id
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/70 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Prompt */}
              <div className="space-y-1.5">
                <Label htmlFor="omi-image-prompt" className="text-xs">
                  {modeId === "auto"
                    ? "Tell Omi what you want"
                    : modeId === "generate"
                      ? "Describe the image"
                      : modeId === "background" && bgAction === "remove"
                        ? "Optional instructions"
                        : "What should Omi do?"}
                </Label>
                <Textarea
                  id="omi-image-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={mode.placeholder}
                  maxLength={1000}
                  className="min-h-24 resize-y"
                />
              </div>

              {/* Auto-mode interpretation */}
              {modeId === "auto" && prompt.trim().length >= 3 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-white/[0.02] px-3 py-2 text-[11px]">
                  {interpreting ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" /> Omi is reading your request…
                    </span>
                  ) : autoIsNone ? (
                    <span className="text-muted-foreground">
                      Omi isn't sure this is an image request — switch to a mode above, or add
                      an image and try “make this…”.
                    </span>
                  ) : autoIsUnderstanding ? (
                    <span className="text-muted-foreground">
                      That's a question about an image — ask it in Chat and Omi will read the
                      image with vision.
                    </span>
                  ) : autoEditNeedsImage ? (
                    <span className="text-amber-400/90">
                      This looks like an edit — upload or pick an image first.
                    </span>
                  ) : resolvedOp ? (
                    <>
                      <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                        Omi will {OP_LABELS[resolvedOp] ?? resolvedOp}
                      </Badge>
                      {interpretation?.kind === "image-edit" &&
                        interpretation.needsMultiple &&
                        readyInputCount < 2 && (
                          <span className="text-amber-400/90">needs at least two images</span>
                        )}
                      {preservePreview.length > 0 && (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <ShieldCheck className="size-3 text-emerald-400" />
                          preserving {preservePreview.length} things you didn't ask to change
                        </span>
                      )}
                    </>
                  ) : null}
                </div>
              )}

              {/* Preservation detail (edits) */}
              {modeId !== "auto" && (mode.op === "edit" || mode.op === "background") && (
                <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-3 shrink-0 text-emerald-400" />
                  Omi tells the provider to preserve identity, pose, lighting and composition —
                  and only to change what you ask for.
                </p>
              )}

              {/* Controls */}
              <div className="flex flex-wrap items-center gap-4">
                {(mode.aspect || modeId === "generate") && (
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Aspect</Label>
                    <Select value={aspectRatio} onValueChange={setAspectRatio}>
                      <SelectTrigger size="sm" className="w-[92px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASPECT_RATIOS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {(modeId === "generate" ||
                  (modeId === "background" && bgAction === "remove")) && (
                  <div className="flex items-center gap-2">
                    <Switch
                      id="omi-image-transparent"
                      checked={transparent}
                      onCheckedChange={setTransparent}
                    />
                    <Label htmlFor="omi-image-transparent" className="text-xs text-muted-foreground">
                      Transparent background (where supported)
                    </Label>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
                <p className="text-[11px] text-muted-foreground">
                  Nothing is sent to a provider until you press the button.
                </p>
                <Button className="cursor-pointer" disabled={!canRun} onClick={() => void handleRun()}>
                  {running ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  {running
                    ? "Omi is rendering…"
                    : modeId === "auto"
                      ? resolvedOp
                        ? `Run · ${OP_LABELS[resolvedOp] ?? resolvedOp}`
                        : "Ask Omi"
                      : modeId === "combine"
                        ? `Combine ${readyInputCount} images`
                        : mode.label}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Result / errors */}
          {error && (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="p-4">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="text-sm font-medium text-destructive">
                      {attempts.length > 0
                        ? "No provider could complete this operation."
                        : error}
                    </p>
                    {attempts.length > 0 && (
                      <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                        {attempts.map((a, i) => (
                          <li key={`${a.provider}-${i}`} className="break-words">
                            <span className="font-medium text-foreground/80">{a.provider}</span>
                            {": "}
                            {a.error ?? "unavailable"}
                            {a.state && a.state !== "unavailable" ? ` (${a.state})` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    {modeId !== "generate" && modeId !== "variation" && attempts.length > 0 && (
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Generating an image from text works now. Editing needs a provider that
                        accepts an image input, so those modes stay unavailable until one is
                        configured — Omi reports the real reason rather than returning a fake image.
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {result && (
            <Card className="border-border/70 bg-card/60">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">Latest result</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {result.provider} · {result.model} · {result.width}×{result.height}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => void download(result)}
                  >
                    <Download className="size-3.5" />
                    Download
                  </Button>
                </div>
                {result.url && (
                  <img
                    src={result.url}
                    alt={result.prompt}
                    className="max-h-[420px] w-full rounded-lg border border-border/60 object-contain"
                  />
                )}
                <p className="text-[11px] text-muted-foreground">
                  Kept as the input for your next operation — describe a change and press the
                  button again to keep editing.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar: capabilities + gallery */}
        <div className="space-y-4">
          <Card className="border-border/70 bg-card/60">
            <CardContent className="space-y-2 p-4">
              <p className="text-sm font-medium">Capabilities right now</p>
              <ul className="space-y-1 text-[11px]">
                {imageCapabilities.map((c) => (
                  <li key={c.op} className="flex items-center justify-between gap-2">
                    <span className="capitalize text-muted-foreground">{c.capability}</span>
                    <span
                      className={cn(
                        "flex items-center gap-1",
                        c.available ? "text-emerald-400" : "text-muted-foreground/70",
                      )}
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          c.available ? "bg-emerald-400" : "bg-muted-foreground/40",
                        )}
                      />
                      {c.available ? "configured" : "needs a key"}
                    </span>
                  </li>
                ))}
                {imageCapabilities.length === 0 && (
                  <li className="text-muted-foreground">Loading capability status…</li>
                )}
              </ul>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                “Configured” means a provider declares the capability — a live run can still be
                rate-limited, and Omi will say so.
              </p>
            </CardContent>
          </Card>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Your gallery</p>
              <span className="text-[11px] text-muted-foreground">private to your account</span>
            </div>

            {gallery === undefined ? (
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="aspect-square animate-pulse rounded-lg border border-border/60 bg-muted/40"
                  />
                ))}
              </div>
            ) : gallery.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center py-10 text-center">
                  <Sparkles className="size-6 text-muted-foreground/60" />
                  <p className="mt-3 text-sm font-medium">No images yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Anything you generate or edit appears here — and stays available as an input
                    for later edits.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="omi-scroll grid max-h-[520px] grid-cols-2 gap-2 overflow-y-auto pr-1">
                {gallery.map((image) => (
                  <div
                    key={image._id}
                    className={cn(
                      "group relative overflow-hidden rounded-lg border bg-muted/40 transition-colors",
                      resultId === image._id
                        ? "border-primary/50"
                        : "border-border/60 hover:border-border",
                    )}
                  >
                    <button
                      type="button"
                      className="block aspect-square w-full cursor-pointer"
                      onClick={() => setPreview(image)}
                      aria-label={`Preview ${image.prompt}`}
                    >
                      {image.url ? (
                        <img
                          src={image.url}
                          alt={image.prompt}
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      ) : (
                        <span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
                          unavailable
                        </span>
                      )}
                    </button>

                    <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-background/95 to-transparent px-1.5 pb-1.5 pt-4 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <Badge
                        variant="outline"
                        className="border-border/70 bg-background/70 text-[9px] font-normal"
                      >
                        {image.op}
                      </Badge>
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          title="Use as input"
                          aria-label="Use as input"
                          className="cursor-pointer rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:text-primary"
                          onClick={() =>
                            addInput({
                              key: `gallery-${image._id}`,
                              kind: "gallery",
                              imageId: image._id,
                              name: image.prompt.slice(0, 24),
                              status: "ready",
                            })
                          }
                        >
                          <Wand2 className="size-3" />
                        </button>
                        <button
                          type="button"
                          title="Download"
                          aria-label="Download"
                          className="cursor-pointer rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => void download(image)}
                        >
                          <Download className="size-3" />
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          aria-label="Delete"
                          className="cursor-pointer rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:text-destructive"
                          onClick={() => void handleDelete(image._id)}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Omi asks the provider that declares the capability; if it fails, it reports the real
              reason rather than a fake image.
            </p>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle className="pr-8 text-sm font-medium">{preview?.prompt}</DialogTitle>
          {preview?.url && (
            <img
              src={preview.url}
              alt={preview.prompt}
              className="max-h-[65vh] w-full rounded-lg border border-border/60 object-contain"
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              {preview?.provider} · {preview?.model} · {preview?.width}×{preview?.height}
              {preview?.transparent ? " · transparent" : ""}
            </span>
            {preview && (
              <span className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() =>
                    addInput({
                      key: `gallery-${preview._id}`,
                      kind: "gallery",
                      imageId: preview._id,
                      name: preview.prompt.slice(0, 24),
                      status: "ready",
                    })
                  }
                >
                  <Wand2 className="size-3.5" />
                  Use as input
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => void download(preview)}
                >
                  <Download className="size-3.5" />
                  Download
                </Button>
              </span>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
