/**
 * Chat attachment upload (PRIORITY 1 — multimodal).
 *
 * The complete flow the product requires:
 *   Attachment → Upload → Secure Storage → Parse/Extract → Knowledge/Index →
 *   Andromeda/Omi → AI → Answer
 *
 * Reuses the Files pipeline exactly:
 *   • extraction happens ON THE USER'S DEVICE (zero cost, §41 privacy) —
 *     DOCX/XLSX via docExtract, PDF via pdf.js (+ on-device OCR fallback via
 *     tesseract.js for scanned PDFs), images described by the vision chain
 *   • the blob is stored via a short-lived Convex upload URL; the original
 *     stays re-downloadable/deletable in Files
 *   • ingest writes an omiDocuments row, so the file joins the knowledge
 *     base and is grounded in chat for THIS turn and all future turns
 *
 * Pure client module: no React, so tests can drive it directly.
 */

import { extractDocx, extractXlsx } from "./docExtract";
import { extractPdf } from "./pdfExtract";

export const MAX_ATTACHMENTS = 5;
/** Keep in sync with omiFiles.ts MAX_FILE_BYTES (2 MB). */
export const MAX_FILE_BYTES = 2_000_000;
/** Images can be bigger (vision caps at ~3.5 MB raw). */
export const MAX_IMAGE_BYTES = 3_500_000;

export type AttachmentKind = "image" | "file";

/** A file chosen in the picker, before upload. */
export type PendingAttachment = {
  localId: string;
  file: File;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** data URL for image thumbnails in the composer. */
  previewUrl?: string;
};

/** Live per-attachment status for the composer chips. */
export type AttachmentState =
  | { localId: string; state: "uploading"; name: string; size: number; kind: AttachmentKind; previewUrl?: string }
  | { localId: string; state: "ready"; name: string; size: number; kind: AttachmentKind; previewUrl?: string; documentId: string; truncated: boolean }
  | { localId: string; state: "failed"; name: string; size: number; kind: AttachmentKind; previewUrl?: string; error: string };

export type IngestOutcome =
  | { ok: true; documentId: string; truncated: boolean }
  | { ok: false; error: string };

type ConvexLike = {
  mutation: (ref: unknown, args: unknown) => Promise<unknown>;
  action: (ref: unknown, args: unknown) => Promise<unknown>;
};

const IMAGE_NAME_RE = /\.(png|jpe?g|webp|gif)$/i;
const IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|gif)$/i;

export function isImageFile(f: { name: string; type: string }): boolean {
  return IMAGE_MIME_RE.test(f.type) || IMAGE_NAME_RE.test(f.name);
}

/** Client-side gate mirroring the server's honest rejection message. */
export function validateForUpload(f: File): { ok: true } | { ok: false; error: string } {
  const isImage = isImageFile(f);
  const cap = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (f.size > cap) {
    return {
      ok: false,
      error: isImage
        ? `"${f.name}" is too large — Omi reads images up to 3.5 MB.`
        : `"${f.name}" is too large — Omi reads files up to 2 MB.`,
    };
  }
  return { ok: true };
}

/**
 * Extract text on-device for structured formats. Throws with an honest,
 * user-facing message when a format can't be read (e.g. scanned PDF without
 * OCR support) — Omi never pretends to have read a file (§35).
 */
async function extractOnDevice(file: File): Promise<string | undefined> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".docx")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = await extractDocx(bytes, file.name);
    return out.text;
  }
  if (lower.endsWith(".xlsx")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = await extractXlsx(bytes, file.name);
    return out.text;
  }
  if (lower.endsWith(".pdf")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = await extractPdf(bytes, file.name);
    return out.text;
  }
  return undefined; // server-side extraction handles plain text
}

/**
 * Upload + ingest one file. `api`/`convex` come from the calling component.
 * Returns the knowledge-document ID that grounds the chat turn.
 */
export async function uploadAttachment(
  file: File,
  deps: {
    api: unknown;
    convex: {
      mutation: ConvexLike["mutation"];
      action: ConvexLike["action"];
    };
  },
): Promise<{ documentId: string; truncated: boolean }> {
  const isImage = isImageFile(file);
  const cap = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (file.size > cap) {
    throw new Error(
      isImage
        ? `"${file.name}" is too large — Omi reads images up to 3.5 MB.`
        : `"${file.name}" is too large — Omi reads files up to 2 MB.`,
    );
  }

  // 1) On-device extraction for structured formats (zero cost, private).
  const preExtracted = isImage ? undefined : await extractOnDevice(file);

  // 2) Secure storage: short-lived upload URL → direct browser→Convex PUT.
  const url = (await deps.convex.mutation((deps.api as any).omiFiles.generateUploadUrl, {})) as string;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
  const { storageId } = (await res.json()) as { storageId: string };

  // 3) Ingest into the knowledge base (ownership is set server-side).
  if (isImage) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Couldn't read that image."));
      reader.readAsDataURL(file);
    });
    const out = (await deps.convex.action((deps.api as any).omiFiles.ingestImage, {
      storageId,
      fileName: file.name,
      dataUrl,
    })) as
      | { ok: true; documentId: string; description: string }
      | { ok: false; error: string; stored: boolean };
    if (!out.ok) {
      throw new Error(
        `${out.error} The image is saved — retry describing it once a vision key is added.`,
      );
    }
    return { documentId: out.documentId, truncated: false };
  }

  const out = (await deps.convex.action((deps.api as any).omiFiles.ingestFile, {
    storageId,
    fileName: file.name,
    preExtracted,
  })) as { documentId: string; truncated: boolean };
  return { documentId: out.documentId, truncated: out.truncated };
}
