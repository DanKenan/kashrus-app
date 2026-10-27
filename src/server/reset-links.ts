import crypto from 'node:crypto';
import { venueScope, type VenueLite } from './venue-scope.ts';

// ---------------------------------------------------------------------------
// Item 10L (design v3, [10L-DS3] agreed; Don 2026-10-22: no admin-to-admin
// links, coordinators for their own venues' people): reset links. Pure
// helpers; the routes live in server.ts. Tokens: 32 random bytes
// (base64url); only the sha256 is stored. The credential stamp ties a link to
// the password that existed when it was made ([DS1 B3]).
// ---------------------------------------------------------------------------

export const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_LINK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_LINK_CEILING = 1000;
export const RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Roles a reset link can be made for (never an admin). 'worker' is the legacy name of mashgiach. */
export const RESET_LINK_TARGET_ROLES = ['coordinator', 'mashgiach', 'owner', 'manager', 'worker'] as const;
/** Roles a coordinator may make a link for (never an admin or another coordinator). */
export const RESET_LINK_COORDINATOR_TARGET_ROLES = ['mashgiach', 'owner', 'manager', 'worker'] as const;

export const RESET_LINK_INVALID_TEXT = 'This link has expired or was already used.';

export function hashResetToken(raw: string): string {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

export function newResetToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashResetToken(raw) };
}

