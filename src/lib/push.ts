/**
 * Web Push (phone notifications) — subscribe / unsubscribe this device.
 *
 * Flow: user taps the bell -> Notification permission -> PushManager.subscribe
 * with the server's VAPID public key -> subscription POSTed to the server.
 * The server then pushes event/task assignments to this device, even with the
 * app closed. iOS requires the PWA to be installed to the Home Screen (16.4+).
 */

export type PushState = 'unsupported' | 'default' | 'granted' | 'denied' | 'subscribed';

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
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) return 'subscribed';
  } catch {
    return 'default';
  }
  return Notification.permission === 'granted' ? 'granted' : 'default';
}

export async function subscribeForPush(
  userEmail: string
): Promise<'subscribed' | 'denied' | 'failed'> {
  if (!pushSupported()) return 'failed';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  try {
    const keyRes = await fetch('/api/push/public-key');
    if (!keyRes.ok) return 'failed';
    const { publicKey } = await keyRes.json();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const saveRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEmail, subscription: sub.toJSON() }),
    });
    if (!saveRes.ok) {
      await sub.unsubscribe().catch(() => {});
      return 'failed';
    }
    return 'subscribed';
  } catch (err) {
    console.warn('[Push] Subscribe failed:', err);
    return 'failed';
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
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
