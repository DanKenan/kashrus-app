// Kiosk QR sign-in, client part (server #154; Don Oct 24 7:58 PM: "Just the
// mashgiach logged in to his account, can scan QR code. That's it. Simple.").
// A signed-in phone opens the tablet's link (/k/<code>), the page asks the
// server to approve it (no tap, no number, no Face ID) and the tablet opens.
// Pure helpers + the phone's calls. The words on screen live in KQR_UI_TEXT;
// a server message is shown where the server sends one.
import { apiFetch, COOKIE_AUTH_HEADER, COOKIE_AUTH_VALUE } from './api';

/** A code: 128-bit random, base64url, exactly 22 characters (server C1). */
export const KQR_CODE_RE = /^[A-Za-z0-9_-]{22}$/;

export const KQR_UI_TEXT = {
  menuRow: 'Sign in to a tablet',
  menuRowSub: 'Scan the code on the wall tablet',
  // Tablet
  tabletTitle: 'Sign in with your phone',
  step1: 'Open Shutfey on your phone. You must be signed in.',
  step2: 'Tap Sign in to a tablet',
  step3: 'Point it at this code. The tablet opens.',
  newCodeIn: 'New code in',
  newCodeSoon: 'New code in a moment…',
  useCode: 'Use your code instead',
  useQr: 'Sign in with your phone',
  staffSignIn: 'Staff sign-in',
  poweredBy: 'Powered by',
  hi: (first: string, venue: string) => (first && venue ? `Hi ${first} – ${venue}` : first ? `Hi ${first}` : 'Hi'),
  opening: 'Opening your tasks…',
  // Phone: scanner
  scanTitle: 'Sign in to a tablet',
  scanPoint: 'Point your camera at the code on the tablet',
  scanTip: "Camera not working? Open your phone's camera app and point it at the tablet instead.",
  scanNoCamera: "This phone can't scan here. Open your phone's camera app and point it at the code on the tablet.",
  scanNotOurs: "That isn't a Shutfey tablet code.",
  siteTitle: "This tablet isn't on this address",
  siteBody: "Scan the code on the tablet with your phone's camera app. It opens the tablet's own address.",
  scanOldCode: 'That code was already tried. Scan the new code on the tablet.',
  tabletsLink: "Tablets you're signed in on",
  // Phone: the link page
  signingIn: (venue: string) => (venue ? `Signing in to the ${venue} tablet…` : 'Signing in to the tablet…'),
  lookAtTablet: 'Look at the tablet. It opens in a moment.',
  rowTablet: 'Tablet',
  rowVenue: 'Venue',
  rowAgency: 'Agency',
  rowYou: 'You',
  doneTitle: (venue: string) => (venue ? `You're signed in on the ${venue} tablet` : "You're signed in on the tablet"),
  doneBody: (until: string) => `You can put your phone away. The tablet signs you out after 3 hours${until ? ` (at ${until})` : ''}, or tap End shift on it.`,
  endedTitle: (venue: string) => (venue ? `You're signed out of the ${venue} tablet` : "You're signed out of the tablet"),
  endedBody: 'The tablet is closed. Scan the code on the tablet to sign in again.',
  ok: 'OK',
  scanAgain: 'Scan again',
  tryAgain: 'Try again',
  // Phone: errors (titles; the body is the server's words where it sends them)
  expiredTitle: 'This code has expired',
  expiredBody: 'The tablet shows a new code every minute. Scan the new code on the tablet.',
  unusableTitle: "This code can't be used",
  unusableBody: 'It was already used, or the tablet showed a new one. Scan the code on the tablet again.',
  notHereTitle: "You can't sign in on this tablet",
  notOpenedTitle: "The tablet didn't open",
  notOpenedBody: "It didn't finish in time, or the tablet showed a new code. Scan the code on the tablet again.",
  tooManyTitle: 'Too many tries',
  signInAgainTitle: 'Sign in again',
  signInAgainBody: 'Sign out of Shutfey on this phone, sign in again, then scan the code on the tablet.',
  unavailableTitle: "Couldn't reach Shutfey",
  unavailableBody: 'Please try again in a moment.',
  // Phone: tablets list
  tabletsTitle: "Tablets you're signed in on",
  tabletsIntro: 'These tablets are open in your name. If you left one open, sign out of it here.',
  tabletsNone: "You're not signed in on any tablet.",
  tabletsFoot: 'Each tablet also signs you out by itself after 3 hours.',
  signOut: 'Sign out',
  since: (a: string, b: string) => `Since ${a} · ends ${b}`,
} as const;

