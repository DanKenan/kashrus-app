/**
 * Item 11a-c client (servers #135 user cookie, #137 kiosk cookies): the move
 * from the stored token to the HttpOnly cookies, with no visible change.
 *  A  apiFetch: every call opts in (X-Shutfey-Auth: cookie, same-origin); a
 *     stored token still goes as Bearer; on the cookie no Authorization; a
 *     tablet on the device cookie sends no X-Kiosk-Device.
 *  B  on the cookie: a 401 signs out; a 401 for an older sign-in is ignored; a
 *     GET 503 is retried and never a sign-out.
 *  C  the move: me (token) -> adopt -> me (cookie only, same person) -> token
 *     deleted. 404/403 = keep today's way (not tried again); 401/503/offline,
 *     another person, auth 'bearer', a token replaced meanwhile = token kept.
 *  K  the tablet: kiosk adopt with the device header; then me on the cookies
 *     only (same tablet + venue) -> token deleted, device secret replaced by
 *     'cookie:<deviceId>'; a different tablet = kept.
 *  S  start: on the cookie GET /api/auth/me (401 signs out, 503 stays);
 *     a token stored after start is moved; stop() stops it.
 *  L  sign-out on the cookie: POST /api/auth/logout on the cookie; 503 tried
 *     again then sent on the next start; a new sign-in cancels it.
 *  W  socket: /ws?auth=cookie on the cookie (no token in the URL, no device
 *     frame on the device cookie); 4401 checked on the cookie.
 *  M  memberships / activate / merge use the cookie when no token is given.
 * Run: npx tsx tests/client/test-11a-cookie-client.mjs
 */
globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), get length() { return store.size; }, key: (i) => Array.from(store.keys())[i] ?? null };
// The browser's Web Locks, shared by every "tab" (module instance) of this test: FIFO, one holder,
// a waiter can give up through its AbortSignal. lockHeld() tells whether a move holds it now.
const webLocksFake = (() => {
  let holder = null; const queue = [];
  const next = () => { if (holder || !queue.length) return; const w = queue.shift(); holder = w; Promise.resolve().then(() => w.cb()).then(w.resolve, w.reject).finally(() => { holder = null; next(); }); };
  return {
    request(name, opts, cb) {
      return new Promise((resolve, reject) => {
        const w = { cb, resolve, reject };
        const sig = opts && opts.signal;
        if (sig) sig.addEventListener?.('abort', () => { const i = queue.indexOf(w); if (i >= 0) { queue.splice(i, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); } });
        queue.push(w); next();
      });
    },
    held: () => !!holder,
  };
})();
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { locks: webLocksFake } });
const logoutMarks = () => Array.from(store.keys()).filter((k) => k.startsWith('shutfey_logout_in_flight:'));
const events = [];
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '', protocol: 'https:', host: 'app.example' }, addEventListener() {}, removeEventListener() {} };
globalThis.window.dispatchEvent = (e) => { events.push(e.type); return true; };
globalThis.CustomEvent ??= class { constructor(type) { this.type = type; } };

const api = await import('../../src/lib/api.ts');
const { setSessionToken, getSessionToken, apiFetch, endServerSession, sessionTiming, isCookieSession, getKioskDevice, setKioskDevice, syncCookieSession } = api;
sessionTiming.storeRetryDelaysMs = [5, 5];
sessionTiming.authSettleGraceMs = 5;

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const raw = String(url);
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    const h = opts.headers instanceof Headers ? Object.fromEntries(opts.headers.entries()) : Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call0 = { method, path, body: body ?? null, h, opts, tokenInStore: getSessionToken() };
    calls.push(call0);
    let r = routes[`${method} ${path}`];
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
    if (typeof r === 'function') r = r(body, h);
    if (r && r.gate) {
      const sig = opts.signal;
      await new Promise((resolve, reject) => {
        r.gate.then(resolve, reject);
        if (sig) {
          if (sig.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          sig.addEventListener?.('abort', () => { call0.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
        }
      });
    }
    if (r === 'THROW') throw new TypeError('network');
    r = r || { status: 200, body: {} };
    const hdr = r.headers || {};
    const call = calls[calls.length - 1];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => hdr[k] ?? null }, clone() { return this; }, json: async () => { call.read = true; return r.body; }, text: async () => { call.read = true; return JSON.stringify(r.body); } };
  };
  return calls;
}
const STORE_DOWN = { status: 503, body: { error: 'Could not check your sign-in right now. Please try again in a moment.', code: 'SESSION_STORE_UNAVAILABLE' } };
const R401 = { status: 401, body: { error: 'Sign in required. Please log in again.' } };
const meUser = (id, auth, kiosk) => ({ status: 200, body: { user: { id, email: `${id}@x.test` }, auth, ...(kiosk ? { kiosk } : {}) } });
function reset() {
  store.clear(); events.length = 0; api.resetCookieSessionForTests();
}
const paths = (calls) => calls.map((c) => `${c.method} ${c.path}`).join(', ');
// A user route set where the move works; `cookieMe` overrides the cookie-only answer.
function userRoutes(id = 'u1', cookieMe = null, adopt = { status: 200, body: { ok: true, adopted: true } }) {
  return {
    'GET /api/auth/me': (b, h) => (h.authorization ? meUser(id, 'bearer') : (cookieMe || meUser(id, 'cookie'))),
    'POST /api/auth/session/adopt': adopt,
  };
}

