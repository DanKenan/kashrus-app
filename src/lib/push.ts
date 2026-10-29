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
  const state = await getPushState();
  if (state !== 'subscribed') return { state, mode: null };
  try {
    const reg = await readyRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return { state: await getPushState(), mode: null };
    const st = await apiFetch('/api/push/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (!st.ok) return { state: 'subscribed', mode: rememberedPushMode(userId) ?? 'all' };
    const d = await st.json();
    if (!d.registered) return { state: 'granted', mode: null };
    const mode: PushMode = d.mode === 'tagged' ? 'tagged' : 'all';
    if (sessionCredentialKey() === cred0) rememberPushMode(userId, mode); // never file one person's answer under another
    return { state: 'subscribed', mode };
  } catch {
    return { state: 'subscribed', mode: rememberedPushMode(userId) ?? 'all' };
  }
}

// PUSHALWAYS (review PARV2): every write of this phone's push setting runs
// one at a time, and a person's own tap wins over the quiet app-open sync.
// A tap bumps explicitGen the moment it happens; a quiet write checks the
// generation it started under right before writing and stands down if a tap
// came since. A tap that arrives while a quiet write is already running waits
// for it and then writes, so the tap is always last.
let explicitGen = 0;
let explicitPending = 0;
let writeChain: Promise<unknown> = Promise.resolve();
function serialWrite<T>(fn: () => Promise<T>): Promise<T> {
  const p = writeChain.then(fn, fn);
  writeChain = p.catch(() => undefined);
  return p;
}

async function doSubscribe(userEmail: string, mode: PushMode, userId?: string, stillOk: () => boolean = () => true): Promise<'subscribed' | 'failed' | 'canceled'> {
  // stillOk (review PARV4): a quiet write re-checks, right before each step that
  // matters, that it is still for the person and session it started for.
  try {
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
    if (!stillOk()) return 'canceled'; // the browser subscription stays; the next sign-in's sync handles it
    const saveRes = await apiFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEmail, subscription: sub.toJSON(), mode }),
    });
    if (!saveRes.ok) {
      if (!existing) await sub.unsubscribe().catch(() => {});
      return 'failed';
    }
    if (!stillOk()) return 'canceled'; // written under the session it started for; nothing recorded for a person who left
    rememberPushMode(userId, mode);
    announce();
    return 'subscribed';
  } catch (err) {
    console.warn('[Push] Subscribe failed:', err);
    return 'failed';
  }
}

/** The person's own "Turn on" (banner or menu). Asks for permission right
 * away (inside the tap — iPhone needs that), then registers this phone. */
export async function subscribeForPush(
  userEmail: string,
  mode: PushMode = 'all',
  userId?: string,
): Promise<'subscribed' | 'denied' | 'failed'> {
  if (!pushSupported()) return 'failed';
  explicitGen++;
  explicitPending++;
  // Bound to the session that tapped (review PARV5): if that person signs out
  // and someone else signs in before the write, the tap is dropped — never
  // written under the next person's sign-in.
  const cred0 = sessionCredentialKey();
  const sameSession = () => sessionCredentialKey() === cred0;
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';
    const r = await serialWrite(() => (sameSession() ? doSubscribe(userEmail, mode, userId, sameSession) : Promise.resolve('canceled' as const)));
    return r === 'canceled' ? 'failed' : r;
  } finally {
    explicitPending--;
  }
}


/**
 * PUSHALWAYS: switch this phone between 'all' and 'tagged' ("Off"). The phone
 * STAYS subscribed either way, so tags and assignments still reach it.
 */
export async function setPushMode(mode: PushMode, userId?: string): Promise<boolean> {
  explicitGen++;
  explicitPending++;
  const cred0 = sessionCredentialKey(); // bound to the session that tapped (review PARV5)
  const sameSession = () => sessionCredentialKey() === cred0;
  return serialWrite(async () => {
    try {
      if (!sameSession()) return false;
      const reg = await readyRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (!sub || !sameSession()) return false;
      const res = await apiFetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), mode }),
      });
      if (!res.ok || !sameSession()) return false;
      rememberPushMode(userId, mode);
      announce();
      return true;
    } catch {
      return false;
    }
  }).finally(() => { explicitPending--; });
}

export interface PushSetup { state: PushState; mode: PushMode | null }

/**
 * The person's own "Turn on" from the banner or the menu (review PARV3): the
 * result plus the state to SHOW, confirmed by the server — after a failure a
 * browser subscription the server does not hold is never shown as on.
 */
export async function turnOnPush(userEmail: string, userId: string): Promise<{ result: 'subscribed' | 'denied' | 'failed'; setup: PushSetup }> {
  const cred0 = sessionCredentialKey();
  const result = await subscribeForPush(userEmail, 'all', userId);
  // The person who tapped is no longer signed in here: nothing about them to show.
  if (sessionCredentialKey() !== cred0) return { result: result === 'subscribed' ? 'failed' : result, setup: { state: 'default', mode: null } };
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
  try {
    const reg = await readyRegistration();
    if (!reg) return { state: Notification.permission === 'granted' ? 'granted' : 'default', mode: null };
    const sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if (Notification.permission !== 'granted') return { state: 'default', mode: null };
      const mode = rememberedPushMode(userId) ?? 'tagged';
      const r = await serialWrite(async () => {
        if (tapped()) return 'tapped' as const;
        // Re-read inside the write slot: a subscription made meanwhile is not ours to overwrite.
        if (await reg.pushManager.getSubscription()) return 'tapped' as const;
        return doSubscribe(userEmail, mode, userId, () => !tapped());
      });
      if (r === 'tapped' || r === 'canceled') return getPushSetup(userId);
      return r === 'subscribed' ? { state: 'subscribed', mode } : { state: 'granted', mode: null };
    }
    const st = await apiFetch('/api/push/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (tapped()) return getPushSetup(userId);
    if (!st.ok) return { state: 'subscribed', mode: rememberedPushMode(userId) };
    const d = await st.json();
    if (d.registered) {
      const mode: PushMode = d.mode === 'tagged' ? 'tagged' : 'all';
      if (!tapped() && rememberedPushMode(userId) !== mode) { rememberPushMode(userId, mode); announce(); }
      return { state: 'subscribed', mode };
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
    if (ok === 'tapped' || tapped()) return getPushSetup(userId);
    if (!ok) return { state: 'granted', mode: null }; // not registered: offer Turn on, never show On
    rememberPushMode(userId, mode);
    announce();
    return { state: 'subscribed', mode };
  } catch {
    return { state: Notification.permission === 'granted' ? 'granted' : 'default', mode: null };
  }
}
