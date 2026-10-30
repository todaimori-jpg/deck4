/**
 * Rasterises the app icons without any image dependency: builds the RGBA
 * buffer directly and writes a PNG with a hand-rolled chunk encoder.
 *
 *   ELECTRON_RUN_AS_NODE=1 Qoder.exe tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG = hex('#0d0f12');
const HI = hex('#e8523f');
const LO = hex('#3f9de8');
const LIME = hex('#c3e64b');

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const u = size / 512;
  const bars = [0.5, 0.7, 0.4, 0.78, 0.55, 0.86, 0.46, 0.66, 0.37];
  const radius = 96 * u;
  const inSquircle = (x, y) => {
    const cx = x - radius;
    const cy = y - radius;
    if (cx >= 0 && cx <= size - 2 * radius) return true;
    if (cy >= 0 && cy <= size - 2 * radius) return true;
    const dx = Math.abs(cx - Math.max(0, Math.min(size - 2 * radius, cx)));
    const dy = Math.abs(cy - Math.max(0, Math.min(size - 2 * radius, cy)));
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = BG;
      if (inSquircle(x, y)) {
        const barW = 26 * u;
        const gap = 42 * u;
        const first = 64 * u;
        const idx = Math.floor((x - first) / gap);
        const within = x - first - idx * gap;
        const mid = 256 * u;
        if (idx >= 0 && idx < bars.length && within < barW) {
          const h = bars[idx] * 170 * u;
          if (y >= mid - 6 * u - h && y < mid - 6 * u) c = HI;
          else if (y > mid + 6 * u && y <= mid + 6 * u + h) c = LO;
        }
        if (Math.abs(x - 255 * u) <= 3 * u && y > 60 * u && y < 452 * u) c = LIME;
      }
      const o = (y * size + x) * 4;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 255;
    }
  }
  return png(size, px);
}

mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [192, 512]) {
  const file = join(root, `icons/icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
