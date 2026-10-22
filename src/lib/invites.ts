// Item 10i (client): invite links (design v3, server PR #108).
//
// Phase C ON for the admin's own agency is read from the server, never
// guessed: GET /api/agency/invites answers 200 when it is ON and 404 when it
// is OFF (it is admin-only, so it is only asked for an admin). Anything else
// (offline, 5xx, 403) is "not known", and the screens keep today's forms.

import { useEffect, useState } from 'react';
import { apiFetch } from './api';

export type InviteFlag = boolean | null;

/** true = Phase C ON, false = OFF, null = not known (treated as OFF by the screens). */
export async function fetchInviteFlag(): Promise<InviteFlag> {
  try {
    const res = await apiFetch('/api/agency/invites');
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The token from an invite link's hash ("#t=<43 chars>"), or null. */
export function readInviteToken(hash: string | null | undefined): string | null {
  const h = String(hash || '').replace(/^#/, '');
  const t = new URLSearchParams(h).get('t') || '';
  return TOKEN_RE.test(t) ? t : null;
}

/** The full link to send, from the server's "/invite#t=…" path; null if it is not one. */
export function fullInviteLink(path: unknown, origin?: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/invite#t=') || !readInviteToken(path.slice('/invite'.length))) return null;
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}${path}`;
}

/** Is this page the invite page? */
export function isInvitePath(pathname: string | null | undefined): boolean {
  return String(pathname || '').replace(/\/+$/, '') === '/invite';
}

/**
 * The flag for the signed-in admin ([10IC-RV1] B1). `adminKey` = user id +
 * agency id (null when not an admin or on a kiosk). Every probe starts from
 * "not known" and applies its own answer, whatever it is (true, false or
 * null), so a stale ON never outlives a failed or OFF answer. The answer is
 * tied to the probe's key: when the admin changes or a form opens (a new key),
 * this returns null in that same render, before the new probe answers.
 */
export function useInviteFlag(adminKey: string | null, teamOpen: boolean, venueOpen: boolean, rev = 0): InviteFlag {
  // `rev` (INVITES CLIENT C1): bumped after "Turn on invites" or a 404 from Send invite, so the flag is asked again.
  const key = adminKey ? `${adminKey}|${teamOpen ? 1 : 0}|${venueOpen ? 1 : 0}|${rev}` : null;
  const [state, setState] = useState<{ key: string | null; flag: InviteFlag }>({ key: null, flag: null });
  useEffect(() => {
    setState({ key, flag: null });
    if (!key) return;
    let active = true;
    void fetchInviteFlag().then((flag) => { if (active) setState({ key, flag }); });
    return () => { active = false; };
  }, [key]);
  return key && state.key === key ? state.flag : null;
}