/** Is this page the tablet-link page (/k or /k/<anything>)? */
export function isKqrPath(pathname: string | null | undefined): boolean {
  return /^\/k(\/.*)?$/.test(String(pathname || ''));
}

/** The code in /k/<code> (one optional trailing slash), or null. */
export function kqrCodeFromPath(pathname: string | null | undefined): string | null {
  const m = /^\/k\/([^/]+)\/?$/.exec(String(pathname || ''));
  return m && KQR_CODE_RE.test(m[1]) ? m[1] : null;
}

function pageIsHttp(): boolean {
  try { return typeof location !== 'undefined' && location.protocol === 'http:'; } catch { return false; }
}

/**
 * An origin the server listed: https, origin only. http only on loopback, or
 * when this page itself is on http (a local test server: its listed
 * addresses are local too). A real phone is always on https.
 */
export function safeAppOrigin(x: unknown, httpPage: boolean = pageIsHttp()): string | null {
  if (typeof x !== 'string' || x.length > 300) return null;
  try {
    const u = new URL(x);
    if (u.origin !== x) return null;
    if (u.protocol === 'https:') return x;
    if (u.protocol === 'http:' && (httpPage || u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return x;
  } catch { /* not a URL */ }
  return null;
}

/** /api/site's appOrigins (the addresses a tablet link may use), validated. Anything else: []. */
export function parseAppOrigins(body: unknown, httpPage: boolean = pageIsHttp()): string[] {
  const list = body && typeof body === 'object' ? (body as any).appOrigins : null;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const x of list.slice(0, 200)) {
    const o = safeAppOrigin(x, httpPage);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

/**
 * What the in-app scanner read -> the tablet link, or null. Only an exact
 * <origin>/k/<code> whose origin the server listed (no user, query or hash).
 */
export function kqrLinkFromScan(text: unknown, appOrigins: readonly string[]): { origin: string; code: string } | null {
  if (typeof text !== 'string' || text.length > 500) return null;
  let u: URL;
  try { u = new URL(text.trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (!appOrigins.includes(u.origin)) return null;
  const m = /^\/k\/([A-Za-z0-9_-]{22})$/.exec(u.pathname);
  if (!m) return null;
  return { origin: u.origin, code: m[1] };
}

// The code from a /k link, kept for this tab only while the person signs in
// (the address bar shows /k without it). Taken by the link page.
const PENDING_KEY = 'shutfey_kqr_pending';
export const KQR_PENDING_MAX_MS = 15 * 60 * 1000;

export function savePendingKqr(code: string, nowMs = Date.now()): void {
  if (!KQR_CODE_RE.test(code)) return;
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ code, at: nowMs })); } catch { /* storage off */ }
}
export function readPendingKqr(nowMs = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.code === 'string' && KQR_CODE_RE.test(p.code) && typeof p.at === 'number' && nowMs - p.at >= 0 && nowMs - p.at < KQR_PENDING_MAX_MS) return p.code;
    sessionStorage.removeItem(PENDING_KEY);
  } catch { /* ignore */ }
  return null;
}
export function clearPendingKqr(): void {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

// A code the server just refused (used, expired, didn't open): the scanner skips it for a minute, so a
// camera still pointing at an old picture does not loop back to the same refusal.
let refused: { code: string; at: number } | null = null;
export function markRefusedKqr(code: string | null, nowMs = Date.now()): void { if (code) refused = { code, at: nowMs }; }
export function wasJustRefused(code: string, nowMs = Date.now()): boolean { return !!refused && refused.code === code && nowMs - refused.at < 60000; }

export type KqrErrorKind = 'expired' | 'unusable' | 'notHere' | 'tooMany' | 'signIn' | 'unavailable' | 'notOpened' | 'site';
export type KqrError = { kind: KqrErrorKind; title: string; body: string; again: 'scan' | 'retry' | 'none' };

/** A refused approve -> the screen to show (the server's code decides; its words are used where they add the venue). */
export function kqrErrorFor(status: number, body: any): KqrError {
  const code = body && typeof body.code === 'string' ? body.code : '';
  const msg = body && typeof body.error === 'string' ? body.error : '';
  const T = KQR_UI_TEXT;
  if (code === 'WRONG_SITE' || code === 'SITE_NOT_SET_UP') return { kind: 'site', title: T.siteTitle, body: T.siteBody, again: 'scan' };
  if (code === 'KIOSK_QR_EXPIRED' || status === 410) return { kind: 'expired', title: T.expiredTitle, body: T.expiredBody, again: 'scan' };
  if (code === 'KIOSK_QR_NOT_HERE') {
    // "You can't sign in on this tablet. Ask your administrator for a code at <venue>." -> the second sentence.
    const rest = msg.startsWith("You can't sign in on this tablet.") ? msg.slice("You can't sign in on this tablet.".length).trim() : msg;
    return { kind: 'notHere', title: T.notHereTitle, body: rest || 'Ask your administrator for a code at this venue.', again: 'none' };
  }
  if (code === 'RATE_LIMITED' || status === 429) return { kind: 'tooMany', title: T.tooManyTitle, body: msg || 'Wait a minute and scan again.', again: 'none' };
  if (code === 'SIGN_IN_FIRST' || status === 401) return { kind: 'signIn', title: T.signInAgainTitle, body: T.signInAgainBody, again: 'none' };
  if (code === 'KIOSK_QR_UNUSABLE' || status === 404) return { kind: 'unusable', title: T.unusableTitle, body: T.unusableBody, again: 'scan' };
  return { kind: 'unavailable', title: T.unavailableTitle, body: T.unavailableBody, again: 'retry' };
}

/**
 * The phone's kiosk-QR calls: the sign-in cookie only (the server refuses a
 * Bearer token here), never a sign-out from these answers (a 401 here is
 * checked with GET /api/auth/me, which follows the app's usual rules).
 */
export async function kqrPhoneFetch(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { [COOKIE_AUTH_HEADER]: COOKIE_AUTH_VALUE };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method: init.method || 'GET',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  // Never a sign-out from a QR answer itself (a site refusal here can be about the tablet's
  // address, not this phone's sign-in). Signed out for real? GET /api/auth/me decides, with the
  // app's usual rules.
  if (res.status === 401 || (res.status === 403 && (body?.code === 'WRONG_SITE' || body?.code === 'SITE_NOT_SET_UP'))) await confirmPhoneSession();
  return { status: res.status, body };
}

/** GET /api/auth/me through apiFetch: a real sign-out signs this phone out the usual way; anything else changes nothing. */
async function confirmPhoneSession(): Promise<void> {
  try {
    const me = await apiFetch('/api/auth/me', { cache: 'no-store' });
    await me.text().catch(() => '');
  } catch {
    // offline: nothing changes
  }
}

/** GET /api/auth/me: may this signed-in phone use "Sign in to a tablet" on this address? false on anything else. */
export async function readCanUseTabletSignIn(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/auth/me', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return !!body && body.canUseTabletSignIn === true;
  } catch {
    return false;
  }
}

