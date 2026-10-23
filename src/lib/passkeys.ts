// Item 11b-c: Face ID / fingerprint sign-in (passkeys), client side.
// Server: #138 (routes below). Browser side: @simplewebauthn/browser (B13).
import {
  WebAuthnAbortService,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { apiFetch } from './api';

/**
 * EVERY word the person sees for this feature, in one place, so the name of
 * the feature (Don's pick, Oct 22: "Quick sign-in", with "Face ID or
 * fingerprint" under it) changes in one commit. Plain words
 * only: never "WebAuthn" (plan 11b-c).
 */
export const PASSKEY_TEXT = {
  // sign-in page
  signInButton: 'Quick sign-in',
  signInSubline: 'Face ID or fingerprint',
  waiting: 'Waiting for Face ID or fingerprint…',
  or: 'or',
  // one-time offer after a password sign-in
  offerTitle: 'Sign in faster next time?',
  offerBody: 'Use Face ID or your fingerprint instead of typing your password on this phone. Your password keeps working.',
  offerAdd: 'Add Face ID or fingerprint',
  offerNotNow: 'Not now',
  offerLater: 'You can add it later from the menu, under Face ID or fingerprint.',
  tryAgain: 'Try again',
  ok: 'OK',
  doneTitle: 'Quick sign-in is on',
  doneBody: 'Next time, tap "Quick sign-in" on this phone. Your password still works too.',
  done: 'Done',
  passwordTitle: 'Enter your password',
  passwordPlaceholder: 'Password',
  continue: 'Continue',
  // menu + settings list
  menuRow: 'Face ID or fingerprint',
  listTitle: 'Face ID or fingerprint',
  listSubtitle: 'Sign in without typing your password',
  listAria: 'Your passkeys',
  loading: 'Loading…',
  emptyTitle: 'No Face ID or fingerprint added yet',
  emptyBody: 'Add it on each phone you use. Your password keeps working.',
  addButton: 'Add Face ID or fingerprint on this phone',
  added: 'Added',
  lastUsed: 'Last used',
  nameLabel: 'Name',
  save: 'Save',
  cancel: 'Cancel',
  rename: (name: string) => `Rename ${name}`,
  remove: (name: string) => `Remove ${name}`,
  removeTitle: (name: string) => `Remove "${name}"?`,
  removeBody: 'Anyone signed in with it is signed out, and that phone will need your password next time. Enter your password to confirm.',
  removeButton: 'Remove',
  yourPassword: 'Your password',
  addedToast: 'Face ID or fingerprint added.',
  removedToast: 'Removed.',
  // errors and limits, in plain words
  unsupported: "This phone or browser can't use Face ID or fingerprint sign-in. Your password still works.",
  cancelled: 'Face ID or fingerprint was cancelled or timed out. Nothing was changed.',
  signInCancelled: 'Face ID or fingerprint was cancelled. Try again, or sign in with your password.',
  signInFailed: "That Face ID or fingerprint isn't set up for Shutfey on this phone. Sign in with your password, then add it from the menu.",
  alreadyOnPhone: 'Face ID or fingerprint is already set up for your account on this phone.',
  unavailable: "Quick sign-in isn't available for this account. Your password keeps working.",
  limit: 'You already have 10 passkeys. Remove one to add another.',
  saveFailed: "Face ID or fingerprint couldn't be saved. Please try again.",
  renameFailed: "The name couldn't be saved. Please try again.",
  removeFailed: "It couldn't be removed. Please try again.",
  needPassword: 'To keep your account safe, enter your password first.',
  wrongPassword: 'That password is not right. Please try again.',
  offline: "Can't reach Shutfey right now. Please try again in a moment.",
} as const;

/**
 * A step-by-step action stops (PasskeyError 'stale', shown to nobody) as soon
 * as this returns false: the dialog closed, or the browser is now signed in as
 * someone else (another tab, a sign-out). Checked before every request and
 * before asking the phone.
 */
export type StillValid = () => boolean;
const stale = () => new PasskeyError('stale', '');
const check = (stillValid?: StillValid) => { if (stillValid && !stillValid()) throw stale(); };

/** Domains PR B (plan 2d): which address a passkey belongs to, as the server labels it (no host is guessed here). */
export type PasskeyAddress = { kind: 'shared' } | { kind: 'site'; agencyName: string } | { kind: 'earlier' } | { kind: 'other' };
export interface PasskeyRow { id: string; name: string; createdAt: string; lastUsedAt: string | null; address?: PasskeyAddress }
export function passkeyAddressFrom(x: unknown): PasskeyAddress | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const k = (x as any).kind;
  if (k === 'shared' || k === 'earlier' || k === 'other') return { kind: k };
  if (k === 'site') {
    const n = (x as any).agencyName;
    return typeof n === 'string' && n.trim() ? { kind: 'site', agencyName: n.trim().slice(0, 200) } : { kind: 'other' };
  }
  return undefined;
}
export function passkeyAddressLabel(a: PasskeyAddress | undefined): string | null {
  if (!a) return null;
  if (a.kind === 'shared') return 'Shutfey address';
  if (a.kind === 'site') return `${a.agencyName} address`;
  if (a.kind === 'earlier') return 'Earlier Shutfey address';
  return 'Another address';
}
export interface PasskeyList { passkeys: PasskeyRow[]; canAdd: boolean }

