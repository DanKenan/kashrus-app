/** Item 12 test fixtures: small real image byte streams (PNG / JPEG headers / WebP) built in code. */
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A valid RGB PNG. noisy = random pixels stored uncompressed (to make a big file). */
export function png(w, h, { noisy = false, seed = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = noisy ? crypto.randomBytes(w * 3) : Buffer.alloc(w * 3, (y * 7 + seed) & 0xff);
    rows.push(Buffer.concat([Buffer.from([0]), row]));
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: noisy ? 0 : 9 });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** JPEG header stream: SOI, APP0 (JFIF), SOF0 with the dimensions, EOI. */
export function jpeg(w, h, { progressive = false } = {}) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, progressive ? 0xc2 : 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function riff(fourcc, data) {
  const len = Buffer.alloc(4); len.writeUInt32LE(data.length);
  const body = Buffer.concat([Buffer.from(fourcc, 'latin1'), len, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const total = Buffer.alloc(4); total.writeUInt32LE(4 + body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), total, Buffer.from('WEBP', 'latin1'), body]);
}
/** Lossless WebP header (VP8L). */
export function webpLossless(w, h) {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  const d = Buffer.alloc(10); d[0] = 0x2f; d.writeUInt32LE(bits >>> 0, 1);
  return riff('VP8L', d);
}
/** Extended WebP header (VP8X). */
export function webpExtended(w, h) {
  const d = Buffer.alloc(10);
  d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', d);
}
/** Lossy WebP header (VP8): frame tag, start code, 14-bit sizes. */
export function webpLossy(w, h) {
  const d = Buffer.alloc(10);
  d[3] = 0x9d; d[4] = 0x01; d[5] = 0x2a; d.writeUInt16LE(w & 0x3fff, 6); d.writeUInt16LE(h & 0x3fff, 8);
  return riff('VP8 ', d);
}

export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
export const GIF = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex');
export const HTML = Buffer.from('<!doctype html><html><body><img src=x onerror=alert(1)></body></html>');
export const b64 = (buf) => Buffer.from(buf).toString('base64');