// ------------------------------------------------------------------ A: headers
{
  reset();
  setSessionToken('tok-A');
  const calls = stubFetch({});
  await apiFetch('/api/agencies/current');
  ok('A1 token stored: Bearer as today', calls[0].h.authorization === 'Bearer tok-A');
  ok('A1 every call opts in to the cookie', calls[0].h['x-shutfey-auth'] === 'cookie');
  ok('A1 same-origin credentials', calls[0].opts.credentials === 'same-origin');
  setSessionToken(null); localStorage.setItem('shutfey_cookie_session', '1');
  await apiFetch('/api/tasks', { method: 'POST', body: '{}' });
  ok('A2 on the cookie: no Authorization header at all', !('authorization' in calls[1].h), JSON.stringify(calls[1].h));
  ok('A2 on the cookie: opt-in + same-origin', calls[1].h['x-shutfey-auth'] === 'cookie' && calls[1].opts.credentials === 'same-origin');
  setKioskDevice('dev1.secret1');
  await apiFetch('/api/kiosk/staff');
  ok('A3 tablet with its secret: X-Kiosk-Device as today', calls[2].h['x-kiosk-device'] === 'dev1.secret1');
  setKioskDevice('cookie:dev1');
  await apiFetch('/api/kiosk/staff');
  ok('A4 tablet on the device cookie: no X-Kiosk-Device', !('x-kiosk-device' in calls[3].h), JSON.stringify(calls[3].h));
  ok('A4 still counts as paired (marker kept)', getKioskDevice() === 'cookie:dev1' && api.getKioskDeviceSecret() === null);
  await apiFetch('/api/x', { headers: { Authorization: 'Bearer choose-1' } });
  ok('A5 a caller credential is kept as given', calls[4].h.authorization === 'Bearer choose-1');
}

// --------------------------------------------------------------- B: 401 / 503
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1'); localStorage.setItem('current_user', '{"id":"u1"}');
  stubFetch({ 'GET /api/tasks': R401 });
  await apiFetch('/api/tasks');
  ok('B1 401 on the cookie: signed out (marker + cached user gone, app told)', !isCookieSession() && localStorage.getItem('current_user') === null && events.includes('shutfey:unauthorized'));

  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  let release; const gate = new Promise((r) => { release = r; });
  stubFetch({ 'GET /api/tasks': { ...R401, gate } });
  const p = apiFetch('/api/tasks');
  await tick(5);
  setSessionToken('tok-new'); // a fresh sign-in while the old request was on its way
  release(); await p;
  ok('B2 401 for the older cookie sign-in keeps the newer one', getSessionToken() === 'tok-new' && !events.includes('shutfey:unauthorized'));

  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const calls = stubFetch({ 'GET /api/tasks': [STORE_DOWN, STORE_DOWN, { status: 200, body: {} }] });
  const r = await apiFetch('/api/tasks');
  ok('B3 GET 503 on the cookie: tried again, then fine', calls.length === 3 && r.status === 200);
  ok('B3 never a sign-out', isCookieSession() && !events.includes('shutfey:unauthorized'));

  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  stubFetch({ 'POST /api/tasks': STORE_DOWN });
  const w = await apiFetch('/api/tasks', { method: 'POST', body: '{}' });
  ok('B4 write 503 on the cookie: handed back, still signed in', w.status === 503 && isCookieSession() && !events.includes('shutfey:unauthorized'));

  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  stubFetch({ 'POST /api/auth/change-password': { status: 401, body: { error: 'Current password is incorrect.', code: 'CURRENT_PASSWORD_WRONG' } } });
  await apiFetch('/api/auth/change-password', { method: 'POST', body: '{}' });
  ok('B5 wrong current password on the cookie: not a sign-out', isCookieSession() && !events.includes('shutfey:unauthorized'));

  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  stubFetch({ 'POST /api/auth/activate': R401 });
  await apiFetch('/api/auth/activate', { method: 'POST', headers: { Authorization: 'Bearer choose-x' }, body: '{}' });
  ok('B7 a 401 for a credential the caller supplied does not end the cookie sign-in', isCookieSession() && !events.includes('shutfey:unauthorized'));

  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  let release8; const gate8 = new Promise((r) => { release8 = r; });
  stubFetch({ 'GET /api/tasks': { ...R401, gate: gate8 } });
  const p8 = apiFetch('/api/tasks');
  await tick(5);
  setSessionToken('tok-B8'); setSessionToken(null); // the stored sign-in changed while it was out
  release8(); await p8;
  ok('B8 a 401 that went out before the sign-in changed is stale (no sign-out)', isCookieSession() && !events.includes('shutfey:unauthorized'));

  // B9: another tab of this browser signed in again on the cookie while this request was out.
  reset(); localStorage.setItem('shutfey_cookie_session', 'id-old');
  let release9; const gate9 = new Promise((r) => { release9 = r; });
  stubFetch({ 'GET /api/tasks': { ...R401, gate: gate9 } });
  const p9 = apiFetch('/api/tasks');
  await tick(5);
  store.set('shutfey_cookie_session', 'id-new-from-other-tab');
  release9(); await p9;
  ok('B9 a 401 for the old cookie sign-in never ends the one another tab just made', localStorage.getItem('shutfey_cookie_session') === 'id-new-from-other-tab' && !events.includes('shutfey:unauthorized'));

  reset();
  stubFetch({ 'GET /api/tasks': R401 });
  await apiFetch('/api/tasks');
  ok('B6 signed out already (no token, no cookie): a 401 sends no event', !events.includes('shutfey:unauthorized'));
}

