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
 * Anything else → null (401 / WS 4401).
 *
 * resolveSessionRow() is the ONE row lookup for HTTP and WS:
 *  - v2 → row.id === mem AND row.personId === sub AND (row.tokenEpoch||0) === ep
 *  - v1 → row.id === sub AND (row.tokenEpoch||0) === 0 (a bumped epoch kills
 *    legacy tokens too)
 *  - kiosk → row.id === sub (the caller then runs kioskSessionStillValid).
 */

export type SessionClaims =
  | { kind: 'v1'; userId: string }
  | { kind: 'v2'; userId: string; personId: string; ep: number }
  | { kind: 'kiosk'; userId: string; agencyId?: string; venueId?: string; pv?: string; dev?: string };

const KIOSK_CLAIMS = ['kiosk', 'agencyId', 'venueId', 'pv', 'dev'];
const V2_CLAIMS = ['v', 'mem', 'ep'];
const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

export function classifySessionClaims(data: any): SessionClaims | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
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
    };
  }
  if (KIOSK_CLAIMS.some((k) => has(data, k))) return null;
  if (has(data, 'v')) {
    if (data.v !== 2) return null;
    if (!nonEmpty(data.sub) || !nonEmpty(data.mem)) return null;
    if (typeof data.ep !== 'number' || !Number.isInteger(data.ep) || data.ep < 0) return null;
    return { kind: 'v2', userId: data.mem, personId: data.sub, ep: data.ep };
  }
  if (has(data, 'mem') || has(data, 'ep')) return null;
  if (!nonEmpty(data.sub)) return null;
  return { kind: 'v1', userId: data.sub };
}

/** A row's epoch: absent → 0; a non-negative integer → itself; anything
 * else (string, negative, fractional, NaN) → null, and the row's tokens are
 * refused (fail closed; never silently treated as 0). */
export function tokenEpochOf(row: { tokenEpoch?: unknown }): number | null {
  const e = (row as any).tokenEpoch;
  if (e === undefined || e === null) return 0;
  return typeof e === 'number' && Number.isInteger(e) && e >= 0 ? e : null;
}

export function resolveSessionRow<T extends { id: string; personId?: string; tokenEpoch?: unknown }>(
  claims: SessionClaims | null,
  users: readonly T[]
): T | undefined {
  if (!claims) return undefined;
  const row = users.find((u) => u && u.id === claims.userId);
  if (!row) return undefined;
  if (claims.kind === 'kiosk') return row;
  const epoch = tokenEpochOf(row);
  if (epoch === null) return undefined;
  if (claims.kind === 'v1') return epoch === 0 ? row : undefined;
  return row.personId === claims.personId && epoch === claims.ep ? row : undefined;
}

/** v2 for any row with a personId (10e: membership rows too); otherwise the legacy v1 claims. */
export function sessionClaimsFor(row: { id: string; personId?: string; tokenEpoch?: unknown }): Record<string, unknown> {
  // An invalid stored epoch issues ep 0, which resolveSessionRow then refuses.
  const epoch = tokenEpochOf(row) ?? 0;
  // 10e: every row that carries a personId gets v2 — the person's first row
  // (personId === id) as since 8d, and a further membership row (personId
  // !== id, created only through newMembership) too: after an E1 bump its
  // epoch is > 0, which a v1 token can never match. Rows without personId
  // (legacy) keep v1.
  if (typeof row.personId === 'string' && row.personId) return { v: 2, sub: row.personId, mem: row.id, ep: epoch };
  return { sub: row.id };
}