/** GET /api/site's appOrigins, fresh. [] when it can't be read. */
export async function loadAppOrigins(): Promise<string[]> {
  try {
    const res = await fetch('/api/site', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return [];
    return parseAppOrigins(await res.json());
  } catch {
    return [];
  }
}

/** Public info: prefer the tablet's agency, with the older agency shape as fallback. */
export function parseKqrInfoAgencyName(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as any;
  const name = b.tablet?.agencyName;
  if (typeof name === 'string' && name.trim()) return name.slice(0, 200);
  return typeof b.agency?.name === 'string' && b.agency.name.trim() ? b.agency.name.slice(0, 200) : '';
}

/** null means a failed lookup; an empty name is still a successful response. */
export async function loadKqrInfoAgencyName(code: string): Promise<string | null> {
  if (!KQR_CODE_RE.test(code)) return null;
  try {
    const res = await fetch(`/api/kiosk/qr/info/${encodeURIComponent(code)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return parseKqrInfoAgencyName(await res.json());
  } catch {
    return null;
  }
}

/** The tablets row keeps its original venue text when no agency is known. */
export function kqrTabletLines(t: { venueName: string; agencyName: string }): string[] {
  return t.agencyName ? [t.venueName, t.agencyName].filter(Boolean) : [t.venueName];
}

export type KqrTablet = { ref: string; tabletName: string; venueName: string; agencyName: string; sinceMs: number; endsAtMs: number };
export function parseTablets(body: unknown): KqrTablet[] {
  const list = body && typeof body === 'object' ? (body as any).tablets : null;
  if (!Array.isArray(list)) return [];
  const str = (x: unknown) => (typeof x === 'string' ? x.slice(0, 200) : '');
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return list
    .filter((t: any) => t && typeof t.ref === 'string' && /^[A-Za-z0-9_-]{22}$/.test(t.ref))
    .map((t: any) => ({ ref: t.ref, tabletName: str(t.tabletName), venueName: str(t.venueName), agencyName: str(t.agencyName), sinceMs: num(t.sinceMs), endsAtMs: num(t.endsAtMs) }));
}

/** "12:15 PM" in this phone's own time. */
export function clockText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}

/** "0:42" for the tablet's countdown. */
export function countdownText(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
