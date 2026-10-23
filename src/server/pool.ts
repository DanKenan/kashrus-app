/**
 * Item 12, 12b-s (plan v6 4.4, 5.5-5.7): Pool contacts (people with no
 * account yet) and in-agency duplicate checks. Pure helpers; server.ts passes
 * the fresh document and the clock.
 *
 * Contacts live in the state document as poolContacts: [{ id, agencyId, name,
 * email?, phone?, note?, status: 'details' | 'invited', inviteId?, createdBy,
 * createdAt, updatedAt }]. Output only through poolContactView (allowlist),
 * only to same-agency admins.
 */
import { isLiveInvite, normalizeInviteEmail, inviteDisplayName } from './invites.ts';

export const POOL_CONTACT_CAP = 100;
export const POOL_NAME_MAX = 80;
export const POOL_NOTE_MAX = 140;
export const POOL_EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PoolContactInput { name: string; email?: string; phone?: string; note?: string }
export type ParseResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; error: string };

const bad = (code: string, error: string): { ok: false; status: number; code: string; error: string } => ({ ok: false, status: 400, code, error });

/**
 * Validate a contact body. `partial` (PATCH): only the keys present change; a
 * key sent as '' or null clears email / phone / note (name can't be cleared).
 */
export function parsePoolContact(
  body: any,
  normalizePhone: (raw: unknown) => { ok: boolean; value?: string },
  partial: boolean,
): ParseResult<Partial<PoolContactInput> & { clear: Array<'email' | 'phone' | 'note'> }> {
  const b = body && typeof body === 'object' ? body : {};
  const out: Partial<PoolContactInput> & { clear: Array<'email' | 'phone' | 'note'> } = { clear: [] };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  if (!partial || has('name')) {
    const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > POOL_NAME_MAX) return bad('POOL_NAME_INVALID', `Enter a name (up to ${POOL_NAME_MAX} characters).`);
    out.name = name;
  }
  if (has('email')) {
    if (b.email === null || (typeof b.email === 'string' && b.email.trim() === '')) out.clear.push('email');
    else {
      const email = typeof b.email === 'string' ? normalizeInviteEmail(b.email) : '';
      if (!email || email.length > POOL_EMAIL_MAX || !EMAIL_RE.test(email)) return bad('POOL_EMAIL_INVALID', 'Enter a valid email address.');
      out.email = email;
    }
  }
  if (has('phone')) {
    if (b.phone === null || (typeof b.phone === 'string' && b.phone.trim() === '')) out.clear.push('phone');
    else {
      const p = normalizePhone(b.phone);
      if (!p.ok || !p.value) return bad('POOL_PHONE_INVALID', "That phone number doesn't look right. Use digits, with + and the country code outside the US.");
      out.phone = p.value;
    }
  }
  if (has('note')) {
    if (b.note === null || (typeof b.note === 'string' && b.note.trim() === '')) out.clear.push('note');
    else {
      const note = typeof b.note === 'string' ? b.note.trim() : '';
      if (!note || note.length > POOL_NOTE_MAX) return bad('POOL_NOTE_INVALID', `Keep the note to ${POOL_NOTE_MAX} characters.`);
      out.note = note;
    }
  }
  return { ok: true, value: out };
}

/** A stored contact is well-formed enough to show / use. */
export function isPoolContact(c: any): boolean {
  return !!c && typeof c === 'object' && typeof c.id === 'string' && !!c.id && typeof c.agencyId === 'string' && !!c.agencyId && typeof c.name === 'string';
}

export function agencyContacts(doc: any, agencyId: string): any[] {
  return (Array.isArray(doc?.poolContacts) ? doc.poolContacts : []).filter((c: any) => isPoolContact(c) && c.agencyId === agencyId);
}

/** The allowlist serializer: the ONLY shape a contact leaves the server in. */
export function poolContactView(c: any, invites: readonly any[], nowMs: number): {
  id: string; name: string; email?: string; phone?: string; note?: string; status: 'details' | 'invited';
  inviteExpired?: boolean; createdAt: string; updatedAt: string;
} {
  const status: 'details' | 'invited' = c.status === 'invited' ? 'invited' : 'details';
  const out: any = { id: String(c.id), name: String(c.name), status, createdAt: String(c.createdAt || ''), updatedAt: String(c.updatedAt || '') };
  if (typeof c.email === 'string' && c.email) out.email = c.email;
  if (typeof c.phone === 'string' && c.phone) out.phone = c.phone;
  if (typeof c.note === 'string' && c.note) out.note = c.note;
  if (status === 'invited') {
    const inv = (Array.isArray(invites) ? invites : []).find((i: any) => i && i.id === c.inviteId && i.agencyId === c.agencyId);
    if (!inv || !isLiveInvite(inv, nowMs)) out.inviteExpired = true;
  }
  return out;
}

