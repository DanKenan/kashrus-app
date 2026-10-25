import { announceSiteRefusal, currentSite, loadSite, siteRefusalFrom, type SiteRefusal } from './site';
// Central API helper: attaches the signed session token to every request.
// Use apiFetch('/api/...') everywhere instead of raw fetch().

const TOKEN_KEY = 'shutfey_session_token';
const KIOSK_DEVICE_KEY = 'kiosk_device';
const KIOSK_VENUE_NAME_KEY = 'kiosk_venue_name';

// ---------------------------------------------------------------------------
// Item 11a-c (servers #135 user cookie, #137 kiosk cookies): this device moves
// from the stored token (Authorization: Bearer) to the server's HttpOnly
// cookies. Every /api call opts in with X-Shutfey-Auth: cookie and same-origin
// credentials. A stored token still wins (the server reads the cookie only when
// no Authorization header is sent), so nothing changes until the move is
// proved: adopt, then GET /api/auth/me WITH the cookie and WITHOUT the token
// gives the same person (and tablet). Only then is the token deleted; on any
// failure it is kept and the move is tried again later (plan 9.2).
// ---------------------------------------------------------------------------
export const COOKIE_AUTH_HEADER = 'X-Shutfey-Auth';
export const COOKIE_AUTH_VALUE = 'cookie';
/**
 * Set while this device is signed in by the cookie (no token stored): a random
 * id per cookie sign-in, shared by every tab (not a secret). A tab compares it
 * to tell "the sign-in this request was sent with" from a newer one made in
 * another tab.
 */
const COOKIE_SESSION_KEY = 'shutfey_cookie_session';
/** A sign-out on the cookie the server has not confirmed yet (sent again on the next start). */
const LOGOUT_PENDING_KEY = 'shutfey_logout_pending';
/** A paired tablet whose device secret now lives only in the device cookie D: 'cookie:<deviceId>'. */
const KIOSK_DEVICE_COOKIE_PREFIX = 'cookie:';

/** Bumped whenever this device's credential changes (token stored or cleared, cookie on or off). */
let credentialGeneration = 0;
/** Set by startCookieSession(): runs the move to the cookie after a token is stored. */
let onTokenStored: (() => void) | null = null;

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

/** True while this device is signed in by the server's cookie rather than a stored token. */
export function isCookieSession(): boolean {
  return !!readKey(COOKIE_SESSION_KEY);
}

function newCookieSessionId(): string {
  return randomId();
}

/**
 * The paired-tablet marker: '<deviceId>.<deviceSecret>' (today), or
 * 'cookie:<deviceId>' once the secret lives only in the device cookie D.
 * Truthy = this tablet is paired. Stored only on the tablet.
 */
export function getKioskDevice(): string | null {
  return readKey(KIOSK_DEVICE_KEY);
}

/** The device secret to send as X-Kiosk-Device (null when the device cookie D proves the tablet). */
export function getKioskDeviceSecret(): string | null {
  const device = getKioskDevice();
  return device && !device.startsWith(KIOSK_DEVICE_COOKIE_PREFIX) ? device : null;
}

export function setKioskDevice(device: string | null): void {
  try {
    if (device) localStorage.setItem(KIOSK_DEVICE_KEY, device);
    else localStorage.removeItem(KIOSK_DEVICE_KEY);
  } catch {
    // storage unavailable — the tablet will return to pairing
  }
}

export function clearKioskDevice(): void {
  setKioskDevice(null);
  try {
    localStorage.removeItem(KIOSK_VENUE_NAME_KEY);
  } catch {
    // ignore
  }
}

export function getKioskVenueName(): string | null {
  try {
    return localStorage.getItem(KIOSK_VENUE_NAME_KEY);
  } catch {
    return null;
  }
}

export function setKioskVenueName(name: string | null): void {
  try {
    if (name) localStorage.setItem(KIOSK_VENUE_NAME_KEY, name);
    else localStorage.removeItem(KIOSK_VENUE_NAME_KEY);
  } catch {
    // ignore
  }
}

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  credentialGeneration++;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable — requests will just be unauthenticated
  }
  if (token) {
    // A fresh sign-in: an older unconfirmed cookie sign-out must never end it.
    writeKey(LOGOUT_PENDING_KEY, null);
    // 11a-c: move the new sign-in to the cookie (no-op until the app started it).
    if (onTokenStored) {
      const run = onTokenStored;
      setTimeout(() => run(), 0);
    }
  }
}

export function clearSession(): void {
  setSessionToken(null);
  writeKey(COOKIE_SESSION_KEY, null);
  try {
    localStorage.removeItem('current_user');
  } catch {
    // ignore
  }
}

/**
 * 11a-c: the sign-in headers for a request made with plain fetch: the given
 * token as Bearer (today's way), else the cookie opt-in when this device is on
 * the cookie. Send with credentials: 'same-origin'.
 */
