/**
 * Item 11, PR 11a-s1 (plan v8 sections 9.1, 10.1, 10.2, 15.1): server-side
 * sessions. A session token now carries a claim `sid`, and such a token is
 * valid ONLY while sessions/{sid} exists, is not revoked, is inside its
 * 30-day absoluteExp, and matches the token (row, person, epoch) - on top of
 * every item 8d / 10 check that already runs (row exists, membership
 * eligible, epoch equal, agency exists).
 *
 * A token WITHOUT sid (issued before this release) keeps today's rules
 * unchanged (the Bearer transition path, 9.6), so no phone is signed out by
 * the deploy.
 *
 * Pure helpers only (no Firestore, no Express): server.ts owns the store,
 * the cache and the routes. stage4 imports this file under plain node, so
 * imports use .ts specifiers (checklist CU).
 */

/** Plan 15.1 (Don): a phone/browser session lives 30 days from sign-in, hard. No idle limit, no refresh. */
export const USER_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** Plan 10.1: a cached session entry older than this is re-read from the store before a GET is served. */
export const SESSION_CACHE_FRESH_MS = 15 * 1000;
/** Upper bound on cached entries (oldest dropped first; a dropped entry is simply re-read). */
export const SESSION_CACHE_MAX = 20000;

/** 128-bit random, base64url without padding: exactly 22 characters. */
export const SESSION_SID_RE = /^[A-Za-z0-9_-]{22}$/;

export function isSid(x: unknown): x is string {
  return typeof x === 'string' && SESSION_SID_RE.test(x);
}

/** Labels of the routes that create a session (bookkeeping only; never an authorization input). */
export const SESSION_VIA = [
  'login',
  'register',
  'register-existing',
  'invite-accept',
  'setup-accept',
  'reset-link',
  'reset-password',
  'change-password',
  'activate',
  'account-merge',
  'recover',
  /** 11a-s2: a pre-11 Bearer token moved to the cookie (its record ends no later than that token). */
  'adopt',
  /** 11a-s3: a kiosk PIN sign-in on a paired tablet (kind 'kiosk'). */
  'kiosk-login',
  /** 11a-s3: a kiosk token from before 11a-s3 moved to the kiosk cookie (its record ends no later than that token). */
  'kiosk-adopt',
  'test',
] as const;
export type SessionVia = (typeof SESSION_VIA)[number];

/** Plan 15.1 (Don): a kiosk session lives 3 hours from the PIN sign-in, hard. Never refreshed. */
export const KIOSK_SESSION_TTL_MS = 3 * 3600 * 1000;

export type SessionDoc = {
  sid: string;
  /** 'kiosk' (11a-s3): a tablet session; it also carries the kiosk fields below. */
  kind: 'user' | 'kiosk';
  /** The person (v2 tokens); null for a legacy row without personId (v1 tokens). */
  personId: string | null;
  /** The membership row the token acts as (claims.userId). */
  rowId: string;
  agencyId: string | null;
  /** The row's tokenEpoch when the session was made (equal to the token's ep). */
  epochAtIssue: number;
  via: SessionVia;
  createdAt: string;
  createdAtMs: number;
  /** createdAtMs + USER_SESSION_TTL_MS; never moved (plan 15.1, N1). */
  absoluteExpMs: number;
  /** First 60 characters of the User-Agent, for the person's own session list later. */
  userAgentHint: string;
  revokedAt: string | null;
  revokeReason: string | null;
  /** 11a-s3, kind 'kiosk' only: the tablet (kiosk device id), its venue and the PIN revision the token carries (pv). */
  kioskDeviceId?: string;
  venueId?: string;
  pvAtIssue?: string;
};

/** The claim shapes a session can back (see session-token.ts SessionClaims). */
export type SessionBackedClaims =
  | { kind: 'v1'; userId: string; sid?: string }
  | { kind: 'v2'; userId: string; personId: string; ep: number; sid?: string }
  | { kind: 'kiosk'; userId: string; agencyId?: string; venueId?: string; pv?: string; dev?: string; sid?: string };

export function buildUserSession(input: {
  sid: string;
  row: { id: string; personId?: unknown; agencyId?: unknown };
  epoch: number;
  via: SessionVia;
  userAgent?: unknown;
  nowMs: number;
  /** 11a-s2 adopt: the record never outlives this moment (the adopted token's own expiry). */
  capExpMs?: number;
}): SessionDoc {
  const { sid, row, epoch, via, nowMs } = input;
  if (!isSid(sid)) throw new Error('buildUserSession: bad sid');
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('buildUserSession: bad epoch');
  const personId = typeof row.personId === 'string' && row.personId ? row.personId : null;
  let absoluteExpMs = nowMs + USER_SESSION_TTL_MS;
  if (input.capExpMs !== undefined) {
    if (typeof input.capExpMs !== 'number' || !Number.isFinite(input.capExpMs) || input.capExpMs <= nowMs) throw new Error('buildUserSession: bad cap');
    absoluteExpMs = Math.min(absoluteExpMs, input.capExpMs);
  }
  return {
    sid,
    kind: 'user',
    personId,
    rowId: String(row.id),
    agencyId: typeof row.agencyId === 'string' && row.agencyId ? row.agencyId : null,
    epochAtIssue: epoch,
    via,
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs,
    absoluteExpMs,
    userAgentHint: String(input.userAgent ?? '').slice(0, 60),
    revokedAt: null,
    revokeReason: null,
  };
}

