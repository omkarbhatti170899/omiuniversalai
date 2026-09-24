/**
 * Omi Image Studio backend — generation/editing orchestration + private
 * gallery. The ONLY image-capability entry points (Studio UI and chat both
 * call these), so auth, rate limiting, validation and storage live in one
 * auditable place (§12 security).
 *
 * Privacy model: generated images go to Convex file storage (zero cost) and
 * every read path is ownership-checked. A user can never list, load, or
 * download another user's image — the gallery query filters by userId and
 * every URL/source read verifies ownership first.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { rateLimit } from "./searchEngine/resilience";
import {
  ASPECT_RATIOS,
  IMAGE_OPS,
  capabilityForOp,
  opNeedsImage,
  opNeedsMultiple,
  type AspectRatio,
  type ImageOp,
} from "./aiProviders/imageCatalog";
import { runImageOp } from "./aiProviders/imageProviders";
import { healthSentence, type ProviderHealth } from "./aiProviders/imageRouter";
import { normalizeImageRequest, type NormalizedImageRequest } from "./aiProviders/imageNormalize";
import {
  classifyImageIntent,
  resolveReferenceIndices,
} from "./aiProviders/imageIntent";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

const MAX_IMAGE_BYTES = 8_000_000; // 8 MB stored per generated image
const MAX_SOURCES = 4;
const MAX_GALLERY_ROWS = 100;

export type ImageOpResult =
  | { ok: true; imageId: string; provider: string; model: string; width: number; height: number }
  | {
      ok: false;
      error: string;
      attempts: Array<{ provider: string; model: string; error?: string; state?: ProviderHealth }>;
      /** Honest overall health (rate_limited, auth_error, …) when available. */
      health?: ProviderHealth;
      /** The capability the request needed, for a precise message. */
      capability?: string;
    };

/**
 * Shared core for `run` (Studio, auth + rate-limit preamble) and
 * `runInternal` (chat, explicit userId): identical ownership checks,
 * provider routing, storage and persistence for both entry points.
 */
async function runImageCore(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: {
    op: ImageOp;
    prompt: string;
    aspectRatio?: string;
    transparent?: boolean;
    sourceImageIds?: Array<Id<"omiImages">>;
    /** Uploaded-image attachments (omiDocuments with an image blob). */
    sourceDocumentIds?: Array<Id<"omiDocuments">>;
    seed?: number;
    parentId?: Id<"omiImages">;
    conversationId?: Id<"omiConversations">;
  },
): Promise<ImageOpResult> {
  const prompt = args.prompt.trim().slice(0, 1000);
  if (prompt.length < 2) {
    return { ok: false, error: "Describe what Omi should do with the image.", attempts: [] };
  }

  const aspectRatio: AspectRatio =
    args.aspectRatio && args.aspectRatio in ASPECT_RATIOS
      ? (args.aspectRatio as AspectRatio)
      : "1:1";

  // Ownership-checked sources: edit-family ops may reference ONLY images
  // the caller owns. Unknown/foreign IDs fail closed here. Two ID spaces are
  // accepted: gallery rows (omiImages) and uploaded attachments (omiDocuments
  // with an image blob) — chat edits "this attached image" through the latter.
  const sourceIds = (args.sourceImageIds ?? []).slice(0, MAX_SOURCES);
  const sources: string[] = [];
  for (const id of sourceIds) {
    const owned = await ctx.runQuery(internal.omiImages.getOwned, { userId, id });
    if (!owned) {
      return { ok: false, error: "One of the selected images isn't available — refresh and try again.", attempts: [] };
    }
    const blob = await ctx.storage.get(owned.fileId);
    if (!blob) {
      return { ok: false, error: "A source image is no longer available.", attempts: [] };
    }
    sources.push(await blobToDataUrl(blob, owned.mimeType));
  }
  for (const docId of (args.sourceDocumentIds ?? []).slice(0, MAX_SOURCES)) {
    const doc = await ctx.runQuery(internal.omiFiles.getOwnedInternal, {
      userId,
      documentId: docId,
    });
    if (!doc || !doc.fileId) {
      return { ok: false, error: "An attached image isn't available.", attempts: [] };
    }
    const blob = await ctx.storage.get(doc.fileId);
    if (!blob) {
      return { ok: false, error: "An attached image is no longer available.", attempts: [] };
    }
    sources.push(await blobToDataUrl(blob, doc.fileType ?? null));
  }

  // Capability preconditions, enforced before any provider call. A missing
  // input is a user-fixable condition, not a provider failure.
  if (opNeedsImage(args.op) && sources.length === 0) {
    return {
      ok: false,
      error: `${capitalize(capabilityForOp(args.op))} works on an image — add or pick one first.`,
      attempts: [],
      capability: capabilityForOp(args.op),
    };
  }
  if (opNeedsMultiple(args.op) && sources.length < 2) {
    return {
      ok: false,
      error: "Combining needs at least two images — add another first.",
      attempts: [],
      capability: capabilityForOp(args.op),
    };
  }

  // NORMALIZE: turn the natural sentence into structured instructions with an
  // explicit preservation clause for edits, then send THAT to the provider
  // instead of the raw user sentence. The raw prompt is still stored for the
  // transcript; the normalized one is what keeps an edit an edit.
  const normalized: NormalizedImageRequest = normalizeImageRequest(args.op, prompt, aspectRatio);

  const result = await runImageOp({
    op: args.op,
    prompt: normalized.prompt,
    aspectRatio,
    transparent: args.transparent ?? false,
    sources: sources.length > 0 ? sources : undefined,
    seed: args.seed,
  });

  if (!result.ok || !result.bytes) {
    return {
      ok: false,
      error: result.error ?? healthSentence(result.health ?? "unavailable", args.op),
      attempts: result.attempts,
      health: result.health,
      capability: capabilityForOp(args.op),
    };
  }
  if (result.bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: "The generated image was too large to store — try a smaller size.", attempts: result.attempts };
  }

  const fileId = await ctx.storage.store(
    new Blob([result.bytes as unknown as BlobPart], { type: result.mimeType }),
  );
  const imageId = await ctx.runMutation(internal.omiImages.insert, {
    userId,
    op: args.op,
    prompt,
    normalizedPrompt: normalized.prompt,
    fileId,
    provider: result.provider ?? "unknown",
    model: result.model ?? "unknown",
    width: result.width,
    height: result.height,
    transparent: result.transparent,
    parentId: args.parentId,
    sourceImageIds: sourceIds.length > 0 ? sourceIds : undefined,
    conversationId: args.conversationId,
  });
  return {
    ok: true,
    imageId,
    provider: result.provider ?? "unknown",
    model: result.model ?? "unknown",
    width: result.width,
    height: result.height,
  };
}

