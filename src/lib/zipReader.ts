/**
 * Minimal ZIP reader — Phase 4 document understanding (master plan).
 *
 * DOCX and XLSX are ZIP archives. This module reads their central directory
 * and inflates entries using the browser/runtime's built-in
 * DecompressionStream("deflate-raw") — a web standard. ZERO dependencies,
 * zero cost, works entirely on the user's device (master plan §41 privacy).
 *
 * Scope: reading named entries is all we need. No zip writing, no encryption.
 */

export interface ZipEntryMeta {
  name: string;
  /** 0 = stored, 8 = deflate. Other methods are rejected. */
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function u16(view: DataView, pos: number): number {
  return view.getUint16(pos, true);
}

function u32(view: DataView, pos: number): number {
  return view.getUint32(pos, true);
}

const nameDecoder = new TextDecoder("utf-8");

/** Locate the End Of Central Directory record (search the last 64 KiB). */
function findEOCD(view: DataView): number {
  const len = view.byteLength;
  const maxBack = Math.min(len, 22 + 65_536);
  for (let i = len - 22; i >= len - maxBack; i--) {
    if (u32(view, i) === EOCD_SIG && i + 22 <= len) return i;
  }
  throw new Error("Not a valid ZIP document (no end-of-archive record).");
}

/** Parse the central directory into entry metadata. */
export function listZipEntries(data: Uint8Array): ZipEntryMeta[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEOCD(view);
  const count = u16(view, eocd + 10);
  let p = u32(view, eocd + 16);

  const entries: ZipEntryMeta[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > data.byteLength || u32(view, p) !== CEN_SIG) {
      throw new Error("Not a valid ZIP document (corrupt central directory).");
    }
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const name = nameDecoder.decode(
      data.subarray(p + 46, p + 46 + nameLen),
    );
    entries.push({
      name,
      method: u16(view, p + 10),
      compressedSize: u32(view, p + 20),
      localHeaderOffset: u32(view, p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Inflate a raw DEFLATE stream using the platform DecompressionStream
 * (browser standard, also present in Node/Bun 18+). No polyfill needed
 * for the modern browsers this app targets.
 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser can't unpack compressed documents yet — try a current Chrome, Edge, Firefox or Safari.",
    );
  }
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Read and decompress one entry's data. Returns null when not present. */
export async function unzipEntry(
  data: Uint8Array,
  entryName: string,
): Promise<Uint8Array | null> {
  const entry = listZipEntries(data).find((e) => e.name === entryName);
  if (!entry) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const o = entry.localHeaderOffset;
  if (o + 30 > data.byteLength || u32(view, o) !== LOC_SIG) {
    throw new Error("Not a valid ZIP document (corrupt local header).");
  }
  // Name/extra lengths must come from the LOCAL header — they may differ
  // from the central directory (e.g. data-descriptor writers).
  const localNameLen = u16(view, o + 26);
  const localExtraLen = u16(view, o + 28);
  const start = o + 30 + localNameLen + localExtraLen;
  const end = start + entry.compressedSize;
  if (end > data.byteLength) {
    throw new Error("Not a valid ZIP document (entry data out of bounds).");
  }
  const raw = data.slice(start, end);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(
    `Unsupported ZIP compression (method ${entry.method}) in this document.`,
  );
}
