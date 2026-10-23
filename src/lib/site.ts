// Domains PR B (client): the site this page was opened on, as the server says
// (GET /api/site, plan 2g/2h). The server decides everything by the raw Host;
// this file only reads its answer for the sign-in page, and never takes the
// Shutfey address from the URL.
import { useEffect, useState } from 'react';

export type SiteAgency = { name: string; brandName: string | null; shortCode: string; logoRev: string | null };
export type SiteInfo =
  | { site: 'shared' }
  | { site: 'agency'; agency: SiteAgency; sharedOrigin: string | null }
  | { site: 'unknown'; sharedOrigin: string | null };
export type SiteRefusalCode = 'WRONG_SITE' | 'SITE_NOT_SET_UP';
export type SiteRefusal = { code: SiteRefusalCode; sharedOrigin: string | null };
/** signedOut: true = this device's sign-in was the one refused and has been cleared; false = a signed-out call was refused. */
export type SiteRefusalEvent = SiteRefusal & { signedOut: boolean };

export const SITE_REFUSED_EVENT = 'shutfey:site-refused';
const SHARED: SiteInfo = { site: 'shared' };

export const SITE_TEXT = {
  signIn: (name: string) => `${name} sign-in`,
  signInPlain: 'Sign in',
  poweredBy: 'Powered by Shutfey',
  wrongSiteTitle: (name: string | null) => (name ? `This address is for ${name} only.` : 'This address is for another agency.'),
  wrongSiteBody: 'Your agency signs in at the Shutfey address.',
  notSetUpTitle: "This address isn't set up yet.",
  notSetUpBody: 'Please use the Shutfey address.',
  goShared: 'Go to the Shutfey address',
  backToSignIn: 'Back to sign-in',
  noLink: 'Please open the Shutfey app the way you usually do.',
  agencyId: 'Agency ID',
};

/** An origin the server named for the Shutfey address: https (or http on loopback in local tests), origin only. */
export function safeSharedOrigin(x: unknown): string | null {
  if (typeof x !== 'string' || x.length > 300) return null;
  try {
    const u = new URL(x);
    if (u.origin !== x) return null;
    if (u.protocol === 'https:') return x;
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return x;
  } catch { /* not a URL */ }
  return null;
}

const str = (x: unknown, max: number): string | null => (typeof x === 'string' && x.trim() && x.length <= max ? x.trim() : null);

/** The /api/site answer -> SiteInfo. Anything unreadable = null (the caller keeps today's page). */
export function parseSiteAnswer(body: unknown): SiteInfo | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  if (b.site === 'shared') return SHARED;
  if (b.site === 'unknown') return { site: 'unknown', sharedOrigin: safeSharedOrigin(b.sharedOrigin) };
  if (b.site === 'agency' && b.agency && typeof b.agency === 'object') {
    const name = str(b.agency.name, 200);
    if (!name) return null;
    return {
      site: 'agency',
      agency: {
        name,
        brandName: str(b.agency.brandName, 200),
        shortCode: str(b.agency.shortCode, 40) || '',
        logoRev: str(b.agency.logoRev, 64),
      },
      sharedOrigin: safeSharedOrigin(b.sharedOrigin),
    };
  }
  return null;
}

/** The name the sign-in page shows: the agency's brand name when it has one, else its name. */
export function siteDisplayName(agency: SiteAgency): string {
  return agency.brandName || agency.name;
}

/**
 * Only a display hint, never a decision: on the Cloud Run addresses and on a
 * local dev host the page opens exactly as before without waiting for
 * /api/site; on any other host the sign-in screens wait for the answer.
 */
export function siteWaitNeeded(hostname: string | undefined = typeof window !== 'undefined' ? window.location.hostname : undefined): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return !(h.endsWith('.run.app') || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1');
}

/** The longest the sign-in screens wait for /api/site before showing today's page. */
export const SITE_WAIT_MAX_MS = 6000;
let current: SiteInfo | null = null;
let loading: Promise<SiteInfo> | null = null;
/** What this page knows about its site right now (null = not answered yet). */
export function currentSite(): SiteInfo | null { return current; }