export type PasskeyErrorKind = 'stale' | 'cancelled' | 'already' | 'unavailable' | 'limit' | 'failed' | 'needPassword' | 'wrongPassword' | 'offline' | 'unsupported';
export class PasskeyError extends Error {
  constructor(public kind: PasskeyErrorKind, message: string) { super(message); this.name = 'PasskeyError'; }
}

/** The server's fresh-proof window: a password sign-in counts for 5 minutes (#138). */
export const PASSWORD_PROOF_MS = 5 * 60 * 1000;
const PW_SIGNIN_KEY = 'shutfey_password_signin_at';
const offerDismissedKey = (userId: string) => `shutfey_passkey_offer_off:${userId}`;

/**
 * Written only when a PASSWORD sign-in has completed on this tab, for the
 * account it opened (after the agency chooser too), with the time the password
 * was accepted. Read once by that account; anything else is ignored.
 */
export function markPasswordSignIn(userId: string, at: number = Date.now()): void {
  if (!userId) return;
  try { sessionStorage.setItem(PW_SIGNIN_KEY, JSON.stringify({ u: userId, at })); } catch { /* ignore */ }
}
export function clearPasswordSignInMark(): void {
  try { sessionStorage.removeItem(PW_SIGNIN_KEY); } catch { /* ignore */ }
}
/**
 * Read once (the mark is removed whatever it says). Returns the moment the
 * offer stops being allowed (password time + 5 min) when the mark is this
 * account's and still inside the window; otherwise null.
 */
export function takePasswordSignInMark(userId: string, now: number = Date.now()): number | null {
  let v: string | null = null;
  try { v = sessionStorage.getItem(PW_SIGNIN_KEY); sessionStorage.removeItem(PW_SIGNIN_KEY); } catch { return null; }
  if (!v || !userId) return null;
  let m: any = null;
  try { m = JSON.parse(v); } catch { return null; }
  const at = m && typeof m === 'object' ? Number(m.at) : NaN;
  if (!m || m.u !== userId || !Number.isFinite(at) || at > now || now - at >= PASSWORD_PROOF_MS) return null;
  return at + PASSWORD_PROOF_MS;
}
/** The account this browser is signed in as now (shared by every tab), or null. */
export function currentAccountId(): string | null {
  try { const u = JSON.parse(localStorage.getItem('current_user') || 'null'); return u && typeof u.id === 'string' ? u.id : null; } catch { return null; }
}
/**
 * The automatic offer is for phones only (a laptop with Touch ID / Windows
 * Hello can still add one from the menu): a touch-first screen whose short
 * side is phone-sized.
 */
export function isPhoneLike(): boolean {
  try {
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const w = Number(window.screen?.width), h = Number(window.screen?.height);
    return coarse && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && Math.min(w, h) < 600;
  } catch { return false; }
}
export function offerDismissed(userId: string): boolean {
  try { return localStorage.getItem(offerDismissedKey(userId)) === '1'; } catch { return true; }
}
export function dismissOffer(userId: string): void {
  try { localStorage.setItem(offerDismissedKey(userId), '1'); } catch { /* ignore */ }
}

/** Stops a Face ID prompt this page started (e.g. the sign-in page closed). */
export function cancelPasskeyPrompt(): void {
  try { WebAuthnAbortService.cancelCeremony(); } catch { /* ignore */ }
}

/** The sign-in button shows only where the browser has passkeys at all. */
export function passkeysInBrowser(): boolean {
  try { return browserSupportsWebAuthn() && !!navigator.credentials; } catch { return false; }
}
/** Adding one needs this phone's own Face ID / fingerprint / screen lock. */
export async function platformPasskeyAvailable(): Promise<boolean> {
  if (!passkeysInBrowser()) return false;
  try { return !!(await platformAuthenticatorIsAvailable()); } catch { return false; }
}

async function body(res: Response): Promise<any> { return res.json().catch(() => ({})); }

/** A server answer -> plain words. A 5xx (503 = store down) is "try again", never a sign-out. */
export function errorFromAnswer(status: number, data: any, fallback: PasskeyError): PasskeyError {
  if (status >= 500) return new PasskeyError('offline', PASSKEY_TEXT.offline);
  const code = data && typeof data === 'object' ? data.code : undefined;
  if (code === 'RECENT_AUTH_REQUIRED') return new PasskeyError('needPassword', PASSKEY_TEXT.needPassword);
  if (code === 'PASSKEY_UNAVAILABLE') return new PasskeyError('unavailable', PASSKEY_TEXT.unavailable);
  if (code === 'PASSKEY_LIMIT') return new PasskeyError('limit', PASSKEY_TEXT.limit);
  if (code === 'WRONG_PASSWORD') return new PasskeyError('wrongPassword', PASSKEY_TEXT.wrongPassword);
  return fallback;
}