// --------------------------------------------------------------- C: the move
{
  reset(); setSessionToken('tok-C1');
  const calls = stubFetch(userRoutes());
  await syncCookieSession();
  ok('C1 order: me (token), adopt, me (cookie)', paths(calls) === 'GET /api/auth/me, POST /api/auth/session/adopt, GET /api/auth/me', paths(calls));
  ok('C1 adopt sent with the token + opt-in + same-origin', calls[1].h.authorization === 'Bearer tok-C1' && calls[1].h['x-shutfey-auth'] === 'cookie' && calls[1].opts.credentials === 'same-origin');
  ok('C1 the proof is sent WITHOUT the token', !('authorization' in calls[2].h) && calls[2].h['x-shutfey-auth'] === 'cookie');
  ok('C1 moved: token deleted, on the cookie', getSessionToken() === null && isCookieSession());
  const firstId = localStorage.getItem('shutfey_cookie_session');
  ok('C1 the cookie sign-in gets a random id (shared by the tabs)', typeof firstId === 'string' && firstId.length >= 8 && firstId !== '1');
  ok('C1 every answer of the move is read (no request left open; a browser keeps an unread one pending)', calls.every((c) => c.read === true), JSON.stringify(calls.map((c) => c.read)));
  ok('C1 no sign-out on the way', !events.includes('shutfey:unauthorized'));
  // A second sync on the cookie is only the start check.
  const calls2 = stubFetch(userRoutes());
  await syncCookieSession();
  ok('C1 on the cookie a later sync only asks who is signed in', paths(calls2) === 'GET /api/auth/me' && !('authorization' in calls2[0].h), paths(calls2));
}
for (const [label, routes, unsupported] of [
  ['me 404 (older server)', { 'GET /api/auth/me': { status: 404, body: {} } }, true],
  ['adopt 404 (older server)', userRoutes('u1', null, { status: 404, body: {} }), true],
  ['adopt 403 (no trusted Origin)', userRoutes('u1', null, { status: 403, body: { code: 'CSRF_ORIGIN' } }), true],
  ['adopt 401', userRoutes('u1', null, R401), false],
  ['adopt 503', userRoutes('u1', null, STORE_DOWN), false],
  ['adopt offline', userRoutes('u1', null, 'THROW'), false],
  ['me (token) 401', { 'GET /api/auth/me': R401 }, false],
  ['me (token) 503', { 'GET /api/auth/me': STORE_DOWN }, false],
  ['proof 401', userRoutes('u1', R401), false],
  ['proof 503', userRoutes('u1', STORE_DOWN), false],
  ['proof says another person', userRoutes('u1', meUser('u2', 'cookie')), false],
  ['proof answered by Bearer', userRoutes('u1', meUser('u1', 'bearer')), false],
  ['proof answers a kiosk', userRoutes('u1', meUser('u1', 'cookie', { venueId: 'v1', deviceId: 'd1' })), false],
  ['both answers name no person', { 'GET /api/auth/me': (b, h) => ({ status: 200, body: { auth: h.authorization ? 'bearer' : 'cookie' } }), 'POST /api/auth/session/adopt': { status: 200, body: { ok: true } } }, false],
]) {
  reset(); setSessionToken('tok-C2');
  const calls = stubFetch(routes);
  await syncCookieSession();
  ok(`C2 ${label}: token kept, not on the cookie, no sign-out`, getSessionToken() === 'tok-C2' && !isCookieSession() && !events.includes('shutfey:unauthorized'), paths(calls));
  ok(`C2 ${label}: every me answer read (none left open)`, calls.filter((c) => c.path === '/api/auth/me').every((c) => c.read === true));
  const again = stubFetch(userRoutes());
  await syncCookieSession();
  if (unsupported) ok(`C2 ${label}: not tried again this page load`, again.length === 0 && getSessionToken() === 'tok-C2', paths(again));
  else ok(`C2 ${label}: tried again next time (and then moves)`, again.length === 3 && getSessionToken() === null && isCookieSession(), paths(again));
}
{
  // C3: a newer token stored while the move was on its way is never deleted.
  reset(); setSessionToken('tok-C3');
  let release; const gate = new Promise((r) => { release = r; });
  const calls = stubFetch({ ...userRoutes(), 'POST /api/auth/session/adopt': { status: 200, body: { ok: true }, gate } });
  const p = syncCookieSession();
  await tick(5);
  store.set('shutfey_session_token', 'tok-C3-new'); // e.g. change password stored a fresh token
  release(); await p;
  ok('C3 newer token kept (the old one is not "moved")', getSessionToken() === 'tok-C3-new' && !isCookieSession(), paths(calls));
}
{
  // C4: a sign-in change on its way: the move waits for it; a token it stores wins.
  reset(); setSessionToken('tok-C4');
  let releaseCp; const cpGate = new Promise((r) => { releaseCp = r; });
  stubFetch({ ...userRoutes(), 'POST /api/auth/change-password': { status: 200, body: { token: 'tok-C4-new' }, gate: cpGate } });
  const cp = apiFetch('/api/auth/change-password', { method: 'POST', body: '{}' });
  const p = syncCookieSession();
  await tick(30);
  ok('C4 still waiting while the sign-in change is on its way', getSessionToken() === 'tok-C4' && !isCookieSession());
  releaseCp(); const res = await cp; store.set('shutfey_session_token', (await res.json()).token);
  await p;
  ok('C4 the token the change stored is kept', getSessionToken() === 'tok-C4-new' && !isCookieSession());
}
{
  // C5: two syncs at once run one move; a token stored during it is moved after.
  reset(); setSessionToken('tok-C5');
  const calls = stubFetch(userRoutes());
  await Promise.all([syncCookieSession(), syncCookieSession()]);
  ok('C5 one move for two requests (then the start check)', paths(calls) === 'GET /api/auth/me, POST /api/auth/session/adopt, GET /api/auth/me, GET /api/auth/me', paths(calls));
}

