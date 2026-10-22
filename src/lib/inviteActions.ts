// INVITES CLIENT (design [INVC-DS1]): the two admin actions on the merged
// server routes. #114 (10j): POST /api/agency/invites/enable turns invite links
// ON for the admin's own agency (one-way). #112 (10k): POST /api/users/:id/invite
// revokes a member's admin-set password and returns a setup link.
// Nothing here is stored; the link is shown once by the caller.

import { apiFetch, apiWrite, versionFromResponse } from './api';
import { fullInviteLink } from './invites';

/** ok, or the words to show (message). */
export interface EnableInvitesResult { ok: boolean; message?: string }

export const ENABLE_FALLBACK_TEXT = "Couldn't turn on invites. Please try again.";

/** POST /api/agency/invites/enable with an empty body. The server's own words on any refusal. */
export async function enableInvites(): Promise<EnableInvitesResult> {
  try {
    const r = await apiWrite('/api/agency/invites/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (r.ok) return { ok: true };
    return { ok: false, message: serverText(r.data, r.error) || ENABLE_FALLBACK_TEXT };
  } catch {
    return { ok: false, message: ENABLE_FALLBACK_TEXT };
  }
}

/** ok with the full link, or the words to show (message); flagOff = the server answered 404 (invites are off). */
export interface SendInviteResult { ok: boolean; link?: string; expiresAt?: string | null; message?: string; flagOff?: boolean; conflict?: boolean }

export const SEND_FALLBACK_TEXT = "Couldn't make the invite. Please try again.";
export const SEND_LINK_MISSING_TEXT = 'The invite was made, but its link is missing. Please try again.';
export const INVITES_OFF_TEXT = 'Invites are off for your agency.';

export const SEND_CHANGED_TEXT = 'Their details changed since you opened this. Check them and confirm again.';

/**
 * POST /api/users/:id/invite (requireVersion). `expectedVersion` is the version of
 * the response the reviewed record came from (loadMemberForInvite), never the
 * latest one seen at send time. 404 = invites are OFF (or the person is gone);
 * 409 VERSION_CONFLICT = something changed: the caller shows the fresh record again.
 */
export async function sendMemberInvite(userId: string, expectedVersion: number | undefined): Promise<SendInviteResult> {
  try {
    const r = await apiWrite(`/api/users/${encodeURIComponent(userId)}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      expectedVersion,
    });
    if (r.ok) {
      const link = fullInviteLink(r.data?.link);
      if (!link) return { ok: false, message: SEND_LINK_MISSING_TEXT };
      return { ok: true, link, expiresAt: typeof r.data?.invite?.expiresAt === 'string' ? r.data.invite.expiresAt : null };
    }
    if (r.status === 404) return { ok: false, message: INVITES_OFF_TEXT, flagOff: true };
    if (r.code === 'VERSION_CONFLICT') return { ok: false, message: SEND_CHANGED_TEXT, conflict: true };
    return { ok: false, message: serverText(r.data, r.error) || SEND_FALLBACK_TEXT };
  } catch {
    return { ok: false, message: SEND_FALLBACK_TEXT };
  }
}

function serverText(data: any, friendly: string | null): string {
  const t = data && typeof data.error === 'string' ? data.error.trim() : '';
  return t || (friendly || '').trim();
}

export const LOAD_FAILED_TEXT = "Couldn't load their details. Please try again.";
export const MEMBER_GONE_TEXT = 'This person is no longer on the team.';

export interface MemberForInvite { ok: boolean; user?: any; version?: number; message?: string; gone?: boolean }

/**
 * [INVC-DS3] B1: the record the admin reviews and ITS version come from one
 * response — a fresh GET /api/users (admin view, with invitePending/needsInvite)
 * and that response's X-State-Version — never from the global last-known version.
 */
export async function loadMemberForInvite(userId: string): Promise<MemberForInvite> {
  try {
    const res = await apiFetch('/api/users');
    if (!res.ok) return { ok: false, message: LOAD_FAILED_TEXT };
    const version = versionFromResponse(res);
    const data: any = await res.json().catch(() => null);
    if (version === undefined || !data || !Array.isArray(data.users)) return { ok: false, message: LOAD_FAILED_TEXT };
    const user = data.users.find((u: any) => u && u.id === userId);
    if (!user) return { ok: false, message: MEMBER_GONE_TEXT, gone: true };
    return { ok: true, user, version };
  } catch {
    return { ok: false, message: LOAD_FAILED_TEXT };
  }
}

/** The fields the admin reviews in the Send invite confirm; a change in any of them means "confirm again". */
export function reviewedFields(u: { id: string; name?: string; email?: string; role?: string; venueId?: string; invitePending?: boolean; needsInvite?: boolean }): string {
  return JSON.stringify([u.id, u.name || '', u.email || '', u.role || '', u.venueId || '', u.invitePending === true, u.needsInvite === true]);
}

/** The status chip for a member row, from the admin-only booleans on GET /api/users. */
export function inviteChip(u: { invitePending?: boolean; needsInvite?: boolean }): string | null {
  if (u.invitePending === true) return 'Invite sent';
  if (u.needsInvite === true) return "Can't sign in — send an invite";
  return null;
}
