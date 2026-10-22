/**
 * Item 11 client part 1 (server #134 live): sign-out ends the server session, a
 * session-store outage is "try again" (never a sign-out), and a registration
 * without a session goes to the normal sign-in form.
 *  L  sign-out: POST /api/auth/logout with the token BEFORE the token is cleared;
 *     offline / 401 / 503 still sign out locally; no token -> nothing sent.
 *  R  apiFetch: GET 503 SESSION_STORE_UNAVAILABLE is retried and never signs out;
 *     a write 503 is handed back once (no retry, no sign-out); 401 still signs out.
 *  W  WebSocket: 1013 and other closes reconnect with backoff (3 s, doubling, 30 s
 *     cap); 4401 signs out only after an HTTP 401 for the SAME token; a newer
 *     token reconnects; no token -> no retry; a dropped socket's late close is ignored.
 *  G  register 201 {token:null}: no token stored, onSuccess NOT called, the sign-in
 *     form opens with the email filled and plain words.
 *  P  change password 503 + passwordChanged: says the password changed (no "try again").
 * Run: npx tsx tests/client/test-11-session-client.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const events = [];
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '', protocol: 'https:', host: 'app.example' }, addEventListener() {}, removeEventListener() {} };
globalThis.window.dispatchEvent = (e) => { events.push(e.type); return true; };
globalThis.CustomEvent ??= class { constructor(type) { this.type = type; } };

const api = await import('../../src/lib/api.ts');
const { setSessionToken, getSessionToken, apiFetch, endServerSession, sessionTiming } = api;
sessionTiming.storeRetryDelaysMs = [5, 5];
sessionTiming.authSettleGraceMs = 5;

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const raw = String(url);
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    const h = opts.headers instanceof Headers ? Object.fromEntries(opts.headers.entries()) : Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method, path, body: body ?? null, h, opts, tokenInStore: getSessionToken() });
    let r = routes[`${method} ${path}`];
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
    if (typeof r === 'function') r = r(body, h);
    if (r === 'THROW') throw new TypeError('network');
    r = r || { status: 200, body: {} };
    const hdr = r.headers || {};
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => hdr[k] ?? null }, clone() { return this; }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}
const STORE_DOWN = { status: 503, body: { error: 'Could not check your sign-in right now. Please try again in a moment.', code: 'SESSION_STORE_UNAVAILABLE' } };

// ---------------------------------------------------------------- L: sign-out
{
  setSessionToken('tok-L');
  const calls = stubFetch({ 'POST /api/auth/logout': { status: 200, body: { ok: true, revoked: true } } });
  const p = endServerSession(getSessionToken());
  api.clearSession();
  await p;
  ok('L1 one POST /api/auth/logout', calls.length === 1 && calls[0].method === 'POST' && calls[0].path === '/api/auth/logout', JSON.stringify(calls.map((c) => c.path)));
  ok('L1 sent with the Bearer token', calls[0]?.h.authorization === 'Bearer tok-L');
  ok('L1 sent while the token was still stored (before clearing)', calls[0]?.tokenInStore === 'tok-L');
  ok('L1 keepalive (survives a navigation)', calls[0]?.opts.keepalive === true);
  ok('L1 token cleared afterwards', getSessionToken() === null);
}
for (const [label, answer] of [['offline', 'THROW'], ['401', { status: 401, body: { error: 'Sign in required. Please log in again.' } }], ['503', STORE_DOWN]]) {
  setSessionToken('tok-L2'); events.length = 0;
  stubFetch({ 'POST /api/auth/logout': answer });
  let threw = false;
  try { const p = endServerSession(getSessionToken()); api.clearSession(); await p; } catch { threw = true; }
  ok(`L2 ${label}: never throws, still signed out locally`, !threw && getSessionToken() === null);
  ok(`L2 ${label}: no "unauthorized" event from the logout call`, !events.includes('shutfey:unauthorized'), events.join());
}
{
  const calls = stubFetch({});
  await endServerSession(null);
  ok('L3 no token: nothing sent', calls.length === 0);
  store.set('kiosk_device', 'dev1.secret');
  setSessionToken('tok-K');
  const c2 = stubFetch({});
  await endServerSession();
  ok('L4 kiosk: device proof header sent too', c2[0]?.h['x-kiosk-device'] === 'dev1.secret');
  store.delete('kiosk_device');
}
{
  const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('const handleLogout = () => {'), app.indexOf('const handleLoginSuccess'));
  const iEnd = body.indexOf('void endServerSession(getSessionToken());');
  const iClear = body.indexOf('clearSession();');
  ok('L5 handleLogout calls the server logout before clearSession()', iEnd > 0 && iClear > iEnd, `${iEnd} ${iClear}`);
  const hdr = fs.readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8');
  const k = hdr.slice(hdr.indexOf('const confirmEnterKioskMode'), hdr.indexOf("window.location.assign('/?kiosk=1')"));
  ok('L6 Enter kiosk mode ends the phone session on the server before clearSession()', k.indexOf('void endServerSession();') > 0 && k.indexOf('clearSession();') > k.indexOf('void endServerSession();'));
}

// ---------------------------------------------------------------- R: HTTP 503 / 401
{
  setSessionToken('tok-R'); events.length = 0;
  const calls = stubFetch({ 'GET /api/tasks': [STORE_DOWN, STORE_DOWN, { status: 200, body: { tasks: [] } }] });
  const res = await apiFetch('/api/tasks');
  ok('R1 GET retried through a store outage, then 200', res.status === 200 && calls.length === 3, `${res.status} ${calls.length}`);
  ok('R1 still signed in, no sign-out event', getSessionToken() === 'tok-R' && !events.includes('shutfey:unauthorized'));
}
{
  setSessionToken('tok-R'); events.length = 0;
  const calls = stubFetch({ 'GET /api/tasks': STORE_DOWN });
  const res = await apiFetch('/api/tasks');
  ok('R2 outage lasts: bounded retries (3 calls), the 503 handed back', res.status === 503 && calls.length === 3, `${res.status} ${calls.length}`);
  ok('R2 never a sign-out', getSessionToken() === 'tok-R' && !events.includes('shutfey:unauthorized'));
}
{
  setSessionToken('tok-R'); events.length = 0;
  const calls = stubFetch({ 'PUT /api/tasks/t1': STORE_DOWN });
  const r = await api.apiWrite('/api/tasks/t1', { method: 'PUT', body: JSON.stringify({ title: 'x' }), operationId: 'op-r3-abcdefgh' });
  ok('R3 a write 503 is sent once (no automatic retry)', calls.length === 1, String(calls.length));
  ok('R3 write fails with the server words, still signed in', r.ok === false && /try again/i.test(r.error || '') && getSessionToken() === 'tok-R' && !events.includes('shutfey:unauthorized'), JSON.stringify(r));
}
{
  setSessionToken('tok-R'); events.length = 0;
  const calls = stubFetch({ 'GET /api/tasks': { status: 503, body: { code: 'MAINTENANCE', error: 'down' } } });
  await apiFetch('/api/tasks');
  ok('R4 another 503 (maintenance) is not retried', calls.length === 1);
}
{
  setSessionToken('tok-R'); events.length = 0;
  stubFetch({ 'GET /api/tasks': { status: 401, body: { error: 'Sign in required. Please log in again.' } } });
  await apiFetch('/api/tasks');
  ok('R5 a 401 still signs out', getSessionToken() === null && events.includes('shutfey:unauthorized'));
}

// ---------------------------------------------------------------- W: WebSocket
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeWS.all.push(this); }
  send() {}
  open() { this.readyState = 1; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  serverClose(code) { this.readyState = 3; this.onclose?.({ code }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1005 })); }
}
globalThis.WebSocket = FakeWS;
const timers = [];
const realSetTimeout = globalThis.setTimeout;
function captureTimers() {
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 1000) { timers.push({ fn, ms }); return timers.length; } return realSetTimeout(fn, ms, ...a); };
}
function releaseTimers() { globalThis.setTimeout = realSetTimeout; }
const sock = await import('../../src/lib/socketClient.ts');
const rs = sock.realtimeSocket;
const last = () => FakeWS.all[FakeWS.all.length - 1];
{
  ok('W0 backoff: first wait about 3 s (as before)', sock.reconnectDelayMs(0, () => 0.5) === 3000);
  ok('W0 backoff doubles: 6 s, 12 s, 24 s', sock.reconnectDelayMs(1, () => 0.5) === 6000 && sock.reconnectDelayMs(2, () => 0.5) === 12000 && sock.reconnectDelayMs(3, () => 0.5) === 24000);
  ok('W0 backoff capped at 30 s', sock.reconnectDelayMs(4, () => 0.5) === 30000 && sock.reconnectDelayMs(50, () => 0.5) === 30000);
  ok('W0 jitter stays within +/-20 %', sock.reconnectDelayMs(0, () => 0) === 2400 && sock.reconnectDelayMs(0, () => 0.999999) <= 3600);
}
{
  // W1: 1013 (store down) -> reconnect with growing waits, never a sign-out
  setSessionToken('tok-W'); events.length = 0; timers.length = 0; captureTimers();
  rs.connect('a@x.test', 'A');
  const s1 = last(); s1.open();
  ok('W1 socket opened with the token', s1.url.includes('token=tok-W'));
  s1.serverClose(1013);
  ok('W1 1013: a reconnect is scheduled', timers.length === 1 && timers[0].ms >= 2400 && timers[0].ms <= 3600, JSON.stringify(timers.map((t) => t.ms)));
  ok('W1 1013: still signed in', getSessionToken() === 'tok-W' && !events.includes('shutfey:unauthorized'));
  timers.shift().fn();
  const s2 = last();
  ok('W1 reconnected (a new socket)', s2 !== s1 && s2.url.includes('token=tok-W'));
  s2.open(); s2.serverClose(1013);
  ok('W1 second 1013: the wait grows (about 6 s)', timers.length === 1 && timers[0].ms >= 4800 && timers[0].ms <= 7200, JSON.stringify(timers.map((t) => t.ms)));
  timers.shift().fn();
  const s3 = last(); s3.open(); s3.message({ type: 'INITIAL_STATE', payload: {} }); s3.serverClose(1006);
  ok('W1 after a message the backoff starts again at about 3 s', timers.length === 1 && timers[0].ms <= 3600, JSON.stringify(timers.map((t) => t.ms)));
  timers.length = 0;
  rs.disconnect();
  releaseTimers();
}
{
  // W2: 4401 and the HTTP check says 401 for the same token -> signed out
  setSessionToken('tok-W2'); events.length = 0; timers.length = 0; captureTimers();
  const calls = stubFetch({ 'GET /api/agencies/current': { status: 401, body: { error: 'Sign in required. Please log in again.' } } });
  rs.connect('a@x.test', 'A');
  const s = last(); s.open(); s.serverClose(4401);
  await tick(60);
  ok('W2 4401: checked over HTTP with the socket token', calls.length === 1 && calls[0].h.authorization === 'Bearer tok-W2', JSON.stringify(calls.map((c) => c.path)));
  ok('W2 4401 + 401: signed out (token cleared, app told)', getSessionToken() === null && events.includes('shutfey:unauthorized'));
  ok('W2 no reconnect after the sign-out', timers.length === 0);
  rs.disconnect(); releaseTimers();
}
{
  // W3: 4401 but the session works over HTTP -> keep signed in, reconnect with backoff
  setSessionToken('tok-W3'); events.length = 0; timers.length = 0; captureTimers();
  stubFetch({ 'GET /api/agencies/current': { status: 200, body: {} } });
  rs.connect('a@x.test', 'A');
  const s = last(); s.open(); s.serverClose(4401);
  await tick(60);
  ok('W3 4401 + 200: still signed in', getSessionToken() === 'tok-W3' && !events.includes('shutfey:unauthorized'));
  ok('W3 reconnect scheduled', timers.length === 1);
  timers.length = 0; rs.disconnect(); releaseTimers();
}
{
  // W4: 4401 + store down (503) -> keep signed in, reconnect
  setSessionToken('tok-W4'); events.length = 0; timers.length = 0; captureTimers();
  stubFetch({ 'GET /api/agencies/current': STORE_DOWN });
  rs.connect('a@x.test', 'A');
  const s = last(); s.open(); s.serverClose(4401);
  await tick(60);
  ok('W4 4401 + 503: still signed in, reconnect scheduled', getSessionToken() === 'tok-W4' && !events.includes('shutfey:unauthorized') && timers.length === 1);
  timers.length = 0; rs.disconnect(); releaseTimers();
}
{
  // W5: change password: the server closes the socket 4401 while the answer with
  // the fresh token is still in flight -> the client waits, then reconnects with it.
  setSessionToken('tok-old'); events.length = 0; timers.length = 0; captureTimers();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = stubFetch({ 'POST /api/auth/change-password': { status: 200, body: { success: true, token: 'tok-new' } }, 'GET /api/agencies/current': { status: 401, body: {} } });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { const r = await inner(url, opts); if (String(url).includes('change-password')) await gate; return r; };
  rs.connect('a@x.test', 'A');
  const s = last(); s.open();
  const pending = apiFetch('/api/auth/change-password', { method: 'POST', body: '{}' }).then(async (res) => { const d = await res.json(); setSessionToken(d.token); });
  await tick(5);
  s.serverClose(4401);
  await tick(80);
  ok('W5 while the change is in flight: no check, no sign-out', getSessionToken() === 'tok-old' && calls.filter((c) => c.path === '/api/agencies/current').length === 0 && !events.includes('shutfey:unauthorized'));
  release(); await pending; await tick(80);
  const s2 = last();
  ok('W5 then reconnected with the fresh token (no HTTP check, no sign-out)', s2 !== s && s2.url.includes('token=tok-new') && getSessionToken() === 'tok-new' && !events.includes('shutfey:unauthorized') && calls.filter((c) => c.path === '/api/agencies/current').length === 0, s2.url);
  rs.disconnect(); releaseTimers(); timers.length = 0;
}
{
  // W6: 4401 with no token (signed out already): no retry, no check
  api.clearSession(); events.length = 0; timers.length = 0; captureTimers();
  const calls = stubFetch({});
  rs.connect();
  const s = last(); s.serverClose(4401);
  await tick(40);
  ok('W6 no token: no check, no reconnect', calls.length === 0 && timers.length === 0);
  releaseTimers();
}
{
  // W7: a socket dropped by disconnect() (sign-out) closing late is ignored
  setSessionToken('tok-W7'); timers.length = 0; captureTimers();
  rs.connect('a@x.test', 'A');
  const s = last(); s.open();
  rs.disconnect();
  await tick(10);
  s.onclose?.({ code: 4401 });
  await tick(40);
  ok('W7 late close of a dropped socket: nothing scheduled, nothing checked', timers.length === 0 && FakeWS.all[FakeWS.all.length - 1] === s);
  releaseTimers();
}
{
  // W8: the token changes while the HTTP check is on its way -> its 401 never signs out the newer session
  setSessionToken('tok-W8'); events.length = 0; timers.length = 0; captureTimers();
  stubFetch({ 'GET /api/agencies/current': () => { setSessionToken('tok-W8-new'); return { status: 401, body: {} }; } });
  rs.connect('a@x.test', 'A');
  const s = last(); s.open(); s.serverClose(4401);
  await tick(60);
  ok('W8 a newer token is kept (no sign-out), reconnect scheduled', getSessionToken() === 'tok-W8-new' && !events.includes('shutfey:unauthorized') && timers.length === 1);
  timers.length = 0; rs.disconnect(); releaseTimers();
}

// ---------------------------------------------------------------- G: register token:null
const { AgencySignupForm, REGISTERED_SIGN_IN_TEXT } = await import('../../src/components/AgencySignupForm.tsx');
const { LoginPage } = await import('../../src/components/LoginPage.tsx');
async function fillSignup(m) {
  await m.type('Agency Name', 'Test Vaad');
  await m.type('Full Name', 'Rivka Admin');
  await m.type('Email', 'Rivka@Vaad.test');
  await m.type('Password', 'secret123');
  await m.type('Venue Name', 'Main Kitchen');
}
{
  api.clearSession();
  const calls = stubFetch({ 'POST /api/agencies/register': { status: 201, body: { success: true, user: { id: 'u1', email: 'rivka@vaad.test', role: 'admin' }, token: null, sessionCode: 'SESSION_STORE_UNAVAILABLE' } } });
  let succeeded = 0; let without = null;
  const m = mount(AgencySignupForm, { onSuccess() { succeeded++; }, onSwitchToLogin() {}, onRegisteredWithoutSession(e) { without = e; } });
  await m.render(); await fillSignup(m); await m.submit();
  ok('G1 register was called', calls.some((c) => c.path === '/api/agencies/register'));
  ok('G1 token null: onSuccess NOT called (no half-signed-in app)', succeeded === 0);
  ok('G1 token null: nothing stored', getSessionToken() === null);
  ok('G1 token null: sign-in path asked for, with the email', without === 'rivka@vaad.test', String(without));
}
{
  stubFetch({ 'POST /api/agencies/register': { status: 201, body: { success: true, user: { id: 'u1', email: 'rivka@vaad.test', role: 'admin' }, token: 'tok-G' } } });
  let user = null;
  const m = mount(AgencySignupForm, { onSuccess(u) { user = u; }, onSwitchToLogin() {}, onRegisteredWithoutSession() {} });
  await m.render(); await fillSignup(m); await m.submit();
  ok('G2 with a token: stored and signed in as before', getSessionToken() === 'tok-G' && user && user.id === 'u1');
  api.clearSession();
}
{
  stubFetch({ 'POST /api/agencies/register': { status: 201, body: { success: true, user: { id: 'u1' }, token: null } } });
  let succeeded = 0;
  const m = mount(AgencySignupForm, { onSuccess() { succeeded++; }, onSwitchToLogin() {} });
  await m.render(); await fillSignup(m); await m.submit();
  ok('G3 no handler given: plain words on the form, not signed in', succeeded === 0 && decode(m.html()).includes(REGISTERED_SIGN_IN_TEXT));
}
{
  // LoginPage hosts the form; the renderer does not expand nested components, so
  // the form's callback is called the way the form calls it (G1 proves the form side).
  let signedIn = 0;
  const m = mount(LoginPage, { onLoginSuccess() { signedIn++; }, initialMode: 'signup' });
  await m.render();
  function* walkAll(n) { if (n == null || typeof n !== 'object') return; if (Array.isArray(n)) { for (const c of n) yield* walkAll(c); return; } if (!React.isValidElement(n)) return; yield n; yield* walkAll(n.props?.children); }
  const formEl = [...walkAll(m.tree())].find((e) => e.type === AgencySignupForm);
  ok('G4 LoginPage passes onRegisteredWithoutSession to the sign-up form', !!formEl && typeof formEl.props.onRegisteredWithoutSession === 'function');
  formEl?.props.onRegisteredWithoutSession('rivka@vaad.test');
  await m.render();
  const h = decode(m.html());
  ok('G4 LoginPage: back on the sign-in form with the note', h.includes('data-login-notice') && h.includes(REGISTERED_SIGN_IN_TEXT), h.slice(0, 200));
  ok('G4 LoginPage: email filled in, not signed in', h.includes('value="rivka@vaad.test"') && signedIn === 0);
}

// ---------------------------------------------------------------- P: change password 503 + passwordChanged
{
  const { ChangePasswordModal, PASSWORD_CHANGED_NO_SESSION_TEXT } = await import('../../src/components/ChangePasswordModal.tsx');
  setSessionToken('tok-P'); events.length = 0;
  stubFetch({ 'POST /api/auth/change-password': { status: 503, body: { ...STORE_DOWN.body, passwordChanged: true } } });
  const m = mount(ChangePasswordModal, { isOpen: true, onClose() {}, currentUser: { id: 'u', email: 'a@x.test', name: 'A', role: 'admin' } });
  await m.render();
  await m.type('Enter current password', 'oldpass123');
  await m.type('Enter new password', 'newpass456');
  await m.type('Re-enter new password', 'newpass456');
  await m.submit();
  const h = decode(m.html());
  ok('P1 says the password changed, no "try again"', h.includes(PASSWORD_CHANGED_NO_SESSION_TEXT) && !h.includes('Please try again in a moment'));
  ok('P1 no sign-out from the 503', !events.includes('shutfey:unauthorized'));
}

console.log(`${failures ? 'FAILED' : 'PASS'} test-11-session-client: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
