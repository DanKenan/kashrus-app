import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { mount } from './lib/mini-render.mjs';

// Render the real screen; isolate device/session plumbing from this polling test.
const bundled = await build({
  entryPoints: ['src/components/KioskQrScreen.tsx'], bundle: true, platform: 'node',
  format: 'cjs', packages: 'external', write: false, jsx: 'automatic',
  plugins: [{ name: 'screen-plumbing', setup(b) {
    b.onResolve({ filter: /\/lib\/(api|site)$/ }, ({ path }) => ({ path, namespace: 'plumbing' }));
    b.onResolve({ filter: /\/ShutfeyLogo$/ }, ({ path }) => ({ path, namespace: 'plumbing' }));
    b.onLoad({ filter: /.*/, namespace: 'plumbing' }, ({ path }) => ({ contents:
      path.endsWith('/api') ? `
        export const apiFetch = (...args) => globalThis.fetch(...args);
        export const cookieSignInsSettled = async () => true;
        export const signOutsSettled = async () => true;
        export const trackCookieSignInRequest = p => p;
        export const endUnusedKioskSignIn = async () => {};
        export const noteServerCookieSignIn = () => {};
        export const setSessionToken = () => {};
      ` : path.endsWith('/site') ? `
        export const useSite = () => null;
        export const useSiteLogo = () => null;
      ` : 'export const ShutfeyLogo = () => null;', loader: 'js' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { KioskQrScreen, KQR_POLL_MS } = mod.exports;
const original = { fetch, setTimeout, clearTimeout, setInterval, clearInterval };
const timers = new Map();
let clock = 0;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  if (!ms) return original.setTimeout(fn, ms, ...args); // mini-render's settle ticks
  const id = { due: clock + ms, fn: () => fn(...args) };
  timers.set(id, id);
  return id;
};
globalThis.clearTimeout = (id) => { if (!timers.delete(id)) original.clearTimeout(id); };
globalThis.setInterval = () => ({});
globalThis.clearInterval = () => {};
const message = 'The app is over its daily limit. Try again after 3 AM.';
const calls = [];
let starts = 0, polls = 0;
globalThis.fetch = async (path) => {
  calls.push(path);
  let body = {}, status = 200;
  if (path === '/api/kiosk/qr/start') {
    starts++;
    body = starts === 1 ? { state: 'waiting', notFinished: true, message: 'Previous sign-in ended.', retryInMs: KQR_POLL_MS }
      : { state: 'waiting', retryInMs: KQR_POLL_MS };
  } else if (path === '/api/kiosk/qr/poll') {
    polls++;
    if (polls === 1) { status = 503; body = { code: 'DAILY_LIMIT', error: message }; }
    else body = { state: 'waiting', retryInMs: KQR_POLL_MS };
  } else assert.equal(path, '/api/kiosk/device');
  return new Response(JSON.stringify(body), { status });
};
try {
  const noop = () => {};
  const ui = mount(KioskQrScreen, { onLoginSuccess: noop, onUseCode: noop, onUnavailable: noop, onExitKiosk: noop });
  const advance = async (ms, screen = ui) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= clock && timers.delete(id)) { timer.fn(); await screen.render(); }
    }
    await screen.render();
  };
  await ui.render();
  assert.equal(starts, 1);
  await advance(KQR_POLL_MS);
  assert.equal(polls, 1);
  assert(ui.text().includes(message));
  assert(ui.buttons().some((b) => b.label === 'Try again'));
  const pausedCalls = calls.length;
  await advance(65000); // Past both the old line-clear timer and the old 30 s quota poll.
  assert.equal(calls.length, pausedCalls, 'DAILY_LIMIT must stop automatic requests');
  assert(ui.text().includes(message), 'quota message must stay visible');
  await ui.click('Try again');
  assert.equal(starts, 2, 'manual retry restarts polling with a fresh start');
  assert(!ui.buttons().some((b) => b.label === 'Try again'));
  await advance(KQR_POLL_MS);
  assert.equal(polls, 2, 'automatic polling resumes after manual retry');
  console.log('PASS: QR quota pauses requests, keeps the message beyond 65 s, and Try again resumes polling');
  for (const hanging of [false, true]) {
    timers.clear(); // Isolate this screen from the previous screen's pending poll.
    let attempts = 0;
    let pollSignal;
    let aborted = false;
    globalThis.fetch = async (path, init = {}) => {
      if (path === '/api/kiosk/device') return new Response('{}');
      if (path === '/api/kiosk/qr/poll' && ++attempts === 1) {
        if (hanging) {
          pollSignal = init.signal;
          pollSignal?.addEventListener('abort', () => { aborted = true; });
          return new Promise(() => {});
        }
        throw new TypeError('Failed to fetch');
      }
      return new Response(JSON.stringify({ state: 'waiting', retryInMs: KQR_POLL_MS }));
    };
    const screen = mount(KioskQrScreen, { onLoginSuccess: noop, onUseCode: noop, onUnavailable: noop, onExitKiosk: noop });
    const lines = () => screen.find((e) => e.props['data-kqr-line'] !== undefined);
    await screen.render();
    await advance(KQR_POLL_MS, screen);
    assert.equal(attempts, 1);
    assert.equal(lines().length, 0, 'a network blip must not show an error line');
    if (hanging) {
      await advance(65000, screen); // Beyond both the old 25 s abort and the 40 s held answer.
      assert.equal(aborted, false, 'a pending claim must not be aborted');
      assert.notEqual(pollSignal?.aborted, true);
      assert.equal(attempts, 1, 'keep waiting for the tracked claim answer');
      assert.equal(lines().length, 0, 'a hanging poll must not show a timeout line');
      continue;
    }
    assert(!screen.text().includes('Failed to fetch'));
    await advance(KQR_POLL_MS * 2 - 1, screen);
    assert.equal(attempts, 1, 'keep the existing 2x backoff');
    await advance(1, screen);
    assert.equal(attempts, 2, 'polling continues after the failure');
    assert.equal(lines().length, 0);
  }
  console.log('PASS: network blips stay silent; hanging claims stay pending without aborts; network errors retry with 2x backoff');
} finally {
  Object.assign(globalThis, original);
}
