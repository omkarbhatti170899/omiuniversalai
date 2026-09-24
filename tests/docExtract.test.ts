/**
 * Phase 14 tests — client-side document understanding (Phase 4).
 *
 * Fixtures are real DOCX/XLSX archives built in-test with a tiny ZIP writer
 * (raw DEFLATE via Bun/Node zlib). This exercises the actual byte-level path:
 * central-directory parsing → local-header parse → inflate → XML extraction.
 * No mocks, no fakes (master plan §35).
 */
import { describe, test, expect } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { unzipEntry, listZipEntries } from "../src/lib/zipReader";
import { extractDocx, extractXlsx } from "../src/lib/docExtract";

// --- Tiny in-test ZIP writer -------------------------------------------------

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function buildZip(files: Array<{ name: string; data: Uint8Array; store?: boolean }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const method = f.store ? 0 : 8;
    const payload = method === 8 ? deflateRawSync(f.data) : f.data;
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(payload.length), ...u32(size),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    chunks.push(local, payload);

    const cen = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(payload.length), ...u32(size),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...nameBytes,
    ]);
    central.push(cen);
    offset += local.length + payload.length;
  }

  const centralBytes = central.reduce((acc, c) => {
    const out = new Uint8Array(acc.length + c.length);
    out.set(acc); out.set(c, acc.length);
    return out;
  }, new Uint8Array(0));

  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralBytes.length), ...u32(offset), ...u16(0),
  ]);

  const all = [...chunks, centralBytes, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

// --- Fixtures ----------------------------------------------------------------

function docxXml(paragraphs: string[]): string {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;
}

function sheetXml(rows: Array<Array<[string, string | null, string]>>): string {
  // rows: array of cells [ref, type, value]
  const cellXml = rows
    .map(
      (cells) =>
        `<row>${cells
          .map(([ref, type, value]) =>
            type === null
              ? `<c r="${ref}"><v>${value}</v></c>`
              : `<c r="${ref}" t="s"><v>${value}</v></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cellXml}</sheetData></worksheet>`;
}

describe("zipReader", () => {
  test("lists entries and inflates stored + deflated entries", async () => {
    const a = new TextEncoder().encode("hello stored world");
    const b = new TextEncoder().encode("deflate me ".repeat(20));
    const zip = buildZip([
      { name: "a.txt", data: a, store: true },
      { name: "b.txt", data: b },
    ]);

    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);

    const gotA = await unzipEntry(zip, "a.txt");
    expect(new TextDecoder().decode(gotA!)).toBe("hello stored world");
    const gotB = await unzipEntry(zip, "b.txt");
    expect(new TextDecoder().decode(gotB!)).toBe("deflate me ".repeat(20));
  });

  test("rejects non-ZIP data with a clear error", async () => {
    const garbage = new TextEncoder().encode("this is not a zip file at all");
    expect(() => listZipEntries(garbage)).toThrow(/Not a valid ZIP/);
  });
});

describe("docx extraction", () => {
  test("extracts paragraph text in order", async () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>"), store: true },
      { name: "word/document.xml", data: new TextEncoder().encode(docxXml(["First paragraph.", "Second paragraph."])) },
    ]);
    const out = await extractDocx(zip, "report.docx");
    expect(out.title).toBe("report");
    expect(out.text).toBe("First paragraph.\nSecond paragraph.");
  });

  test("rejects a document without document.xml honestly", async () => {
    const zip = buildZip([{ name: "readme.txt", data: new TextEncoder().encode("not a docx") }]);
    expect(extractDocx(zip, "fake.docx")).rejects.toThrow(/missing document\.xml/);
  });
});

describe("xlsx extraction", () => {
  test("resolves shared strings and keeps cell references", async () => {
    const zip = buildZip([
      { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(sheetXml([[["A1", "s", "0"], ["B1", "s", "1"]], [["A2", null, "42"]]])) },
      { name: "xl/sharedStrings.xml", data: new TextEncoder().encode(
        `<?xml version="1.0"?><sst><si><t>Name</t></si><si><t>Value</t></si></sst>`,
      ) },
    ]);
    const out = await extractXlsx(zip, "budget.xlsx");
    expect(out.title).toBe("budget");
    expect(out.text).toContain("A1: Name");
    expect(out.text).toContain("B1: Value");
    expect(out.text).toContain("A2: 42");
    expect(out.meta).toContain("spreadsheet");
  });

  test("handles multiple sheets in order", async () => {
    const zip = buildZip([
      { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(sheetXml([[["A1", null, "first"]]])) },
      { name: "xl/worksheets/sheet2.xml", data: new TextEncoder().encode(sheetXml([[["A1", null, "second"]]])) },
    ]);
    const out = await extractXlsx(zip, "book.xlsx");
    expect(out.text.indexOf("first")).toBeLessThan(out.text.indexOf("second"));
  });
});
