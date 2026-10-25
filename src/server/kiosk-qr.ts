/**
 * Kiosk QR sign-in, server part (addendum v2 AGREED, Oct 24 2026; base plan
 * v8 9.7). Pure helpers only (no Express, no Firestore): server.ts owns the
 * store, the routes and the clocks. stage4 imports this file under plain
 * node, so imports use .ts specifiers (checklist CU).
 *
 * The flow (Don, Oct 21; final Oct 24 7:58 PM "Just the mashgiach logged in
 * to his account, can scan QR code. That's it."): a signed-in phone opens the
 * scanned link, the page POSTs the approval, and the tablet opens on that
 * person. NO passkey, NO number, NO separate confirm on this path. What it proves: "this signed-in person approved
 * opening the tablet named <tablet> at <venue>" - never presence.
 *
 * A code lives in kioskQr/{hash} (never app-state/main); only an HMAC of the
 * code is stored. States: live -> approved -> claimed | expired | cancelled |
 * refused. The device's state (generation g, its one current code, the extra
 * code clock, the last kiosk session started on it) lives in
 * kioskQrDevices/{deviceId}. A number step can be added later as one more
 * field on the approved code (no migration: unknown fields are ignored).
 */
import crypto from 'node:crypto';

/** 128-bit random, base64url without padding: exactly 22 characters (C1). */
export const KQR_CODE_RE = /^[A-Za-z0-9_-]{22}$/;
/** C1: a code lives 60 s; the tablet rotates it every 60 s. */
export const KQR_CODE_TTL_MS = 60 * 1000;
/** C2: after approval the tablet has 30 s to claim (claimDeadline = approvedAt + 30 s). */
export const KQR_CLAIM_WINDOW_MS = 30 * 1000;
/** C1: at most one EXTRA new code (Cancel / reload) per 20 s per device. */
export const KQR_EXTRA_CODE_GAP_MS = 20 * 1000;
/** An approval id (C7): 128-bit random, base64url. */
export const KQR_APPROVAL_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** A tablet-session reference for "Sign out" (D2): 128-bit random, base64url. */
export const KQR_REF_RE = /^[A-Za-z0-9_-]{22}$/;
/** The page a QR link points at (/k/ + the code) and everything under /k. */
export const KQR_PAGE_PATH_RE = /^\/k(\/.*)?$/;

export type KqrCodeState = 'live' | 'approved' | 'claimed' | 'expired' | 'cancelled' | 'refused';

export type KqrApproval = {
  /** Random id the phone polls with (C7); never the code or its hash. */
  id: string;
  personId: string;
  rowId: string;
  /** The approving user session (re-checked at claim, C5). */
  sid: string;
  /** The row's tokenEpoch and kioskPinRev at approval (both must be unchanged at claim). */
  epoch: number;
  pv: string;
};

export type KqrCodeDoc = {
  /** HMAC of the code (the document id); the code itself is never stored. */
  hash: string;
  state: KqrCodeState;
  deviceId: string;
  agencyId: string;
  venueId: string;
  /** The device's secretHash when the code was issued (credential replaced -> dead). */
  deviceSecretHash: string;
  /** The device generation the code belongs to (C2). */
  g: number;
  createdAtMs: number;
  expiresAtMs: number;
  approvedAtMs?: number;
  claimDeadlineMs?: number;
  approval?: KqrApproval;
  claimedAtMs?: number;
  claimedSid?: string;
  endedAtMs?: number;
  endReason?: string;
};

export type KqrDeviceDoc = {
  deviceId: string;
  /** Generation: reload, Cancel and any kiosk sign-in on the tablet bump it (C2). */
  g: number;
  /** The device's one current code (hash), or null. */
  codeHash: string | null;
  /** The code before it (kept so a late scan reads "expired"; deleted at the next rotation unless approved). */
  prevCodeHash: string | null;
  /** The last time an EXTRA code (Cancel / reload) was issued. */
  lastExtraAtMs: number;
  /** The last kiosk session started on this tablet (PIN or QR) and when. */
  lastSid: string | null;
  lastSessionAtMs: number;
};

export function emptyKqrDevice(deviceId: string): KqrDeviceDoc {
  return { deviceId, g: 0, codeHash: null, prevCodeHash: null, lastExtraAtMs: 0, lastSid: null, lastSessionAtMs: 0 };
}