/** Constant-time compare of a stored link hash with sha256(raw). */
export function resetTokenMatches(storedHash: unknown, raw: unknown): boolean {
  if (typeof storedHash !== 'string' || typeof raw !== 'string' || !raw) return false;
  const a = Buffer.from(storedHash, 'utf8');
  const b = Buffer.from(hashResetToken(raw), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The record whose stored hash matches sha256(raw), or null. */
export function resetLinkForToken(list: readonly any[], raw: string): any | null {
  if (!RESET_TOKEN_RE.test(String(raw || ''))) return null;
  const h = hashResetToken(raw);
  const cand = (Array.isArray(list) ? list : []).find((l: any) => l && l.resetTokenHash === h);
  return cand && resetTokenMatches(cand.resetTokenHash, raw) ? cand : null;
}

/**
 * [DS1 B3] sha256(credentialOwnerId + ':' + the owner row's stored password
 * hash). null when there is no stored password (a link is refused then).
 */
export function credentialStampHash(credentialOwnerId: unknown, storedPassword: unknown): string | null {
  if (typeof credentialOwnerId !== 'string' || !credentialOwnerId) return null;
  if (typeof storedPassword !== 'string' || !storedPassword) return null;
  return crypto.createHash('sha256').update(`${credentialOwnerId}:${storedPassword}`, 'utf8').digest('hex');
}

/** Constant-time compare of two stamps (hex strings). */
export function stampsEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);

export function isLiveResetLink(link: any, nowMs: number): boolean {
  return !!link && link.status === 'pending' && ms(link.expiresAt) > nowMs;
}

/** What an admin sees: never the hash, the stamp or the email. */
export function resetLinkAdminView(link: any): { id: string; memberId: string; createdBy: string; createdAt: string; expiresAt: string } {
  return {
    id: String(link?.id || ''), memberId: String(link?.memberId || ''), createdBy: String(link?.createdBy || ''),
    createdAt: String(link?.createdAt || ''), expiresAt: String(link?.expiresAt || ''),
  };
}

/** The moment a non-live record made its last transition (NaN when unknown). */
function lastTransitionMs(link: any): number {
  if (!link || typeof link !== 'object') return NaN;
  if (link.status === 'used') return ms(link.usedAt);
  if (link.status === 'revoked') return ms(link.revokedAt);
  if (link.status === 'pending') return ms(link.expiresAt);
  return NaN;
}

/**
 * [DS1 N4] Retention: a non-live record is dropped 7 days after its last
 * transition. Live records and records with a malformed timestamp are kept
 * (the ceiling below bounds them).
 */
export function pruneResetLinks(list: any[], nowMs: number): any[] {
  return (Array.isArray(list) ? list : []).filter((l) => {
    if (!l || typeof l !== 'object' || typeof l.id !== 'string') return false;
    if (isLiveResetLink(l, nowMs)) return true;
    const at = lastTransitionMs(l);
    if (!Number.isFinite(at)) return true;
    return nowMs - at < RESET_LINK_RETENTION_MS;
  });
}

/**
 * [DS1 N4] Make room for ONE new record under the ceiling: drop the oldest
 * NON-live records first (live links are never dropped). ok:false when the
 * list is still full of live links (the create answers 503).
 */
export function makeRoomForResetLink(list: any[], nowMs: number, ceiling: number = RESET_LINK_CEILING): { ok: boolean; list: any[] } {
  let out = pruneResetLinks(list, nowMs);
  if (out.length < ceiling) return { ok: true, list: out };
  const nonLive = out
    .filter((l) => !isLiveResetLink(l, nowMs))
    .map((l) => ({ l, at: lastTransitionMs(l) }))
    .sort((a, b) => (Number.isFinite(a.at) ? a.at : -Infinity) - (Number.isFinite(b.at) ? b.at : -Infinity));
  const drop = new Set<any>();
  for (const { l } of nonLive) {
    if (out.length - drop.size < ceiling) break;
    drop.add(l);
  }
  out = out.filter((l) => !drop.has(l));
  return out.length < ceiling ? { ok: true, list: out } : { ok: false, list: out };
}

const agencyOf = (x: any): string => (x && typeof x.agencyId === 'string' && x.agencyId) || 'agency-hkc';

/** Venues of the person that EXIST now in `agencyId` (home + venueAccess, via venueScope). */
function existingVenuesOf(row: any, venues: readonly VenueLite[], agencyId: string): string[] {
  const s = venueScope(row, venues);
  if (s === 'agency') return [];
  return s.filter((id) => (venues || []).some((v) => v && v.id === id && agencyOf(v) === agencyId));
}

/**
 * P1 ([DS1 B2], [DS1 N1]; Don 2026-10-22): who may make a reset link for whom.
 * - Never for an admin, a primary admin or the platform operator, whoever asks.
 * - An admin: any coordinator / mashgiach / owner / manager of their own agency.
 * - A coordinator: a mashgiach / owner / manager of their own agency whose existing
 *   venues meet the coordinator's own existing venues (rule T, same data).
 *   A dangling venue id, another agency's venue or no venue grants nothing.
 * - Everyone else: never. Fail closed on anything missing.
 */
export function mayMakeResetLink(caller: any, target: any, venues: readonly VenueLite[], opts: { platformOperatorId?: string } = {}): boolean {
  if (!caller || !target || typeof caller.id !== 'string' || typeof target.id !== 'string') return false;
  if (caller.id === target.id) return false;
  const agencyId = agencyOf(caller);
  if (agencyOf(target) !== agencyId) return false;
  if (typeof target.role !== 'string' || !(RESET_LINK_TARGET_ROLES as readonly string[]).includes(target.role)) return false;
  if (target.isPrimaryAdmin === true) return false;
  if (opts.platformOperatorId && target.id === opts.platformOperatorId) return false;
  if (caller.role === 'admin') return true;
  if (caller.role !== 'coordinator') return false;
  if (!(RESET_LINK_COORDINATOR_TARGET_ROLES as readonly string[]).includes(target.role)) return false;
  const mine = existingVenuesOf(caller, venues, agencyId);
  if (!mine.length) return false;
  const theirs = existingVenuesOf(target, venues, agencyId);
  return theirs.some((v) => mine.includes(v));
}

/** The pause record a used link writes on another agency's row ([DS1 B5]). */
export function resetSuspensionRecord(link: any): { linkId: string; at: string; byAgencyId: string } {
  return { linkId: String(link.id), at: String(link.usedAt), byAgencyId: String(link.agencyId) };
}
