/**
 * 10g client test: sign-in chooser + "Switch agency" (server #105 is live).
 *   L*  lib/memberships: clean list, choose-answer check, list + activate calls
 *       (plain fetch, bearer = the token given, never signs out a session).
 *   P*  LoginPage: an email with several agencies shows "Which agency?"; the
 *       choose token is never stored as the session; picking one activates it,
 *       stores THAT token and signs in. One agency = today's sign-in, unchanged.
 *   S*  AgencySwitcherSheet: one row per agency, current marked, tap another =
 *       activate with the stored session + onActivated; tap current = close;
 *       a refusal shows the server's words and keeps the session.
 *   H*  Header: "Switch agency" only when App passes the handler (both menus).
 *   A*  App wiring: memberships read for the signed-in phone session (also a
 *       restored one), never on a kiosk; menu item only with 2+ agencies.
 * Run: npx tsx tests/client/test-10g-chooser.mjs
 */
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = globalThis.window || {};
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent || (() => true);
globalThis.document = globalThis.document || { activeElement: null, addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; } };
const TOKEN_KEY = 'shutfey_session_token';

let calls = [];
function serve(routes) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = (opts.method || 'GET').toUpperCase();
    const h = opts.headers instanceof Headers ? Object.fromEntries(opts.headers.entries()) : (opts.headers || {});
    const auth = h.Authorization || h.authorization || null;
    let body = null; try { body = JSON.parse(opts.body); } catch {}
    calls.push({ method, path, auth, body, cache: opts.cache });
    const r = routes[`${method} ${path}`];
    if (r === 'NETWORK') throw new TypeError('Failed to fetch');
    const [status, data] = r ? (typeof r === 'function' ? r(body, auth) : r) : [404, {}];
    return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => data, clone() { return { json: async () => data }; } };
  };
}

const M = await import('../../src/lib/memberships.ts');
const two = [
  { membershipId: 'rowB', agencyId: 'agB', agencyName: 'Brooklyn Vaad', role: 'admin' },
  { membershipId: 'rowA', agencyId: 'agA', agencyName: 'Hartford Kashrut', role: 'mashgiach', isCurrent: true },
];

// L — lib
ok('L1 clean keeps fields', JSON.stringify(M.cleanMemberships(two)) === JSON.stringify(two));
ok('L2 clean drops junk + duplicates, names a blank agency', JSON.stringify(M.cleanMemberships([null, 3, { agencyName: 'x' }, { membershipId: 'r1', agencyName: ' ' }, { membershipId: 'r1' }])) === JSON.stringify([{ membershipId: 'r1', agencyId: '', agencyName: 'Agency', role: '' }]));
ok('L3 clean of a non-list -> []', M.cleanMemberships(undefined).length === 0 && M.cleanMemberships({}).length === 0);
ok('L4 choose answer recognised', M.isChooseAnswer({ chooseMembership: true, token: 't', memberships: [] }) && !M.isChooseAnswer({ token: 't', user: {} }) && !M.isChooseAnswer({ chooseMembership: true, token: '', memberships: [] }) && !M.isChooseAnswer(null));
store.set(TOKEN_KEY, 'SESSION');
serve({ 'GET /api/auth/memberships': [200, { memberships: two }] });
const listed = await M.fetchMemberships('SESSION');
ok('L5 list uses bearer + no-store', calls.length === 1 && calls[0].auth === 'Bearer SESSION' && calls[0].cache === 'no-store');
ok('L6 list returned clean', listed && listed.length === 2 && listed[1].isCurrent === true);
serve({ 'GET /api/auth/memberships': [403, { error: 'no' }] });
ok('L7 403 -> null, session kept', (await M.fetchMemberships('SESSION')) === null && store.get(TOKEN_KEY) === 'SESSION');
serve({ 'GET /api/auth/memberships': [401, { error: 'Sign in required.' }] });
ok('L8 401 -> null, session NOT cleared by this call', (await M.fetchMemberships('SESSION')) === null && store.get(TOKEN_KEY) === 'SESSION');
serve({});
ok('L9 no token -> null, no call', (await M.fetchMemberships(null)) === null && calls.length === 0);
serve({ 'GET /api/auth/memberships': 'NETWORK' });
ok('L10 offline -> null', (await M.fetchMemberships('SESSION')) === null);
serve({ 'POST /api/auth/activate': (b, auth) => [200, { token: 'NEW-' + b.membershipId, user: { id: b.membershipId, agencyName: 'Brooklyn Vaad' }, auth }] });
const act = await M.activateMembership('CHOOSE', 'rowB');
ok('L11 activate posts membershipId with the given bearer', calls[0].method === 'POST' && calls[0].auth === 'Bearer CHOOSE' && calls[0].body.membershipId === 'rowB' && calls[0].cache === 'no-store');
ok('L12 activate returns token + user, stores nothing itself', act.ok && act.token === 'NEW-rowB' && act.user.id === 'rowB' && store.get(TOKEN_KEY) === 'SESSION');
serve({ 'POST /api/auth/activate': [403, { error: 'That membership is not available.' }] });
const bad = await M.activateMembership('SESSION', 'rowX');
ok('L13 refusal -> server words, session kept', !bad.ok && bad.error === 'That membership is not available.' && store.get(TOKEN_KEY) === 'SESSION');
serve({ 'POST /api/auth/activate': [200, { token: 'x' }] });
ok('L14 answer without user -> not ok', !(await M.activateMembership('SESSION', 'rowB')).ok);
serve({ 'POST /api/auth/activate': 'NETWORK' });
ok('L15 offline -> plain words', (await M.activateMembership('SESSION', 'rowB')).error === M.MEMBERSHIP_NETWORK_TEXT);
serve({});
ok('L16 no token / no id -> no call', !(await M.activateMembership(null, 'rowB')).ok && !(await M.activateMembership('S', '')).ok && calls.length === 0);

