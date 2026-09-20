import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { rateLimit } from "./searchEngine/resilience";
import { htmlToText } from "./searchProviders/pageFetcher";

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
 *
 * Binary formats we cannot honestly read yet (e.g. PDF, images) are rejected
 * with a clear message; Omi never pretends to have read a file.
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
    // both fine; everything else is honestly rejected.
    if (!isTextual && !isHtml && !preExtracted) {
      throw new Error(
        `Omi reads text-based files (txt, md, csv, json, html, code) plus Word (.docx) and Excel (.xlsx). "${fileName}" isn't supported yet — PDF/image reading is on the roadmap.`,
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
