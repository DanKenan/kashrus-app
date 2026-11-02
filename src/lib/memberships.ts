// 10g client: a person with several agencies (memberships) under one login.
// The server (#105) answers sign-in with { chooseMembership, token, memberships }
// when the email has more than one agency; GET /api/auth/memberships lists them
// and POST /api/auth/activate opens one. Both take either that short "choose"
// token or the normal session token.
//
// These calls use plain fetch, never apiFetch: a 401/403 here means "can't list
// or open that agency", and must not sign out a session that is already working.
// 11a-c: a null token means this device's own sign-in: the cookie when the
// device is on it (sessionAuthHeaders), else nothing to send.

import { deviceCredentialKeyFor, hasSessionCredential, noticeSiteRefusalFor, sessionAuthHeaders } from './api';

export interface Membership {
  membershipId: string;
  agencyId: string;
  agencyName: string;
  role: string;
  isCurrent?: boolean;
}

export const MEMBERSHIP_ERROR_TEXT = "That agency can't be opened right now. Please sign in again.";
export const MEMBERSHIP_NETWORK_TEXT = 'No connection. Please try again.';

export function cleanMemberships(raw: unknown): Membership[] {
  if (!Array.isArray(raw)) return [];
  const out: Membership[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const membershipId = typeof r.membershipId === 'string' ? r.membershipId : '';
    if (!membershipId || seen.has(membershipId)) continue;
    seen.add(membershipId);
    out.push({
      membershipId,
      agencyId: typeof r.agencyId === 'string' ? r.agencyId : '',
      agencyName: typeof r.agencyName === 'string' && r.agencyName.trim() ? r.agencyName : 'Agency',
      role: typeof r.role === 'string' ? r.role : '',
      ...(r.isCurrent === true ? { isCurrent: true } : {}),
    });
  }
  return out;
}

/** The sign-in answer for an email with several agencies. */
export function isChooseAnswer(data: any): data is { chooseMembership: true; token: string; memberships: unknown[] } {
  return !!data && data.chooseMembership === true && typeof data.token === 'string' && !!data.token && Array.isArray(data.memberships);
}

/** Lists the person's agencies. null = can't tell (signed out, kiosk, offline). */
export async function fetchMemberships(token: string | null): Promise<Membership[] | null> {
  if (!hasSessionCredential(token)) return null;
  try {
    const sentKey = deviceCredentialKeyFor(token);
    const res = await fetch('/api/auth/memberships', {
      headers: sessionAuthHeaders(token),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    // Domains PR B: refused on this address -> the screen.
    if (!res.ok) { await noticeSiteRefusalFor(res, sentKey); return null; }
    const data = await res.json().catch(() => null);
    return data ? cleanMemberships(data.memberships) : null;
  } catch {
    return null;
  }
}

export interface ActivateResult { ok: boolean; token?: string; user?: any; error?: string }

/** Opens one agency. On success the caller stores the token and signs in with the user. */
export async function activateMembership(token: string | null, membershipId: string): Promise<ActivateResult> {
  if (!hasSessionCredential(token) || !membershipId) return { ok: false, error: MEMBERSHIP_ERROR_TEXT };
  try {
    // A choose token is not this device's sign-in (screen only); a session token is.
    const sentKey = deviceCredentialKeyFor(token);
    const res = await fetch('/api/auth/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessionAuthHeaders(token) },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ membershipId }),
    });
    if (!res.ok) await noticeSiteRefusalFor(res, sentKey);
    const data = await res.json().catch(() => ({} as any));
    if (res.ok && data && typeof data.token === 'string' && data.token && data.user) {
      return { ok: true, token: data.token, user: data.user };
    }
    return { ok: false, error: typeof data?.error === 'string' && data.error ? data.error : MEMBERSHIP_ERROR_TEXT };
  } catch {
    return { ok: false, error: MEMBERSHIP_NETWORK_TEXT };
  }
}