{
  // C6: each move gets a new id.
  reset(); setSessionToken('tok-C6a');
  stubFetch(userRoutes());
  await syncCookieSession();
  const id1 = localStorage.getItem('shutfey_cookie_session');
  setSessionToken('tok-C6b');
  await syncCookieSession();
  const id2 = localStorage.getItem('shutfey_cookie_session');
  ok('C6 a new cookie sign-in gets a new id', !!id1 && !!id2 && id1 !== id2 && getSessionToken() === null);
}
{
  // C7: a sign-out still on its way: its answer deletes this browser's cookie, so the move of a
  // sign-in made meanwhile waits for it (the token is kept until then).
  reset(); localStorage.setItem('shutfey_cookie_session', 'id-c7');
  let releaseLo; const loGate = new Promise((r) => { releaseLo = r; });
  const calls = stubFetch({ ...userRoutes(), 'POST /api/auth/logout': { status: 200, body: { ok: true }, gate: loGate } });
  const lo = endServerSession(); api.clearSession();
  await tick(5);
  setSessionToken('tok-C7');
  const mv = syncCookieSession();
  await tick(40);
  ok('C7 no move while the sign-out is on its way (token kept)', !calls.some((c) => c.path === '/api/auth/me') && getSessionToken() === 'tok-C7', paths(calls));
  releaseLo(); await lo; await mv;
  ok('C7 after the sign-out answered, the move runs and finishes', getSessionToken() === null && isCookieSession(), paths(calls));
}
{
  // C7b: a newer token stored while the move waited: the older one is not sent at all.
  reset(); localStorage.setItem('shutfey_cookie_session', 'id-c7b');
  let releaseLo; const loGate = new Promise((r) => { releaseLo = r; });
  const calls = stubFetch({ ...userRoutes(), 'POST /api/auth/logout': { status: 200, body: { ok: true }, gate: loGate } });
  const lo = endServerSession(); api.clearSession();
  store.set('shutfey_session_token', 'tok-C7b-old');
  const mv = syncCookieSession();
  await tick(20);
  setSessionToken('tok-C7b-new');
  releaseLo(); await lo; await mv; await syncCookieSession();
  ok('C7b the older token is never sent after the wait', !calls.some((c) => c.h.authorization === 'Bearer tok-C7b-old'), JSON.stringify(calls.map((c) => c.h.authorization || '-')));
  ok('C7b the newer one is moved', getSessionToken() === null && isCookieSession());
}
{
  // C8: a token sign-out on its way counts too.
  reset(); setSessionToken('tok-C8-old');
  let releaseLo; const loGate = new Promise((r) => { releaseLo = r; });
  const calls = stubFetch({ ...userRoutes(), 'POST /api/auth/logout': { status: 200, body: { ok: true }, gate: loGate } });
  const lo = endServerSession(getSessionToken()); api.clearSession();
  setSessionToken('tok-C8-new');
  const mv = syncCookieSession();
  await tick(40);
  ok('C8 token sign-out on its way: the move waits', !calls.some((c) => c.path === '/api/auth/me') && getSessionToken() === 'tok-C8-new');
  releaseLo(); await lo; await mv;
  ok('C8 then it moves', getSessionToken() === null && isCookieSession());
}
{
  // C9: a sign-out that never answers: the move gives up for now (token kept), no hang.
  reset();
  sessionTiming.logoutSettleMaxMs = 30; sessionTiming.logoutAbortMarginMs = -100000; // (the cut-off is E1's)
  stubFetch({ ...userRoutes(), 'POST /api/auth/logout': { status: 200, body: {}, gate: new Promise(() => {}) } });
  setSessionToken('tok-C9-old');
  void endServerSession(getSessionToken()); api.clearSession();
  setSessionToken('tok-C9');
  await syncCookieSession();
  sessionTiming.logoutSettleMaxMs = 15000; sessionTiming.logoutAbortMarginMs = 2000;
  ok('C9 a sign-out that never answers: token kept, move tried later', getSessionToken() === 'tok-C9' && !isCookieSession());
}

// ------------------------------------------------- T: two tabs of one browser
// A second module instance = a second tab: its own memory, the same localStorage.
const apiB = await import('../../src/lib/api.ts?tab=b');
apiB.sessionTiming.storeRetryDelaysMs = [5, 5];
apiB.sessionTiming.authSettleGraceMs = 5;
function resetBoth() { reset(); apiB.resetCookieSessionForTests(); }
{
  // T1 (RV1 P1-2): tab A's old-cookie 401 arrives after tab B signed in again and moved.
  resetBoth(); setSessionToken('tok-T1a');
  stubFetch(userRoutes());
  await syncCookieSession();
  let release; const gate = new Promise((r) => { release = r; });
  stubFetch({ ...userRoutes(), 'GET /api/tasks': { ...R401, gate } });
  const pA = apiFetch('/api/tasks');
  await tick(5);
  apiB.setSessionToken('tok-T1b');
  await apiB.syncCookieSession();
  const idB = localStorage.getItem('shutfey_cookie_session');
  release(); await pA;
  ok('T1 tab B moved its new sign-in', apiB.getSessionToken() === null && !!idB);
  ok("T1 tab A's stale 401 does not end tab B's newer sign-in", localStorage.getItem('shutfey_cookie_session') === idB && !events.includes('shutfey:unauthorized'));
}
{
  // T2 (RV1 P1-1): tab A's sign-out on its way; tab B signs in: B's move waits for A's answer.
  resetBoth(); localStorage.setItem('shutfey_cookie_session', 'id-T2');
  let release; const gate = new Promise((r) => { release = r; });
  const calls = stubFetch({ ...userRoutes(), 'POST /api/auth/logout': { status: 200, body: { ok: true }, gate } });
  const lo = endServerSession(); api.clearSession();
  apiB.setSessionToken('tok-T2b');
  const mv = apiB.syncCookieSession();
  await tick(60);
  ok("T2 tab B's move waits for tab A's sign-out answer (token kept)", !calls.some((c) => c.path === '/api/auth/me') && apiB.getSessionToken() === 'tok-T2b', paths(calls));
  release(); await lo; await mv;
  ok('T2 then tab B moves', apiB.getSessionToken() === null && apiB.isCookieSession() && localStorage.getItem('shutfey_logout_in_flight') === null);
}
{
  // T3 (RV1 P1-3): tab A's adopt is on its way; tab B stores a newer token: B's adopt is sent only
  // after A's move is over (Web Lock), so a late answer of A's can never overwrite B's newer cookie.
  resetBoth();
  setSessionToken('tok-T3a');
  let releaseA; const gateA = new Promise((r) => { releaseA = r; });
  const order = [];
  const calls = stubFetch({
    'GET /api/auth/me': (b, h) => (h.authorization ? meUser('u1', 'bearer') : meUser('u1', 'cookie')),
    'POST /api/auth/session/adopt': (b, h) => { order.push(h.authorization); return h.authorization === 'Bearer tok-T3a' ? { status: 200, body: { ok: true }, gate: gateA } : { status: 200, body: { ok: true } }; },
  });
  const mvA = syncCookieSession();
  await tick(60);
  apiB.setSessionToken('tok-T3b');
  const mvB = apiB.syncCookieSession();
  await tick(80);
  ok("T3 tab B's adopt waits while tab A's is on its way (A holds the lock)", order.length === 1 && order[0] === 'Bearer tok-T3a' && webLocksFake.held(), JSON.stringify(order));
  releaseA(); await mvA; await mvB;
  ok('T3 then B adopts the newest token last', order.length === 2 && order[1] === 'Bearer tok-T3b', JSON.stringify(order));
  ok("T3 A did not delete B's token; B moved it", getSessionToken() === null && isCookieSession() && calls.filter((c) => c.path === '/api/auth/session/adopt').length === 2);
}
{
  // T4 (RV4): a browser without Web Locks never moves: it keeps the token (today's way), no request, no retry.
  resetBoth();
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {} });
  sessionTiming.movePostponedRetryMs = 30;
  setSessionToken('tok-T4');
  const c = stubFetch(userRoutes());
  await syncCookieSession();
  Object.defineProperty(globalThis, 'navigator', nav);
  await tick(120);
  sessionTiming.movePostponedRetryMs = 10000;
  ok('T4 no Web Locks: token kept, nothing sent, no retry loop', getSessionToken() === 'tok-T4' && !isCookieSession() && c.length === 0, paths(c));
  // another tab holds the lock (its move is running): wait, then keep the token and try later
  resetBoth();
  let releaseHold; const hold = new Promise((r) => { releaseHold = r; });
  const holding = webLocksFake.request('shutfey-cookie-move', {}, () => hold);
  sessionTiming.moveLockMaxMs = 80; sessionTiming.movePostponedRetryMs = 60;
  setSessionToken('tok-T4b');
  const c2 = stubFetch(userRoutes());
  await syncCookieSession();
  ok('T4 another tab moving: wait, then keep the token for later', getSessionToken() === 'tok-T4b' && c2.length === 0, paths(c2));
  releaseHold(); await holding;
  for (let i = 0; i < 30 && getSessionToken(); i++) await tick(20);
  sessionTiming.moveLockMaxMs = 30000; sessionTiming.movePostponedRetryMs = 10000;
  ok('T4 the postponed move runs by itself once the lock is free', getSessionToken() === null && isCookieSession());
}

