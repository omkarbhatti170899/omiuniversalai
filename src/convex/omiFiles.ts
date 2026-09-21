import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { rateLimit } from "./searchEngine/resilience";
import { htmlToText } from "./searchProviders/pageFetcher";
import {
  ALLOWED_IMAGE_TYPES,
  VISION_LIMITS,
  validateImageDataUrl,
} from "./aiProviders/visionCatalog";
import { describeImage } from "./aiProviders/vision";

/**
 * Omi Files — Phase 4 (multimodal) ingest.
 *
 * Files are uploaded to Convex file storage (zero cost) and their readable
 * text is extracted LOCALLY — no paid parsing/vision API is involved. The
 * extracted text becomes an `omiDocuments` entry, so every existing retrieval
 * and grounding path (Knowledge search, Omi chat) picks it up automatically.
 *
 * Supported:
 *  • text-based files — txt, md, csv, json, html, code, logs (server extraction)
 *  • DOCX / XLSX — extracted ON THE USER'S DEVICE (src/lib/docExtract.ts,
 *    zero dependencies) and passed here as `preExtracted`; the original blob
 *    is still stored so files remain re-downloadable and deletable.
 *  • PDF (text-based) — extracted on-device via pdf.js (Apache-2.0,
 *    src/lib/pdfExtract.ts). Scanned/image-only PDFs fall back to on-device
 *    OCR (tesseract.js, Apache-2.0, keyless — src/lib/ocr.ts).
 *  • images (png/jpeg/webp/gif) — validated, stored, and described by the
 *    VisionProvider chain (aiProviders/vision.ts) IF a vision-capable key is
 *    configured; otherwise the image is still stored but ingest reports the
 *    honest "vision unavailable" state instead of a fake description.
 *
 * Binary formats we cannot honestly read yet are rejected with a clear
 * message; Omi never pretends to have read a file.
 */

const MAX_FILE_BYTES = 2_000_000; // 2 MB
// Keep in sync with the knowledge base cap (omiKnowledge.ts).
const MAX_CONTENT_CHARS = 60_000;

const TEXTUAL_NAME_RE =
  /\.(txt|md|markdown|csv|json|log|ts|tsx|js|jsx|py|rb|go|rs|java|c|h|cpp|sh|ya?ml|toml|ini|xml|svg|html?)$/i;

export type IngestResult = { documentId: string; truncated: boolean };

/** Short-lived upload URL for direct browser → Convex storage upload. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Ingest an uploaded image: validate it, describe it through the
 * VisionProvider chain (if configured), and store the description as a
 * knowledge document alongside the original blob. Honesty first: without a
 * vision provider the image is stored but NOT described, and the caller is
 * told exactly why.
 */
export const ingestImage = action({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    /** Base64 data URL of the image (already size/type-checked client-side; re-checked here). */
    dataUrl: v.string(),
    /** Optional focus for the description, e.g. "read the chart labels". */
    prompt: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { storageId, fileName, dataUrl, prompt },
  ): Promise<
    | { ok: true; documentId: string; description: string; truncated: false }
    | { ok: false; error: string; stored: boolean }
  > => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to upload images.");

    const rl = rateLimit(`image:${userId}`, 10);
    if (!rl.ok) {
      throw new Error(
        `Too many image uploads — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    const meta = await ctx.storage.getMetadata(storageId);
    if (!meta) throw new Error("Upload not found — try again.");
    if (meta.size > VISION_LIMITS.maxImageBytes) {
      throw new Error(
        `Image is too large — Omi reads images up to ${Math.round(VISION_LIMITS.maxImageBytes / 1_000_000)} MB.`,
      );
    }
    const contentType = meta.contentType ?? "";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new Error(
        `"${fileName}" isn't a supported image — use PNG, JPEG, WebP or GIF.`,
      );
    }

    // Defense in depth: re-validate the data URL server-side (client checks
    // are UX, not security — master plan §12).
    const validated = validateImageDataUrl(dataUrl);
    if (!validated.ok) {
      throw new Error(validated.error);
    }

    const focus = (prompt ?? "").trim().slice(0, VISION_LIMITS.maxPromptChars);
    const ask = focus.length > 0 ? focus : "Describe this image in clear detail.\n If it contains text, transcribe the key text verbatim.";

    const described = await describeImage(validated.dataUrl, ask, "describe");
    if (!described.ok) {
      // The image stays in storage (re-upload-free retry later); report honestly.
      return { ok: false, error: described.error ?? "Vision failed.", stored: true };
    }

    const title = (fileName.replace(/\.[^.]+$/, "").trim() || fileName).slice(0, 200);
    const description = described.description;
    const wordCount = description.split(/\s+/).filter(Boolean).length;

    const documentId = await ctx.runMutation(internal.omiFiles.createFileDocument, {
      userId,
      title,
      content: `Image description of "${title}":\n\n${description}`,
      fileId: storageId,
      fileType: contentType || "image",
      fileSize: meta.size,
      wordCount,
    });
    return { ok: true, documentId, description, truncated: false };
  },
});