/** One GET /api/site per page load. Unreadable/failed = 'shared' (the page as today; the server still gates). */
export function loadSite(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<SiteInfo> {
  if (loading) return loading;
  loading = (async () => {
    let info: SiteInfo = SHARED;
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), SITE_WAIT_MAX_MS) : null;
      try {
        const res = await fetchImpl('/api/site', { cache: 'no-store', credentials: 'same-origin', signal: ctrl?.signal });
        if (res.ok) info = parseSiteAnswer(await res.json()) || SHARED;
      } finally { if (timer) clearTimeout(timer); }
    } catch { /* offline, too slow or an older server: keep today's page */ }
    current = info;
    return info;
  })();
  return loading;
}
export function resetSiteForTests(): void { current = null; loading = null; }

/** The site agency's logo as a data URL (GET /api/site/logo?rev=), or null. */
export async function loadSiteLogo(rev: string | null, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<string | null> {
  if (!rev || rev.length > 64) return null;
  try {
    const res = await fetchImpl(`/api/site/logo?rev=${encodeURIComponent(rev)}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: any = await res.json();
    if (body?.rev !== rev || !['image/png', 'image/jpeg', 'image/webp'].includes(body?.mime) || typeof body.data !== 'string') return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.data) || body.data.length > 2_000_000) return null;
    return `data:${body.mime};base64,${body.data}`;
  } catch { return null; }
}

export function useSite(): SiteInfo | null {
  const [site, setSite] = useState<SiteInfo | null>(() => current ?? (siteWaitNeeded() ? null : SHARED));
  useEffect(() => {
    let active = true;
    void loadSite().then((s) => { if (active) setSite(s); });
    return () => { active = false; };
  }, []);
  return site;
}

export function useSiteLogo(rev: string | null | undefined): string | null {
  const [src, setSrc] = useState<{ rev: string; src: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (!rev) { setSrc(null); return; }
    void loadSiteLogo(rev).then((s) => { if (active) setSrc(s ? { rev, src: s } : null); });
    return () => { active = false; };
  }, [rev]);
  return src && src.rev === rev ? src.src : null;
}

/** A server refusal that means "not on this address" (403 on every route; the recovery route says it on a 401). */
export function siteRefusalFrom(status: number, body: unknown): SiteRefusal | null {
  if (status !== 403 && status !== 401) return null;
  if (!body || typeof body !== 'object') return null;
  const code = (body as any).code;
  if (code !== 'WRONG_SITE' && code !== 'SITE_NOT_SET_UP') return null;
  if (status === 401 && code !== 'WRONG_SITE') return null;
  return { code, sharedOrigin: safeSharedOrigin((body as any).sharedOrigin) };
}

export function announceSiteRefusal(r: SiteRefusalEvent): void {
  try { window.dispatchEvent(new CustomEvent(SITE_REFUSED_EVENT, { detail: r })); } catch { /* ignore */ }
}

/** For calls made with plain fetch: shows the screen on a site refusal (never on the shared address). True = refused. */
export function noticeSiteRefusal(status: number, body: unknown): boolean {
  if (current?.site === 'shared') return false;
  const r = siteRefusalFrom(status, body);
  if (!r) return false;
  // These callers send no sign-in: the screen only (signedOut: false). Decided once the site is known.
  void loadSite().then((s) => { if (s.site !== 'shared') announceSiteRefusal({ ...r, signedOut: false }); });
  return true;
}

/**
 * What the app does with a refusal event: 'leave' = this device's refused sign-in
 * was cleared, leave the signed-in screens (no server sign-out: the server already
 * refused that session here); 'screen' = show the screen and keep any sign-in.
 */
export function siteRefusalAction(e: SiteRefusalEvent | undefined, signedIn: boolean): 'leave' | 'screen' | 'ignore' {
  if (!e || (e.code !== 'WRONG_SITE' && e.code !== 'SITE_NOT_SET_UP')) return 'ignore';
  return e.signedOut === true && signedIn ? 'leave' : 'screen';
}

/** The Shutfey address to send a person to: /api/site's answer first, else the refusal's (both are the server's words). */
export function sharedOriginFor(site: SiteInfo | null, refusal: SiteRefusal | null): string | null {
  if (site && site.site !== 'shared' && site.sharedOrigin) return site.sharedOrigin;
  return refusal?.sharedOrigin ?? null;
}
