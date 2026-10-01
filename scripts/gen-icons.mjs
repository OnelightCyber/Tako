import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

const BASE_TOP = [248, 248, 250];
const BASE_BOTTOM = [201, 204, 214];
const INK = [24, 22, 30];
const SPARK = [255, 255, 255];
const RIM = [0, 0, 0];

const SS = 4;
const DOME = 2.35;
const BASE = 2.9;

function insideBody(x, y, rx, ry) {
  if (y <= 0) return Math.pow(Math.abs(x / rx), DOME) + Math.pow(Math.abs(y / ry), DOME) <= 1;
  const wide = rx * (1 + 0.05 * Math.min(1, y / ry));
  return Math.pow(Math.abs(x / wide), BASE) + Math.pow(Math.abs(y / ry), BASE) <= 1;
}

function insideEllipse(x, y, rx, ry) {
  return (x / rx) ** 2 + (y / ry) ** 2 <= 1;
}

function renderMascot(size) {
  const px = new Uint8Array(size * size * 4);
  const R = size * 0.36;
  const rx = R * 1.02;
  const ry = R * 0.95;
  const cx = size / 2;
  const cy = size / 2 + R * 0.04;
  const rim = R * 0.055;

  const eyeYaw = 0.37;
  const eyePitch = -0.12;
  const cp = Math.cos(eyePitch);
  const ex = Math.sin(eyeYaw) * cp * rx;
  const ey = -Math.sin(eyePitch) * ry;
  const fx = Math.max(0.18, Math.cos(eyeYaw));
  const fy = Math.max(0.18, cp);
  const erx = R * 0.25 * 0.54 * fx;
  const ery = R * 0.27 * 0.52 * fy;
  const sr = R * 0.25 * 0.17 * fx;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bodyHits = 0;
      let rimHits = 0;
      let eyeHits = 0;
      let sparkHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px0 = x + (sx + 0.5) / SS - cx;
          const py0 = y + (sy + 0.5) / SS - cy;
          if (!insideBody(px0, py0, rx + rim, ry + rim)) continue;
          rimHits++;
          if (!insideBody(px0, py0, rx, ry)) continue;
          bodyHits++;
          for (const sd of [-1, 1]) {
            const lx = px0 - sd * ex;
            const ly = py0 - ey;
            if (insideEllipse(lx, ly, erx, ery)) {
              if (insideEllipse(lx + erx * 0.34, ly + ery * 0.4, sr, sr)) sparkHits++;
              else eyeHits++;
            }
          }
        }
      }
      if (rimHits === 0) continue;

      const total = SS * SS;
      const rimA = rimHits / total;
      const bodyA = bodyHits / total;
      const eyeA = eyeHits / total;
      const sparkA = sparkHits / total;

      const t = Math.min(1, Math.max(0, ((x - cx) * -0.6 + (y - cy) * 0.8) / (2 * ry) + 0.5));
      const body = [0, 1, 2].map((i) => BASE_TOP[i] + (BASE_BOTTOM[i] - BASE_TOP[i]) * t);

      let col = RIM.slice();
      if (bodyA > 0) col = col.map((c, i) => c * (1 - bodyA / rimA) + body[i] * (bodyA / rimA));
      if (eyeA > 0) col = col.map((c, i) => c * (1 - eyeA) + INK[i] * eyeA);
      if (sparkA > 0) col = col.map((c, i) => c * (1 - sparkA) + SPARK[i] * sparkA);

      const o = (y * size + x) * 4;
      px[o] = Math.round(col[0]);
      px[o + 1] = Math.round(col[1]);
      px[o + 2] = Math.round(col[2]);
      px[o + 3] = Math.round(Math.min(1, rimA) * 255);
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

mkdirSync(OUT, { recursive: true });

const png = (size) => encodePNG(size, renderMascot(size));

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name} — ${data.length} bytes`);
}

const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })));
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes`);
