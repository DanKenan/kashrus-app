// 10L client (server PR #118): reset-password links.
// An admin (any non-admin member of their agency) or a coordinator (mashgiach /
// owner / worker at a venue they coordinate) makes a one-time link that works
// for 24 hours. Making it changes nothing on the person's account; the person
// opens /reset#t=<token> and chooses a new password. The link is shown once,
// right after it is made, and never stored by the app.

import { apiFetch, apiWrite, versionFromResponse } from './api';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The token from a reset link's hash ("#t=<43 chars>"), or null. */
export function readResetToken(hash: string | null | undefined): string | null {
  const h = String(hash || '').replace(/^#/, '');
  const t = new URLSearchParams(h).get('t') || '';
  return TOKEN_RE.test(t) ? t : null;
}

export function isResetPath(pathname: string | null | undefined): boolean {
  return String(pathname || '').replace(/\/+$/, '') === '/reset';
}

/** The full link to send, from the server's "/reset#t=…" path; null if it is not one. */
export function fullResetLink(path: unknown, origin?: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/reset#t=') || !readResetToken(path.slice('/reset'.length))) return null;
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}${path}`;
}

type Member = { id: string; role?: string; isPrimaryAdmin?: boolean; venueId?: string; venueIds?: string[] };

const venuesOf = (u: Member): string[] => {
  const ids = Array.isArray(u.venueIds) ? u.venueIds.filter((x) => typeof x === 'string') : [];
  if (u.venueId && !ids.includes(u.venueId)) ids.push(u.venueId);
  return ids;
};

/**
 * Who sees "Reset password link" on a member row — the server rule (mayMakeResetLink)
 * as far as the client can see it; the server decides. Never yourself, an admin or the
 * primary admin. Admin: any coordinator / mashgiach / owner / worker. Coordinator:
 * a mashgiach / owner / worker who shares one of the coordinator's venues.
 */
export function canMakeResetLink(caller: Member | null | undefined, target: Member | null | undefined): boolean {
  if (!caller || !target || caller.id === target.id) return false;
  if (target.isPrimaryAdmin === true) return false;
  const role = target.role || '';
  if (!['coordinator', 'mashgiach', 'owner', 'worker'].includes(role)) return false;
  if (caller.role === 'admin') return true;
  if (caller.role !== 'coordinator') return false;
  if (!['mashgiach', 'owner', 'worker'].includes(role)) return false;
  const mine = venuesOf(caller);
  return venuesOf(target).some((v) => mine.includes(v));
}

export interface MakeResetLinkResult { ok: boolean; link?: string; expiresAt?: string | null; message?: string }

export const RESET_FALLBACK_TEXT = "Couldn't make the reset link. Please try again.";
export const RESET_LINK_MISSING_TEXT = 'The reset link was made, but its link is missing. Please try again.';

async function freshVersion(): Promise<number | undefined> {
  try {
    const res = await apiFetch('/api/users');
    return res.ok ? versionFromResponse(res) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST /api/users/:id/reset-link (requireVersion). The link is harmless until it is
 * used (the person's password and sessions stay as they are), so a version conflict
 * is retried once on a fresh version without asking again. The server's own words
 * on any refusal (403 not allowed, 409 not available for this person).
 */
export async function makeResetLink(userId: string): Promise<MakeResetLinkResult> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const expectedVersion = await freshVersion();
      const r = await apiWrite(`/api/users/${encodeURIComponent(userId)}/reset-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        expectedVersion,
      });
      if (r.ok) {
        const link = fullResetLink(r.data?.link);
        if (!link) return { ok: false, message: RESET_LINK_MISSING_TEXT };
        return { ok: true, link, expiresAt: typeof r.data?.resetLink?.expiresAt === 'string' ? r.data.resetLink.expiresAt : null };
      }
      if (r.code === 'VERSION_CONFLICT' && attempt === 0) continue;
      const t = r.data && typeof r.data.error === 'string' ? r.data.error.trim() : '';
      return { ok: false, message: t || (r.error || '').trim() || RESET_FALLBACK_TEXT };
    }
    return { ok: false, message: RESET_FALLBACK_TEXT };
  } catch {
    return { ok: false, message: RESET_FALLBACK_TEXT };
  }
}


export interface ResetRequest { memberId: string; name: string; requestedAt: string; linkLive: boolean }