/**
 * Ingest an uploaded file: read it from storage, extract readable text with
 * local parsing only, and store it as a knowledge document referencing the
 * original blob.
 */
export const ingestFile = action({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    /**
     * Text extracted on the user's device for structured formats (DOCX/XLSX).
     * Optional: plain-text files are extracted server-side as before.
     */
    preExtracted: v.optional(v.string()),
  },
  // Explicit return type avoids the generated-api type-inference cycle.
  handler: async (ctx, { storageId, fileName, preExtracted }): Promise<IngestResult> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to upload files.");

    const rl = rateLimit(`file:${userId}`, 20);
    if (!rl.ok) {
      throw new Error(
        `Too many uploads — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    const meta = await ctx.storage.getMetadata(storageId);
    if (!meta) throw new Error("Upload not found — try again.");
    if (meta.size > MAX_FILE_BYTES) {
      throw new Error("File is too large — Omi reads files up to 2 MB.");
    }

    const contentType = meta.contentType ?? "";
    const lowerName = fileName.toLowerCase();
    const isHtml =
      contentType.includes("html") ||
      lowerName.endsWith(".html") ||
      lowerName.endsWith(".htm");
    const isTextual =
      contentType.startsWith("text/") ||
      contentType.includes("json") ||
      TEXTUAL_NAME_RE.test(lowerName);

    // Client-extracted text (DOCX/XLSX) and server-readable text files are
    // both fine; images have their own action; everything else is honestly rejected.
    if (!isTextual && !isHtml && !preExtracted) {
      throw new Error(
        `Omi reads text-based files (txt, md, csv, json, html, code), Word (.docx), Excel (.xlsx), text-based PDFs and images. "${fileName}" isn't supported yet.`,
      );
    }

    let content: string;
    let truncated = false;
    if (preExtracted !== undefined) {
      content = preExtracted.trim().slice(0, MAX_CONTENT_CHARS);
      truncated = preExtracted.trim().length > MAX_CONTENT_CHARS;
    } else {
      const blob = await ctx.storage.get(storageId);
      if (!blob) throw new Error("Upload not found — try again.");
      const raw = await blob.text();
      content = (isHtml ? htmlToText(raw) : raw).trim().slice(0, MAX_CONTENT_CHARS);
      truncated = raw.trim().length > MAX_CONTENT_CHARS;
    }
    if (content.length < 20) {
      throw new Error("No readable text found in that file.");
    }

    const title = (fileName.replace(/\.[^.]+$/, "").trim() || fileName).slice(
      0,
      200,
    );
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    const documentId = await ctx.runMutation(
      internal.omiFiles.createFileDocument,
      {
        userId,
        title,
        content,
        fileId: storageId,
        fileType: contentType || (lowerName.split(".").pop() ?? "text"),
        fileSize: meta.size,
        wordCount,
      },
    );
    return { documentId, truncated };
  },
});

/** Delete a file document (and its stored blob). */
export const remove = mutation({
  args: { id: v.id("omiDocuments") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const doc = await ctx.db.get(id);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Not your file");

    if (doc.fileId) await ctx.storage.delete(doc.fileId);
    await ctx.db.delete(id);
  },
});

/** Internal insert used by the ingest action (actions can't touch the DB). */
export const createFileDocument = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    content: v.string(),
    fileId: v.id("_storage"),
    fileType: v.string(),
    fileSize: v.number(),
    wordCount: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiDocuments", {
      userId: args.userId,
      title: args.title,
      content: args.content,
      source: "user",
      fileId: args.fileId,
      fileType: args.fileType,
      fileSize: args.fileSize,
      wordCount: args.wordCount,
      createdAt: Date.now(),
    });
  },
});
