/**
 * PDF text extraction — client-side (Phase 4/24 completion).
 *
 * Runs ON THE USER'S DEVICE (privacy §41): the PDF bytes never leave the
 * browser for parsing; only the extracted text uploads through the existing
 * omiFiles text pipeline, exactly like DOCX/XLSX.
 *
 * Dependency: pdfjs-dist (Apache-2.0) — the one vetted open-source addition
 * approved for this feature. Loaded lazily so the initial bundle is not
 * affected, with the legacy build for broad browser compatibility.
 */

import { isScannedLikeText, ocrCanvases } from "./ocr";

export type PdfExtractResult = {
  text: string;
  pages: number;
  kind: "pdf";
};

export async function extractPdf(
  data: Uint8Array,
  fileName: string,
  maxChars = 60_000,
): Promise<PdfExtractResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Vite-correct worker wiring: resolve the worker asset from the legacy
  // build so both dev and production builds load it reliably (an empty
  // workerSrc falls back to a fragile fake-worker path).
  (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
    new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | null = null;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const pages: string[] = [];
    let total = 0;
    const pageCount = doc.numPages;
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (pageText) {
        pages.push(`[Page ${i}]\n${pageText}`);
        total += pageText.length;
      }
      if (total > maxChars) break; // bounded extraction; caller truncates
      page.cleanup();
    }
    const text = pages.join("\n\n");
    if (isScannedLikeText(text)) {
      // Scanned/image PDF: fall back to on-device OCR (Apache-2.0, keyless,
      // §41 privacy — pages render and recognize locally, never uploaded).
      const ocr = await ocrCanvases(async (pageIndex) => {
        const page = await doc!.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx2d = canvas.getContext("2d");
        if (!ctx2d) return null;
        await page.render({ canvasContext: ctx2d, viewport }).promise;
        return canvas;
      }, pageCount);
      if (isScannedLikeText(ocr.text)) {
        throw new Error(
          `No readable text found in "${fileName}" — even OCR came back empty (pages may be blank or unreadable).`,
        );
      }
      return {
        text: `${ocr.text}\n\n(Extracted via on-device OCR — recognition can be imperfect.)`,
        pages: ocr.pages,
        kind: "pdf",
      };
    }
    return { text, pages: pages.length, kind: "pdf" };
  } finally {
    try {
      await doc?.destroy();
    } catch {
      // ignore teardown errors
    }
  }
}
