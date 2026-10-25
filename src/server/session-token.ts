/**
 * Item 8d: session token classification (pure; no I/O, no secret).
 *
 * server.ts verifies the HS256 signature and exp, then hands the decoded
 * claims here. Exactly one of three shapes is accepted ("8d plan v1"):
 *  - kiosk: kiosk === true. The kiosk path keeps today's validation; a
 *    kiosk token that also carries v, mem or ep is rejected.
 *  - v2:    v === 2, sub and mem non-empty strings, ep a non-negative
 *           integer, and no kiosk claim.
 *  - v1:    legacy { sub, iat, exp }: no v, mem or ep key at all, sub a
 *           non-empty string, and no kiosk claim.
 *  - choose (10g): v === 3, sub and cr non-empty strings, ep a non-negative
 *           integer, no mem and no kiosk claim. Never resolves to a row.
 * Anything else → null (401 / WS 4401).
 *
 * resolveSessionRow() is the ONE row lookup for HTTP and WS:
 *  - v2 → row.id === mem AND row.personId === sub AND (row.tokenEpoch||0) === ep
 *  - v1 → row.id === sub AND (row.tokenEpoch||0) === 0 (a bumped epoch kills
 *    legacy tokens too)
 *  - kiosk → row.id === sub (the caller then runs kioskSessionStillValid).
 */

import { isSid } from './sessions.ts';

export type SessionClaims =
  /** sid (item 11, 11a-s1): present on tokens issued with a server session; such a token
   * is valid only while sessions/{sid} backs it (server.ts). Absent on older tokens. */
  | { kind: 'v1'; userId: string; sid?: string }
  | { kind: 'v2'; userId: string; personId: string; ep: number; sid?: string }
  /** endsAtMs: set by server.ts verifyToken only (the kiosk 3 h cap); never by the classifier. */
  | { kind: 'kiosk'; userId: string; agencyId?: string; venueId?: string; pv?: string; dev?: string; sid?: string; endsAtMs?: number }
  /** 10g: proves a person's credential, grants NO membership (never authUser). */
  | { kind: 'choose'; personId: string; ownerRowId: string; ep: number; passkeyCredentialId?: string; recentAuth?: { atMs: number; epoch: number } };

const KIOSK_CLAIMS = ['kiosk', 'agencyId', 'venueId', 'pv', 'dev'];
const V2_CLAIMS = ['v', 'mem', 'ep'];
const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isProofInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

export function classifySessionClaims(data: any): SessionClaims | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  // 11a-s1: sid is allowed only on session tokens, and only well-formed.
  // 11a-s3: kiosk tokens may carry sid too (the kiosk session record).
  // A choose token carrying sid, or a malformed sid, is no token.
  const hasSid = has(data, 'sid');
  if (hasSid && !isSid(data.sid)) return null;
  const sidPart = hasSid ? { sid: data.sid as string } : {};
  if (data.kiosk === true) {
    if (V2_CLAIMS.some((k) => has(data, k))) return null;
    if (!nonEmpty(data.sub)) return null;
    return {
      kind: 'kiosk',
      userId: data.sub,
      agencyId: typeof data.agencyId === 'string' ? data.agencyId : undefined,
      venueId: typeof data.venueId === 'string' ? data.venueId : undefined,
      pv: typeof data.pv === 'string' ? data.pv : undefined,
      dev: typeof data.dev === 'string' ? data.dev : undefined,
      ...sidPart,
    };
  }
  if (KIOSK_CLAIMS.some((k) => has(data, k))) return null;
  if (has(data, 'v')) {
    if (data.v === 3) {
      // 10g choose token: exactly sub (person), cr (owner row), ep; no mem.
      if (has(data, 'mem') || hasSid) return null;
      if (!nonEmpty(data.sub) || !nonEmpty(data.cr)) return null;
      if (typeof data.ep !== 'number' || !Number.isInteger(data.ep) || data.ep < 0) return null;
      // FACEID2: ra/re = the fresh proof (password or Face ID) of the sign-in that issued this
      // choose token: its moment (ms) and the person's recentAuthEpoch then. Both or neither,
      // non-negative safe integers only; anything else refuses the token.
      let recentAuth: { atMs: number; epoch: number } | undefined;
      if (has(data, 'ra') || has(data, 're')) {
        if (!isProofInt(data.ra) || !isProofInt(data.re)) return null;
        recentAuth = { atMs: data.ra, epoch: data.re };
      }
      const raPart = recentAuth ? { recentAuth } : {};
      // 11b-s: pk = the passkey this choice comes from (the chosen session carries it); optional, well-formed only.
      if (has(data, 'pk')) {
        if (typeof data.pk !== 'string' || !/^[A-Za-z0-9_-]{16,1364}$/.test(data.pk)) return null;
        return { kind: 'choose', personId: data.sub, ownerRowId: data.cr, ep: data.ep, passkeyCredentialId: data.pk, ...raPart };
      }
      return { kind: 'choose', personId: data.sub, ownerRowId: data.cr, ep: data.ep, ...raPart };
    }
    if (data.v !== 2) return null;
    if (!nonEmpty(data.sub) || !nonEmpty(data.mem)) return null;
    if (typeof data.ep !== 'number' || !Number.isInteger(data.ep) || data.ep < 0) return null;
    return { kind: 'v2', userId: data.mem, personId: data.sub, ep: data.ep, ...sidPart };
  }
  if (has(data, 'mem') || has(data, 'ep') || has(data, 'cr')) return null;
  if (!nonEmpty(data.sub)) return null;
  return { kind: 'v1', userId: data.sub, ...sidPart };
}

