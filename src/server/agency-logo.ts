/**
 * Item 12 (S1, "Signed — item 12 logo plan v3") — agency logo helpers. Pure:
 * strict base64 decode, type sniffed from magic bytes only (PNG / JPEG /
 * WebP; SVG, GIF, HTML and everything else refused), dimensions parsed from
 * the image header (each side 1..256 px), and the revision id.
 *
 * The bytes never live in app-state/main: they go to a revision-addressed
 * doc agencyLogos/{agencyId}__{rev} in the same Firestore database, and the
 * agency record carries only the short logoRev (server.ts routes).
 */

import crypto from 'crypto';

export const LOGO_MAX_BYTES = 102400;
export const LOGO_MAX_SIDE = 256;
export const LOGO_REV_RE = /^[0-9a-f]{12}-[0-9a-f]{6}$/;

export type LogoMime = 'image/png' | 'image/jpeg' | 'image/webp';

export type DecodedLogo = { bytes: Buffer; mime: LogoMime; width: number; height: number };

export const LOGO_ERRORS = {
  type: 'Use a PNG, JPEG or WebP image.',
  size: 'The image must be 100 KB or smaller.',
  dims: 'The image must be 256 × 256 pixels or smaller.',
  unreadable: 'That image could not be read. Try another file.',
} as const;

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict base64 (standard alphabet, padded, no data: prefix, no whitespace). */
export function strictBase64(input: unknown): Buffer | null {
  if (typeof input !== 'string' || input.length === 0 || input.length % 4 !== 0) return null;
  if (!B64_RE.test(input)) return null;
  const buf = Buffer.from(input, 'base64');
  // Round-trip guard: what we decoded must re-encode to exactly the input.
  if (buf.toString('base64') !== input) return null;
  return buf;
}

export function sniffLogoMime(b: Buffer): LogoMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function pngSize(b: Buffer): { width: number; height: number } | null {
  // Signature (8) + IHDR length (4) + 'IHDR' (4) + width (4) + height (4)
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    // Fill bytes
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Frame tag (3) then start code 9D 01 2A, then 14-bit width/height
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width: w, height: h };
  }
  return null;
}

export function logoDimensions(b: Buffer, mime: LogoMime): { width: number; height: number } | null {
  const d = mime === 'image/png' ? pngSize(b) : mime === 'image/jpeg' ? jpegSize(b) : webpSize(b);
  if (!d || !Number.isInteger(d.width) || !Number.isInteger(d.height)) return null;
  return d;
}

/** Validates an upload. Returns the decoded logo or a plain error sentence. */
export function decodeLogo(input: unknown): { ok: true; logo: DecodedLogo } | { ok: false; error: string } {
  const bytes = strictBase64(input);
  if (!bytes) return { ok: false, error: LOGO_ERRORS.unreadable };
  if (bytes.length < 1 || bytes.length > LOGO_MAX_BYTES) return { ok: false, error: LOGO_ERRORS.size };
  const mime = sniffLogoMime(bytes);
  if (!mime) return { ok: false, error: LOGO_ERRORS.type };
  const d = logoDimensions(bytes, mime);
  if (!d) return { ok: false, error: LOGO_ERRORS.unreadable };
  if (d.width < 1 || d.height < 1 || d.width > LOGO_MAX_SIDE || d.height > LOGO_MAX_SIDE) return { ok: false, error: LOGO_ERRORS.dims };
  return { ok: true, logo: { bytes, mime, width: d.width, height: d.height } };
}

/** First 12 hex of sha256(bytes) + '-' + 6 random hex: unique per upload. */
export function newLogoRev(bytes: Buffer): string {
  return `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function logoDocId(agencyId: string, rev: string): string {
  return `${agencyId}__${rev}`;
}

/** Cleanup rule (plan v3): delete only a doc that is not the current rev AND older than the grace. */
export const LOGO_CLEANUP_GRACE_MS = 15 * 60 * 1000;
export const LOGO_INFLIGHT_MAX_MS = 120 * 1000;
export function logoDocDeletable(doc: { rev?: string; createdAt?: string }, currentRev: string | null | undefined, nowMs: number, graceMs = LOGO_CLEANUP_GRACE_MS): boolean {
  if (!doc || typeof doc.rev !== 'string') return false;
  if (currentRev && doc.rev === currentRev) return false;
  const t = Date.parse(String(doc.createdAt || ''));
  if (!Number.isFinite(t)) return false;
  return nowMs - t > graceMs;
}
