/**
 * Item 11, PR 11b-s (plan v8 11b-s + 9.4 / 9.5 / 10.3 / 10.7 / 10.8 / 11.2):
 * passkey (Face ID / fingerprint / phone screen lock) records and the pure
 * rules around them. Don decision A (Oct 25): every credential origin may enroll after a fresh proof.
 * No I/O here; server.ts does the reads, the transactions
 * and the WebAuthn verification (@simplewebauthn/server).
 *
 * Storage (server-only collections, never inside app-state/main or users[]):
 *  - personCredentials/{personId}: the person's passkeys (max 10), an opaque
 *    per-person user handle, credVersion (bumped on every removal) and
 *    recentAuthEpoch (bumped on removal: every "recent sign-in proof" of the
 *    person ends).
 *  - passkeyIndex/{sha256(credentialId)}: credentialId -> personId, written
 *    create-only at registration; a removed credential leaves a tombstone so
 *    the same credentialId can never be registered again.
 *  - webauthnChallenges/{challengeId}: one ceremony (register | login),
 *    single use, 120 s.
 */
import crypto from 'node:crypto';

export const PASSKEYS_MAX = 10;
export const CHALLENGE_TTL_MS = 120 * 1000;
/** Plan 9.5: a password re-entry or a passkey assertion on THIS session counts for 5 minutes. */
export const RECENT_AUTH_MS = 5 * 60 * 1000;
export const PASSKEY_NAME_MAX = 40;
/** A WebAuthn credential id as base64url (1..1023 bytes -> at most 1364 characters). */
export const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{16,1364}$/;
export const CHALLENGE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export type PasskeyEntry = {
  credentialId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports: string[];
  aaguid: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  createdBySid: string | null;
  /** Domains PR A (2d): the RP ID it was made for (server-written from the challenge). Absent on older entries. */
  rpId?: string;
};

export type PersonCredentialsDoc = {
  personId: string;
  /** 32 random bytes (base64url); the WebAuthn user.id. Never the person id or the email. Immutable. */
  passkeyUserHandle: string;
  credVersion: number;
  recentAuthEpoch: number;
  passkeys: PasskeyEntry[];
  updatedAt: string;
};

export type PasskeyIndexDoc = {
  credentialIdHash: string;
  personId: string;
  createdAt: string;
  /** Set when the passkey was removed: the id stays taken forever. */
  removedAt: string | null;
};

export type ChallengePurpose = 'register' | 'login';
export type ChallengeDoc = {
  id: string;
  challenge: string;
  purpose: ChallengePurpose;
  rpId: string;
  origin: string;
  /** register only: the person, membership row and session that asked. */
  personId: string | null;
  rowId: string | null;
  sid: string | null;
  createdAtMs: number;
  expMs: number;
  consumedAt: string | null;
};

export type PasskeyAuthMethod = { type: 'passkey'; personId: string; credentialId: string };

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function credentialIdHash(credentialId: string): string {
  return crypto.createHash('sha256').update(`shutfey/passkey-index/v1|${credentialId}`).digest('base64url');
}

export function newPersonCredentials(personId: string, nowIso: string): PersonCredentialsDoc {
  return { personId, passkeyUserHandle: b64url(crypto.randomBytes(32)), credVersion: 0, recentAuthEpoch: 0, passkeys: [], updatedAt: nowIso };
}

/** Reads a stored personCredentials doc; anything malformed is null (fail closed). */
export function asPersonCredentials(x: unknown, personId: string): PersonCredentialsDoc | null {
  if (!x || typeof x !== 'object') return null;
  const d = x as Partial<PersonCredentialsDoc>;
  if (d.personId !== personId || typeof d.passkeyUserHandle !== 'string' || !d.passkeyUserHandle) return null;
  if (!Number.isInteger(d.credVersion) || !Number.isInteger(d.recentAuthEpoch) || !Array.isArray(d.passkeys)) return null;
  return d as PersonCredentialsDoc;
}

export function findPasskey(doc: PersonCredentialsDoc | null, credentialId: string): PasskeyEntry | null {
  if (!doc) return null;
  return doc.passkeys.find((p) => p && p.credentialId === credentialId) || null;
}

