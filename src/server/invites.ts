import crypto from 'node:crypto';

/**
 * Item 10 (plan v4 D1): who may link / hold recovery codes. ONE helper:
 * acceptance (10i c), recovery-code issuance at first multi (C5, 10i) and
 * POST /api/auth/recovery-codes (10f) all call it.
 *
 * 'self-registered' and 'invite-new' are evidence of CREDENTIAL CONTROL (the
 * person chose the password with no admin knowing it), not of email
 * ownership (D3). 'admin', 'agency-reset', absent (legacy) and anything else
 * are never linkable and can never obtain or replace recovery codes.
 */
export function credentialMayLink(origin: unknown): boolean {
  return origin === 'self-registered' || origin === 'invite-new';
}

// ---------------------------------------------------------------------------
// Item 10h: invites (create / list / revoke). Pure helpers; the routes live in
// server.ts. Tokens: 32 random bytes (base64url), only the sha256 is stored.
// ---------------------------------------------------------------------------

export const INVITE_ROLES = ['admin', 'coordinator', 'mashgiach'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const INVITE_MAX_VENUES = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashInviteToken(raw: string): string {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

export function newInviteToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashInviteToken(raw) };
}

/** Per-agency Phase C flag (C4). Server-only; only exactly `enabled === true` counts. */
export function phaseCEnabled(agency: any): boolean {
  return !!agency && typeof agency === 'object' && !!agency.phaseC && agency.phaseC.enabled === true;
}

export function normalizeInviteEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export type InviteInput = { email: string; role: InviteRole; venueIds: string[] };

/**
 * Validates a create body against the caller's agency venue ids. One generic
 * error per field class; a venue id of another agency gets the same answer as
 * an unknown id (no existence oracle).
 */
export function parseInviteInput(body: any, agencyVenueIds: readonly string[]): { ok: true; value: InviteInput } | { ok: false; error: string; code: string } {
  const email = normalizeInviteEmail(body?.email);
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.', code: 'INVITE_EMAIL_INVALID' };
  const role = body?.role;
  if (typeof role !== 'string' || !(INVITE_ROLES as readonly string[]).includes(role)) return { ok: false, error: 'Choose a valid role.', code: 'INVITE_ROLE_INVALID' };
  const rawVenues = body?.venueIds;
  const venueError = { ok: false as const, error: 'Choose venues from your own agency.', code: 'INVITE_VENUES_INVALID' };
  if (role === 'admin') {
    if (rawVenues !== undefined && rawVenues !== null && !(Array.isArray(rawVenues) && rawVenues.length === 0)) return venueError;
    return { ok: true, value: { email, role, venueIds: [] } };
  }
  if (!Array.isArray(rawVenues) || rawVenues.length === 0 || rawVenues.length > INVITE_MAX_VENUES) return venueError;
  const allowed = new Set(agencyVenueIds);
  const out: string[] = [];
  for (const v of rawVenues) {
    if (typeof v !== 'string' || !allowed.has(v)) return venueError;
    if (!out.includes(v)) out.push(v);
  }
  return { ok: true, value: { email, role: role as InviteRole, venueIds: out } };
}

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);

export function isLiveInvite(inv: any, nowMs: number): boolean {
  return !!inv && inv.status === 'pending' && ms(inv.expiresAt) > nowMs;
}

/** What GET returns: never the hash, never internals. */
export function inviteListView(inv: any): { id: string; email: string; role: string; venueIds: string[]; invitedBy: string; createdAt: string; expiresAt: string } {
  return {
    id: String(inv.id), email: String(inv.email), role: String(inv.role),
    venueIds: Array.isArray(inv.venueIds) ? inv.venueIds.map(String) : [],
    invitedBy: String(inv.invitedBy || ''), createdAt: String(inv.createdAt || ''), expiresAt: String(inv.expiresAt || ''),
  };
}

/**
 * Retention (design v2 N2): a record that is not live is dropped 30 days after
 * its LAST status transition (revokedAt / expiresAt / acceptedAt). Live
 * records and records with a missing or malformed timestamp are kept.
 */
export function pruneInvites(list: any[], nowMs: number): any[] {
  return (Array.isArray(list) ? list : []).filter((inv) => {
    if (!inv || typeof inv !== 'object') return false;
    if (isLiveInvite(inv, nowMs)) return true;
    const at = inv.status === 'revoked' ? ms(inv.revokedAt)
      : inv.status === 'accepted' ? ms(inv.acceptedAt)
      : inv.status === 'pending' ? ms(inv.expiresAt)
      : NaN;
    if (!Number.isFinite(at)) return true;
    return nowMs - at < INVITE_RETENTION_MS;
  });
}