/** What the phone said -> plain words. */
export function errorFromBrowser(e: any, cancelledText: string): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const n = typeof e?.name === 'string' ? e.name : '';
  if (n === 'InvalidStateError') return new PasskeyError('already', PASSKEY_TEXT.alreadyOnPhone);
  if (n === 'NotSupportedError' || n === 'SecurityError') return new PasskeyError('unsupported', PASSKEY_TEXT.unsupported);
  if (n === 'NotAllowedError' || n === 'AbortError') return new PasskeyError('cancelled', cancelledText);
  return new PasskeyError('failed', cancelledText === PASSKEY_TEXT.cancelled ? PASSKEY_TEXT.saveFailed : PASSKEY_TEXT.signInFailed);
}

const post = (b: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const netError = () => new PasskeyError('offline', PASSKEY_TEXT.offline);
async function call(input: string, init?: RequestInit): Promise<{ res: Response; data: any }> {
  let res: Response;
  try { res = await apiFetch(input, init); } catch { throw netError(); }
  return { res, data: await body(res) };
}

export async function listPasskeys(): Promise<PasskeyList> {
  const { res, data } = await call('/api/passkeys');
  if (!res.ok) throw errorFromAnswer(res.status, data, netError());
  const rows = Array.isArray(data?.passkeys) ? data.passkeys.filter((p: any) => p && typeof p.id === 'string') : [];
  return { passkeys: rows.map((p: any) => ({ id: p.id, name: typeof p.name === 'string' && p.name ? p.name : 'Passkey', createdAt: p.createdAt ?? '', lastUsedAt: p.lastUsedAt ?? null, address: passkeyAddressFrom(p.address) })), canAdd: data?.canAdd === true };
}

/** POST /api/auth/recent-auth: the password again, for adding after 5 min or removing. */
export async function confirmPassword(password: string): Promise<void> {
  const { res, data } = await call('/api/auth/recent-auth', post({ password }));
  if (!res.ok) throw errorFromAnswer(res.status, data, new PasskeyError('wrongPassword', PASSKEY_TEXT.wrongPassword));
}

export async function addPasskey(opts: { name?: string; stillValid?: StillValid } = {}): Promise<PasskeyRow | null> {
  const { name, stillValid } = opts;
  if (!passkeysInBrowser()) throw new PasskeyError('unsupported', PASSKEY_TEXT.unsupported);
  check(stillValid);
  const opt = await call('/api/passkeys/register/options', post({}));
  check(stillValid);
  if (!opt.res.ok) throw errorFromAnswer(opt.res.status, opt.data, new PasskeyError('failed', PASSKEY_TEXT.saveFailed));
  if (!opt.data?.challengeId || !opt.data?.options) throw new PasskeyError('failed', PASSKEY_TEXT.saveFailed);
  let response: unknown;
  try { response = await startRegistration({ optionsJSON: opt.data.options }); } catch (e) { check(stillValid); throw errorFromBrowser(e, PASSKEY_TEXT.cancelled); }
  check(stillValid);
  const v = await call('/api/passkeys/register/verify', post({ challengeId: opt.data.challengeId, response, ...(name ? { name } : {}) }));
  if (!v.res.ok) throw errorFromAnswer(v.res.status, v.data, new PasskeyError('failed', PASSKEY_TEXT.saveFailed));
  return v.data?.passkey ?? null;
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  const { res, data } = await call(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) throw errorFromAnswer(res.status, data, new PasskeyError('failed', PASSKEY_TEXT.renameFailed));
}

export async function removePasskey(id: string, stillValid?: StillValid): Promise<void> {
  check(stillValid);
  const { res, data } = await call(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw errorFromAnswer(res.status, data, new PasskeyError('failed', PASSKEY_TEXT.removeFailed));
}

/** Passkey sign-in: success is the same body as /api/auth/login (a session, or the agency chooser). */
export async function signInWithPasskey(stillValid?: StillValid): Promise<any> {
  if (!passkeysInBrowser()) throw new PasskeyError('unsupported', PASSKEY_TEXT.unsupported);
  const opt = await call('/api/auth/passkey/options', post({}));
  check(stillValid);
  if (!opt.res.ok) throw errorFromAnswer(opt.res.status, opt.data, new PasskeyError('failed', PASSKEY_TEXT.signInFailed));
  if (!opt.data?.challengeId || !opt.data?.options) throw new PasskeyError('failed', PASSKEY_TEXT.signInFailed);
  let response: unknown;
  try { response = await startAuthentication({ optionsJSON: opt.data.options }); } catch (e) { check(stillValid); throw errorFromBrowser(e, PASSKEY_TEXT.signInCancelled); }
  check(stillValid);
  const v = await call('/api/auth/passkey/verify', post({ challengeId: opt.data.challengeId, response }));
  check(stillValid);
  if (!v.res.ok) throw errorFromAnswer(v.res.status, v.data, new PasskeyError('failed', PASSKEY_TEXT.signInFailed));
  return v.data;
}

export function describeWhen(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const d = new Date(iso); if (isNaN(d.getTime())) return 'never';
  const days = Math.floor((now - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(days > 300 ? { year: 'numeric' } : {}) });
}