// P — LoginPage
const { LoginPage } = await import('../../src/components/LoginPage.tsx');
store.clear();
let signedIn = [];
const lp = mount(LoginPage, { onLoginSuccess: (u) => signedIn.push(u), darkMode: false, onToggleDarkMode() {} });
await lp.render();
serve({
  'POST /api/auth/login': [200, { chooseMembership: true, token: 'CHOOSE-TOKEN', memberships: two }],
  'POST /api/auth/activate': (b, auth) => [200, { token: 'ROW-' + b.membershipId, user: { id: b.membershipId, name: 'Dana', role: 'admin', agencyName: 'Brooklyn Vaad' } }],
});
await lp.type('Email', 'dana@example.com');
await lp.type('Password', 'secret-pass');
await lp.submit();
ok('P1 several agencies -> "Which agency?" with both', lp.text().includes('Which agency?') && lp.text().includes('Brooklyn Vaad') && lp.text().includes('Hartford Kashrut'), lp.text().slice(0, 200));
ok('P2 choose token is NOT stored as the session', store.get(TOKEN_KEY) === undefined && signedIn.length === 0);
ok('P3 the chooser names the email and the menu switch', lp.text().includes('dana@example.com') && lp.text().includes('switch any time from the menu'));
await lp.click('Brooklyn Vaad');
const actCall = calls.find((c) => c.path === '/api/auth/activate');
ok('P4 picking one activates it with the choose token', actCall && actCall.auth === 'Bearer CHOOSE-TOKEN' && actCall.body.membershipId === 'rowB');
ok('P5 that agency token is stored, then signed in', store.get(TOKEN_KEY) === 'ROW-rowB' && signedIn.length === 1 && signedIn[0].id === 'rowB');
// refusal on activate keeps the chooser and shows words
store.clear(); signedIn = [];
const lp2 = mount(LoginPage, { onLoginSuccess: (u) => signedIn.push(u), darkMode: false, onToggleDarkMode() {} });
await lp2.render();
serve({ 'POST /api/auth/login': [200, { chooseMembership: true, token: 'CT', memberships: two }], 'POST /api/auth/activate': [403, { error: 'That membership is not available.' }] });
await lp2.type('Email', 'dana@example.com'); await lp2.type('Password', 'pw'); await lp2.submit();
await lp2.click('Hartford Kashrut');
ok('P6 refused pick -> words shown, still choosing, nothing stored', lp2.text().includes('That membership is not available.') && lp2.text().includes('Which agency?') && store.get(TOKEN_KEY) === undefined && signedIn.length === 0);
await lp2.click('Back to sign in');
ok('P7 Back to sign in -> the form again', !lp2.text().includes('Which agency?') && lp2.find((e) => e.type === 'form').length === 1);
// one agency: today's flow
store.clear(); signedIn = [];
const lp3 = mount(LoginPage, { onLoginSuccess: (u) => signedIn.push(u), darkMode: false, onToggleDarkMode() {} });
await lp3.render();
serve({ 'POST /api/auth/login': [200, { token: 'ONE', user: { id: 'u1', name: 'Sam', role: 'mashgiach' } }] });
await lp3.type('Email', 'sam@example.com'); await lp3.type('Password', 'pw'); await lp3.submit();
ok('P8 one agency -> signed in directly as before', store.get(TOKEN_KEY) === 'ONE' && signedIn.length === 1 && calls.length === 1);
// choose answer with an empty list -> a plain error, not a blank chooser
store.clear(); signedIn = [];
const lp4 = mount(LoginPage, { onLoginSuccess: (u) => signedIn.push(u), darkMode: false, onToggleDarkMode() {} });
await lp4.render();
serve({ 'POST /api/auth/login': [200, { chooseMembership: true, token: 'CT', memberships: [] }] });
await lp4.type('Email', 'x@example.com'); await lp4.type('Password', 'pw'); await lp4.submit();
ok('P9 empty list -> error, no chooser, nothing stored', !lp4.text().includes('Which agency?') && store.get(TOKEN_KEY) === undefined && signedIn.length === 0);