/** A row's epoch: absent → 0; a non-negative integer → itself; anything
 * else (string, negative, fractional, NaN) → null, and the row's tokens are
 * refused (fail closed; never silently treated as 0). */
export function tokenEpochOf(row: { tokenEpoch?: unknown }): number | null {
  const e = (row as any).tokenEpoch;
  if (e === undefined || e === null) return 0;
  return typeof e === 'number' && Number.isInteger(e) && e >= 0 ? e : null;
}

export function resolveSessionRow<T extends { id: string; personId?: string; tokenEpoch?: unknown; agencyId?: unknown }>(
  claims: SessionClaims | null,
  users: readonly T[],
  agencies?: readonly { id?: unknown }[]
): T | undefined {
  if (!claims) return undefined;
  // 10g: a choose token NEVER resolves to a row (no authUser, no socket).
  if (claims.kind === 'choose') return undefined;
  const row = users.find((u) => u && u.id === claims.userId);
  if (!row) return undefined;
  if (claims.kind === 'kiosk') return row;
  const epoch = tokenEpochOf(row);
  if (epoch === null) return undefined;
  if (claims.kind === 'v1') return epoch === 0 ? row : undefined;
  if (row.personId !== claims.personId || epoch !== claims.ep) return undefined;
  // 10g (matrix): a v2 token's membership must still have its agency.
  if (agencies && typeof row.agencyId === 'string' && row.agencyId && !agencies.some((a) => a && a.id === row.agencyId)) return undefined;
  return row;
}

/** 10g: the person's credential row in `users` (single-row person: its only row; multi: the credentialOwner). */
export function credentialRowOfPerson<T extends { id: string; personId?: string; credentialOwner?: unknown }>(users: readonly T[], personId: string): T | undefined {
  const rows = users.filter((u) => u && u.personId === personId);
  if (rows.length === 1) return rows[0];
  const owners = rows.filter((u) => u.credentialOwner === true);
  return owners.length === 1 ? owners[0] : undefined;
}

/**
 * 10g: a choose token is valid iff row cr exists, cr.personId === sub, cr is
 * the person's credential row NOW and its epoch === ep. So E1 (all rows
 * bumped), E3 (owner moved or removed) and E2 on the owner all kill it.
 */
export function resolveChooseOwner<T extends { id: string; personId?: string; tokenEpoch?: unknown; credentialOwner?: unknown }>(
  claims: SessionClaims | null,
  users: readonly T[]
): T | undefined {
  if (!claims || claims.kind !== 'choose') return undefined;
  const cr = users.find((u) => u && u.id === claims.ownerRowId);
  if (!cr || cr.personId !== claims.personId) return undefined;
  if (credentialRowOfPerson(users, claims.personId)?.id !== cr.id) return undefined;
  const epoch = tokenEpochOf(cr);
  return epoch !== null && epoch === claims.ep ? cr : undefined;
}

/**
 * 10g: the choose claims for a person's credential row (signed with a 10-minute exp by the server).
 * FACEID2: recentAuth = the fresh proof of the sign-in that issues this token (ra/re), carried to
 * the session the person then picks (POST /api/auth/activate copies it, never extends it).
 */
export function chooseClaimsFor(
  ownerRow: { id: string; personId?: string; tokenEpoch?: unknown },
  passkeyCredentialId?: string,
  recentAuth?: { atMs: number; epoch: number },
): Record<string, unknown> {
  const proof = recentAuth && isProofInt(recentAuth.atMs) && isProofInt(recentAuth.epoch) ? { ra: recentAuth.atMs, re: recentAuth.epoch } : {};
  return { v: 3, sub: ownerRow.personId, cr: ownerRow.id, ep: tokenEpochOf(ownerRow) ?? 0, ...(passkeyCredentialId ? { pk: passkeyCredentialId } : {}), ...proof };
}

/** v2 for any row with a personId (10e: membership rows too); otherwise the legacy v1 claims. */
export function sessionClaimsFor(row: { id: string; personId?: string; tokenEpoch?: unknown }, sid?: string): Record<string, unknown> {
  // 11a-s1: sid (when given) binds the token to its server session record.
  if (sid !== undefined && !isSid(sid)) throw new Error('sessionClaimsFor: bad sid');
  const sidPart = sid !== undefined ? { sid } : {};
  // An invalid stored epoch issues ep 0, which resolveSessionRow then refuses.
  const epoch = tokenEpochOf(row) ?? 0;
  // 10e: every row that carries a personId gets v2 — the person's first row
  // (personId === id) as since 8d, and a further membership row (personId
  // !== id, created only through newMembership) too: after an E1 bump its
  // epoch is > 0, which a v1 token can never match. Rows without personId
  // (legacy) keep v1.
  if (typeof row.personId === 'string' && row.personId) return { v: 2, sub: row.personId, mem: row.id, ep: epoch, ...sidPart };
  return { sub: row.id, ...sidPart };
}