/** A live invite with no home venue (a Pool invite) for a non-admin role. */
export function isPoolInvite(inv: any): boolean {
  return !!inv && inv.kind !== 'setup' && String(inv.role) !== 'admin' && Array.isArray(inv.venueIds) && inv.venueIds.length === 0;
}

export type DuplicateHit = { kind: 'member' | 'invite' | 'contact'; displayName: string };

/**
 * 5.7 duplicates, inside ONE agency only (nothing about other agencies is
 * read). EMAIL is hard (rows, live invites, other contacts); PHONE is soft
 * (rows, live invites, other contacts). `self` excludes the contact's own
 * record and its own linked invite.
 */
export function findPoolDuplicates(
  doc: any, agencyId: string, probe: { email?: string; phone?: string },
  self: { contactId?: string; inviteId?: string }, nowMs: number,
): { email: DuplicateHit | null; phone: DuplicateHit | null } {
  const users: any[] = (Array.isArray(doc?.users) ? doc.users : []).filter((u: any) => u && (u.agencyId || 'agency-hkc') === agencyId);
  const invites: any[] = (Array.isArray(doc?.invites) ? doc.invites : []).filter((i: any) => i && i.kind !== 'setup' && i.agencyId === agencyId && isLiveInvite(i, nowMs) && i.id !== self.inviteId);
  const contacts: any[] = agencyContacts(doc, agencyId).filter((c: any) => c.id !== self.contactId);
  const email = probe.email ? normalizeInviteEmail(probe.email) : '';
  const phone = probe.phone || '';
  let emailHit: DuplicateHit | null = null;
  let phoneHit: DuplicateHit | null = null;
  if (email) {
    const u = users.find((x) => normalizeInviteEmail(x.email) === email);
    if (u) emailHit = { kind: 'member', displayName: String(u.name || '') };
    else {
      const i = invites.find((x) => normalizeInviteEmail(x.email) === email);
      if (i) emailHit = { kind: 'invite', displayName: inviteDisplayName(i) };
      else {
        const c = contacts.find((x) => typeof x.email === 'string' && normalizeInviteEmail(x.email) === email);
        if (c) emailHit = { kind: 'contact', displayName: String(c.name) };
      }
    }
  }
  if (phone) {
    const u = users.find((x) => typeof x.phoneNumber === 'string' && x.phoneNumber === phone);
    if (u) phoneHit = { kind: 'member', displayName: String(u.name || '') };
    else {
      const i = invites.find((x) => typeof x.phoneNumber === 'string' && x.phoneNumber === phone);
      if (i) phoneHit = { kind: 'invite', displayName: inviteDisplayName(i) };
      else {
        const c = contacts.find((x) => x.phone === phone);
        if (c) phoneHit = { kind: 'contact', displayName: String(c.name) };
      }
    }
  }
  return { email: emailHit, phone: phoneHit };
}

/**
 * Accept / revoke bookkeeping: remove contacts whose linked invite was
 * accepted (5.6), and set contacts whose linked invite is no longer live back
 * to 'details' is NOT done (an expired invite shows "Invite expired").
 */
export function dropContactsForAcceptedInvites(doc: any): any {
  const list: any[] = Array.isArray(doc?.poolContacts) ? doc.poolContacts : null as any;
  if (!list || !list.length) return doc;
  const accepted = new Set((Array.isArray(doc.invites) ? doc.invites : []).filter((i: any) => i && i.status === 'accepted').map((i: any) => `${i.agencyId}\u0000${i.id}`));
  const kept = list.filter((c: any) => !(c && typeof c.inviteId === 'string' && accepted.has(`${c.agencyId}\u0000${c.inviteId}`)));
  return kept.length === list.length ? doc : { ...doc, poolContacts: kept };
}

/** Revoke the live invite linked to a contact (edit email / delete / re-invite). */
export function revokeLinkedInvite(invites: readonly any[], contact: any, actor: string, nowMs: number, reason: string): { invites: any[]; revoked: string | null } {
  let revoked: string | null = null;
  const nowIso = new Date(nowMs).toISOString();
  const next = (Array.isArray(invites) ? invites : []).map((i: any) => {
    if (i && contact && typeof contact.inviteId === 'string' && i.id === contact.inviteId && i.agencyId === contact.agencyId && isLiveInvite(i, nowMs)) {
      revoked = String(i.id);
      return { ...i, status: 'revoked', revokedAt: nowIso, revokedBy: actor, revokeReason: reason };
    }
    return i;
  });
  return { invites: next, revoked };
}