// S — AgencySwitcherSheet
const { AgencySwitcherSheet } = await import('../../src/components/AgencySwitcherSheet.tsx');
store.clear(); store.set(TOKEN_KEY, 'SESSION-A');
let activated = []; let closed = 0;
const sp = { isOpen: true, onClose: () => { closed++; }, memberships: two, currentMembershipId: 'rowA', onActivated: (t, u) => activated.push([t, u]) };
const sm = mount(AgencySwitcherSheet, sp); await sm.render();
const rows = sm.find((e) => e.type === 'button' && e.props['data-membership']);
ok('S1 dialog titled Switch agency', sm.find((e) => e.props.role === 'dialog' && e.props['aria-modal'] === 'true').length === 1 && sm.text().includes('Switch agency'));
ok('S2 one row per agency, roles shown', rows.length === 2 && sm.text().includes('Admin') && sm.text().includes('Mashgiach'));
ok('S3 current marked aria-current', rows.filter((r) => r.props['aria-current'] === 'true').length === 1 && rows[1].props['aria-current'] === 'true');
serve({ 'POST /api/auth/activate': (b) => [200, { token: 'T-' + b.membershipId, user: { id: b.membershipId } }] });
await sm.click('Hartford Kashrut');
ok('S4 tap current -> just closes, no call', closed === 1 && calls.length === 0 && activated.length === 0);
await sm.click('Brooklyn Vaad');
ok('S5 tap another -> activate with the stored session', calls.length === 1 && calls[0].auth === 'Bearer SESSION-A' && calls[0].body.membershipId === 'rowB');
ok('S6 -> onActivated(token, user) then close', activated.length === 1 && activated[0][0] === 'T-rowB' && activated[0][1].id === 'rowB' && closed === 2);
serve({ 'POST /api/auth/activate': [403, { error: 'That membership is not available.' }] });
const sm2 = mount(AgencySwitcherSheet, { ...sp, onClose: () => { closed++; } }); await sm2.render();
closed = 0; activated = [];
await sm2.click('Brooklyn Vaad');
ok('S7 refusal -> words shown, stays open, session kept', sm2.text().includes('That membership is not available.') && closed === 0 && activated.length === 0 && store.get(TOKEN_KEY) === 'SESSION-A');
const shut = mount(AgencySwitcherSheet, { ...sp, isOpen: false }); await shut.render();
ok('S8 closed -> nothing rendered', shut.html() === '');

// H/A — source wiring
const hdr = fs.readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
ok('H1 Header: Switch agency in both menus, only with the handler', (hdr.match(/\{onOpenAgencySwitcher && \(/g) || []).length === 1 && (hdr.match(/\{currentUser && onOpenAgencySwitcher && \(/g) || []).length === 1 && (hdr.match(/<span>Switch agency<\/span>/g) || []).length === 2);
ok('A1 App: handler only with 2+ agencies', /onOpenAgencySwitcher=\{memberships\.length > 1 \? \(\) => setIsAgencySwitcherOpen\(true\) : undefined\}/.test(app));
ok('A2 App: list read for the signed-in row, never on a kiosk', /if \(isKiosk \|\| !currentUserRowId\) \{ setMemberships\(\[\]\);/.test(app) && /fetchMemberships\(getSessionToken\(\)\)/.test(app) && /\}, \[isKiosk, currentUserRowId\]\);/.test(app));
ok('A3 App: switching stores the new token, then signs in as that row', /onActivated=\{\(token, user\) => \{ setSessionToken\(token\); handleLoginSuccess\(user\); \}\}/.test(app));
ok('A4 App: the Header (with the menu item) is not rendered on a kiosk', /\{!isKiosk && \(\s*<Header/.test(app));
const lpSrc = fs.readFileSync(new URL('../../src/components/LoginPage.tsx', import.meta.url), 'utf8');
ok('P10 LoginPage: chooser branch comes before storing the sign-in token', lpSrc.indexOf('if (isChooseAnswer(data))') > 0 && lpSrc.indexOf('if (isChooseAnswer(data))') < lpSrc.indexOf('if (data.token) {\n        setSessionToken(data.token);'));

console.log(`10g chooser: ${passed} passed, ${failures} failed`);
if (failures) { console.log('FAILED'); process.exit(1); }
