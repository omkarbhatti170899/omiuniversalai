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
  // Disable the worker bundle entirely: single-threaded main-thread parsing
  // is the right trade-off for a 2 MB cap, and avoids bundler/worker wiring.
  // pdf.js v4: GlobalWorkerOptions must exist even when workerSrc is a stub.
  (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
    "";

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
    if (text.replace(/\[Page \d+\]/g, "").trim().length < 20) {
      throw new Error(
        `No readable text found in "${fileName}" — it may be a scanned image PDF (OCR is on the roadmap).`,
      );
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
