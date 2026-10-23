/**
 * A tab still open on an OLD version can ask for a lazy-loaded file (a screen
 * split into its own JS file) that the new deploy no longer has. The browser
 * then fails to load it and the screen never opens.
 *
 * Vite reports exactly this as the 'vite:preloadError' event. We reload the
 * page once, so the tab gets the new version and the screen opens normally.
 * Guarded: at most one such reload per RELOAD_GUARD_MS (sessionStorage), so a
 * file that is really missing shows its error instead of looping.
 *
 * Lazy files today: the public home page (components/home/HomeLanding.tsx).
 *
 * This is the one automatic reload outside lib/swUpdate.ts's "only on a tap"
 * rule, on purpose: it happens only when a lazy file failed to load while the
 * browser is online, at most once per 30 s (this guard covers chunk recovery
 * only; it is separate from swUpdate's own loop guard), and never activates a waiting
 * service worker (that stays behind the update bar / Update app button).
 */
const RELOAD_KEY = 'shutfey-chunk-reload-at';
const RELOAD_GUARD_MS = 30_000;

export function installChunkReload(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    // Offline: a reload cannot help (and could land on an old cached page);
    // the screen's own error boundary offers Sign in / Try again instead.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    } catch {
      return; // no storage, no guard: let the error surface
    }
    if (Date.now() - last < RELOAD_GUARD_MS) return; // already tried once
    try {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      return;
    }
    event.preventDefault();
    window.location.reload();
  });
}
