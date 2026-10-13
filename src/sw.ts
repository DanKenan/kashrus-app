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

// Allow the page to activate a waiting update immediately
// (virtual:pwa-register posts { type: 'SKIP_WAITING' } on update).
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (data && data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// ---- Web Push: show the notification, even with the app closed ----
self.addEventListener('push', (event: PushEvent) => {
  let title = 'Kosher Supervisor';
  let body = '';
  let url = '/';
  try {
    const data = event.data?.json() ?? {};
    if (typeof data.title === 'string') title = data.title;
    if (typeof data.body === 'string') body = data.body;
    if (typeof data?.data?.url === 'string') url = data.data.url;
  } catch {
    // keep defaults
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      data: { url },
      tag: 'kashrus-push',
    })
  );
});

// Tapping the notification opens/focuses the app.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if ('focus' in client) {
          await (client as WindowClient).focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
