// Generates a minimal PNG app icon without any dependencies:
// a dark rounded square with a terminal-style ">" prompt and cursor.
// Usage: node scripts/make-icon.mjs [size] > icon.png  (or pass out path)
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SIZE = Number(process.argv[2] || 1024);
const OUT = process.argv[3] || "src-tauri/icons/icon.png";

// CRC32 (PNG chunks)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

const BG = [13, 17, 23]; // #0d1117
const FG = [88, 230, 217]; // #58e6d9 teal
const CURSOR = [230, 237, 243]; // near-white

const px = new Uint8Array(SIZE * SIZE * 4);

const distSeg = (px_, py, x1, y1, x2, y2) => {
  const dx = x2 - x1,
    dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px_ - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const qx = x1 + t * dx,
    qy = y1 + t * dy;
  return Math.hypot(px_ - qx, py - qy);
};

const s = SIZE;
const cx0 = 0.22 * s,
  cyT = 0.26 * s,
  cMidX = 0.62 * s,
  cyM = 0.5 * s,
  cyB = 0.74 * s;
const thick = 0.055 * s;
const curX0 = 0.68 * s,
  curY0 = 0.66 * s,
  curX1 = 0.9 * s,
  curY1 = 0.8 * s;
const r = 0.18 * s; // corner radius

for (let y = 0; y < s; y++) {
  for (let x = 0; x < s; x++) {
    // rounded-rect mask
    const inX = x >= r && x < s - r ? 0 : Math.min(Math.abs(x - r), Math.abs(x - (s - r - 1)));
    const inY = y >= r && y < s - r ? 0 : Math.min(Math.abs(y - r), Math.abs(y - (s - r - 1)));
    const outside =
      Math.hypot(Math.max(0, r - inX - 0), Math.max(0, r - inY)) > r &&
      (x < r || x >= s - r) &&
      (y < r || y >= s - r);
    const i = (y * s + x) * 4;
    let col = BG;
    let a = 255;
    if (outside) {
      a = 0;
    } else {
      const d1 = distSeg(x, y, cx0, cyT, cMidX, cyM);
      const d2 = distSeg(x, y, cMidX, cyM, cx0, cyB);
      if (d1 < thick || d2 < thick) col = FG;
      if (x >= curX0 && x <= curX1 && y >= curY0 && y <= curY1) col = CURSOR;
    }
    px[i] = col[0];
    px[i + 1] = col[1];
    px[i + 2] = col[2];
    px[i + 3] = a;
  }
}

// PNG: signature + IHDR + IDAT + IEND, filter byte 0 per scanline
const raw = Buffer.alloc(s * (s * 4 + 1));
for (let y = 0; y < s; y++) {
  raw[y * (s * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * s * 4, s * 4).copy(raw, y * (s * 4 + 1) + 1);
}
mkdirSync(dirname(OUT), { recursive: true });
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(s, 0);
ihdr.writeUInt32BE(s, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${s}x${s}, ${png.length} bytes)`);
