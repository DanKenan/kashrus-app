import { apiFetch, sessionCredentialKey } from './api';
/**
 * Web Push (phone notifications) — subscribe / unsubscribe this device.
 *
 * Flow: user taps the bell -> Notification permission -> PushManager.subscribe
 * with the server's VAPID public key -> subscription POSTed to the server.
 * The server then pushes event/task assignments to this device, even with the
 * app closed. iOS requires the PWA to be installed to the Home Screen (16.4+).
 */

export type PushState = 'unsupported' | 'default' | 'granted' | 'denied' | 'subscribed';
/** PUSHALWAYS: this phone's setting on the server. 'all' = every push;
 * 'tagged' = the button's "Off": only when the person is tagged or assigned
 * (tags, @All, tasks/events assigned to them, overdue on their task, their alerts). */
export type PushMode = 'all' | 'tagged';
export const PUSH_CHANGED_EVENT = 'shutfey-push-changed';

const modeKey = (userId: string) => `shutfey_push_mode:${userId}`;
/** The last setting this phone had for this person (null = never set here). */
export function rememberedPushMode(userId: string): PushMode | null {
  try { const v = localStorage.getItem(modeKey(userId)); return v === 'all' || v === 'tagged' ? v : null; } catch { return null; }
}
function rememberPushMode(userId: string | undefined, mode: PushMode): void {
  if (!userId) return;
  try { localStorage.setItem(modeKey(userId), mode); } catch { /* private mode: fine */ }
}
function announce(): void {
  try { window.dispatchEvent(new Event(PUSH_CHANGED_EVENT)); } catch { /* no window */ }
}
/** serviceWorker.ready never settles where no worker is registered: bounded. */
async function readyRegistration(ms = 6000): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready.catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await readyRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) return 'subscribed';
  } catch {
    return 'default';
  }
  return Notification.permission === 'granted' ? 'granted' : 'default';
}

/**
 * PUSHALWAYS (review PARV1): the state the menu and banner show, confirmed by
 * the server. A browser subscription the server does not hold for this person
 * is NOT shown as on (nothing would reach them): it reads as 'granted' (not
 * set up), so the banner/button offer Turn on, which registers it again.
 * If the server cannot be asked, the browser's own state stands.
 */
export async function getPushSetup(userId: string): Promise<PushSetup> {
  const cred0 = sessionCredentialKey();
  const gen0 = explicitGen;
  const isStale = () => explicitGen !== gen0 || sessionCredentialKey() !== cred0;
  const done = (r: PushSetup): PushSetup => (isStale() ? { ...r, stale: true } : r);
  const state = await getPushState();
  if (state !== 'subscribed') return done({ state, mode: null });
  try {
    const reg = await readyRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return done({ state: await getPushState(), mode: null });
    const st = await apiFetch('/api/push/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (!st.ok) return done({ state: 'subscribed', mode: rememberedPushMode(userId) ?? 'all' });
    const d = await st.json();
    if (!d.registered) return done({ state: 'granted', mode: null });
    const mode: PushMode = d.mode === 'tagged' ? 'tagged' : 'all';
    // Never keep an answer older than a tap, or one person's answer under another (review PARV5/PARV6).
    if (!isStale()) rememberPushMode(userId, mode);
    return done({ state: 'subscribed', mode });
  } catch {
    return done({ state: 'subscribed', mode: rememberedPushMode(userId) ?? 'all' });
  }
}

// PUSHALWAYS — one rule for every asynchronous push operation (reviews
// PARV2–PARV6): it may act only while it is still (a) for the session that
// started it and (b) not older than the person's newest explicit choice.
//  - Writes run one at a time (serialWrite).
//  - Each explicit tap (Turn on, On/Off) takes a new generation the moment it
//    happens. It writes only while it is still the newest tap AND its session
//    is unchanged — checked inside its write slot, before the authenticated
//    POST and again before anything is remembered or announced. A tap
//    superseded by a newer tap (or a sign-out/sign-in) writes nothing.
//  - The quiet app-open sync stands down when any tap happened since it
//    started (or was in flight then), or the session/screen changed.
//  - A status read reports `stale` when a tap or a session change happened
//    while it was in flight; a stale read is never remembered or shown.
let explicitGen = 0;
let explicitPending = 0;
let writeChain: Promise<unknown> = Promise.resolve();
function serialWrite<T>(fn: () => Promise<T>): Promise<T> {
  const p = writeChain.then(fn, fn);
  writeChain = p.catch(() => undefined);
  return p;
}
/** A guard for an explicit tap: true while it is the newest tap in the same session. */
function explicitTicket(): () => boolean {
  const myGen = ++explicitGen;
  const cred0 = sessionCredentialKey();
  return () => explicitGen === myGen && sessionCredentialKey() === cred0;
}

async function doSubscribe(userEmail: string, mode: PushMode, userId: string | undefined, stillOk: () => boolean): Promise<'subscribed' | 'failed' | 'canceled'> {
  try {
    if (!stillOk()) return 'canceled';
    const keyRes = await apiFetch('/api/push/public-key');
    if (!keyRes.ok) return 'failed';
    const { publicKey } = await keyRes.json();
    const reg = await readyRegistration();
    if (!reg) return 'failed';
    if (!stillOk()) return 'canceled';
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    if (!stillOk()) return 'canceled'; // the browser subscription stays; the next sync or tap registers it
    const saveRes = await apiFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEmail, subscription: sub.toJSON(), mode }),
    });
    if (!saveRes.ok) {
      if (!existing) await sub.unsubscribe().catch(() => {});
      return 'failed';
    }
    if (!stillOk()) return 'canceled'; // nothing remembered/announced for a superseded or departed run
    rememberPushMode(userId, mode);
    announce();
    return 'subscribed';
  } catch (err) {
    console.warn('[Push] Subscribe failed:', err);
    return 'failed';
  }
}

