/**
 * OMI UNIVERSAL AI — brand icon rasteriser.
 * =============================================================================
 * WHY THIS EXISTS
 * Store packaging (Google Play, TWA, Lighthouse installability) requires PNG
 * app icons, and until now the repo had no way to produce them: the only brand
 * asset was an SVG, and this environment has no rasteriser (no libcairo, no
 * ImageMagick, no rsvg, no system package rights). The icons were therefore
 * documented as an owner-side BLOCKED item.
 *
 * This script removes that blocker without adding a dependency. The mark is
 * built from primitives (rounded rect, circles, one rotated ellipse), so it can
 * be evaluated analytically per pixel. Everything here is stdlib: `zlib` for
 * the PNG deflate stream, `fs` to write. No new package, nothing added to the
 * browser bundle, and the output is deterministic.
 *
 * IT IS NOT A REDRAW. The geometry below mirrors public/logo.svg exactly
 * (512-unit design space, scaled): core r=74, ring rx=176 ry=132 rotated -22deg,
 * nodes at (424,256) r=19 / (140,192) r=13 / (196,374) r=11. If you change the
 * SVG, change the constants here in the same commit — OmiMark.tsx reads the SVG
 * for on-screen use, these numbers are for the raster variants only.
 *
 * USAGE
 *   bun scripts/generateBrandIcons.ts
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// --- Design-space geometry (see public/logo.svg) -----------------------------
const D = 512;
const CORE_R = 74;
const RING_RX = 176;
const RING_RY = 132;
const RING_W = 11;
const RING_DEG = -22;
const GLOW_R = 196;
const NODES: Array<{ x: number; y: number; r: number; c: RGB }> = [
  { x: 424, y: 256, r: 19, c: [110, 123, 255] }, // sits on the ring, indigo end
  { x: 140, y: 192, r: 13, c: [34, 211, 238] }, // cyan
  { x: 196, y: 374, r: 11, c: [139, 152, 255] }, // periwinkle
];

type RGB = [number, number, number];
const CORE_HI: RGB = [139, 152, 255];
const CORE_MID: RGB = [110, 123, 255];
const CORE_LO: RGB = [34, 211, 238];
const BG_TOP: RGB = [16, 16, 24];
const BG_BOT: RGB = [11, 11, 15];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 1px-wide analytic coverage from a signed distance: the cheap, clean AA. */
const cov = (d: number) => clamp01(0.5 - d);

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Core + ring gradient, both running top-left → bottom-right in design space. */
function accent(t: number): RGB {
  return t < 0.55 ? mix(CORE_HI, CORE_MID, t / 0.55) : mix(CORE_MID, CORE_LO, (t - 0.55) / 0.45);
}

function rotate(px: number, py: number): [number, number] {
  const a = (-RING_DEG * Math.PI) / 180; // inverse of the mark's rotation
  const x = px - D / 2;
  const y = py - D / 2;
  return [x * Math.cos(a) - y * Math.sin(a) + D / 2, x * Math.sin(a) + y * Math.cos(a) + D / 2];
}

/** First-order signed distance to an axis-aligned ellipse (accurate near the curve). */
function ellipseSdf(x: number, y: number, rx: number, ry: number): number {
  const px = x - D / 2;
  const py = y - D / 2;
  const u = px / rx;
  const v = py / ry;
  const f = u * u + v * v - 1;
  const gx = (2 * px) / (rx * rx);
  const gy = (2 * py) / (ry * ry);
  const g = Math.hypot(gx, gy);
  return g === 0 ? -Math.min(rx, ry) : f / g;
}