/**
 * 11a-s3 (plan 9.1, 15.1): the record of a kiosk PIN sign-in. absoluteExpMs =
 * createdAt + 3 h, never moved; capExpMs (kiosk adopt) only shortens it.
 */
export function buildKioskSession(input: {
  sid: string;
  row: { id: string; personId?: unknown };
  epoch: number;
  agencyId: string;
  venueId: string;
  deviceId: string;
  pv: string;
  via: SessionVia;
  userAgent?: unknown;
  nowMs: number;
  capExpMs?: number;
}): SessionDoc {
  const { sid, row, epoch, nowMs } = input;
  if (!isSid(sid)) throw new Error('buildKioskSession: bad sid');
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('buildKioskSession: bad epoch');
  for (const k of ['agencyId', 'venueId', 'deviceId', 'pv'] as const) {
    if (typeof input[k] !== 'string' || !input[k]) throw new Error(`buildKioskSession: bad ${k}`);
  }
  let absoluteExpMs = nowMs + KIOSK_SESSION_TTL_MS;
  if (input.capExpMs !== undefined) {
    if (typeof input.capExpMs !== 'number' || !Number.isFinite(input.capExpMs) || input.capExpMs <= nowMs) throw new Error('buildKioskSession: bad cap');
    absoluteExpMs = Math.min(absoluteExpMs, input.capExpMs);
  }
  return {
    sid,
    kind: 'kiosk',
    personId: typeof row.personId === 'string' && row.personId ? row.personId : null,
    rowId: String(row.id),
    agencyId: input.agencyId,
    epochAtIssue: epoch,
    via: input.via,
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs,
    absoluteExpMs,
    userAgentHint: String(input.userAgent ?? '').slice(0, 60),
    revokedAt: null,
    revokeReason: null,
    kioskDeviceId: input.deviceId,
    venueId: input.venueId,
    pvAtIssue: input.pv,
  };
}

/**
 * The one rule: does this stored session back these claims right now?
 * Fails closed on anything missing or malformed.
 */
export function sessionBacksClaims(doc: unknown, claims: SessionBackedClaims | null | undefined, nowMs: number): boolean {
  if (!doc || typeof doc !== 'object' || !claims) return false;
  const d = doc as Partial<SessionDoc>;
  if (!isSid(claims.sid) || d.sid !== claims.sid) return false;
  if (d.rowId !== claims.userId) return false;
  if (claims.kind === 'kiosk') {
    // 11a-s3: a kiosk record backs only a kiosk token of the same row, agency,
    // venue, tablet and PIN revision (each present on both sides).
    if (d.kind !== 'kiosk') return false;
    for (const [rec, tok] of [[d.agencyId, claims.agencyId], [d.venueId, claims.venueId], [d.kioskDeviceId, claims.dev], [d.pvAtIssue, claims.pv]] as const) {
      if (typeof rec !== 'string' || !rec || rec !== tok) return false;
    }
  } else if (d.kind !== 'user') {
    return false;
  } else if (claims.kind === 'v2') {
    if (d.personId !== claims.personId) return false;
    if (d.epochAtIssue !== claims.ep) return false;
  } else if (claims.kind === 'v1') {
    if (d.personId !== null) return false;
    if (d.epochAtIssue !== 0) return false;
  } else {
    return false;
  }
  if (d.revokedAt) return false;
  if (typeof d.absoluteExpMs !== 'number' || !Number.isFinite(d.absoluteExpMs) || nowMs >= d.absoluteExpMs) return false;
  return true;
}

export type SessionCacheEntry = { doc: SessionDoc | null; readAtMs: number };

/** Insertion-ordered map with a size cap: put() moves the key to the newest end. */
export function cachePut(cache: Map<string, SessionCacheEntry>, sid: string, entry: SessionCacheEntry, max: number = SESSION_CACHE_MAX): void {
  cache.delete(sid);
  cache.set(sid, entry);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** A cached entry is used without a store read only while it is fresher than SESSION_CACHE_FRESH_MS. */
export function cacheFresh(entry: SessionCacheEntry | undefined, nowMs: number): entry is SessionCacheEntry {
  return !!entry && nowMs - entry.readAtMs < SESSION_CACHE_FRESH_MS && entry.readAtMs <= nowMs;
}
