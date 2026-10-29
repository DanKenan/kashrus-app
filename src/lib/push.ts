import { apiFetch } from './api';
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
    rememberPushMode(userId, mode);
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

async function doSubscribe(userEmail: string, mode: PushMode, userId?: string): Promise<'subscribed' | 'failed'> {
  try {
    const keyRes = await apiFetch('/api/push/public-key');
    if (!keyRes.ok) return 'failed';
    const { publicKey } = await keyRes.json();
    const reg = await readyRegistration();
    if (!reg) return 'failed';
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const saveRes = await apiFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEmail, subscription: sub.toJSON(), mode }),
    });
    if (!saveRes.ok) {
      if (!existing) await sub.unsubscribe().catch(() => {});
      return 'failed';
    }
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
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';
    return await serialWrite(() => doSubscribe(userEmail, mode, userId));
  } finally {
    explicitPending--;
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await apiFetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch (err) {
    console.warn('[Push] Unsubscribe failed:', err);
  }
}

/**
 * PUSHALWAYS: switch this phone between 'all' and 'tagged' ("Off"). The phone
 * STAYS subscribed either way, so tags and assignments still reach it.
 */
export async function setPushMode(mode: PushMode, userId?: string): Promise<boolean> {
  explicitGen++;
  explicitPending++;
  return serialWrite(async () => {
    try {
      const reg = await readyRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (!sub) return false;
      const res = await apiFetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), mode }),
      });
      if (!res.ok) return false;
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
 * PUSHALWAYS: run quietly when a person opens the app on a phone. Never asks
 * for permission. If the phone already allowed notifications but has no
 * subscription (it was turned off the old way, or the push service dropped
 * it), it subscribes again — with the setting this phone last had, else
 * "Only when I'm tagged or assigned". If the phone is subscribed but the
 * server has no record of it for this person (a shared phone, or a lost
 * record), it is registered for them with their own last setting here, else
 * "Only when I'm tagged or assigned".
 */
export async function syncPushQuietly(userEmail: string, userId: string): Promise<PushSetup> {
  if (!pushSupported()) return { state: 'unsupported', mode: null };
  if (Notification.permission === 'denied') return { state: 'denied', mode: null };
  const g0 = explicitGen;
  const tapInFlightAtStart = explicitPending > 0;
  // A tap since this sync started, or one still running when it started: the
  // tap's result is the truth and the quiet sync writes nothing (review PARV2).
  const tapped = () => tapInFlightAtStart || explicitGen !== g0;
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
        return doSubscribe(userEmail, mode, userId);
      });
      if (r === 'tapped') return getPushSetup(userId);
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
    if (ok === 'tapped') return getPushSetup(userId);
    if (!ok) return { state: 'granted', mode: null }; // not registered: offer Turn on, never show On
    rememberPushMode(userId, mode);
    announce();
    return { state: 'subscribed', mode };
  } catch {
    return { state: Notification.permission === 'granted' ? 'granted' : 'default', mode: null };
  }
}
