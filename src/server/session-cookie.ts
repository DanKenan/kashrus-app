/**
 * Item 11, PR 11a-s2 (plan v8 sections 9.2, 9.3, 10.6, 11a-s): the user
 * session cookie and the trusted-origin rule. Pure helpers only (no Express,
 * no Firestore); server.ts owns the routes. stage4 imports this file under
 * plain node (checklist CU).
 *
 * U = the user session cookie. Production: __Host-shutfey_s with Secure,
 * HttpOnly, Path=/, no Domain (host-only), SameSite=Lax. Test mode only (plain
 * http on loopback): the name drops the __Host- prefix and Secure, because a
 * browser refuses __Host- cookies without Secure (plan 10.6).
 */

export const USER_COOKIE_PROD = '__Host-shutfey_s';
export const USER_COOKIE_TEST = 'shutfey_s';

/** The production origin when APP_ORIGINS is not configured (today's only host; Don: "no domain for now"). */
export const DEFAULT_APP_ORIGINS = ['https://workers-collaborative-dashboard-1080260390009.us-east1.run.app'];

export type CookieConfig = { name: string; secure: boolean };

export function userCookieConfig(testMode: boolean): CookieConfig {
  return testMode ? { name: USER_COOKIE_TEST, secure: false } : { name: USER_COOKIE_PROD, secure: true };
}

/**
 * 11a-s3 (plan 9.2): K = the kiosk session cookie (a kiosk token backed by a
 * kiosk session record), D = the kiosk device cookie (the paired tablet's
 * credential '<deviceId>.<secret>'). Same attributes and test-mode rule as U.
 */
export const KIOSK_COOKIE_PROD = '__Host-shutfey_ks';
export const KIOSK_COOKIE_TEST = 'shutfey_ks';
export const DEVICE_COOKIE_PROD = '__Host-shutfey_kd';
export const DEVICE_COOKIE_TEST = 'shutfey_kd';
/** D lives as long as browsers allow (400 days); it is set again on every kiosk sign-in. Unpairing deletes it. */
export const DEVICE_COOKIE_MAX_AGE_SEC = 400 * 24 * 3600;

export function kioskCookieConfig(testMode: boolean): CookieConfig {
  return testMode ? { name: KIOSK_COOKIE_TEST, secure: false } : { name: KIOSK_COOKIE_PROD, secure: true };
}
export function deviceCookieConfig(testMode: boolean): CookieConfig {
  return testMode ? { name: DEVICE_COOKIE_TEST, secure: false } : { name: DEVICE_COOKIE_PROD, secure: true };
}

/** A device credential is '<id>.<secret>', both base64url-ish, as the X-Kiosk-Device header carries it. */
const DEVICE_CREDENTIAL_SHAPE = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,128}$/;
export function isDeviceCredentialShape(x: unknown): x is string {
  return typeof x === 'string' && DEVICE_CREDENTIAL_SHAPE.test(x);
}
export function setDeviceCookieHeader(cfg: CookieConfig, credential: string, maxAgeSec: number = DEVICE_COOKIE_MAX_AGE_SEC): string {
  if (!isDeviceCredentialShape(credential)) throw new Error('setDeviceCookieHeader: bad value');
  const age = Math.max(0, Math.floor(maxAgeSec));
  return `${cfg.name}=${credential}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${cfg.secure ? '; Secure' : ''}`;
}

/** Every value the Cookie header carries for this name, in order (a duplicate is the caller's to refuse). */
export function cookieValues(header: unknown, name: string): string[] {
  const out: string[] = [];
  const raw = Array.isArray(header) ? header.join('; ') : typeof header === 'string' ? header : '';
  if (!raw || raw.length > 16384) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let v = part.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out.push(v);
  }
  return out;
}

/** A session token is base64url.base64url.base64url; anything else never becomes a cookie. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function setCookieHeader(cfg: CookieConfig, value: string, maxAgeSec: number): string {
  if (!TOKEN_SHAPE.test(value) || value.length > 4000) throw new Error('setCookieHeader: bad value');
  const age = Math.max(0, Math.floor(maxAgeSec));
  return `${cfg.name}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${cfg.secure ? '; Secure' : ''}`;
}

export function clearCookieHeader(cfg: CookieConfig): string {
  return `${cfg.name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${cfg.secure ? '; Secure' : ''}`;
}

/** scheme://host[:port] of an absolute http(s) URL, lower-cased; null for anything else. */
export function normalizeOrigin(x: unknown): string | null {
  if (typeof x !== 'string' || !x || x.length > 512) return null;
  try {
    const u = new URL(x);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Plan 9.3 / 10.6: the trusted origins come from server config only (APP_ORIGINS,
 * comma-separated https origins), falling back to DEFAULT_APP_ORIGINS; never
 * from Host or X-Forwarded-*. Test mode adds http://127.0.0.1:<port> and
 * http://localhost:<port> of this server. Production ignores http entries.
 */
export function trustedOrigins(input: { appOrigins?: unknown; testMode: boolean; port: number }): string[] {
  const listed = typeof input.appOrigins === 'string' && input.appOrigins.trim()
    ? input.appOrigins.split(',').map((s) => normalizeOrigin(s.trim())).filter((o): o is string => !!o)
    : [];
  const base = (listed.length ? listed : DEFAULT_APP_ORIGINS).filter((o) => input.testMode || o.startsWith('https://'));
  const out = new Set(base);
  if (input.testMode && Number.isInteger(input.port) && input.port > 0) {
    out.add(`http://127.0.0.1:${input.port}`);
    out.add(`http://localhost:${input.port}`);
  }
  return Array.from(out);
}

/** True only for an Origin header that is exactly one of the trusted origins (missing, "null" or malformed: false). */
export function originTrusted(originHeader: unknown, trusted: readonly string[]): boolean {
  if (typeof originHeader !== 'string' || originHeader !== originHeader.trim()) return false;
  const o = normalizeOrigin(originHeader);
  if (!o || o !== originHeader) return false; // byte-exact (browsers send the serialized, lower-case origin)
  return trusted.includes(o);
}

export const CSRF_ORIGIN_BODY = { error: 'This request came from another site and was refused.', code: 'CSRF_ORIGIN' } as const;