{
  // E1 (RV2 P1-1): tab A's sign-out answer is late (past every wait): it is never cut off, so tab B
  // keeps its token (move postponed, tried again) until A's answer is in; then B moves.
  resetBoth();
  sessionTiming.logoutSettleMaxMs = 60; apiB.sessionTiming.logoutSettleMaxMs = 60;
  apiB.sessionTiming.movePostponedRetryMs = 40;
  localStorage.setItem('shutfey_cookie_session', 'id-E1');
  let release; const gate = new Promise((r) => { release = r; });
  const calls = stubFetch({ ...userRoutes(), 'POST /api/auth/logout': { status: 200, body: { ok: true }, gate } });
  const lo = endServerSession(); api.clearSession();
  ok('E1 the sign-out request is not cut off (no abort signal)', !calls[0].opts.signal);
  apiB.setSessionToken('tok-E1b');
  await apiB.syncCookieSession();
  await tick(200);
  ok("E1 past the wait, tab B still keeps its token while A's sign-out may land", apiB.getSessionToken() === 'tok-E1b' && !calls.some((c) => c.path === '/api/auth/session/adopt'), paths(calls));
  release(); await lo;
  for (let i = 0; i < 40 && apiB.getSessionToken(); i++) await tick(20);
  ok("E1 once A's answer is in, B's postponed move runs by itself", apiB.getSessionToken() === null && apiB.isCookieSession() && logoutMarks().length === 0, paths(calls));
  sessionTiming.logoutSettleMaxMs = 15000; apiB.sessionTiming.logoutSettleMaxMs = 15000; apiB.sessionTiming.movePostponedRetryMs = 10000;
}
{
  // E1b (RV2 P1-2): two sign-outs at the same moment each have their own mark; the first answer
  // removes only its own, so the second still holds the moves back.
  resetBoth(); setSessionToken('tok-E1b-a'); apiB.resetCookieSessionForTests();
  sessionTiming.logoutSettleMaxMs = 40;
  let r1, r2; const g1 = new Promise((r) => { r1 = r; }); const g2 = new Promise((r) => { r2 = r; });
  const realNow = Date.now; const frozen = realNow(); Date.now = () => frozen;
  stubFetch({ ...userRoutes(), 'POST /api/auth/logout': [{ status: 200, body: {}, gate: g1 }, { status: 200, body: {}, gate: g2 }] });
  const lo1 = endServerSession('tok-x1');
  const lo2 = apiB.endServerSession('tok-x2');
  Date.now = realNow;
  ok('E1b two marks for two sign-outs sent at the same moment', logoutMarks().length === 2, JSON.stringify(logoutMarks()));
  r1(); await lo1;
  ok('E1b the first answer removes only its own mark', logoutMarks().length === 1);
  const c = stubFetch(userRoutes());
  await syncCookieSession();
  ok('E1b the second sign-out still on its way: no move (token kept)', getSessionToken() === 'tok-E1b-a' && c.length === 0, paths(c));
  r2(); await lo2;
  await syncCookieSession();
  ok('E1b after both answers: the move runs', getSessionToken() === null && isCookieSession());
  sessionTiming.logoutSettleMaxMs = 15000;
}
{
  // E1c: a mark left by a closed tab counts for logoutUnknownMaxMs, then it is dropped.
  resetBoth(); sessionTiming.logoutSettleMaxMs = 30;
  store.set('shutfey_logout_in_flight:closedtab', String(Date.now() - 1000));
  setSessionToken('tok-E1c');
  let c = stubFetch(userRoutes());
  await syncCookieSession();
  ok('E1c a recent mark of a closed tab: token kept (it may still land)', getSessionToken() === 'tok-E1c' && c.length === 0);
  store.set('shutfey_logout_in_flight:closedtab', String(Date.now() - sessionTiming.logoutUnknownMaxMs - 1));
  await syncCookieSession();
  ok('E1c past logoutUnknownMaxMs it is dropped and the move runs', getSessionToken() === null && isCookieSession() && logoutMarks().length === 0);
  sessionTiming.logoutSettleMaxMs = 15000;
}
{
  // E2 (RV2): a hung adopt is cut off (no late Set-Cookie after the move ends); token kept.
  resetBoth(); sessionTiming.adoptMaxMs = 50; sessionTiming.adoptAbortGraceMs = 60;
  setSessionToken('tok-E2');
  const calls = stubFetch({ ...userRoutes(), 'POST /api/auth/session/adopt': { status: 200, body: {}, gate: new Promise(() => {}) } });
  const t0 = Date.now();
  let heldDuringGrace = null;
  setTimeout(() => { heldDuringGrace = webLocksFake.held(); }, 80);
  await syncCookieSession();
  const took = Date.now() - t0;
  sessionTiming.adoptMaxMs = 20000; sessionTiming.adoptAbortGraceMs = 5000;
  ok('E2 after the cut-off the lock is held a little longer (a late answer lands first)', took >= 100 && heldDuringGrace === true, `took=${took} held=${heldDuringGrace}`);
  const ad = calls.find((c) => c.path === '/api/auth/session/adopt');
  ok('E2 a hung adopt is aborted, token kept, not on the cookie', ad && ad.aborted === true && getSessionToken() === 'tok-E2' && !isCookieSession());
  ok('E2 and the lock is released', !webLocksFake.held());
}
{
  // E6 (RV3): another tab stored a newer token while A's first me was out (A holds the lock):
  // A must not adopt its older token.
  resetBoth();
  setSessionToken('tok-E6a');
  let release; const gate = new Promise((r) => { release = r; });
  const calls = stubFetch({
    'GET /api/auth/me': (b, h) => (h.authorization === 'Bearer tok-E6a' ? { ...meUser('u1', 'bearer'), gate } : meUser('u1', h.authorization ? 'bearer' : 'cookie')),
    'POST /api/auth/session/adopt': { status: 200, body: { ok: true } },
  });
  const mvA = syncCookieSession();
  await tick(40);
  store.set('shutfey_session_token', 'tok-E6b');
  release(); await mvA;
  ok('E6 the older token is not adopted after a newer one was stored', !calls.some((c) => c.path === '/api/auth/session/adopt' && c.h.authorization === 'Bearer tok-E6a'), paths(calls));
}
// ------------------------------------------------------------------ K: tablet
{
  reset(); setKioskDevice('dev1.sec1'); setSessionToken('ktok-1');
  const kme = (h) => (h.authorization ? meUser('m1', 'bearer', { venueId: 'v1', deviceId: 'dev1' }) : meUser('m1', 'cookie', { venueId: 'v1', deviceId: 'dev1' }));
  const calls = stubFetch({ 'GET /api/auth/me': (b, h) => kme(h), 'POST /api/kiosk/session/adopt': { status: 200, body: { ok: true, adopted: true } } });
  await syncCookieSession();
  ok('K1 order: me, kiosk adopt, me', paths(calls) === 'GET /api/auth/me, POST /api/kiosk/session/adopt, GET /api/auth/me', paths(calls));
  ok('K1 kiosk adopt carries the token + device header + opt-in', calls[1].h.authorization === 'Bearer ktok-1' && calls[1].h['x-kiosk-device'] === 'dev1.sec1' && calls[1].h['x-shutfey-auth'] === 'cookie');
  ok('K1 proof on the cookies only (no token, no device header)', !('authorization' in calls[2].h) && !('x-kiosk-device' in calls[2].h));
  ok('K1 moved: token deleted, secret replaced by the device marker', getSessionToken() === null && isCookieSession() && getKioskDevice() === 'cookie:dev1');
  ok('K1 the user adopt was never called on a tablet', !calls.some((c) => c.path === '/api/auth/session/adopt'));
  // Exit kiosk (sign-out) keeps the tablet paired; the next PIN sign-in uses the device cookie.
  const out = stubFetch({ 'POST /api/auth/logout': { status: 200, body: { ok: true } } });
  const p = endServerSession(getSessionToken()); api.clearSession(); await p;
  ok('K2 exit = POST /api/auth/logout on the cookie, no device header', out.length === 1 && !('authorization' in out[0].h) && !('x-kiosk-device' in out[0].h) && out[0].h['x-shutfey-auth'] === 'cookie', paths(out));
  ok('K2 still paired after the exit', getKioskDevice() === 'cookie:dev1' && !isCookieSession());
}
for (const [label, cookieKiosk] of [['another tablet', { venueId: 'v1', deviceId: 'dev2' }], ['another venue', { venueId: 'v2', deviceId: 'dev1' }], ['no kiosk field', null]]) {
  reset(); setKioskDevice('dev1.sec1'); setSessionToken('ktok-2');
  stubFetch({ 'GET /api/auth/me': (b, h) => (h.authorization ? meUser('m1', 'bearer', { venueId: 'v1', deviceId: 'dev1' }) : meUser('m1', 'cookie', cookieKiosk)), 'POST /api/kiosk/session/adopt': { status: 200, body: { ok: true } } });
  await syncCookieSession();
  ok(`K3 proof shows ${label}: token and device secret kept`, getSessionToken() === 'ktok-2' && getKioskDevice() === 'dev1.sec1' && !isCookieSession());
}
{
  // K3b: a kiosk answer without its tablet and venue is not a proof (both sides alike).
  reset(); setKioskDevice('dev1.sec1'); setSessionToken('ktok-2b');
  stubFetch({ 'GET /api/auth/me': (b, h) => meUser('m1', h.authorization ? 'bearer' : 'cookie', {}), 'POST /api/kiosk/session/adopt': { status: 200, body: { ok: true } } });
  await syncCookieSession();
  ok('K3b kiosk answers without tablet/venue: token and device secret kept', getSessionToken() === 'ktok-2b' && getKioskDevice() === 'dev1.sec1' && !isCookieSession());
}
for (const [label, ans] of [['404', { status: 404, body: {} }], ['403', { status: 403, body: { code: 'CSRF_ORIGIN' } }], ['401', R401], ['503', STORE_DOWN]]) {
  reset(); setKioskDevice('dev1.sec1'); setSessionToken('ktok-3');
  stubFetch({ 'GET /api/auth/me': meUser('m1', 'bearer', { venueId: 'v1', deviceId: 'dev1' }), 'POST /api/kiosk/session/adopt': ans });
  await syncCookieSession();
  ok(`K4 kiosk adopt ${label}: today's way kept`, getSessionToken() === 'ktok-3' && getKioskDevice() === 'dev1.sec1' && !isCookieSession() && !events.includes('shutfey:unauthorized'));
}

