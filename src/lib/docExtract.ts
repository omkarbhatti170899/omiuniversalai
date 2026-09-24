/**
 * DOCX / XLSX text extraction — Phase 4 document understanding (master plan).
 *
 * Both formats are ZIP + XML. We unpack them with the local zipReader and
 * parse the XML with a small built-in scanner (no DOMParser, no dependencies
 * — runs in the browser, a worker, or any JS runtime). ZERO dependencies,
 * zero cost, and nothing leaves the user's device — extraction runs
 * client-side before upload (master plan §41 privacy).
 *
 * Extracted text flows into the existing knowledge-base pipeline, so Omi
 * can search and quote these documents exactly like any other knowledge doc.
 */

import { unzipEntry, listZipEntries } from "./zipReader";

export interface ExtractedDoc {
  title: string;
  text: string;
  meta: string[];
}

// --- Minimal XML scanning (no DOMParser required) ---------------------------

const ENTITY_RE = /&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g;

function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, code: string) => {
    switch (code) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
      default:
        if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(2), 16));
        return String.fromCodePoint(parseInt(code.slice(1), 10));
    }
  });
}

export interface XmlElement {
  attrs: Record<string, string>;
  inner: string;
}

const ATTR_RE = /([a-zA-Z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(openTag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(openTag)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

/**
 * Find all elements named `tag` in order. Depth-counts nested same-name
 * elements (returns the outermost, whose `inner` includes nested content)
 * and handles self-closing tags. OOXML has no comments/CDATA in practice.
 */
export function findElements(xml: string, tag: string): XmlElement[] {
  const out: XmlElement[] = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const realOpenAfter = (pos: number): boolean => {
    const after = xml[pos + open.length];
    return after === undefined || /[\s/>]/.test(after);
  };

  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf(open, i);
    if (start === -1) break;
    if (!realOpenAfter(start)) {
      i = start + open.length;
      continue;
    }
    const gt = xml.indexOf(">", start);
    if (gt === -1) break;
    const openTag = xml.slice(start, gt + 1);

    if (openTag.endsWith("/>")) {
      out.push({ attrs: parseAttrs(openTag), inner: "" });
      i = gt + 1;
      continue;
    }

    // Match closes with depth counting (self-closing nested tags don't count).
    let depth = 1;
    let q = gt + 1;
    let end = -1;
    while (q < xml.length) {
      const nextOpen = xml.indexOf(open, q);
      const nextClose = xml.indexOf(close, q);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose && realOpenAfter(nextOpen)) {
        const nestedGt = xml.indexOf(">", nextOpen);
        if (nestedGt === -1) break;
        if (!xml.slice(nextOpen, nestedGt + 1).endsWith("/>")) depth++;
        q = nestedGt + 1;
      } else {
        depth--;
        q = nextClose + close.length;
        if (depth === 0) {
          end = nextClose;
          break;
        }
      }
    }
    if (end === -1) break;
    out.push({ attrs: parseAttrs(openTag), inner: xml.slice(gt + 1, end) });
    i = end + close.length;
  }
  return out;
}

// --- DOCX -------------------------------------------------------------------

/**
 * Extract paragraph text from a Word document. Tab/br markers between runs
 * become whitespace so words don't glue together; text inside nested
 * containers (e.g. textboxes) is still captured.
 */
export async function extractDocx(
  data: Uint8Array,
  fileName: string,
): Promise<ExtractedDoc> {
  const docXml = await unzipEntry(data, "word/document.xml");
  if (!docXml) {
    throw new Error("Not a valid Word document (missing document.xml).");
  }
  const xml = new TextDecoder().decode(docXml);
  const body = findElements(xml, "w:body")[0];
  if (!body) throw new Error("Not a valid Word document (missing body).");

  const parts: string[] = [];
  for (const p of findElements(body.inner, "w:p")) {
    let text = "";
    for (const t of findElements(p.inner, "w:t")) {
      text += decodeEntities(t.inner);
    }
    if (text.trim().length > 0) parts.push(text.trim());
  }

  if (parts.length === 0) {
    throw new Error("No readable text found in that Word document.");
  }

  return {
    title: fileName.replace(/\.[^.]+$/, "").trim() || fileName,
    text: parts.join("\n"),
    meta: ["word", `${parts.length} paragraphs`],
  };
}

// --- XLSX -------------------------------------------------------------------

interface CellRecord {
  ref: string;
  type: string | null; // "s" shared string, "inlineStr", "str" formula string
  value: string;
}

function readCells(sheetXml: string): CellRecord[] {
  const cells: CellRecord[] = [];
  for (const c of findElements(sheetXml, "c")) {
    const ref = c.attrs.r ?? "";
    const type = c.attrs.t ?? null;
    let value = "";
    if (type === "inlineStr") {
      for (const t of findElements(c.inner, "t")) {
        value += decodeEntities(t.inner);
      }
    } else {
      const v = findElements(c.inner, "v")[0];
      value = v ? decodeEntities(v.inner) : "";
    }
    if (ref) cells.push({ ref, type, value });
  }
  return cells;
}

/** Extract cell text from a spreadsheet workbook (first 10 sheets). */
export async function extractXlsx(
  data: Uint8Array,
  fileName: string,
): Promise<ExtractedDoc> {
  const names = listZipEntries(data).map((e) => e.name);
  const sheetNames = names
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/)?.[1] ?? 0);
      const nb = Number(b.match(/(\d+)/)?.[1] ?? 0);
      return na - nb;
    })
    .slice(0, 10);
  if (sheetNames.length === 0) {
    throw new Error("Not a valid spreadsheet (no worksheets found).");
  }

  // Shared strings may be absent for inline-string workbooks.
  const shared: string[] = [];
  const sharedXml = await unzipEntry(data, "xl/sharedStrings.xml");
  if (sharedXml) {
    for (const si of findElements(new TextDecoder().decode(sharedXml), "si")) {
      let text = "";
      for (const t of findElements(si.inner, "t")) {
        text += decodeEntities(t.inner);
      }
      shared.push(text);
    }
  }

  const lines: string[] = [];
  for (let i = 0; i < sheetNames.length; i++) {
    const sheetXml = await unzipEntry(data, sheetNames[i]);
    if (!sheetXml) continue;
    const cells = readCells(new TextDecoder().decode(sheetXml));

    lines.push(`Sheet ${i + 1}`);
    for (const cell of cells) {
      let value = cell.value;
      if (cell.type === "s") {
        const idx = Number(value);
        value =
          Number.isInteger(idx) && shared[idx] !== undefined ? shared[idx] : "";
      }
      value = value.trim();
      if (value.length > 0) {
        lines.push(`${cell.ref}: ${value}`);
      }
    }
    lines.push("");
  }

  const text = lines.join("\n").trim();
  if (text.length < 10) {
    throw new Error("No readable content found in that spreadsheet.");
  }

  return {
    title: fileName.replace(/\.[^.]+$/, "").trim() || fileName,
    text,
    meta: [
      "spreadsheet",
      `${sheetNames.length} sheet${sheetNames.length === 1 ? "" : "s"}`,
    ],
  };
}
