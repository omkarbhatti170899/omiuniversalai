/**
 * Image Studio wiring contracts.
 *
 * Why a source-level contract and not a runtime call: both of these bugs lived
 * in a Convex action and a Convex adapter — the chat action needs a Convex
 * runtime plus an authenticated user, and the adapter needs a live provider —
 * so neither could be driven from the unit suite. What CAN be pinned is the
 * exact wiring that broke, and that is what a regression test needs to stop
 * from coming back.
 *
 * 1. Chat → image engine id space. The chat action once mapped attachments to
 *    `a.fileId` (a STORAGE id) cast to `Id<"omiImages">` and passed it as
 *    `sourceDocumentIds`. The engine re-reads sources through an
 *    ownership-checked `omiDocuments` lookup, so every "edit this attached
 *    image" request failed with "an attached image isn't available" — a
 *    feature that looked implemented and never worked.
 * 2. Studio → image engine uploads. `omiImages.run` (the Studio/UI entry
 *    point) accepted only gallery ids, so an uploaded image could never be
 *    edited from the Studio even though the chat path already supported it.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const read = (rel: string) =>
  readFileSync(new URL(`../src/convex/${rel}`, import.meta.url).pathname, "utf-8");

describe("chat → image engine: document ids, never storage ids", () => {
  const chat = read("omiChat.ts");

  test("image attachments are identified by their omiDocuments row id", () => {
    expect(chat).toMatch(
      /const imageAttachmentIds\s*=\s*attachments[\s\S]{0,200}?\.map\(\(a\) => a\._id\)/,
    );
  });

  test("no storage id is ever cast into the image-id space", () => {
    // The exact shape of the bug that shipped: `a.fileId as unknown as Id<...>`.
    expect(chat).not.toMatch(/fileId as unknown as Id</);
    expect(chat).not.toMatch(/sourceDocumentIds[\s\S]{0,120}?fileId/);
  });

  test("the edit path forwards attachments as sourceDocumentIds", () => {
    expect(chat).toMatch(/sourceDocumentIds:/);
    expect(chat).toMatch(/sourceImageIds:/);
  });
});

describe("Image Studio → image engine: uploads are editable", () => {
  const images = read("omiImages.ts");
  const studio = readFileSync(
    new URL("../src/components/workspace/ImageStudioView.tsx", import.meta.url)
      .pathname,
    "utf-8",
  );

  test("the public run action accepts uploaded-document sources", () => {
    const runAction = images.slice(images.indexOf("export const run = action"));
    expect(runAction).toMatch(
      /sourceDocumentIds: v\.optional\(v\.array\(v\.id\("omiDocuments"\)\)\)/,
    );
  });

  test("the action forwards them into the same ownership-checked core", () => {
    expect(images).toMatch(/sourceDocumentIds: args\.sourceDocumentIds/);
    // Document sources are re-read through the ownership-checked lookup — the
    // check that a storage id could never satisfy (the bug this guards).
    expect(images).toMatch(/internal\.omiFiles\.getOwnedInternal/);
    expect(images).toMatch(/documentId: docId/);
  });

  test("the Studio uploads images and sends the document ids", () => {
    expect(studio).toMatch(/uploadAttachment\(/);
    expect(studio).toMatch(/sourceDocumentIds:/);
  });
});

describe("image adapters report a usable mime type", () => {
  const providers = read("aiProviders/imageProviders.ts");

  test("a provider response without a content-type still yields a mimeType", () => {
    // Adapter results carry an optional mimeType; ImageGenResult requires one.
    expect(providers).toMatch(/mimeType: res\.mimeType \?\? "image\/png"/);
  });
});
