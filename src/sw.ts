/// <reference lib="webworker" />
/**
 * Custom service worker (vite-plugin-pwa injectManifest).
 * App-shell precaching + Web Push handling for phone notifications.
 */
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Precache the app shell (manifest injected at build time).
precacheAndRoute(self.__WB_MANIFEST);

// Google Fonts runtime caching (same as the previous generateSW setup).
registerRoute(
  /^https:\/\/fonts\.googleapis\.com\/.*/i,
  new CacheFirst({
    cacheName: 'google-fonts-cache',
    plugins: [
      new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);
registerRoute(
  /^https:\/\/fonts\.gstatic\.com\/.*/i,
  new CacheFirst({
    cacheName: 'gstatic-fonts-cache',
    plugins: [
      new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// A new version waits until the page tells it to take over
// (lib/swUpdate.ts posts { type: 'SKIP_WAITING' }: from the "Update app"
// button, or when the app is opened). It never takes over on its own.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (data && data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// Once active, control every open page of the app straight away (also the
// very first visit), so 'controllerchange' fires and offline works at once.
self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

// ---- Web Push: show the notification, even with the app closed ----
/** A push/click URL is honoured only as a path on this origin. */
function isSameOriginPath(u: string): boolean {
  if (!u.startsWith('/') || u.startsWith('//') || u.startsWith('/\\')) return false;
  try {
    return new URL(u, self.location.origin).origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener('push', (event: PushEvent) => {
  let title = 'Shutfey';
  let body = '';
  let url = '/';
  // 5b: each alert carries its own tag (one notification per alert, never
  // replacing another), and the receiver's mute arrives as silent: true —
  // the notification is still shown, just without sound or vibration.
  let tag = 'kashrus-push';
  let silent = false;
  try {
    const data = event.data?.json() ?? {};
    if (typeof data.title === 'string') title = data.title;
    if (typeof data.body === 'string') body = data.body;
    // A5: same-origin path only — a plain startsWith('/') would let a
    // protocol-relative "//evil.example" through as a redirect.
    if (typeof data?.data?.url === 'string' && isSameOriginPath(data.data.url)) url = data.data.url;
    if (typeof data?.data?.tag === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(data.data.tag)) tag = data.data.tag;
    silent = data?.data?.silent === true;
  } catch {
    // keep defaults
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      data: { url },
      tag,
      silent,
      // A re-sent alert with the same tag sounds again unless muted.
      renotify: tag !== 'kashrus-push' && !silent,
    } as NotificationOptions)
  );
});

// Tapping the notification opens/focuses the app.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const rawUrl = (event.notification.data as { url?: string } | undefined)?.url || '/';
  const url = isSameOriginPath(rawUrl) ? rawUrl : '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if ('focus' in client) {
          await (client as WindowClient).focus();
          // 5b: an open app jumps to the alert itself.
          client.postMessage({ type: 'OPEN_URL', url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
