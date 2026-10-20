/**
 * Service-worker updates: the one place that decides when a new version of
 * the app takes over and when the page reloads.
 *
 * Why this exists: the service worker precaches index.html and the JS. A new
 * deploy installs a NEW service worker, which then WAITS until it is told to
 * take over (sw.ts only calls skipWaiting on a { type: 'SKIP_WAITING' }
 * message). Until it takes over, the old precached app keeps being served —
 * which is why clearing site data was the only way to see a deploy.
 *
 *  - "Update app" button (checkForUpdate): check → wait until the new worker
 *    has finished installing → tell it to take over → reload only once it
 *    really controls the page. No update → 'current' (the button says so; no
 *    reload). Check or takeover failed → 'failed' (no reload into the old copy).
 *  - Opening the app (initSwUpdates): while the page is still untouched (no
 *    tap or key press yet, first STARTUP_WINDOW_MS), a waiting worker — one
 *    that installed during an earlier visit, or one that finishes installing
 *    now — takes over and the page reloads once. Returning to a page nobody
 *    has touched since it loaded does the same.
 *  - A page someone has used is NEVER reloaded on its own: the new version
 *    waits for the next open or the button. Resuming only downloads it.
 *
 * Automatic reloads are guarded (at most one per RELOAD_GUARD_MS, stored in
 * sessionStorage) so a bad deploy can never cause a reload loop.
 */

const RELOAD_KEY = 'shutfey-sw-reload-at';
const RELOAD_GUARD_MS = 30_000;
/** Install finished this soon after load, before any input → take over now. */
const STARTUP_WINDOW_MS = 10_000;
/** While open, look for a new version at most this often (on resume). */
const RESUME_CHECK_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 60_000;
const TAKEOVER_TIMEOUT_MS = 10_000;

export type UpdateCheckResult = 'updating' | 'current' | 'failed';

/** This page asked the new worker to take over (its own reload follows). */
let takeoverInProgress = false;
/** Another tab activated a new version; reload at the next safe moment. */
let reloadPending = false;
/** When this page loaded, and whether anyone has tapped or typed since. */
const startedAt = Date.now();
let interacted = false;
/** The page opened under an older worker (not a first visit). */
const openedControlled =
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
if (typeof window !== 'undefined') {
  const markInteracted = () => {
    interacted = true;
  };
  window.addEventListener('pointerdown', markInteracted, { capture: true, once: true });
  window.addEventListener('keydown', markInteracted, { capture: true, once: true });
}

function stillStarting(): boolean {
  return !interacted && Date.now() - startedAt <= STARTUP_WINDOW_MS;
}

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

function reloadedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    return at > 0 && Date.now() - at < RELOAD_GUARD_MS;
  } catch {
    return false;
  }
}

/**
 * Reload the page for an update. `force` is for an explicit tap on
 * "Update app"; automatic reloads are skipped if one just happened.
 */
export function reloadForUpdate(force = false): boolean {
  if (!force && reloadedRecently()) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // private mode etc. — still reload
  }
  window.location.reload();
  return true;
}

/** Resolves true once `worker` has installed, false if it failed or timed out. */
function waitForInstalled(worker: ServiceWorker, timeoutMs: number): Promise<boolean> {
  const done = () =>
    worker.state === 'installed' || worker.state === 'activating' || worker.state === 'activated';
  if (done()) return Promise.resolve(true);
  if (worker.state === 'redundant') return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('statechange', onChange);
      resolve(false);
    }, Math.max(0, timeoutMs));
    function onChange() {
      if (done() || worker.state === 'redundant') {
        clearTimeout(timer);
        worker.removeEventListener('statechange', onChange);
        resolve(done());
      }
    }
    worker.addEventListener('statechange', onChange);
  });
}

/**
 * Tell the waiting worker to take over, and reload only once it really
 * controls this page. Resolves false (no reload) if it never takes control
 * within TAKEOVER_TIMEOUT_MS — a reload then would only bring back the old
 * copy.
 */