/** A stored device doc, normalized (anything malformed reads as fresh, fail closed for codes). */
export function asKqrDevice(raw: unknown, deviceId: string): KqrDeviceDoc {
  const d: any = raw && typeof raw === 'object' ? raw : {};
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  return {
    deviceId,
    g: Number.isInteger(d.g) && d.g >= 0 ? d.g : 0,
    codeHash: typeof d.codeHash === 'string' && /^[0-9a-f]{64}$/.test(d.codeHash) ? d.codeHash : null,
    prevCodeHash: typeof d.prevCodeHash === 'string' && /^[0-9a-f]{64}$/.test(d.prevCodeHash) ? d.prevCodeHash : null,
    lastExtraAtMs: num(d.lastExtraAtMs),
    lastSid: typeof d.lastSid === 'string' && d.lastSid ? d.lastSid : null,
    lastSessionAtMs: num(d.lastSessionAtMs),
  };
}

export function isKqrCode(x: unknown): x is string {
  return typeof x === 'string' && KQR_CODE_RE.test(x);
}

/** The code-hashing key: HKDF-SHA256 from the server's signing secret (C1). */
export function kqrDeriveKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('shutfey-kioskqr', 'utf8'), Buffer.from('kiosk-qr-code-v1', 'utf8'), 32));
}

/** The stored id of a code: hex HMAC-SHA256(key, code). */
export function kqrHash(key: Buffer, code: string): string {
  return crypto.createHmac('sha256', key).update(code, 'utf8').digest('hex');
}

/** A new random 22-character token (code, approval id, session ref). */
export function kqrRandom(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * B1: the origin the QR link uses. Server config only: the agency's own
 * address (inviteLinkOrigin) when it has one, else the shared Shutfey
 * address. Never the request's Host / X-Forwarded-Host.
 */
export function kqrEmitOrigin(agencySiteOrigin: string | null, sharedOrigin: string): string {
  return agencySiteOrigin || sharedOrigin;
}

export function kqrLink(origin: string, code: string): string {
  if (!isKqrCode(code)) throw new Error('kqrLink: bad code');
  return `${origin}/k/${code}`;
}

/** What the tablet's poll sees, from its code and device docs at nowMs (no writes). */
export type KqrPollView =
  | { kind: 'none' }
  | { kind: 'live' }
  | { kind: 'expired' }
  | { kind: 'approved' }
  | { kind: 'approved-late' }
  | { kind: 'claimed' }
  | { kind: 'dead' };

export function kqrView(code: KqrCodeDoc | null, dev: KqrDeviceDoc, deviceId: string, nowMs: number): KqrPollView {
  if (!code || !dev.codeHash || code.hash !== dev.codeHash || code.deviceId !== deviceId) return { kind: 'none' };
  if (code.state === 'claimed') return { kind: 'claimed' };
  if (code.g !== dev.g) return { kind: 'dead' };
  if (code.state === 'approved') {
    if (typeof code.claimDeadlineMs === 'number' && nowMs < code.claimDeadlineMs) return { kind: 'approved' };
    return { kind: 'approved-late' };
  }
  if (code.state === 'live') return nowMs < code.expiresAtMs ? { kind: 'live' } : { kind: 'expired' };
  return { kind: 'dead' };
}

/**
 * The answer an approve gets for a code in this state (before the person
 * checks). 'ok' = may be approved now. Exact words live in KQR_TEXT.
 */
export type KqrApproveGate = 'ok' | 'already' | 'expired' | 'unusable';
export function kqrApproveGate(code: KqrCodeDoc | null, dev: KqrDeviceDoc | null, personId: string, nowMs: number): KqrApproveGate {
  if (!code || !dev) return 'unusable';
  if (code.state === 'approved' && code.approval && code.approval.personId === personId && code.g === dev.g && dev.codeHash === code.hash &&
      typeof code.claimDeadlineMs === 'number' && nowMs < code.claimDeadlineMs) return 'already';
  if (code.state !== 'live') return code.state === 'expired' ? 'expired' : 'unusable';
  if (dev.codeHash !== code.hash || dev.g !== code.g) return 'unusable';
  if (nowMs >= code.expiresAtMs) return 'expired';
  return 'ok';
}

/** The person's first name for the tablet greeting ("Hi Yossi – Hill Bakery", B14). */
export function kqrFirstName(name: unknown): string {
  const s = typeof name === 'string' ? name.trim() : '';
  return s ? s.split(/\s+/)[0].slice(0, 40) : '';
}

/** All words in one place (like PASSKEY_TEXT). The client may show its own copy of the same words. */
export const KQR_TEXT = {
  expired: 'This code has expired. Scan the new code on the tablet.',
  unusable: "This code can't be used. Scan the code on the tablet again.",
  already: 'Already approved.',
  notOpened: "The tablet didn't open. Scan again.",
  notHere: (venueName: string) => `You can't sign in on this tablet. Ask your administrator for a code at ${venueName}.`,
  tooMany: 'Too many tries. Wait a minute and scan again.',
  signInFirst: 'Sign in first',
  tabletDidNotFinish: "Signing you in didn't finish. Scan again.",
  notFound: 'Not found.',
} as const;
