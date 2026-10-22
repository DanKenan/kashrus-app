/**
 * Item 10f (plan v4 B9 / C5 / D4): recovery codes — PURE helpers (no I/O).
 *
 * A set is 10 one-time codes, each 10 Crockford base32 characters (50 bits
 * from crypto.randomBytes), shown to the person ONCE. Only
 * sha256(salt + ':' + code) is stored, on the person's credential (owner)
 * row as recoveryCodeHashes; the salt is random per set. Regeneration
 * replaces the whole set. Matching compares against every stored hash with
 * crypto.timingSafeEqual (no early exit).
 *
 * recoveryFailures on the same row is the per-PERSON failure counter:
 * 5 consecutive failures lock recovery for 1 hour; retries and IP changes do
 * not reset it; success removes it.
 */
import crypto from 'node:crypto';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;
export const RECOVERY_MAX_FAILURES = 5;
export const RECOVERY_LOCK_MS = 60 * 60 * 1000;
/** Crockford base32: digits + letters without I, L, O, U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface RecoveryCodeSet {
  v: 1;
  salt: string;
  hashes: string[];
  createdAt: string;
}
export interface RecoveryFailures {
  count: number;
  lockedUntil: string | null;
}

/** One code: 10 x 5 bits taken from 7 random bytes (56 bits; the top 6 are discarded). */
function oneCode(): string {
  const b = crypto.randomBytes(7);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    out = CROCKFORD_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** Display form XXXXX-XXXXX. */
export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Crockford decoding of user input: case-insensitive, spaces and hyphens
 * ignored, O -> 0, I/L -> 1. Anything else that is not exactly 10 alphabet
 * characters -> null.
 */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of s) if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  return s;
}

export function hashRecoveryCode(salt: string, normalizedCode: string): string {
  return crypto.createHash('sha256').update(`${salt}:${normalizedCode}`).digest('hex');
}

/** A new set: the plaintext codes (to show once) and the stored form. */
export function generateRecoveryCodes(nowIso: string): { codes: string[]; set: RecoveryCodeSet } {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(oneCode());
  const list = [...codes];
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    codes: list.map(formatRecoveryCode),
    set: { v: 1, salt, hashes: list.map((c) => hashRecoveryCode(salt, c)), createdAt: nowIso },
  };
}

export function isRecoveryCodeSet(x: unknown): x is RecoveryCodeSet {
  const s = x as any;
  // RV1 N1: exact salt shape, at most one set's worth of hashes, a real timestamp.
  return !!s && typeof s === 'object' && s.v === 1 && typeof s.salt === 'string' && /^[0-9a-f]{32}$/.test(s.salt) &&
    Array.isArray(s.hashes) && s.hashes.length <= RECOVERY_CODE_COUNT &&
    s.hashes.every((h: unknown) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) &&
    typeof s.createdAt === 'string' && Number.isFinite(Date.parse(s.createdAt));
}

/** Index of the matching stored hash, or -1. Every hash is compared (constant work per set). */
export function matchRecoveryCode(set: unknown, input: unknown): number {
  if (!isRecoveryCodeSet(set)) return -1;
  const code = normalizeRecoveryCode(input);
  const probe = Buffer.from(hashRecoveryCode(set.salt, code ?? '-'.repeat(RECOVERY_CODE_LENGTH)), 'hex');
  let found = -1;
  for (let i = 0; i < set.hashes.length; i++) {
    const eq = crypto.timingSafeEqual(probe, Buffer.from(set.hashes[i], 'hex'));
    if (eq && found === -1 && code !== null) found = i;
  }
  return found;
}

/** The set with one hash removed (the code is burned). */
export function burnRecoveryCode(set: RecoveryCodeSet, index: number): RecoveryCodeSet {
  return { ...set, hashes: set.hashes.filter((_, i) => i !== index) };
}

function asFailures(x: unknown): RecoveryFailures {
  const f = x as any;
  const count = f && Number.isInteger(f.count) && f.count >= 0 ? f.count : 0;
  const lockedUntil = f && typeof f.lockedUntil === 'string' && Number.isFinite(Date.parse(f.lockedUntil)) ? f.lockedUntil : null;
  return { count, lockedUntil };
}

/** Locked now? (an expired lock reads as unlocked). */
export function recoveryLocked(failures: unknown, nowMs: number): boolean {
  const f = asFailures(failures);
  return f.lockedUntil !== null && Date.parse(f.lockedUntil) > nowMs;
}

/** The failure record after one more failure at nowMs (5th consecutive -> locked 1 h, count back to 0). */
export function recordRecoveryFailure(failures: unknown, nowMs: number): RecoveryFailures {
  const f = asFailures(failures);
  const base = f.lockedUntil !== null && Date.parse(f.lockedUntil) <= nowMs ? 0 : f.count; // expired lock: start over
  const count = base + 1;
  if (count >= RECOVERY_MAX_FAILURES) return { count: 0, lockedUntil: new Date(nowMs + RECOVERY_LOCK_MS).toISOString() };
  return { count, lockedUntil: null };
}