/** Plan 9.5: the session's recent proof is valid for 5 minutes and only while the person's recentAuthEpoch has not moved. */
export function recentAuthValid(session: { recentAuthAtMs?: unknown; recentAuthEpoch?: unknown } | null | undefined, personEpoch: number, nowMs: number): boolean {
  if (!session) return false;
  const at = session.recentAuthAtMs;
  if (typeof at !== 'number' || !Number.isFinite(at) || at > nowMs || nowMs - at >= RECENT_AUTH_MS) return false;
  return session.recentAuthEpoch === personEpoch;
}

/**
 * FACEID2: the proof a choose token carries from the sign-in that issued it
 * (password or Face ID), as the chosen session's recentAuth: copied unchanged
 * (never restarted) while it is inside its 5 minutes, else none. The epoch is
 * the person's at sign-in; recentAuthValid compares it with the CURRENT one at
 * every use, so a passkey removed meanwhile ends it.
 */
export function chosenRecentAuth(recentAuth: unknown, nowMs: number): { atMs: number; epoch: number } | undefined {
  if (!recentAuth || typeof recentAuth !== 'object') return undefined;
  const { atMs, epoch } = recentAuth as { atMs?: unknown; epoch?: unknown };
  if (typeof atMs !== 'number' || typeof epoch !== 'number') return undefined;
  if (!Number.isSafeInteger(atMs) || atMs < 0 || !Number.isSafeInteger(epoch) || epoch < 0) return undefined;
  if (atMs > nowMs || nowMs - atMs >= RECENT_AUTH_MS) return undefined;
  return { atMs, epoch };
}

/** A passkey's display name: trimmed, control characters removed, at most 40 characters; empty -> the fallback. */
export function cleanPasskeyName(x: unknown, fallback: string): string {
  const s = typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, PASSKEY_NAME_MAX).trim() : '';
  return s || fallback;
}

/** A plain default name from the User-Agent ("iPhone", "Android phone", ...). Never the raw string. */
export function defaultPasskeyName(userAgent: unknown): string {
  const ua = String(userAgent || '');
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  return 'Phone or computer';
}

/** What the person's own list shows: never the key, the counter, the handle or the creating session. */
export function publicPasskey(p: PasskeyEntry): { id: string; name: string; createdAt: string; lastUsedAt: string | null } {
  return { id: p.credentialId, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt };
}

/** Is the stored challenge usable for this request right now? (exists, unconsumed, unexpired, same purpose, rp, origin and - for register - person, row and session) */
export function challengeMatches(
  doc: unknown,
  want: { id: string; purpose: ChallengePurpose; origin: string; personId?: string | null; rowId?: string | null; sid?: string | null },
  nowMs: number
): doc is ChallengeDoc {
  if (!doc || typeof doc !== 'object') return false;
  const c = doc as Partial<ChallengeDoc>;
  if (c.id !== want.id || c.purpose !== want.purpose || c.consumedAt) return false;
  if (typeof c.challenge !== 'string' || !c.challenge || typeof c.rpId !== 'string' || !c.rpId) return false;
  if (c.origin !== want.origin) return false;
  if (typeof c.expMs !== 'number' || !Number.isFinite(c.expMs) || nowMs >= c.expMs) return false;
  if (want.purpose === 'register') {
    if (!want.personId || c.personId !== want.personId) return false;
    if (!want.rowId || c.rowId !== want.rowId) return false;
    if (!want.sid || c.sid !== want.sid) return false;
  }
  return true;
}

/**
 * Plan 9.4 / N6: a counter that is non-zero must move forward; a passkey that
 * always reports 0 (synced passkeys) is accepted.
 */
export function counterAcceptable(stored: number, received: number): boolean {
  if (!Number.isInteger(stored) || !Number.isInteger(received) || stored < 0 || received < 0) return false;
  if (stored === 0 && received === 0) return true;
  return received > stored;
}

export function isPasskeyAuthMethod(x: unknown): x is PasskeyAuthMethod {
  if (!x || typeof x !== 'object') return false;
  const a = x as Partial<PasskeyAuthMethod>;
  return a.type === 'passkey' && typeof a.personId === 'string' && !!a.personId && typeof a.credentialId === 'string' && CREDENTIAL_ID_RE.test(a.credentialId);
}