export type TurnOnResult = 'subscribed' | 'denied' | 'failed' | 'superseded';

/** The person's own "Turn on" (banner or menu). Asks for permission right
 * away (inside the tap — iPhone needs that), then registers this phone.
 * 'superseded': a newer tap or a sign-out/sign-in came first; nothing written. */
export async function subscribeForPush(
  userEmail: string,
  mode: PushMode = 'all',
  userId?: string,
): Promise<TurnOnResult> {
  if (!pushSupported()) return 'failed';
  const current = explicitTicket();
  explicitPending++;
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return current() ? 'denied' : 'superseded';
    const r = await serialWrite(() => doSubscribe(userEmail, mode, userId, current));
    return r === 'canceled' ? 'superseded' : r;
  } finally {
    explicitPending--;
  }
}

export type SetModeResult = 'done' | 'failed' | 'superseded';

/**
 * PUSHALWAYS: switch this phone between 'all' and 'tagged' ("Off"). The phone
 * STAYS subscribed either way, so tags and assignments still reach it.
 */
export async function setPushMode(mode: PushMode, userId?: string): Promise<SetModeResult> {
  const current = explicitTicket();
  explicitPending++;
  return serialWrite(async (): Promise<SetModeResult> => {
    try {
      if (!current()) return 'superseded';
      const reg = await readyRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (!current()) return 'superseded';
      if (!sub) return 'failed';
      const res = await apiFetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), mode }),
      });
      if (!res.ok) return 'failed';
      if (!current()) return 'superseded';
      rememberPushMode(userId, mode);
      announce();
      return 'done';
    } catch {
      return 'failed';
    }
  }).finally(() => { explicitPending--; });
}

/** stale: a tap or a sign-out/sign-in happened while this was read — do not show or keep it. */
export interface PushSetup { state: PushState; mode: PushMode | null; stale?: boolean }

/**
 * The person's own "Turn on" from the banner or the menu (review PARV3): the
 * result plus the state to SHOW, confirmed by the server — after a failure a
 * browser subscription the server does not hold is never shown as on.
 */
export async function turnOnPush(userEmail: string, userId: string): Promise<{ result: TurnOnResult; setup: PushSetup }> {
  const cred0 = sessionCredentialKey();
  const result = await subscribeForPush(userEmail, 'all', userId);
  // The person who tapped is no longer signed in here: nothing about them to show.
  if (sessionCredentialKey() !== cred0) return { result: 'superseded', setup: { state: 'default', mode: null, stale: true } };
  if (result === 'subscribed') return { result, setup: { state: 'subscribed', mode: 'all' } };
  if (result === 'denied') return { result, setup: { state: 'denied', mode: null } };
  return { result, setup: await getPushSetup(userId) };
}

