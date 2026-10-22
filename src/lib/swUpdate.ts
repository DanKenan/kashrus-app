/**
 * Service-worker updates: the one place that decides when a new version of
 * the app takes over and when the page reloads.
 *
 * Why this exists: the service worker precaches index.html and the JS. A new
 * deploy installs a NEW service worker, which then WAITS until it is told to
 * take over (sw.ts only calls skipWaiting on a { type: 'SKIP_WAITING' }
 * message). Until it takes over, the old precached app keeps being served.
 *
 * The rule (Don, "New version — tap to update"): the app NEVER reloads on its
 * own. A new version that is waiting shows a slim bar ("New version ready" +
 * "Tap to update", components/UpdateBanner.tsx); only that tap, or the "Update
 * app" button, switches and reloads:
 *  - Tap (applyUpdate): only when nothing is being saved, no form/sheet is
 *    open and nobody is typing (lib/updateSafety.ts); otherwise the bar says
 *    "Will update when you're done" and offers the tap again. Then: tell the
 *    waiting worker to take over → reload once, only when it really controls
 *    the page.
 *  - "Update app" button (checkForUpdate): check → wait until the new worker
 *    has finished installing → take over → reload. No update → 'current' (the
 *    button says so; no reload). Check or takeover failed → 'failed'.
 *  - Another tab switched versions (or the browser swapped them while this
 *    page was open): this page keeps working on the code it has and shows the
 *    bar; the tap reloads it.
 *  - Nobody taps: the waiting version takes over by itself only through the
 *    browser's normal lifecycle (every window of the app closed, then opened
 *    again), with no reload of anyone's page.
 *  - Checks for a new version (download only, never a switch): on open, when
 *    the app comes back to the screen (at most every RESUME_CHECK_MS), when
 *    the device is back online, and every PERIODIC_CHECK_MS while visible.
 *
 * Reloads are guarded (at most one per RELOAD_GUARD_MS, stored in
 * sessionStorage) so a bad deploy can never cause a reload loop.
 */

import { updateBlockedReason, type UpdateBlockReason } from './updateSafety';

const RELOAD_KEY = 'shutfey-sw-reload-at';
const RELOAD_GUARD_MS = 30_000;
/** While open, look for a new version at most this often (on resume). */
const RESUME_CHECK_MS = 15 * 60_000;
/** While visible, look for a new version this often. */
const PERIODIC_CHECK_MS = 60 * 60_000;
const INSTALL_TIMEOUT_MS = 60_000;
const TAKEOVER_TIMEOUT_MS = 10_000;

export type UpdateCheckResult = 'updating' | 'current' | 'failed';
/** none: nothing new · ready: a new version is waiting for the tap · updating: switching/reloading. */
export type UpdateState = 'none' | 'ready' | 'updating';
export type ApplyUpdateResult = 'updating' | 'current' | 'failed' | { busy: UpdateBlockReason };

/** This page asked the new worker to take over (its own reload follows). */
let takeoverInProgress = false;
/** A new version already controls this page (another tab, or the browser); a reload shows it. */
let reloadPending = false;
let registration: ServiceWorkerRegistration | undefined;
let state: UpdateState = 'none';
const listeners = new Set<() => void>();
/** The page opened under an older worker (not a first visit). */
const openedControlled =
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

function setState(next: UpdateState): void {
  if (state === next) return;
  state = next;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // a listener's error never breaks the others
    }
  }
}

/** The bar's state (useSyncExternalStore). */
export function getUpdateState(): UpdateState {
  return state;
}
export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

function hasController(): boolean {
  return supported() && !!navigator.serviceWorker.controller;
}

