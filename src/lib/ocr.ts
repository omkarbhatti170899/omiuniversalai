/**
 * OCR — client-side, on-device (Phase 4/24 completion).
 *
 * Runs ON THE USER'S DEVICE (privacy §41): page images are rendered locally
 * and recognized locally; document bytes and images never leave the browser.
 * The recognized TEXT uploads through the existing omiFiles text pipeline,
 * exactly like every other document.
 *
 * Dependency: tesseract.js (Apache-2.0) — vetted open source, keyless, no
 * paid API. Lazy-loaded so the initial bundle is unaffected. Recognition
 * language data (~eng.traineddata) is fetched on first use from the open
 * CDN the library ships with — free, no key, documented here honestly.
 *
 * Bounded by design: a page cap and a character cap keep OCR runs finite.
 */

const MAX_OCR_PAGES = 10;
const MAX_OCR_CHARS = 40_000;

export type OcrResult = {
  text: string;
  pages: number;
};

/**
 * Recognize text from a list of canvas-producing page renderers. The caller
 * (pdfExtract) renders PDF pages; this module stays DOM-agnostic and bounded.
 */
export async function ocrCanvases(
  renderPage: (index: number) => Promise<HTMLCanvasElement | null>,
  pageCount: number,
): Promise<OcrResult> {
  const Tesseract = (await import("tesseract.js")).default;
  const pages: string[] = [];
  let total = 0;
  const limit = Math.min(pageCount, MAX_OCR_PAGES);

  for (let i = 0; i < limit; i++) {
    const canvas = await renderPage(i);
    if (!canvas) continue;
    const result = await Tesseract.recognize(canvas, "eng");
    const text = (result.data.text ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      pages.push(`[Page ${i + 1}]\n${text}`);
      total += text.length;
    }
    if (total > MAX_OCR_CHARS) break;
  }

  return { text: pages.join("\n\n"), pages: pages.length };
}

/** True when a text layer is too thin to be real content (scanned doc). */
export function isScannedLikeText(text: string): boolean {
  return text.replace(/\[Page \d+\]/g, "").trim().length < 20;
}