function roundedRectSdf(x: number, y: number, half: number, r: number): number {
  const qx = Math.abs(x - D / 2) - (half - r);
  const qy = Math.abs(y - D / 2) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Screen-blend a colour over the accumulator: light adds, never clips flat. */
function screen(dst: [number, number, number], src: RGB, a: number) {
  dst[0] = 255 - (255 - dst[0]) * (1 - (src[0] / 255) * a);
  dst[1] = 255 - (255 - dst[1]) * (1 - (src[1] / 255) * a);
  dst[2] = 255 - (255 - dst[2]) * (1 - (src[2] / 255) * a);
}

function render(size: number, opts: { maskable?: boolean } = {}): Uint8Array {
  const s = D / size; // design units per pixel
  const artScale = opts.maskable ? 0.8 : 1; // Android's 80% safe zone
  const px = new Uint8Array(size * size * 4);
  const radius = opts.maskable ? 0 : D * 0.22; // maskable art is full-bleed

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) * s;
      const dy = (y + 0.5) * s;
      // Undo the maskable inset so all shape maths stays in design space.
      const ux = (dx - D / 2) / artScale + D / 2;
      const uy = (dy - D / 2) / artScale + D / 2;

      const bgA = cov(roundedRectSdf(dx, dy, D / 2, radius));
      const rgb: [number, number, number] = mix(BG_TOP, BG_BOT, clamp01(dy / D));
      const alpha = bgA;

      // Ambient bloom (screen blend so it lightens the near-black, not muddies it).
      const gd = Math.hypot(ux - D / 2, uy - D / 2) - GLOW_R;
      const glowA = Math.pow(clamp01(-gd / GLOW_R), 2.1) * 0.3;
      screen(rgb, CORE_MID, glowA);

      // Orbital ring.
      const [rx, ry] = rotate(ux, uy);
      const ringD = Math.abs(ellipseSdf(rx, ry, RING_RX, RING_RY)) - RING_W / 2;
      const ringA = cov(ringD);
      if (ringA > 0) screen(rgb, accent(clamp01((ux + uy) / (2 * D))), ringA * 0.85);

      // Nodes ride the ring, so they are tested in the rotated frame.
      for (const n of NODES) {
        const [nx, ny] = rotate(n.x, n.y);
        const a = cov(Math.hypot(rx - nx, ry - ny) - n.r);
        if (a > 0) screen(rgb, n.c, a);
      }

      // The core.
      const coreA = cov(Math.hypot(ux - D / 2, uy - D / 2) - CORE_R);
      if (coreA > 0) {
        const t = clamp01(((ux - D / 2) + (uy - D / 2) + 2 * CORE_R) / (4 * CORE_R));
        const c = accent(t);
        rgb[0] = rgb[0] * (1 - coreA) + c[0] * coreA;
        rgb[1] = rgb[1] * (1 - coreA) + c[1] * coreA;
        rgb[2] = rgb[2] * (1 - coreA) + c[2] * coreA;
      }

      const o = (y * size + x) * 4;
      px[o] = Math.round(rgb[0]);
      px[o + 1] = Math.round(rgb[1]);
      px[o + 2] = Math.round(rgb[2]);
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// --- Minimal PNG encoder (stdlib only) ----------------------------------------
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(px: Uint8Array, size: number): Uint8Array {
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size); // filter byte 0 per scanline
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

// --- Write the set the manifest and the stores need --------------------------
const targets: Array<{ file: string; size: number; maskable?: boolean }> = [
  { file: "public/icons/icon-192.png", size: 192 },
  { file: "public/icons/icon-512.png", size: 512 },
  { file: "public/icons/maskable-512.png", size: 512, maskable: true },
  { file: "public/icons/apple-touch-icon.png", size: 180 },
];

for (const t of targets) {
  const out = resolve(process.cwd(), t.file);
  mkdirSync(dirname(out), { recursive: true });
  const png = encodePng(render(t.size, { maskable: t.maskable }), t.size);
  writeFileSync(out, png);
  console.log(`✓ ${t.file} — ${t.size}×${t.size}, ${(png.length / 1024).toFixed(1)} KB`);
}
console.log("\nBrand icons written. Nothing was added to the browser bundle — this");
console.log("script is a build-time tool, not an import.");