function takeOver(reg: ServiceWorkerRegistration, force: boolean): Promise<boolean> {
  const waiting = reg.waiting;
  if (!waiting) return Promise.resolve(false);
  const controls = () =>
    navigator.serviceWorker.controller === waiting &&
    (waiting.state === 'activating' || waiting.state === 'activated');
  takeoverInProgress = true;
  return new Promise((resolve) => {
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      takeoverInProgress = ok;
      // An automatic switch never reloads a page someone started using while
      // it ran (a tap or key press since); the new version shows on the next
      // open. The explicit tap always reloads.
      if (ok && (force || !interacted)) reloadForUpdate(force);
      resolve(ok);
    };
    const onChange = () => {
      if (controls()) finish(true);
    };
    const timer = setTimeout(() => finish(controls()), TAKEOVER_TIMEOUT_MS);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    try {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      finish(false);
    }
  });
}

/** "Update app" button. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!supported()) {
    reloadForUpdate(true);
    return 'updating';
  }
  let reg: ServiceWorkerRegistration | undefined;
  try {
    reg = await navigator.serviceWorker.getRegistration();
  } catch {
    reg = undefined;
  }
  if (!reg) {
    reloadForUpdate(true);
    return 'updating';
  }
  if (!reg.waiting && !reg.installing) {
    try {
      await reg.update();
    } catch {
      return 'failed'; // offline, or the server did not answer
    }
  }
  const incoming = reg.installing ?? reg.waiting;
  if (!incoming) return 'current';
  const installed = await waitForInstalled(incoming, INSTALL_TIMEOUT_MS);
  if (!installed || !reg.waiting) return 'failed';
  return (await takeOver(reg, true)) ? 'updating' : 'failed';
}

/**
 * A new version became active (registerSW's onNeedReload). If this page asked
 * for it, its own reload is already on the way. If another tab did, this page
 * keeps working and reloads at the next safe moment: right now if nobody has
 * touched it yet, otherwise when it comes back from a long time in the
 * background.
 */
export function onNewVersionActivated(): void {
  if (takeoverInProgress) return;
  if (stillStarting()) {
    reloadForUpdate();
    return;
  }
  reloadPending = true; // used only if the page is still untouched on return
}

/** Call once at startup with the registration from registerSW. */
export function initSwUpdates(reg: ServiceWorkerRegistration | undefined): void {
  if (!supported() || !reg) return;

  // First visit: nothing old to replace (sw.ts claims the page on activate).
  const hadController = () => !!navigator.serviceWorker.controller;

  const watchStartupInstall = (worker: ServiceWorker | null) => {
    if (!worker) return;
    const left = STARTUP_WINDOW_MS - (Date.now() - startedAt);
    if (left <= 0) return;
    void waitForInstalled(worker, left).then((ok) => {
      if (ok && stillStarting() && hadController() && reg.waiting) {
        void takeOver(reg, false);
      }
    });
  };
  if (reg.waiting) {
    // Found too late (someone already tapped or typed): it waits for the
    // next open or the button.
    if (stillStarting() && hadController()) void takeOver(reg, false);
  } else {
    watchStartupInstall(reg.installing);
  }
  reg.addEventListener('updatefound', () => watchStartupInstall(reg.installing));
  // The browser may swap versions by itself while this page opens (the last
  // old tab just closed). If that happens before anyone touches the page,
  // reload once so the page runs the new code too.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (openedControlled && !takeoverInProgress && stillStarting()) reloadForUpdate();
  });

  // Back from the background: look for a new version now and then (download
  // only). A page that sat untouched since it loaded switches right away —
  // nobody's work is on it. A page someone has used is never reloaded on its
  // own (a half-written report must survive a phone call); it gets the new
  // version on the next open or from the button.
  let lastCheck = startedAt;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!interacted) {
      if (reloadPending) {
        reloadForUpdate();
        return;
      }
      if (hadController() && reg.waiting) {
        void takeOver(reg, false);
        return;
      }
    }
    const now = Date.now();
    if (now - lastCheck >= RESUME_CHECK_MS) {
      lastCheck = now;
      reg.update().catch(() => {
        // offline — try again on the next resume
      });
    }
  });
}