/** A new version is waiting (and this is not the very first visit): show the bar. */
function markReady(): void {
  if (takeoverInProgress) return;
  if (reloadPending || (registration?.waiting && hasController())) setState('ready');
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
 * Reload the page for an update (only ever from a tap). [UPD-RV1] B2: the
 * loop guard holds for every update reload, taps included: if one happened
 * less than RELOAD_GUARD_MS ago, nothing reloads and false comes back.
 */
export function reloadForUpdate(): boolean {
  if (reloadedRecently()) return false;
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
function takeOver(reg: ServiceWorkerRegistration): Promise<boolean> {
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
      // Only ever called from a tap (the bar or "Update app").
      let reloaded = false;
      if (ok) {
        reloaded = reloadForUpdate();
        // The loop guard held the reload: the new version controls the page,
        // so the bar offers the reload again (a later tap).
        if (!reloaded) reloadPending = true;
      }
      takeoverInProgress = reloaded;
      resolve(reloaded);
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

/**
 * "Update app" button. [UPD-RV1] B1: the same safety gate as the bar's tap,
 * checked first and again right before any switch or reload (the checks in
 * between are asynchronous). Busy -> { busy } and nothing changes.
 */
export async function checkForUpdate(
  blocked: () => UpdateBlockReason | null = updateBlockedReason,
): Promise<UpdateCheckResult | { busy: UpdateBlockReason }> {
  const first = blocked();
  if (first) return { busy: first };
  const reloadIfSafe = (): UpdateCheckResult | { busy: UpdateBlockReason } => {
    const reason = blocked();
    if (reason) return { busy: reason };
    return reloadForUpdate() ? 'updating' : 'failed';
  };
  if (!supported()) return reloadIfSafe();
  let reg: ServiceWorkerRegistration | undefined;
  try {
    reg = await navigator.serviceWorker.getRegistration();
  } catch {
    reg = undefined;
  }
  if (!reg) return reloadIfSafe();
  if (!reg.waiting && !reg.installing) {
    try {
      await reg.update();
    } catch {
      return 'failed'; // offline, or the server did not answer
    }
  }
  const incoming = reg.installing ?? reg.waiting;
  if (!incoming) {
    if (reloadPending) {
      // The new version already controls this page; a reload shows it.
      const res = reloadIfSafe();
      if (res === 'updating') setState('updating');
      return res;
    }
    return 'current';
  }
  const installed = await waitForInstalled(incoming, INSTALL_TIMEOUT_MS);
  if (!installed || !reg.waiting) return 'failed';
  const late = blocked();
  if (late) {
    markReady();
    return { busy: late };
  }
  setState('updating');
  if (await takeOver(reg)) return 'updating';
  markReady();
  if (state === 'updating') setState('none');
  return 'failed';
}

/**
 * The bar's tap. Switches only when it is safe (nothing saving, no open
 * form/sheet, nobody typing); otherwise answers { busy } and changes nothing.
 */
export async function applyUpdate(
  blocked: () => UpdateBlockReason | null = updateBlockedReason,
): Promise<ApplyUpdateResult> {
  const reason = blocked();
  if (reason) return { busy: reason };
  const reg = registration;
  if (reg?.waiting) {
    setState('updating');
    const ok = await takeOver(reg);
    if (!ok) {
      setState('ready');
      return 'failed';
    }
    return 'updating';
  }
  if (reloadPending) {
    // The new version already controls this page; a reload shows it.
    if (!reloadForUpdate()) return 'failed';
    setState('updating');
    return 'updating';
  }
  setState('none');
  return 'current';
}

/**
 * A new version became active (registerSW's onNeedReload). If this page asked
 * for it, its own reload is already on the way. Otherwise (another tab, or the
 * browser's own lifecycle) this page keeps working and shows the bar.
 */
export function onNewVersionActivated(): void {
  if (takeoverInProgress) return;
  reloadPending = true;
  markReady();
}

/** Call once at startup with the registration from registerSW. */
export function initSwUpdates(reg: ServiceWorkerRegistration | undefined): void {
  if (!supported() || !reg) return;
  registration = reg;

  // A worker that finishes installing while this page is open: show the bar
  // once it is waiting (never on a first visit: nothing old to replace).
  const watchInstall = (worker: ServiceWorker | null) => {
    if (!worker) return;
    const onChange = () => {
      if (worker.state === 'installed') markReady();
      if (worker.state === 'installed' || worker.state === 'redundant' || worker.state === 'activated') {
        worker.removeEventListener('statechange', onChange);
      }
    };
    worker.addEventListener('statechange', onChange);
    onChange();
  };
  markReady();
  watchInstall(reg.installing);
  reg.addEventListener('updatefound', () => watchInstall(reg.installing));

  // The browser may swap versions by itself while this page is open (the
  // last other window closed). No reload: the bar offers it.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (openedControlled && !takeoverInProgress) {
      reloadPending = true;
      markReady();
    }
  });

  // Look for a new version now and then (download only, never a switch).
  let lastCheck = Date.now();
  const check = (minGapMs: number) => {
    const now = Date.now();
    if (now - lastCheck < minGapMs) return;
    lastCheck = now;
    reg.update().catch(() => {
      // offline — try again on the next trigger
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    markReady();
    check(RESUME_CHECK_MS);
  });
  window.addEventListener('online', () => check(0));
  setInterval(() => {
    if (document.visibilityState === 'visible') check(PERIODIC_CHECK_MS - 1000);
  }, PERIODIC_CHECK_MS);
}

/** Tests only: reset module state. */
export function __resetSwUpdatesForTest(): void {
  takeoverInProgress = false;
  reloadPending = false;
  registration = undefined;
  state = 'none';
  listeners.clear();
}