export function sessionAuthHeaders(token: string | null = getSessionToken()): Record<string, string> {
  const headers: Record<string, string> = { [COOKIE_AUTH_HEADER]: COOKIE_AUTH_VALUE };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** True when a request can be signed in at all: a token, or this device's cookie. */
export function hasSessionCredential(token: string | null = getSessionToken()): boolean {
  return !!token || isCookieSession();
}

/**
 * What the current sign-in is, as one comparable value: the token, or
 * 'cookie:<generation>' on the cookie; null = signed out. Changes whenever the
 * sign-in changes, so a late answer for an older one is recognised.
 */
export function sessionCredentialKey(): string | null {
  const token = getSessionToken();
  if (token) return token;
  const cookieId = readKey(COOKIE_SESSION_KEY);
  return cookieId ? `cookie:${cookieId}:${credentialGeneration}` : null;
}

/** Drop-in fetch replacement for /api calls — adds Authorization automatically. */
/**
 * QA2 Q2: Change password answers a wrong current password with 401. That is
 * not a session problem. Recognised by the code CURRENT_PASSWORD_WRONG, or by
 * today's exact server words on that one endpoint (the session-expired 401 on
 * the same endpoint says "Sign in required…" and still signs out).
 */
export const WRONG_CURRENT_PASSWORD_TEXT = 'Current password is incorrect.';
async function isWrongCurrentPassword401(input: string, res: Response): Promise<boolean> {
  try {
    const body = await res.clone().json();
    if (!body || typeof body !== 'object') return false;
    if (body.code === 'CURRENT_PASSWORD_WRONG') return true;
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    return path === '/api/auth/change-password' && body.error === WRONG_CURRENT_PASSWORD_TEXT;
  } catch {
    return false;
  }
}

/**
 * Item 11 client part 1 (server #134): timing knobs, one place (tests shorten them).
 * - storeRetryDelaysMs: a GET answered 503 SESSION_STORE_UNAVAILABLE ("could not
 *   check your sign-in right now") is tried again after these waits. It is never
 *   a sign-out; only 401 signs out.
 * - authSettleGraceMs: after a refused WebSocket (4401), wait this long once no
 *   sign-in-changing request is in flight, so a fresh token from that request
 *   (change password, merge accounts) is stored before the session is judged.
 * - logoutSettleMaxMs / moveLockMaxMs (11a-c): how long the move to the cookie
 *   waits for a sign-out on its way / for another tab's move before trying later.
 *   logoutUnknownMaxMs: a sign-out mark left by a closed tab counts this long.
 *   An adopt request is cut off after adoptMaxMs and the move's lock is then
 *   kept adoptAbortGraceMs more. A postponed move is tried again after
 *   movePostponedRetryMs.
 */
export const sessionTiming = { storeRetryDelaysMs: [1000, 3000], authSettleGraceMs: 1500, authSettleMaxMs: 60000, logoutSettleMaxMs: 15000, logoutUnknownMaxMs: 600000, moveLockMaxMs: 30000, adoptMaxMs: 20000, adoptAbortGraceMs: 5000, movePostponedRetryMs: 10000 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function apiPath(input: string): string {
  return String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
}

/** True for a 503 whose body says the server could not check the sign-in (try again, never sign out). */
export async function isSessionStoreUnavailable(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const body = await res.clone().json();
    return !!body && body.code === 'SESSION_STORE_UNAVAILABLE';
  } catch {
    return false;
  }
}

// Requests that can replace this device's token (change password, merge, activate…).
// Counted from the request until its whole answer has arrived; lastSignInChangeAt
// is when the last one finished (its caller stores the new token right after).
let authChangesInFlight = 0;
let lastSignInChangeAt = 0;
function canChangeSignIn(input: string, method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && /^\/api\/(auth|account)\//.test(apiPath(input));
}

/** True while a sign-in-changing request is on its way, or finished less than the grace ago. */
export function signInChangePending(): boolean {
  return authChangesInFlight > 0 || Date.now() - lastSignInChangeAt < sessionTiming.authSettleGraceMs;
}

/**
 * Resolves true once no sign-in-changing request has been in flight for a full
 * grace period (re-checked after the grace, so one started meanwhile is waited
 * for too); false when that did not happen within authSettleMaxMs — the caller
 * then treats the session as unknown and tries again later, never signs out.
 */
export async function waitForSignInChangesToSettle(): Promise<boolean> {
  const started = Date.now();
  while (signInChangePending()) {
    if (Date.now() - started >= sessionTiming.authSettleMaxMs) return false;
    await sleep(Math.min(100, sessionTiming.authSettleGraceMs));
  }
  return true;
}

/** The code of a 401 answer, if it carries one. */
async function unauthorizedCode(res: Response): Promise<string | undefined> {
  try {
    const body = await res.clone().json();
    if (body && typeof body.code === 'string') return body.code;
  } catch {
    // ignore — not every 401 carries a JSON body
  }
  return undefined;
}

function applyKioskUnpaired(responseCode: string | undefined): void {
  if (responseCode === 'KIOSK_UNPAIRED') {
    // The tablet is no longer paired: drop the stored device credential so
    // the tablet returns to the pairing screen.
    clearKioskDevice();
    try {
      window.dispatchEvent(new CustomEvent('shutfey:kiosk-unpaired'));
    } catch {
      // ignore
    }
  }
}

function signOutLocally(code?: string): void {
  // Token expired or revoked — clear it and tell the app to show login.
  // 12a-c: the 401's code rides along (KIOSK_SESSION_ENDED: the kiosk shows
  // "Your time at this venue has ended." and stays paired).
  clearSession();
  try {
    window.dispatchEvent(new CustomEvent('shutfey:unauthorized', { detail: { code } }));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Domains PR B (plan 2h): one rule for every call that can be told "not on this
// address" (WRONG_SITE / SITE_NOT_SET_UP), apiFetch and plain fetch alike. The
// server sends these only on an agency or unknown address; decided once
// /api/site has answered, and never on the shared address.
//   sentKey = the device sign-in the request carried (sessionCredentialKey() form:
//   the stored token, or 'cookie:<n>'), or null for a call that carried none
//   (sign-in, invite/reset links, a choose token).
//   'cleared' = it was this device's current sign-in: cleared, screen (signedOut).
//   'screen'  = no device sign-in was sent: the screen only, any sign-in kept.
//   'stale'   = the sign-in sent was replaced meanwhile: nothing to do.
// ---------------------------------------------------------------------------
export async function noticeSiteRefusalFor(res: Response, sentKey: string | null): Promise<'cleared' | 'screen' | 'stale' | null> {
  if (res.status !== 403 && res.status !== 401) return null;
  if (currentSite()?.site === 'shared') return null;
  let refusal: SiteRefusal | null = null;
  try { refusal = siteRefusalFrom(res.status, await res.clone().json()); } catch { /* not JSON */ }
  if (!refusal) return null;
  if ((await loadSite()).site === 'shared') return null;
  if (!sentKey) {
    announceSiteRefusal({ ...refusal, signedOut: false });
    return 'screen';
  }
  if (sessionCredentialKey() === sentKey) {
    clearSession();
    announceSiteRefusal({ ...refusal, signedOut: true });
    return 'cleared';
  }
  return 'stale';
}

/** The device sign-in a plain-fetch call with sessionAuthHeaders(token) carries (null: none of this device's). */
export function deviceCredentialKeyFor(token: string | null): string | null {
  if (token) return token === getSessionToken() ? token : null;
  return isCookieSession() ? sessionCredentialKey() : null;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const callerHeaders = new Headers(init.headers || {});
  const callerSetAuth = callerHeaders.has('Authorization');
  // Headers for one attempt, built from the sign-in stored NOW (a retry after a
  // wait must not carry a token that was replaced meanwhile).
  // 11a-c: every call opts in to the cookie; a stored token still wins.
  const attemptHeaders = (): { headers: Headers; token: string | null; cookieKey: string | null } => {
    const headers = new Headers(callerHeaders);
    const token = getSessionToken();
    if (token && !callerSetAuth) headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has(COOKIE_AUTH_HEADER)) headers.set(COOKIE_AUTH_HEADER, COOKIE_AUTH_VALUE);
    const kioskDevice = getKioskDeviceSecret();
    if (kioskDevice && !headers.has('X-Kiosk-Device')) headers.set('X-Kiosk-Device', kioskDevice);
    // Signed in by the cookie on this attempt: no token and no caller credential.
    const cookieKey = !token && !callerSetAuth ? sessionCredentialKey() : null;
    return { headers, token, cookieKey };
  };
  const method = (init.method || 'GET').toUpperCase();
  const signInChange = canChangeSignIn(input, method);
  if (signInChange) authChangesInFlight++;
  let res: Response;
  let usedToken: string | null;
  let usedCookieKey: string | null;
  try {
    let attempt = attemptHeaders();
    usedToken = attempt.token;
    usedCookieKey = attempt.cookieKey;
    res = await fetch(input, { credentials: 'same-origin', ...init, headers: attempt.headers });
    // Item 11: the server could not check the sign-in (session store down).
    // A read is simply tried again a little later; a write is handed back to
    // its caller as a failed save ("try again"). Never a sign-out.
    if (method === 'GET' || method === 'HEAD') {
      for (const waitMs of sessionTiming.storeRetryDelaysMs) {
        if (!(await isSessionStoreUnavailable(res)) || init.signal?.aborted) break;
        await sleep(waitMs);
        if (init.signal?.aborted) break;
        attempt = attemptHeaders();
        usedToken = attempt.token;
        usedCookieKey = attempt.cookieKey;
        res = await fetch(input, { credentials: 'same-origin', ...init, headers: attempt.headers });
      }
    }
    // A sign-in-changing answer counts until its whole body has arrived (the
    // caller's json() then resolves at once and it stores the new token).
    if (signInChange) {
      try {
        await res.clone().text();
      } catch {
        // ignore — the caller reads (or fails to read) the body itself
      }
    }
  } finally {
    if (signInChange) {
      authChangesInFlight--;
      lastSignInChangeAt = Date.now();
    }
  }
  // Track the server's document version from every API response so writes
  // can send back the version this client last saw (version contract).
  trackVersionHeader(res);
  // Domains PR B (plan 2h): "not on this address" (WRONG_SITE / SITE_NOT_SET_UP).
  // A caller-set Authorization (a choose/invite token) is not this device's sign-in.
  if (res.status === 403 || res.status === 401) await noticeSiteRefusalFor(res, callerSetAuth ? null : (usedToken || usedCookieKey));
  if (res.status === 401) {
    const code401 = await unauthorizedCode(res);
    applyKioskUnpaired(code401);
    // QA2 Q2: a wrong CURRENT password on Change password is the person's
    // typo, not an expired session — keep them signed in (the form says so).
    const wrongCurrentPassword = await isWrongCurrentPassword401(input, res);
    // Item 11: only the session this request was sent with is over; a token
    // stored while it was on its way (a fresh sign-in, a changed password) is
    // kept. Checked after the last await, right before clearing.
    if (usedToken && !wrongCurrentPassword && getSessionToken() === usedToken) signOutLocally(code401);
    // 11a-c: the same rule on the cookie: only while the cookie sign-in this
    // request was sent with is still this device's sign-in.
    else if (!usedToken && usedCookieKey && !wrongCurrentPassword && sessionCredentialKey() === usedCookieKey) signOutLocally(code401);
  }
  return res;
}

/**
 * Item 11 client part 1: end this device's session on the server (POST
 * /api/auth/logout with its token) before the app forgets the token. Best
 * effort: a network error or any non-2xx answer still signs out locally (the
 * caller clears the token right after starting this). A plain fetch, not
 * apiFetch, so a 401 here (an already-ended session) never re-enters sign-out.
 * keepalive lets the request finish if the page navigates away (kiosk mode).
 *
 * 11a-c: on the cookie (no token stored) the same call is sent with the
 * opt-in; the server revokes the session and deletes the cookie (never the
 * tablet's device cookie). The cookie cannot be deleted from here, so a 503
 * or a network error is sent again (sessionTiming.storeRetryDelaysMs) and, if
 * still unconfirmed, again on the next start (until a new sign-in).
 */
export function endServerSession(token: string | null = getSessionToken()): Promise<void> {
  const onCookie = !token && isCookieSession();
  if (!token && !onCookie) return Promise.resolve();
  const headers: Record<string, string> = sessionAuthHeaders(token);
  const kioskDevice = getKioskDeviceSecret();
  if (kioskDevice) headers['X-Kiosk-Device'] = kioskDevice;
  if (!onCookie) {
    try {
      return sendLogoutRequest(headers).then(
        (res) => res.text().then(() => undefined, () => undefined),
        () => undefined
      );
    } catch {
      return Promise.resolve();
    }
  }
  writeKey(LOGOUT_PENDING_KEY, '1');
  return sendPendingLogout(headers);
}

/**
 * 11a-c: sign-out requests still on their way. Their answer deletes this
 * browser's sign-in cookies, whichever they are by then, so a sign-in made
 * meanwhile (in any tab) could lose its new cookie: the move to the cookie
 * waits while any is on its way and otherwise keeps the token and tries later.
 * - In this tab: the set (exact).
 * - For the other tabs: one localStorage key per request
 *   (shutfey_logout_in_flight:<random id> = when it was sent, with :m when
 *   a readable marker cookie was set). The answer deletes that marker after
 *   deleting the sign-in cookies, so even after a reload a missing marker
 *   proves that exact answer has landed. The sending tab also removes the
 *   key and marker once its answer (or a network error) is in.
 * Keys without :m (older pages, cookies off, older server) keep the 10-minute rule; marker absence is checked only for ids of 16 lower-case hex.
 * - Without that proof, a key left by a tab that closed or navigated away
 *   (its keepalive request may still be on its way) counts as "maybe still
 *   on its way" for
 *   logoutUnknownMaxMs (10 min, longer than any request can live at the
 *   server and proxies), and only then is it dropped.
 * A sign-out is still sent at once (never queued), so it leaves even if the
 * page navigates right after.
 */
const LOGOUT_IN_FLIGHT_PREFIX = 'shutfey_logout_in_flight:';
const logoutsInFlight = new Set<Promise<unknown>>();
function randomId(): string {
  try {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }
}
// Outlive the key window so marker expiry cannot be mistaken for an applied answer.
const LOGOUT_MARKER_MAX_AGE_S = 660;
function logoutMarkerCookie(id: string, maxAge: number): string {
  return `shutfey_lo_${id}=${maxAge ? '1' : ''}; Path=/; Max-Age=${maxAge}; SameSite=Strict${globalThis.location?.protocol === 'https:' ? '; Secure' : ''}`;
}
function expireLogoutMarker(id: string): void {
  try { document.cookie = logoutMarkerCookie(id, 0); } catch { /* cookies unavailable */ }
}
function trackLogout<T>(p: Promise<T>, id: string, markerSet: boolean): Promise<T> {
  logoutsInFlight.add(p);
  const key = `${LOGOUT_IN_FLIGHT_PREFIX}${id}`;
  writeKey(key, `${Date.now()}${markerSet ? ':m' : ''}`);
  const done = () => {
    logoutsInFlight.delete(p);
    writeKey(key, null);
    expireLogoutMarker(id);
  };
  p.then(done, done);
  return p;
}

function sendLogoutRequest(headers: Record<string, string>): Promise<Response> {
  const id = randomId();
  let markerSet = false;
  try {
    document.cookie = logoutMarkerCookie(id, LOGOUT_MARKER_MAX_AGE_S);
    markerSet = document.cookie.split(';').some((c) => c.trim() === `shutfey_lo_${id}=1`);
  } catch { /* no readable cookies: keep the full unknown-request window */ }
  return trackLogout(fetch('/api/auth/logout', { method: 'POST', headers: { ...headers, 'X-Shutfey-Logout-Id': id }, credentials: 'same-origin', keepalive: true }), id, markerSet);
}

/** The other tabs' sign-out keys; drops the ones past logoutUnknownMaxMs. */
function otherTabsLogoutInFlight(): boolean {
  let any = false;
  try {
    const ls = globalThis.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(LOGOUT_IN_FLIGHT_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const value = ls.getItem(k) ?? '';
      const parsed = /^(\d+)(:m)?$/.exec(value);
      const sentAt = parsed ? Number(parsed[1]) : NaN;
      const id = k.slice(LOGOUT_IN_FLIGHT_PREFIX.length);
      const validId = /^[0-9a-f]{16}$/.test(id);
      if (!Number.isFinite(sentAt) || Date.now() - sentAt >= sessionTiming.logoutUnknownMaxMs) {
        ls.removeItem(k);
        if (validId) expireLogoutMarker(id);
        continue;
      }
      if (parsed?.[2] && validId) {
        try {
          if (!document.cookie.split(';').some((c) => c.trim().startsWith(`shutfey_lo_${id}=`))) {
            ls.removeItem(k);
            continue;
          }
        } catch { /* unreadable cookies: fail closed */ }
      }
      any = true;
    }
  } catch {
    // no storage: only this tab's own requests are known
  }
  return any;
}

function logoutInFlightAnywhere(): boolean {
  return logoutsInFlight.size > 0 || otherTabsLogoutInFlight();
}

/** Resolves true once no sign-out request is on its way in any tab (false after maxMs: keep the token, try later). */
async function waitForLogoutsToSettle(maxMs = sessionTiming.logoutSettleMaxMs): Promise<boolean> {
  const started = Date.now();
  while (logoutInFlightAnywhere()) {
    if (Date.now() - started >= maxMs) return false;
    await sleep(50);
  }
  return true;
}

/**
 * 11a-c: one move to the cookie at a time across all tabs of this browser (an
 * adopt answer sets the cookie, so two tabs' adopts must not interleave), with
 * the browser's Web Locks: the lock is held by the browser for the tab for the
 * whole move, even while the tab is suspended, so no other tab can adopt while
 * an earlier adopt could still land. A browser without Web Locks does not move
 * at all: it keeps the token (today's way), which is always safe.
 * Not acquired within moveLockMaxMs = the move is tried again later.
 */
let holdsMoveLock: () => boolean = () => false;

function webLocks(): { request: (...args: any[]) => Promise<unknown> } | null {
  const locks = (globalThis as any).navigator?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

async function withCrossTabMoveLock(fn: () => Promise<void>): Promise<boolean> {
  const locks = webLocks();
  if (!locks) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), sessionTiming.moveLockMaxMs);
  let acquired = false;
  try {
    await locks.request('shutfey-cookie-move', { signal: ctrl.signal }, async () => {
      acquired = true;
      clearTimeout(timer);
      holdsMoveLock = () => true;
      try {
        await fn();
      } finally {
        holdsMoveLock = () => false;
      }
    });
  } catch {
    // not acquired in time (or the move failed)
  } finally {
    clearTimeout(timer);
  }
  return acquired;
}

/** 11a-c: true when the server has confirmed the cookie sign-out (2xx), or there was nothing to end (401). */
async function postLogoutOnCookie(headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await sendLogoutRequest(headers);
    await res.text().catch(() => '');
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

async function sendPendingLogout(headers: Record<string, string>): Promise<void> {
  const waits = [0, ...sessionTiming.storeRetryDelaysMs];
  for (const waitMs of waits) {
    if (waitMs) await sleep(waitMs);
    // A tablet QR sign-in on its way sets a new sign-in cookie: wait for it (it clears the mark if it
    // signed in). Still on its way: send nothing now (the mark stays; the next start sends it).
    if (signInsInFlight.size > 0 && !(await cookieSignInsSettled())) return;
    // A new sign-in meanwhile cleared the mark: its cookie must not be ended.
    if (readKey(LOGOUT_PENDING_KEY) !== '1') return;
    if (await postLogoutOnCookie(headers)) {
      if (readKey(LOGOUT_PENDING_KEY) === '1' && !getSessionToken() && !isCookieSession()) writeKey(LOGOUT_PENDING_KEY, null);
      return;
    }
  }
}

/**
 * Item 11: the WebSocket was closed 4401 ("session ended"). Confirm over HTTP
 * with the socket's own token before signing out, so a socket the server closed
 * while handing this device a fresh token (change password, merge) never signs
 * the person out. 'ended' = a 401 for the token this device still holds (signed
 * out here, the same way as any 401); 'valid' = the session works; 'unknown' =
 * no answer, 503, a newer token or a sign-in change meanwhile (reconnect later).
 * 11a-c: the socket's credential may be the cookie ('cookie:<n>' from
 * sessionCredentialKey()); then the check is sent on the cookie, no token.
 */
export async function confirmSessionAfterSocketRefusal(
  token: string,
  stillWanted: () => boolean = () => true
): Promise<'ended' | 'valid' | 'unknown'> {
  const onCookie = token.startsWith('cookie:');
  const headers: Record<string, string> = sessionAuthHeaders(onCookie ? null : token);
  const kioskDevice = getKioskDeviceSecret();
  if (kioskDevice) headers['X-Kiosk-Device'] = kioskDevice;
  let res: Response;
  try {
    res = await fetch('/api/agencies/current', { headers, credentials: 'same-origin' });
  } catch {
    return 'unknown';
  }
  // Domains PR B: refused on this address (the token, or this device's cookie key).
  if ((await noticeSiteRefusalFor(res, token)) === 'cleared') return 'ended';
  if (res.status === 401) {
    const code = await unauthorizedCode(res);
    // After the last await: a token stored meanwhile is a newer session, a
    // sign-in change on its way may store one, and a socket the client dropped
    // or replaced no longer speaks for this device — in each case keep it.
    if (sessionCredentialKey() !== token || signInChangePending() || !stillWanted()) return 'unknown';
    applyKioskUnpaired(code);
    signOutLocally(code);
    return 'ended';
  }
  return res.ok ? 'valid' : 'unknown';
}

// ---------------------------------------------------------------------------
// 11a-c: the move from the stored token to the cookie, and the start check.
// ---------------------------------------------------------------------------

/** An endpoint the server does not have (an older server): today's way stays, for this page load. */
let cookieMoveUnsupported = false;
let syncRunning: Promise<void> | null = null;
let syncAgain = false;

interface MeAnswer { status: number; userId?: string; auth?: string; kiosk?: { venueId?: string; deviceId?: string } }

async function readMe(headers: Record<string, string>): Promise<MeAnswer> {
  // Domains PR B: the device sign-in this check speaks for (token or cookie: one session).
  const sentKey = sessionCredentialKey();
  try {
    const res = await fetch('/api/auth/me', { headers, credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) {
      await noticeSiteRefusalFor(res, sentKey);
      await res.text().catch(() => '');
      return { status: res.status };
    }
    const body = await res.json().catch(() => null);
    const userId = body && body.user && typeof body.user.id === 'string' ? body.user.id : undefined;
    const kiosk = body && body.kiosk && typeof body.kiosk === 'object' ? body.kiosk : undefined;
    return { status: res.status, userId, auth: body ? body.auth : undefined, kiosk };
  } catch {
    return { status: 0 };
  }
}

/**
 * One try at moving the stored token to the cookie. Returns without changing
 * anything unless every step answered as expected:
 *  1. GET /api/auth/me with the token: who it is (and which tablet). 404 = older server.
 *  2. POST /api/auth/session/adopt (or /api/kiosk/session/adopt on a tablet)
 *     with the token: 200 sets the cookie. 404 or 403 = keep today's way.
 *  3. GET /api/auth/me with the cookie only (no token, no device header): the
 *     same person (and tablet), auth 'cookie'.
 *  4. No sign-in change on its way and the same token still stored: switch to
 *     the cookie and delete the token (a tablet keeps only 'cookie:<deviceId>').
 * 401, 503, offline or anything else: keep the token; tried again on the next
 * start or the next stored token. Never a sign-out (only apiFetch signs out).
 */
async function moveTokenToCookie(token: string): Promise<void> {
  // A sign-out still on its way would delete the cookie this sign-in is about to use.
  if (!(await waitForLogoutsToSettle())) {
    movePostponed = true;
    return;
  }
  if (getSessionToken() !== token) return;
  const deviceSecret = getKioskDeviceSecret();
  const bearer: Record<string, string> = sessionAuthHeaders(token);
  if (deviceSecret) bearer['X-Kiosk-Device'] = deviceSecret;
  const before = await readMe(bearer);
  if (before.status === 404) {
    cookieMoveUnsupported = true;
    return;
  }
  if (before.status !== 200 || !before.userId) return;
  const onTablet = !!before.kiosk;
  if (onTablet && (!before.kiosk?.deviceId || !before.kiosk?.venueId)) return;
  // Right before the adopt (the one step that sets the cookie): the token is
  // still the stored one and this tab holds the move lock. Else: keep the token.
  if (getSessionToken() !== token || getKioskDeviceSecret() !== deviceSecret) return;
  if (!holdsMoveLock()) {
    movePostponed = true;
    return;
  }
  let adopted: Response;
  try {
    // Cut off if it hangs, so no late answer (which sets the cookie) can land
    // after this move is over and another tab's move has started.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), sessionTiming.adoptMaxMs);
    try {
      adopted = await fetch(onTablet ? '/api/kiosk/session/adopt' : '/api/auth/session/adopt', {
        method: 'POST',
        headers: bearer,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      // Read the (small) answer so the request is finished, never left open.
      await adopted.clone().text().catch(() => '');
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Cut off (or offline): its answer may still be landing; hold the lock a
    // little longer so no other tab's adopt is answered before it. Token kept.
    await sleep(sessionTiming.adoptAbortGraceMs);
    return;
  }
  // Domains PR B: a site refusal is not "an older server" (the move simply stops).
  if (adopted.status === 403 && (await noticeSiteRefusalFor(adopted, token))) return;
  if (adopted.status === 404 || adopted.status === 403) {
    cookieMoveUnsupported = true;
    return;
  }
  if (!adopted.ok) return;
  const after = await readMe(sessionAuthHeaders(null));
  if (after.status !== 200 || after.auth !== 'cookie' || after.userId !== before.userId) return;
  if (onTablet !== !!after.kiosk) return;
  if (onTablet && (after.kiosk?.deviceId !== before.kiosk?.deviceId || after.kiosk?.venueId !== before.kiosk?.venueId)) return;
  // A sign-in change (change password, merge, switch agency) may still store a newer token.
  if (!(await waitForSignInChangesToSettle())) return;
  // After the last await: only the token that was moved is deleted, and only
  // while this tab holds the move lock.
  if (getSessionToken() !== token || getKioskDeviceSecret() !== deviceSecret) return;
  if (!holdsMoveLock()) {
    movePostponed = true;
    return;
  }
  writeKey(COOKIE_SESSION_KEY, newCookieSessionId());
  writeKey(LOGOUT_PENDING_KEY, null);
  if (onTablet && deviceSecret) setKioskDevice(`${KIOSK_DEVICE_COOKIE_PREFIX}${before.kiosk?.deviceId}`);
  setSessionTokenQuietly(null);
}

/**
 * Kiosk QR: requests whose answer can sign this tablet in (the tablet's poll: a claim answer
 * sets the sign-in cookie on a cookie tablet). A sign-out retry waits for them, and the PIN
 * sign-in waits for them, so no late answer lands on top of a newer sign-in or sign-out.
 * The tracked promise settles only after a late claim nobody uses has been ended.
 */
const signInsInFlight = new Set<Promise<unknown>>();
export function trackCookieSignInRequest<T>(p: Promise<T>): Promise<T> {
  signInsInFlight.add(p);
  const done = () => { signInsInFlight.delete(p); };
  p.then(done, done);
  return p;
}
/** Resolves true once no tracked sign-in request is on its way (false after maxMs). */
export async function cookieSignInsSettled(maxMs = 30000): Promise<boolean> {
  const started = Date.now();
  while (signInsInFlight.size > 0) {
    if (Date.now() - started >= maxMs) return false;
    await sleep(50);
  }
  return true;
}
/**
 * Resolves true once no sign-out request is on its way in any tab (false after maxMs): the same
 * conservative rule as the move to the cookie (a key left by a page that is gone counts for up to
 * logoutUnknownMaxMs, since its keepalive request may still land and delete the sign-in cookie).
 */
export function signOutsSettled(maxMs = sessionTiming.logoutSettleMaxMs): Promise<boolean> {
  return waitForLogoutsToSettle(maxMs);
}
/**
 * A tablet QR sign-in whose answer came after the screen was left (nobody will use it): end it
 * on the server. Its own token (a header tablet), or the sign-in cookie that answer just set.
 * Tracked as a sign-out, so a sign-in made next waits for it before moving to the cookie.
 */
export async function endUnusedKioskSignIn(token: string | null): Promise<void> {
  const headers: Record<string, string> = { [COOKIE_AUTH_HEADER]: COOKIE_AUTH_VALUE };
  if (token) headers.Authorization = `Bearer ${token}`;
  const kioskDevice = getKioskDeviceSecret();
  if (kioskDevice) headers['X-Kiosk-Device'] = kioskDevice;
  for (const waitMs of [0, ...sessionTiming.storeRetryDelaysMs]) {
    if (waitMs) await sleep(waitMs);
    try {
      const res = await sendLogoutRequest(headers);
      await res.text().catch(() => '');
      if (res.status !== 503) return;
    } catch {
      return;
    }
  }
}

/**
 * Kiosk QR sign-in on a tablet paired with the device cookie: the server set the sign-in cookie in
 * its answer and sent no token. This device is now signed in on the cookie, as after a move: a new
 * cookie sign-in id, no stored token, and an older unconfirmed sign-out never ends this one.
 */
export function noteServerCookieSignIn(): void {
  setSessionTokenQuietly(null);
  writeKey(LOGOUT_PENDING_KEY, null);
  writeKey(COOKIE_SESSION_KEY, newCookieSessionId());
}

/** Clears the stored token without starting another move (the cookie now carries the sign-in). */
function setSessionTokenQuietly(token: string | null): void {
  credentialGeneration++;
  writeKey(TOKEN_KEY, token);
}

async function syncOnce(): Promise<void> {
  const token = getSessionToken();
  if (token) {
    // No Web Locks (an old browser): stay on the token, today's way.
    if (cookieMoveUnsupported || !webLocks()) return;
    movePostponed = false;
    const acquired = await withCrossTabMoveLock(() => moveTokenToCookie(token));
    // Another tab's move or a sign-out on its way: the token is kept, try again later.
    if (!acquired || movePostponed) scheduleMoveRetry();
    return;
  }
  if (isCookieSession()) {
    // Start check on the cookie: who is signed in. apiFetch's rules apply:
    // a 401 signs out, a 503 is tried again and is never a sign-out.
    try {
      const res = await apiFetch('/api/auth/me', { cache: 'no-store' });
      await res.text().catch(() => '');
    } catch {
      // offline: stay signed in, the next request will tell
    }
    return;
  }
  // Signed out with an unconfirmed cookie sign-out: send it again.
  if (readKey(LOGOUT_PENDING_KEY) === '1') {
    const headers = sessionAuthHeaders(null);
    const kioskDevice = getKioskDeviceSecret();
    if (kioskDevice) headers['X-Kiosk-Device'] = kioskDevice;
    await sendPendingLogout(headers);
  }
}

let movePostponed = false;
let moveRetryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleMoveRetry(): void {
  if (moveRetryTimer) return;
  moveRetryTimer = setTimeout(() => {
    moveRetryTimer = null;
    if (getSessionToken()) void syncCookieSession();
  }, sessionTiming.movePostponedRetryMs);
}

/** Runs the move / start check once at a time; a request meanwhile runs it once more afterwards. */
export function syncCookieSession(): Promise<void> {
  if (syncRunning) {
    syncAgain = true;
    return syncRunning;
  }
  syncRunning = (async () => {
    try {
      do {
        syncAgain = false;
        await syncOnce();
      } while (syncAgain);
    } finally {
      syncRunning = null;
    }
  })();
  return syncRunning;
}

/**
 * Called once by the app at start: checks the sign-in now (GET /api/auth/me,
 * or the move of a stored token to the cookie) and moves every token stored
 * later (a new sign-in). Returns a function that stops the later moves.
 */
export function startCookieSession(): () => void {
  const run = () => {
    void syncCookieSession();
  };
  onTokenStored = run;
  run();
  return () => {
    if (onTokenStored === run) onTokenStored = null;
  };
}

/**
 * 11a-c, kiosk clean slate (?kiosk=1): the stored token is forgotten as
 * today; the server session behind it, and any sign-in cookie this browser
 * holds (U, or a kiosk K), is ended too, so a cookie cannot carry the previous
 * person into kiosk mode. The tablet's device cookie D is kept.
 */
export function endSessionForKioskEntry(): void {
  const token = getSessionToken();
  if (token || isCookieSession()) void endServerSession(token);
  credentialGeneration++;
  writeKey(COOKIE_SESSION_KEY, null);
}

/** Tests only: forget what this page load learned about the server. */
export function resetCookieSessionForTests(): void {
  cookieMoveUnsupported = false;
  syncAgain = false;
  logoutsInFlight.clear();
  movePostponed = false;
  if (moveRetryTimer) clearTimeout(moveRetryTimer);
  moveRetryTimer = null;
}

// ---------------------------------------------------------------------------
// Stage 2 version contract (client side).
//
// The server stamps every /api response with X-State-Version (the _v of the
// single app-state/main Firestore document) and every WebSocket message with
// `version`. This module remembers the highest version seen.
//
// WRITE BASELINE CONTRACT (round 5 — the core rule):
//   expectedVersion sent with a write = the document version the data being
//   written was RENDERED FROM. Full stop.
//
//   For form-based edits (task edit modal, notes editor, etc.): capture the
//   baseline when the form LOADS/OPENS via captureEditBaseline(), keep it
//   until the save succeeds, and pass it as expectedVersion explicitly.
//   NEVER use the latest-observed version (lastKnownVersion) as a write
//   baseline for a form: the browser may have heard a newer version over
//   WebSocket AFTER the form rendered, and sending that newer version would
//   silently overwrite someone else's change with stale form data.
//
//   lastKnownVersion remains useful for optimistic UI freshness (e.g.
//   "newer data available" banners) — but it is NOT a write baseline.
//
// The server rejects with 409 VERSION_CONFLICT (version sent but outdated)
// or 428 STALE_CLIENT (no version sent at all — e.g. an old cached PWA
// client).
// ---------------------------------------------------------------------------

let lastKnownVersion: number | undefined = undefined;

/** Highest document version observed from API responses / WS messages. */
export function getLastKnownVersion(): number | undefined {
  return lastKnownVersion;
}

/** Record a version seen from the server (keeps the max). */
export function observeVersion(v: unknown): void {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (Number.isFinite(n) && n >= 0 && (lastKnownVersion === undefined || n > lastKnownVersion)) {
    lastKnownVersion = n;
  }
}

/**
 * Capture the write baseline for an edit form. Call this when the form
 * LOADS or OPENS (not when the user hits save) — it snapshots the document
 * version the form's data was rendered from. Pass the returned value as
 * `expectedVersion` to apiWrite when saving.
 *
 * Why a snapshot, not getLastKnownVersion() at save time: a WebSocket update
 * can arrive while the form is open, bumping lastKnownVersion past what the
 * form shows. Saving with that newer version would silently overwrite the
 * other user's change with this form's stale data. The snapshot freezes the
 * baseline at what the user actually saw.
 *
 * If the baseline is stale by save time, the server answers 409 and the
 * existing conflict flow (draft preserved, re-apply banner) handles it.
 */
export function captureEditBaseline(): number | undefined {
  return lastKnownVersion;
}

/**
 * Read the document version from a specific fetch Response's
 * X-State-Version header — WITHOUT touching the global tracker. Use this
 * for the precise pattern: the version that came with the exact response
 * whose body populated the form.
 *
 *   const res = await apiFetch('/api/tasks/123');
 *   const baseline = versionFromResponse(res); // version this data came from
 *   const task = await res.json();
 *   // ... later, on save:
 *   await apiWrite('/api/tasks/123', { method: 'PUT', expectedVersion: baseline, ... });
 */
export function versionFromResponse(res: Response): number | undefined {
  try {
    const h = res.headers.get('X-State-Version');
    if (!h) return undefined;
    const n = Number(h);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function trackVersionHeader(res: Response): void {
  try {
    const h = res.headers.get('X-State-Version');
    if (h) observeVersion(h);
  } catch {
    // ignore — version tracking is best-effort
  }
}

// ---------------------------------------------------------------------------
// Stale-client drafts: when the server answers 428 STALE_CLIENT, the user's
// screen is older than the version contract and must refresh — but the
// user's unsaved input must NOT be silently discarded. Callers pass
// `draft: { key, label, data }`; apiWrite persists it to localStorage and the
// app offers to re-apply it after refresh (see App.tsx stale-draft banner).
// ---------------------------------------------------------------------------

export interface StaleDraft {
  /** Stable key, e.g. 'checkin:task-123'. One draft per key (latest wins). */
  key: string;
  /** Human-readable label shown in the restore banner. */
  label: string;
  /** Endpoint + method + JSON body needed to re-apply the write. */
  endpoint: string;
  method: string;
  body: unknown;
  savedAt: string;
}

const DRAFTS_KEY = 'shutfey_stale_drafts';

export function loadStaleDrafts(): StaleDraft[] {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveStaleDraft(draft: StaleDraft): void {
  try {
    const rest = loadStaleDrafts().filter((d) => d.key !== draft.key);
    localStorage.setItem(DRAFTS_KEY, JSON.stringify([...rest, draft]));
    try {
      window.dispatchEvent(new CustomEvent('shutfey:stale-draft'));
    } catch {
      // ignore
    }
  } catch {
    // storage unavailable — the in-memory form state is still intact
  }
}

export function discardStaleDraft(key: string): void {
  try {
    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify(loadStaleDrafts().filter((d) => d.key !== key))
    );
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Structured write helper (Stage 2: transactional backend).
// Writes can now fail with 409 (version/conflict — someone else changed the
// data) or 503 (save failed — the database was unreachable). Every POST/PUT/
// DELETE/PATCH call should go through apiWrite instead of apiFetch so those
// failures surface as friendly messages instead of silent no-ops or fake
// success toasts.
// ---------------------------------------------------------------------------

export interface ApiWriteResult<T = any> {
  /** true only when the server confirmed the write (res.ok). */
  ok: boolean;
  status: number;
  /** Parsed response body on success; parsed error body (or null) on failure. */
  data: T;
  /** Friendly, display-ready error message when ok === false. */
  error: string | null;
  /** Server error code when provided (e.g. VERSION_CONFLICT, SAVE_FAILED). */
  code?: string;
}

/**
 * Friendly message for a failed write. Prefers the server's message when it
 * is user-facing (Stage 2 conflict/save-failure messages are), otherwise
 * falls back to plain wording for the status.
 */
export function describeWriteError(status: number, serverMessage?: string): string {
  if (serverMessage && serverMessage.trim()) return serverMessage.trim();
  if (status === 428)
    return 'Your app is out of date — please refresh the app, then try again. Your input was saved.';
  if (status === 409) return 'Someone else changed this — please review and retry.';
  if (status === 503) return "Couldn't save — please check your connection and retry.";
  if (status === 0) return "Couldn't save — please check your connection and retry.";
  if (status === 401) return 'Your session expired — please sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'That item no longer exists — it may have been deleted.';
  return "Couldn't save — please try again.";
}

/**
 * Generate a stable operation ID for ONE user action. Call this ONCE when the
 * user initiates the action (e.g., on button click), then pass the same ID to
 * apiWrite on every attempt including retries. Do NOT generate a new ID per
 * retry — the server uses it to detect duplicate submissions.
 *
 * Example:
 *   const actionId = newActionId();
 *   const attempt = async () => apiWrite('/api/tasks/123', {
 *     method: 'PUT',
 *     body: JSON.stringify({ ... }),
 *     operationId: actionId,  // same ID on retry
 *     // expectedVersion: pass the form's captured baseline explicitly for
 *     // edits (captureEditBaseline() at form load). The auto-injected
 *     // last-seen version is only a fallback for non-form writes.
 *   });
 */
export function newActionId(): string {
  return crypto.randomUUID();
}

/**
 * POST/PUT/DELETE/PATCH wrapper: performs the request, parses the body, and
 * returns a structured result. Never throws for HTTP error statuses; only
 * throws on truly unexpected failures. Callers must check `result.ok` before
 * treating the write as successful or showing a success toast.
 *
 * Versioning & idempotency contract (Stage 2):
 * - `expectedVersion`: the DOCUMENT version the data being written was
 *   RENDERED FROM (the write baseline — see the contract above). For
 *   form-based edits, capture it with captureEditBaseline() when the form
 *   loads and pass it explicitly. If omitted on PUT/PATCH/DELETE, apiWrite
 *   falls back to the last version this client saw — correct only for
 *   writes whose data was just fetched or re-rendered from the latest
 *   state; form saves MUST pass an explicit baseline.
 *   The server rejects with 409 VERSION_CONFLICT if it doesn't match the
 *   current version — the screen is stale and must refresh. For creates
 *   (POST to a collection), omit it.
 * - If the server answers 428 STALE_CLIENT, no version was sent at all (old
 *   cached client). The write is rejected safely — never silently applied.
 * - `operationId`: stable UUID per user action (see newActionId()). Generate
 *   ONCE per action in the UI component, reuse on retry. If omitted, apiWrite
 *   generates one — but then retries from the caller MUST pass the same ID
 *   back, or the retry becomes a separate operation.
 * - `draft`: on 428 STALE_CLIENT, persist the user's input so a refresh does
 *   not silently discard it. The app restores it from localStorage.
 */
/** Writes sent and not answered yet (the update bar waits for 0: lib/updateSafety.ts). */
let inFlightWrites = 0;
export function writesInFlight(): number {
  return inFlightWrites;
}

type ApiWriteInit = RequestInit & {
  expectedVersion?: number;
  operationId?: string;
  draft?: { key: string; label: string; data: () => unknown };
};

export async function apiWrite<T = any>(input: string, init: ApiWriteInit = {}): Promise<ApiWriteResult<T>> {
  inFlightWrites++;
  try {
    return await apiWriteOnce<T>(input, init);
  } finally {
    inFlightWrites = Math.max(0, inFlightWrites - 1);
  }
}

async function apiWriteOnce<T = any>(input: string, init: ApiWriteInit): Promise<ApiWriteResult<T>> {
  const { expectedVersion, operationId, draft, ...fetchInit } = init;
  // Stable operationId: reuse the caller's (for retries) or generate once.
  const opId = operationId || crypto.randomUUID();
  const method = (fetchInit.method || 'POST').toUpperCase();
  // Version contract: updates automatically carry the last version this
  // client saw. An explicit expectedVersion from the caller wins.
  const versionToSend =
    expectedVersion !== undefined
      ? expectedVersion
      : method === 'PUT' || method === 'PATCH' || method === 'DELETE'
        ? getLastKnownVersion()
        : undefined;

  let res: Response;
  let sentBody: unknown = undefined;
  // For body-less updates (e.g. DELETE with no body), the version and
  // operation ID travel as query params — the server reads both places.
  let url = input;
  if (!fetchInit.body && versionToSend !== undefined) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}expectedVersion=${encodeURIComponent(String(versionToSend))}&operationId=${encodeURIComponent(opId)}`;
  }
  try {
    // Inject versioning fields into the JSON body.
    let body = fetchInit.body;
    const headers = new Headers(fetchInit.headers || {});
    if (body && typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (versionToSend !== undefined && parsed.expectedVersion === undefined) {
            parsed.expectedVersion = versionToSend;
          }
          if (!parsed.operationId) {
            parsed.operationId = opId;
          }
          body = JSON.stringify(parsed);
          sentBody = parsed;
        }
      } catch {
        // Not JSON — send as-is; server will handle missing fields.
      }
    }
    if (!headers.has('Content-Type') && typeof body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
    res = await apiFetch(url, { ...fetchInit, body, headers });
  } catch {
    return {
      ok: false,
      status: 0,
      data: null as T,
      error: describeWriteError(0),
      code: 'NETWORK_ERROR',
    };
  }
  const data = (await res.json().catch(() => ({}))) as T;
  if (res.ok) {
    return { ok: true, status: res.status, data, error: null };
  }
  const body = (data || {}) as Record<string, any>;
  const code = typeof body.code === 'string' ? body.code : undefined;
  const serverMessage = typeof body.error === 'string' ? body.error : undefined;
  // Stale client: the write was rejected safely. Preserve the user's input
  // so the required refresh does not silently discard it.
  if (res.status === 428 && draft) {
    try {
      saveStaleDraft({
        key: draft.key,
        label: draft.label,
        endpoint: input,
        method,
        body: sentBody !== undefined ? sentBody : draft.data(),
        savedAt: new Date().toISOString(),
      });
    } catch {
      // ignore — the form state in memory is still intact
    }
  }
  return {
    ok: false,
    status: res.status,
    data,
    error: describeWriteError(res.status, serverMessage),
    code,
  };
}