/** GET /api/agency/reset-requests: who asked for a reset in the last 24 h (admin / coordinator). [] on any failure. */
export async function loadResetRequests(): Promise<ResetRequest[]> {
  try {
    const res = await apiFetch('/api/agency/reset-requests', { cache: 'no-store' });
    if (!res.ok) return [];
    const d = await res.json().catch(() => null);
    const list = Array.isArray(d?.requests) ? d.requests : [];
    return list
      .filter((r: any) => r && typeof r.memberId === 'string' && r.memberId && typeof r.requestedAt === 'string')
      .map((r: any) => ({ memberId: r.memberId, name: typeof r.name === 'string' ? r.name : '', requestedAt: r.requestedAt, linkLive: r.linkLive === true }));
  } catch {
    return [];
  }
}

export const CONFIRM_FALLBACK_TEXT = "Couldn't confirm. Please try again.";

/** POST /api/users/:id/confirm-reset (admin): un-pause a membership paused by another agency's reset link. */
export async function confirmPausedMember(userId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const expectedVersion = await freshVersion();
      const r = await apiWrite(`/api/users/${encodeURIComponent(userId)}/confirm-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        expectedVersion,
      });
      if (r.ok) return { ok: true };
      if (r.code === 'VERSION_CONFLICT' && attempt === 0) continue;
      const t = r.data && typeof r.data.error === 'string' ? r.data.error.trim() : '';
      return { ok: false, message: t || (r.error || '').trim() || CONFIRM_FALLBACK_TEXT };
    }
    return { ok: false, message: CONFIRM_FALLBACK_TEXT };
  } catch {
    return { ok: false, message: CONFIRM_FALLBACK_TEXT };
  }
}

// ---- The public /reset page (no session header is ever sent) ----

export const RESET_INVALID_TEXT = 'This link has expired or was already used.';
export const RESET_TRY_AGAIN_TEXT = "Couldn't reach the server. Please try again.";

export type ResetPreview =
  | { state: 'ok'; firstName: string; agencyName: string; expiresAt: string | null }
  | { state: 'invalid' }
  | { state: 'error'; message: string };

export async function previewResetLink(token: string, fetcher: typeof fetch = fetch): Promise<ResetPreview> {
  try {
    const res = await fetcher('/api/reset-links/preview', { method: 'GET', headers: { 'X-Reset-Token': token }, cache: 'no-store', credentials: 'omit' });
    if (res.status === 404) return { state: 'invalid' };
    const d: any = await res.json().catch(() => null);
    if (res.ok && d) {
      return { state: 'ok', firstName: typeof d.firstName === 'string' ? d.firstName : '', agencyName: typeof d.agencyName === 'string' ? d.agencyName : '', expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : null };
    }
    return { state: 'error', message: (d && typeof d.error === 'string' && d.error.trim()) || RESET_TRY_AGAIN_TEXT };
  } catch {
    return { state: 'error', message: RESET_TRY_AGAIN_TEXT };
  }
}

export type ResetAccept =
  | { state: 'ok'; user: any; token: string }
  | { state: 'invalid' }
  /** The password changed, but this membership cannot sign in (paused / venue removed): the server's words. */
  | { state: 'changed-no-session'; message: string }
  | { state: 'error'; message: string; code?: string };

export async function acceptResetLink(token: string, newPassword: string, fetcher: typeof fetch = fetch): Promise<ResetAccept> {
  try {
    const res = await fetcher('/api/reset-links/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reset-Token': token },
      body: JSON.stringify({ newPassword }),
      cache: 'no-store',
      credentials: 'omit',
    });
    const d: any = await res.json().catch(() => null);
    if (res.ok && d && d.user && typeof d.token === 'string' && d.token) return { state: 'ok', user: d.user, token: d.token };
    if (res.status === 404) return { state: 'invalid' };
    const msg = (d && typeof d.error === 'string' && d.error.trim()) || '';
    if (d && d.passwordChanged === true) return { state: 'changed-no-session', message: msg || 'Your password was changed, but you cannot sign in here right now. Ask your agency admin.' };
    if (res.ok) return { state: 'error', message: RESET_TRY_AGAIN_TEXT };
    return { state: 'error', message: msg || RESET_TRY_AGAIN_TEXT, code: d && typeof d.code === 'string' ? d.code : undefined };
  } catch {
    return { state: 'error', message: RESET_TRY_AGAIN_TEXT };
  }
}
