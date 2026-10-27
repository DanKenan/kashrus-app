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

export const INVITE_ROLES = ['admin', 'coordinator', 'mashgiach', 'manager'] as const;
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

/**
 * Phase C (invites) for an agency. Don 2026-10-22 10:36Z ("We don't need the
 * button"): invites are ON for EVERY agency, always. Any agency record counts;
 * a stored `phaseC` value (written by the retired 10j route or older data) is
 * ignored and never written. A missing agency is still false (fail closed).
 */
export function phaseCEnabled(agency: any): boolean {
  return !!agency && typeof agency === 'object';
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
  // 12b-s (RV1 nit): the Pool flag is checked before the admin shape.
  if (body?.pool === true && role !== 'mashgiach') return { ok: false, error: 'Only mashgichim can be invited to the Pool.', code: 'POOL_ROLE_INVALID' };
  if (role === 'admin') {
    if (rawVenues !== undefined && rawVenues !== null && !(Array.isArray(rawVenues) && rawVenues.length === 0)) return venueError;
    return { ok: true, value: { email, role, venueIds: [] } };
  }
  // 12b-s (5.6): "pool": true = a mashgiach invite with NO main venue
  // (venueIds []); accepting it creates a Pool row (noHomeVenue). Without the
  // flag the old shape stays required (old clients unchanged).
  if (body?.pool === true) {
    if (role !== 'mashgiach') return { ok: false, error: 'Only mashgichim can be invited to the Pool.', code: 'POOL_ROLE_INVALID' };
    if (rawVenues !== undefined && rawVenues !== null && !(Array.isArray(rawVenues) && rawVenues.length === 0)) return venueError;
    return { ok: true, value: { email, role: role as InviteRole, venueIds: [] } };
  }
  if (!Array.isArray(rawVenues) || rawVenues.length === 0 || rawVenues.length > INVITE_MAX_VENUES) return venueError;
  const allowed = new Set(agencyVenueIds);
  const out: string[] = [];
  for (const v of rawVenues) {
    if (typeof v !== 'string' || !allowed.has(v)) return venueError;
    if (!out.includes(v)) out.push(v);
  }
  // Manager (Don 2026-10-27, "same style as the owner"): exactly ONE venue,
  // like an owner. A manager is never multi-venue through an invite.
  if (role === 'manager' && out.length !== 1) return { ok: false, error: 'A manager belongs to exactly one venue.', code: 'INVITE_VENUES_INVALID' };
  return { ok: true, value: { email, role: role as InviteRole, venueIds: out } };
}

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);

export function isLiveInvite(inv: any, nowMs: number): boolean {
  return !!inv && inv.status === 'pending' && ms(inv.expiresAt) > nowMs;
}

/** What GET returns: never the hash, never internals. */
export function inviteListView(inv: any): { id: string; kind: string; email: string; name: string; phoneNumber?: string; memberId?: string; role: string; venueIds: string[]; invitedBy: string; createdAt: string; expiresAt: string } {
  return {
    id: String(inv.id), kind: inv.kind === 'setup' ? 'setup' : 'member', email: String(inv.email), name: inviteDisplayName(inv),
    ...(typeof inv.phoneNumber === 'string' && inv.phoneNumber ? { phoneNumber: inv.phoneNumber } : {}),
    ...(inv.kind === 'setup' && typeof inv.memberId === 'string' ? { memberId: inv.memberId } : {}),
    role: String(inv.role),
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

// ---------------------------------------------------------------------------
// Item 10i (design v3, [10I-DS3] agreed; v3.1: no recovery codes): the ONE
// profile parser for every invite-creating path (POST /api/agency/invites,
// POST /api/users when the flag is ON, POST /api/venues owner invites).
// ---------------------------------------------------------------------------
export type MemberPermissions = { canFillTasks: boolean; canAssignTasks: boolean };

/** POST /api/users' role-based permission defaults (shared, W3). */
export function defaultPermissionsFor(role: string, permissions?: any): MemberPermissions {
  return {
    canFillTasks:
      permissions?.canFillTasks !== undefined
        ? Boolean(permissions.canFillTasks)
        : role === 'admin' || role === 'coordinator' || role === 'mashgiach',
    canAssignTasks:
      permissions?.canAssignTasks !== undefined
        ? Boolean(permissions.canAssignTasks)
        : role === 'admin' || role === 'coordinator',
  };
}

export type MemberInviteInput = Omit<InviteInput, 'role'> & { role: InviteRole | 'owner'; name: string; phoneNumber?: string; permissions: MemberPermissions };

/**
 * parseInviteInput + name (required, 1..100), phoneNumber (optional, through
 * the caller's normalizer), permissions (role defaults). Role 'owner' only
 * when the SERVER says so (allowOwner: the venue-owner path); a body can
 * never authorise it.
 */
export function parseMemberInvite(
  body: any,
  agencyVenueIds: readonly string[],
  opts: { allowOwner?: boolean; normalizePhone: (raw: unknown) => { ok: boolean; value?: string }; phoneError: string }
): { ok: true; value: MemberInviteInput } | { ok: false; error: string; code: string } {
  const isOwner = body?.role === 'owner';
  if (isOwner && !opts.allowOwner) return { ok: false, error: 'Choose a valid role.', code: 'INVITE_ROLE_INVALID' };
  if (isOwner && body?.pool === true) return { ok: false, error: 'Only mashgichim can be invited to the Pool.', code: 'POOL_ROLE_INVALID' };
  const base = parseInviteInput(isOwner ? { ...body, role: 'mashgiach' } : body, agencyVenueIds);
  if (base.ok === false) return base;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) return { ok: false, error: 'Enter a name (up to 100 characters).', code: 'INVITE_NAME_INVALID' };
  const phone = opts.normalizePhone(body?.phoneNumber);
  if (!phone.ok) return { ok: false, error: opts.phoneError, code: 'INVITE_PHONE_INVALID' };
  const role = isOwner ? 'owner' : base.value.role;
  return {
    ok: true,
    value: {
      ...base.value, role, name,
      ...(phone.value ? { phoneNumber: phone.value } : {}),
      permissions: defaultPermissionsFor(role, body?.permissions),
    },
  };
}

/** The invitee's display name (records from before 10i carry none: the email's local part). */
export function inviteDisplayName(inv: any): string {
  if (typeof inv?.name === 'string' && inv.name.trim()) return inv.name.trim();
  const e = typeof inv?.email === 'string' ? inv.email : '';
  return e.split('@')[0] || 'Team member';
}

/** Constant-time compare of a stored invite hash with sha256(raw). */
export function inviteHashMatches(storedHash: unknown, raw: unknown): boolean {
  if (typeof storedHash !== 'string' || typeof raw !== 'string' || !raw) return false;
  const a = Buffer.from(storedHash, 'utf8');
  const b = Buffer.from(hashInviteToken(raw), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const INVITE_ACCEPT_FAILED_TEXT = "We couldn't accept the invite with these details. If you already use Shutfey, sign in with that password.";
export const INVITE_LINK_INVALID_TEXT = 'This invite link is not valid anymore.';
export const INVITE_NOT_LINKABLE_TEXT = "This account can't be connected to another agency yet.";
export const INVITE_MAX_FAILED_ATTEMPTS = 5;