// ------------------------------------------------------------------- S: start
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const calls = stubFetch({ 'GET /api/auth/me': meUser('u1', 'cookie') });
  const stop = api.startCookieSession(); await tick(20);
  ok('S1 start on the cookie: GET /api/auth/me on the cookie', paths(calls) === 'GET /api/auth/me' && !('authorization' in calls[0].h));
  ok('S1 its answer is read (the page settles)', calls[0].read === true);
  stubFetch(userRoutes('u9'));
  setSessionToken('tok-S'); // a new sign-in after start
  await tick(40);
  ok('S2 a token stored after start is moved to the cookie', getSessionToken() === null && isCookieSession());
  stop();
  const after = stubFetch(userRoutes('u9'));
  setSessionToken('tok-S2'); await tick(40);
  ok('S3 stopped: no move', after.length === 0 && getSessionToken() === 'tok-S2');
}
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  stubFetch({ 'GET /api/auth/me': R401 });
  await syncCookieSession();
  ok('S4 start check 401: signed out', !isCookieSession() && events.includes('shutfey:unauthorized'));
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const c = stubFetch({ 'GET /api/auth/me': STORE_DOWN });
  await syncCookieSession();
  ok('S5 start check 503: tried again, stays signed in', c.length === 3 && isCookieSession() && !events.includes('shutfey:unauthorized'));
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  stubFetch({ 'GET /api/auth/me': 'THROW' });
  await syncCookieSession();
  ok('S6 start check offline: stays signed in', isCookieSession() && !events.includes('shutfey:unauthorized'));
  reset();
  const none = stubFetch({});
  await syncCookieSession();
  ok('S7 signed out: nothing sent', none.length === 0);
}