/**
 * Run one image operation from the Studio UI: auth + rate-limit preamble,
 * then the shared core.
 */
export const run = action({
  args: {
    op: v.union(...IMAGE_OPS.map((o) => v.literal(o))),
    prompt: v.string(),
    aspectRatio: v.optional(v.string()),
    transparent: v.optional(v.boolean()),
    /** Gallery IDs of input image(s) for edit-family ops (ownership-checked). */
    sourceImageIds: v.optional(v.array(v.id("omiImages"))),
    /**
     * Uploaded-image attachments (omiDocuments) as inputs — what the Studio's
     * upload button produces. Same ownership check as sourceImageIds: an
     * unknown or foreign document fails closed, so a user can never edit (or
     * even read) another user's upload.
     */
    sourceDocumentIds: v.optional(v.array(v.id("omiDocuments"))),
    seed: v.optional(v.number()),
    /** Multi-turn lineage: the image this op edits/extends. */
    parentId: v.optional(v.id("omiImages")),
  },
  handler: async (ctx, args): Promise<ImageOpResult> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to use Image Studio.");

    const rl = rateLimit(`imagegen:${userId}`, 12);
    if (!rl.ok) {
      throw new Error(
        `Too many image requests — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      );
    }

    return await runImageCore(ctx, userId, {
      op: args.op,
      prompt: args.prompt,
      aspectRatio: args.aspectRatio,
      transparent: args.transparent,
      sourceImageIds: args.sourceImageIds,
      sourceDocumentIds: args.sourceDocumentIds,
      seed: args.seed,
      parentId: args.parentId,
    });
  },
});

/**
 * Interpret a natural-language request for the Studio's "auto" mode: classify
 * the operation, resolve which image the user means, and return the
 * normalized request. Pure compute (no provider call), so the UI can show
 * "Omi will edit this image" BEFORE spending a request.
 */
export const interpret = action({
  args: {
    prompt: v.string(),
    hasImageContext: v.boolean(),
    imageCount: v.optional(v.number()),
  },
  handler: async (ctx, { prompt, hasImageContext, imageCount }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to use Image Studio.");
    const count = imageCount ?? (hasImageContext ? 1 : 0);
    const intent = classifyImageIntent(prompt, hasImageContext, count);

    if (intent.kind === "none") return { kind: "none" as const };
    if (intent.kind === "image-understanding") {
      return { kind: "image-understanding" as const };
    }
    if (intent.kind === "generate") {
      const normalized = normalizeImageRequest("generate", intent.prompt, intent.aspectRatio);
      return {
        kind: "generate" as const,
        op: "generate" as const,
        aspectRatio: intent.aspectRatio ?? null,
        transparent: intent.transparent,
        capability: capabilityForOp("generate"),
        references: resolveReferenceIndices(intent.references, count),
        normalized,
      };
    }
    const normalized = normalizeImageRequest(intent.op, intent.prompt);
    return {
      kind: "image-edit" as const,
      op: intent.op,
      needsImage: intent.needsImage,
      needsMultiple: intent.needsMultiple,
      capability: capabilityForOp(intent.op),
      references: resolveReferenceIndices(intent.references, count),
      normalized,
    };
  },
});

/**
 * Run one image operation as an INTERNAL call with an explicit,
 * already-authenticated userId — the shape the chat action needs (actions
 * cannot call other actions, and chat never accepts client-supplied IDs).
 */
export const runInternal = internalAction({
  args: {
    userId: v.id("users"),
    op: v.union(...IMAGE_OPS.map((o) => v.literal(o))),
    prompt: v.string(),
    aspectRatio: v.optional(v.string()),
    transparent: v.optional(v.boolean()),
    sourceImageIds: v.optional(v.array(v.id("omiImages"))),
    /** Uploaded-image attachments (omiDocuments with an image blob). */
    sourceDocumentIds: v.optional(v.array(v.id("omiDocuments"))),
    seed: v.optional(v.number()),
    parentId: v.optional(v.id("omiImages")),
    conversationId: v.optional(v.id("omiConversations")),
  },
  handler: async (ctx, args): Promise<ImageOpResult> => {
    return await runImageCore(ctx, args.userId, {
      op: args.op,
      prompt: args.prompt,
      aspectRatio: args.aspectRatio,
      transparent: args.transparent,
      sourceImageIds: args.sourceImageIds,
      sourceDocumentIds: args.sourceDocumentIds,
      seed: args.seed,
      parentId: args.parentId,
      conversationId: args.conversationId,
    });
  },
});

/** Gallery — the user's images, newest first, with fresh URLs. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("omiImages")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_GALLERY_ROWS);
    const withUrls = [];
    for (const r of rows) {
      withUrls.push({
        _id: r._id,
        op: r.op,
        prompt: r.prompt,
        provider: r.provider,
        model: r.model,
        width: r.width,
        height: r.height,
        transparent: r.transparent ?? false,
        parentId: r.parentId,
        url: await ctx.storage.getUrl(r.fileId),
        createdAt: r.createdAt,
      });
    }
    return withUrls;
  },
});

/** Fresh URL for one owned image (chat rendering + downloads). */
export const imageUrl = query({
  args: { id: v.id("omiImages") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) return null;
    return await ctx.storage.getUrl(row.fileId);
  },
});

/** Delete one owned image (row + blob). */
export const remove = mutation({
  args: { id: v.id("omiImages") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const row = await ctx.db.get(id);
    if (!row) return;
    if (row.userId !== userId) throw new Error("Not your image");
    await ctx.storage.delete(row.fileId);
    await ctx.db.delete(id);
  },
});

// ---- internal helpers ----------------------------------------------------

/** "image editing" → "Image editing" (sentence start in honest messages). */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

async function blobToDataUrl(
  blob: Blob,
  mimeType: string | null,
): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const mime = mimeType ?? blob.type ?? "image/png";
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

// ---- internal ------------------------------------------------------------

/** Ownership-checked read used by runImageCore (sources) and the chat action. */
/**
 * Latest image Omi produced in THIS conversation (multi-turn editing:
 * "now make it bluer" binds to this without a re-upload). Ownership-checked.
 */
export const latestForConversation = internalQuery({
  args: { userId: v.id("users"), conversationId: v.id("omiConversations") },
  handler: async (ctx, { userId, conversationId }) => {
    const row = await ctx.db
      .query("omiImages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .first();
    if (!row || row.userId !== userId) return null;
    return row._id;
  },
});

export const getOwned = internalQuery({
  args: { userId: v.id("users"), id: v.id("omiImages") },
  handler: async (ctx, { userId, id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) return null;
    return { fileId: row.fileId, mimeType: null as string | null, prompt: row.prompt };
  },
});

export const insert = internalMutation({
  args: {
    userId: v.id("users"),
    op: v.string(),
    prompt: v.string(),
    /** The structured prompt actually sent to the provider (provenance). */
    normalizedPrompt: v.optional(v.string()),
    fileId: v.id("_storage"),
    provider: v.string(),
    model: v.string(),
    width: v.number(),
    height: v.number(),
    transparent: v.boolean(),
    parentId: v.optional(v.id("omiImages")),
    sourceImageIds: v.optional(v.array(v.id("omiImages"))),
    conversationId: v.optional(v.id("omiConversations")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("omiImages", {
      userId: args.userId,
      op: args.op as never,
      prompt: args.prompt,
      normalizedPrompt: args.normalizedPrompt,
      fileId: args.fileId,
      provider: args.provider,
      model: args.model,
      width: args.width,
      height: args.height,
      transparent: args.transparent,
      parentId: args.parentId,
      sourceImageIds: args.sourceImageIds,
      conversationId: args.conversationId,
      // Verified extra means this row only exists because real image bytes
      // passed format verification before storage.
      verified: true,
      createdAt: Date.now(),
    });
  },
});

/** Attach generated images to the Omi reply that produced them (chat flow). */
export const attachToMessage = internalMutation({
  args: { messageId: v.id("omiMessages"), imageIds: v.array(v.id("omiImages")) },
  handler: async (ctx, { messageId, imageIds }) => {
    await ctx.db.patch(messageId, { images: imageIds });
  },
});