/**
 * PUSHALWAYS: run quietly when a person opens the app on a phone. Never asks
 * for permission. If the phone already allowed notifications but has no
 * subscription (it was turned off the old way, or the push service dropped
 * it), it subscribes again — with the setting this phone last had, else
 * "Only when I'm tagged or assigned". If the phone is subscribed but the
 * server has no record of it for this person (a shared phone, or a lost
 * record), it is registered for them with their own last setting here, else
 * "Only when I'm tagged or assigned".
 */
export async function syncPushQuietly(userEmail: string, userId: string, isCurrent: () => boolean = () => true): Promise<PushSetup> {
  if (!pushSupported()) return { state: 'unsupported', mode: null };
  if (Notification.permission === 'denied') return { state: 'denied', mode: null };
  const g0 = explicitGen;
  const cred0 = sessionCredentialKey();
  const tapInFlightAtStart = explicitPending > 0;
  // A tap since this sync started, or one still running when it started: the
  // tap's result is the truth and the quiet sync writes nothing (review PARV2).
  // The person it started for is no longer the one signed in here (sign-out,
  // account switch: isCurrent() false): it writes nothing either — a write
  // would go out under the NEW session's sign-in (review PARV3).
  const tapped = () => tapInFlightAtStart || explicitGen !== g0 || !isCurrent() || sessionCredentialKey() !== cred0;
  const fin = (r: PushSetup): PushSetup => (tapped() ? { ...r, stale: true } : r);
  // Stood down (a tap, or the person/session changed): report nothing and read
  // nothing — a read now would run under whoever is signed in NOW and could be
  // filed under this person (review PARV7). The tap's own announce repaints.
  const STOOD_DOWN: PushSetup = { state: 'default', mode: null, stale: true };
  try {
    const reg = await readyRegistration();
    if (!reg) return fin({ state: Notification.permission === 'granted' ? 'granted' : 'default', mode: null });
    const sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if (Notification.permission !== 'granted') return fin({ state: 'default', mode: null });
      const mode = rememberedPushMode(userId) ?? 'tagged';
      const r = await serialWrite(async () => {
        if (tapped()) return 'tapped' as const;
        // Re-read inside the write slot: a subscription made meanwhile is not ours to overwrite.
        if (await reg.pushManager.getSubscription()) return 'tapped' as const;
        return doSubscribe(userEmail, mode, userId, () => !tapped());
      });
      if (r === 'tapped' || r === 'canceled') return STOOD_DOWN;
      return fin(r === 'subscribed' ? { state: 'subscribed', mode } : { state: 'granted', mode: null });
    }
    const st = await apiFetch('/api/push/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (tapped()) return STOOD_DOWN;
    if (!st.ok) return fin({ state: 'subscribed', mode: rememberedPushMode(userId) });
    const d = await st.json();
    if (d.registered) {
      const mode: PushMode = d.mode === 'tagged' ? 'tagged' : 'all';
      if (!tapped() && rememberedPushMode(userId) !== mode) { rememberPushMode(userId, mode); announce(); }
      return fin({ state: 'subscribed', mode });
    }
    // The server has no record of this phone for THIS person: the endpoint
    // belongs to another account on a shared phone, or the record was lost.
    // Never everything unasked (review PARV1): their own last setting on this
    // phone, else "Only when tagged or assigned".
    const mode = rememberedPushMode(userId) ?? 'tagged';
    const ok = await serialWrite(async () => {
      if (tapped()) return 'tapped' as const;
      const re = await apiFetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail, subscription: sub.toJSON(), mode }),
      });
      return re.ok;
    });
    if (ok === 'tapped' || tapped()) return STOOD_DOWN;
    if (!ok) return fin({ state: 'granted', mode: null }); // not registered: offer Turn on, never show On
    rememberPushMode(userId, mode);
    announce();
    return fin({ state: 'subscribed', mode });
  } catch {
    return fin({ state: Notification.permission === 'granted' ? 'granted' : 'default', mode: null });
  }
}