// ------------------------------------------------------------- L: sign-out
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const calls = stubFetch({ 'POST /api/auth/logout': { status: 200, body: { ok: true, revoked: true } } });
  const p = endServerSession(getSessionToken()); api.clearSession(); await p;
  ok('L1 cookie sign-out: one POST /api/auth/logout on the cookie', calls.length === 1 && !('authorization' in calls[0].h) && calls[0].h['x-shutfey-auth'] === 'cookie' && calls[0].opts.credentials === 'same-origin');
  ok('L1 keepalive', calls[0].opts.keepalive === true);
  ok('L1 the answer is read', calls[0].read === true);
  ok('L1 signed out locally, nothing pending', !isCookieSession() && localStorage.getItem('shutfey_logout_pending') === null);
}
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const calls = stubFetch({ 'POST /api/auth/logout': STORE_DOWN });
  const p = endServerSession(); api.clearSession(); await p;
  ok('L2 503: sent again (3 tries), signed out locally at once', calls.length === 3 && !isCookieSession());
  ok('L2 still unconfirmed: kept for the next start', localStorage.getItem('shutfey_logout_pending') === '1');
  const next = stubFetch({ 'POST /api/auth/logout': { status: 200, body: { ok: true } } });
  await syncCookieSession();
  ok('L3 next start sends it again, then it is done', next.length === 1 && next[0].path === '/api/auth/logout' && localStorage.getItem('shutfey_logout_pending') === null);
}
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  stubFetch({ 'POST /api/auth/logout': 'THROW' });
  const p = endServerSession(); api.clearSession(); await p;
  ok('L4 offline: pending', localStorage.getItem('shutfey_logout_pending') === '1');
  setSessionToken('tok-new-signin');
  ok('L4 a new sign-in cancels the old pending sign-out', localStorage.getItem('shutfey_logout_pending') === null);
  const c = stubFetch(userRoutes());
  await syncCookieSession();
  ok('L4 ...so it is never sent (it would end the new cookie)', !c.some((x) => x.path === '/api/auth/logout'), paths(c));
}
{
  // L4b: a new sign-in while the cookie sign-out waits to be sent again: the retry is dropped.
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  sessionTiming.storeRetryDelaysMs = [60, 60];
  const calls = stubFetch({ 'POST /api/auth/logout': STORE_DOWN });
  const p = endServerSession(); api.clearSession();
  await tick(20);
  setSessionToken('tok-L4b');
  await p;
  sessionTiming.storeRetryDelaysMs = [5, 5];
  ok('L4b after the new sign-in no further logout is sent', calls.length === 1, paths(calls));
}
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  stubFetch({ 'POST /api/auth/logout': R401 });
  const p = endServerSession(); api.clearSession(); await p;
  ok('L5 401 (already ended): done, nothing pending', localStorage.getItem('shutfey_logout_pending') === null);
  reset();
  const c = stubFetch({});
  await endServerSession();
  ok('L6 no token and not on the cookie: nothing sent', c.length === 0);
  reset(); setSessionToken('tok-L7');
  const b = stubFetch({ 'POST /api/auth/logout': STORE_DOWN });
  const p7 = endServerSession(getSessionToken()); api.clearSession(); await p7;
  ok('L7 token sign-out unchanged: one call with the token, nothing pending', b.length === 1 && b[0].h.authorization === 'Bearer tok-L7' && localStorage.getItem('shutfey_logout_pending') === null);
}
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const c = stubFetch({ 'POST /api/auth/logout': { status: 200, body: { ok: true } } });
  api.endSessionForKioskEntry(); await tick(10);
  ok('L8 kiosk clean slate on the cookie: logout sent on the cookie, cookie sign-in forgotten', c.length === 1 && c[0].path === '/api/auth/logout' && !('authorization' in c[0].h) && !isCookieSession());
  reset(); setSessionToken('tok-L8');
  const t8 = stubFetch({ 'POST /api/auth/logout': { status: 200, body: { ok: true } } });
  api.endSessionForKioskEntry(); await tick(10);
  ok('L8 token: logout with the token + opt-in (ends any sign-in cookie too)', t8.length === 1 && t8[0].h.authorization === 'Bearer tok-L8' && t8[0].h['x-shutfey-auth'] === 'cookie');
  reset();
  const n = stubFetch({});
  api.endSessionForKioskEntry(); await tick(10);
  ok('L8 nothing stored: nothing sent', n.length === 0);
}

