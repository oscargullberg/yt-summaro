import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dir, "..", "extension", "icons");
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function insideRounded(x, y, left, top, right, bottom, radius) {
  const nx = clamp(x, left + radius, right - radius);
  const ny = clamp(y, top + radius, bottom - radius);
  return (x - nx) ** 2 + (y - ny) ** 2 <= radius ** 2;
}

function insideRobot(x, y) {
  const face = insideRounded(x, y, 0.235, 0.295, 0.765, 0.770, 0.092);
  const antenna = insideRounded(x, y, 0.464, 0.207, 0.536, 0.374, 0.036);
  const ears = insideRounded(Math.min(x, 1 - x), y, 0.121, 0.452, 0.198, 0.662, 0.024);
  const eye = (Math.abs(x - 0.5) - 0.105) ** 2 + (y - 0.531) ** 2 <= 0.056 ** 2;
  return (face || antenna || ears) && !eye;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / SAMPLES;
  const weight = 1 / (SAMPLES * SAMPLES);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = (x + (sx + 0.5) * step) / size;
          const py = (y + (sy + 0.5) * step) / size;
          if (!insideRounded(px, py, 0.025, 0.12, 0.975, 0.88, 0.21)) continue;

          const t = clamp((py - 0.12) / 0.76, 0, 1);
          const red = lerp(230, 187, t);
          const white = insideRobot(px, py);
          const cr = white ? 255 : red;
          const cg = white ? 255 : 15;
          const cb = white ? 255 : 29;

          r += cr * weight;
          g += cg * weight;
          b += cb * weight;
          a += weight;
        }
      }

      const offset = (y * size + x) * 4;
      if (a > 0) {
        rgba[offset] = Math.round(r / a);
        rgba[offset + 1] = Math.round(g / a);
        rgba[offset + 2] = Math.round(b / a);
        rgba[offset + 3] = Math.round(a * 255);
      }
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