// ------------------------------------------------------------------ W: socket
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.all.push(this); }
  send(m) { this.sent.push(m); }
  open() { this.readyState = 1; this.onopen?.(); }
  serverClose(code) { this.readyState = 3; this.onclose?.({ code }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1005 })); }
}
globalThis.WebSocket = FakeWS;
const sock = await import('../../src/lib/socketClient.ts');
const rs = sock.realtimeSocket;
const last = () => FakeWS.all[FakeWS.all.length - 1];
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  rs.connect('a@x.test', 'A');
  const s = last(); s.open();
  ok('W1 on the cookie: /ws?auth=cookie, no token in the URL', /\/ws\?auth=cookie$/.test(s.url), s.url);
  rs.disconnect();
  setKioskDevice('cookie:dev1');
  rs.connect('a@x.test', 'A');
  const k = last(); k.open();
  ok('W2 tablet on the device cookie: no KIOSK_DEVICE frame (D proves it)', !k.sent.some((m) => m.includes('KIOSK_DEVICE')), JSON.stringify(k.sent));
  rs.disconnect();
  setKioskDevice('dev1.sec1');
  rs.connect('a@x.test', 'A');
  const k2 = last(); k2.open();
  ok('W3 tablet with its secret: the frame as today', k2.sent.some((m) => m.includes('KIOSK_DEVICE') && m.includes('dev1.sec1')));
  rs.disconnect();
  setKioskDevice(null);
  store.delete('shutfey_cookie_session'); setSessionToken('tok-W');
  rs.connect('a@x.test', 'A');
  ok('W4 token stored: ?token= as today', last().url.includes('?token=tok-W') && !last().url.includes('auth=cookie'));
  rs.disconnect();
  setSessionToken(null);
  rs.connect('a@x.test', 'A');
  ok('W5 signed out: no query (as today)', /\/ws$/.test(last().url), last().url);
  rs.disconnect();
}
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const calls = stubFetch({ 'GET /api/agencies/current': R401 });
  rs.connect('a@x.test', 'A');
  const s = last(); s.open(); s.serverClose(4401);
  await tick(80);
  ok('W6 4401 on the cookie: checked over HTTP on the cookie', calls.length === 1 && !('authorization' in calls[0].h) && calls[0].h['x-shutfey-auth'] === 'cookie', paths(calls));
  ok('W6 401: signed out', !isCookieSession() && events.includes('shutfey:unauthorized'));
  rs.disconnect();
}
{
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const calls = stubFetch({ 'GET /api/agencies/current': { status: 200, body: {} } });
  const realST = globalThis.setTimeout; const timers = [];
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 1000) { timers.push(ms); return 0; } return realST(fn, ms, ...a); };
  rs.connect('a@x.test', 'A');
  const s = last(); s.open(); s.serverClose(4401);
  await tick(80);
  globalThis.setTimeout = realST;
  ok('W7 4401 but the cookie works: stays signed in, reconnects later', calls.length === 1 && isCookieSession() && timers.length === 1);
  rs.disconnect();
}
{
  // W8: a 4401 on a token socket after the device moved to the cookie meanwhile: reconnect on the cookie, no sign-out.
  reset(); setSessionToken('tok-W8');
  stubFetch({});
  rs.connect('a@x.test', 'A');
  const s = last(); s.open();
  store.delete('shutfey_session_token'); localStorage.setItem('shutfey_cookie_session', '1');
  s.serverClose(4401);
  await tick(80);
  ok('W8 moved meanwhile: reconnected on the cookie at once, not signed out', /auth=cookie$/.test(last().url) && last() !== s && isCookieSession() && !events.includes('shutfey:unauthorized'), last().url);
  rs.disconnect();
}

// ------------------------------------------------------- M: plain-fetch callers
{
  const mem = await import('../../src/lib/memberships.ts');
  const merge = await import('../../src/lib/accountMerge.ts');
  reset(); localStorage.setItem('shutfey_cookie_session', '1');
  const calls = stubFetch({
    'GET /api/auth/memberships': { status: 200, body: { memberships: [] } },
    'POST /api/auth/activate': { status: 200, body: { token: 't2', user: { id: 'u2' } } },
    'POST /api/account/merge-into': { status: 200, body: {} },
    'POST /api/account/bring-in': { status: 200, body: {} },
  });
  const list = await mem.fetchMemberships(getSessionToken());
  ok('M1 memberships on the cookie: asked, no token', Array.isArray(list) && calls[0] && !('authorization' in calls[0].h) && calls[0].h['x-shutfey-auth'] === 'cookie' && calls[0].opts.credentials === 'same-origin');
  const act = await mem.activateMembership(getSessionToken(), 'm2');
  ok('M2 switch agency on the cookie works', act.ok === true && !('authorization' in calls[1].h) && calls[1].h['x-shutfey-auth'] === 'cookie');
  await mem.activateMembership('choose-tok', 'm2');
  ok('M3 the chooser token still goes as Bearer', calls[2].h.authorization === 'Bearer choose-tok');
  await merge.mergeAccounts('bring-in', { email: 'b@x.test', password: 'pw' }, 'op1', getSessionToken());
  ok('M4 merge on the cookie: opt-in, no token, same-origin', calls[3] && !('authorization' in calls[3].h) && calls[3].h['x-shutfey-auth'] === 'cookie' && calls[3].opts.credentials === 'same-origin', paths(calls));
  reset();
  const none = stubFetch({});
  ok('M5 signed out: memberships not asked', (await mem.fetchMemberships(getSessionToken())) === null && none.length === 0);
}

// --------------------------------------------- X: source rules (no visible change)
{
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  ok('X1 App starts the cookie session once', /useEffect\(\(\) => startCookieSession\(\), \[\]\)/.test(app));
  ok('X2 ?kiosk=1 ends the server session and any sign-in cookie too', /endSessionForKioskEntry\(\);/.test(app));
  const header = fs.readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8');
  ok('X3 backup download no longer reads the token from storage by hand', !header.includes("localStorage.getItem('shutfey_session_token')") && header.includes('sessionAuthHeaders()'));
  const srcDir = new URL('../../src/', import.meta.url);
  const offenders = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir); if (e.isDirectory()) { if (e.name !== 'server') walk(p); } else if (/\.tsx?$/.test(e.name)) { const t = fs.readFileSync(p, 'utf8'); if (/Bearer \$\{(getSessionToken\(\)|localStorage)/.test(t)) offenders.push(e.name); } } };
  walk(srcDir);
  ok('X4 no client file builds a Bearer header from storage by hand', offenders.length === 0, offenders.join());
}

console.log(`${failures ? 'FAIL' : 'PASS'} test-11a-cookie-client: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
