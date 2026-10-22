/**
 * 10M part 2 client test: merge two accounts (Don, Oct 22 2026), mocked server.
 *   L*  lib/accountMerge: who stops / who stays, request body per route, plain
 *       fetch with the stored session (never signs out), success / unknown /
 *       refusal words for every error code of the signed design.
 *   F*  MergeAccountsSheet, both ways in: pick -> form -> confirm (names the
 *       email that stops and the one to use) -> merge -> done with every agency;
 *       wrong password -> words, back on the form, nothing stored; lost answer /
 *       401 -> "sign in with <main email>"; same email refused before sending;
 *       one operation id per confirmed attempt.
 *   A*  App wiring: token stored like #127, memberships from the answer, signs in
 *       as the main account; not on a kiosk; Header item in both menus.
 * Run: npx tsx tests/client/test-10m-merge-accounts.mjs
 */
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { activeElement: null, addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; } };
const TOKEN_KEY = 'shutfey_session_token';
let calls = [];
function serve(routes) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = (opts.method || 'GET').toUpperCase();
    const h = opts.headers || {};
    let body = null; try { body = JSON.parse(opts.body); } catch {}
    calls.push({ method, path, auth: h.Authorization || null, body, cache: opts.cache });
    const r = routes[`${method} ${path}`];
    if (r === 'NETWORK') throw new TypeError('Failed to fetch');
    const [status, data] = r ? (typeof r === 'function' ? r(body) : r) : [404, {}];
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  };
}
const L = await import('../../src/lib/accountMerge.ts');
const A_EMAIL = 'main@shul.test'; const B_EMAIL = 'extra@shul.test';
const MEMS = [
  { membershipId: 'rowA1', agencyId: 'agA', agencyName: 'Hartford Kashrut', role: 'admin' },
  { membershipId: 'rowB1', agencyId: 'agB', agencyName: 'Brooklyn Vaad', role: 'admin' },
];
const success = (body) => [200, { success: true, merged: true, token: 'FRESH-A', email: A_EMAIL, user: { id: 'rowB1', email: A_EMAIL, name: 'Dana' }, memberships: MEMS }];

// L — lib
ok('L1 merge-into: signed-in (B) stops, typed (A) stays', JSON.stringify(L.mergeRoles('merge-into', B_EMAIL, ` ${A_EMAIL} `)) === JSON.stringify({ stops: B_EMAIL, keeps: A_EMAIL }));
ok('L2 bring-in: typed (B) stops, signed-in (A) stays', JSON.stringify(L.mergeRoles('bring-in', A_EMAIL, B_EMAIL)) === JSON.stringify({ stops: B_EMAIL, keeps: A_EMAIL }));
ok('L3 routes', L.MERGE_ROUTE['merge-into'] === '/api/account/merge-into' && L.MERGE_ROUTE['bring-in'] === '/api/account/bring-in');
const b1 = L.mergeBody('merge-into', { email: ' main@shul.test ', password: ' pw A ', currentPassword: 'pw B' }, 'op-x-1234567890');
ok('L4 merge-into body: email trimmed, passwords as typed, currentPassword, confirm, opId', JSON.stringify(b1) === JSON.stringify({ email: 'main@shul.test', password: ' pw A ', confirm: true, operationId: 'op-x-1234567890', currentPassword: 'pw B' }));
const b2 = L.mergeBody('bring-in', { email: B_EMAIL, password: 'pwB', currentPassword: 'ignored' }, 'op-y-1234567890');
ok('L5 bring-in body has no currentPassword', !('currentPassword' in b2) && b2.confirm === true && b2.email === B_EMAIL);
const ids = new Set(Array.from({ length: 50 }, () => L.newMergeOperationId()));
ok('L6 operation ids match the server pattern and differ', ids.size === 50 && [...ids].every((x) => /^[A-Za-z0-9_-]{8,100}$/.test(x)));
store.set(TOKEN_KEY, 'SESSION-B');
serve({ 'POST /api/account/merge-into': success });
const r1 = await L.mergeAccounts('merge-into', { email: A_EMAIL, password: 'a', currentPassword: 'b' }, 'op-1-abcdefghij', 'SESSION-B');
ok('L7 posts once to the route with the session bearer, no-store', calls.length === 1 && calls[0].path === '/api/account/merge-into' && calls[0].auth === 'Bearer SESSION-B' && calls[0].cache === 'no-store');
ok('L8 success recognised; lib stores nothing', L.isMergeSuccess(r1) && store.get(TOKEN_KEY) === 'SESSION-B');
serve({ 'POST /api/account/merge-into': [401, { error: 'Sign in required. Please log in again.' }] });
const r401 = await L.mergeAccounts('merge-into', { email: A_EMAIL, password: 'a', currentPassword: 'b' }, 'op-1-abcdefghij', 'SESSION-B');
ok('L9 401 -> unknown (may have gone through), session NOT cleared here', L.isMergeUnknown(r401) && !L.isMergeSuccess(r401) && store.get(TOKEN_KEY) === 'SESSION-B');
serve({ 'POST /api/account/bring-in': 'NETWORK' });
const rnet = await L.mergeAccounts('bring-in', { email: B_EMAIL, password: 'a' }, 'op-1-abcdefghij', 'SESSION-A');
ok('L10 no answer -> unknown', rnet.status === 0 && L.isMergeUnknown(rnet));
ok('L11 200 without a token -> unknown, not success', L.isMergeUnknown({ ok: true, status: 200, data: { merged: true } }) && !L.isMergeSuccess({ ok: true, status: 200, data: { merged: true } }));
const E = (code, status = 403, error = 'srv') => L.mergeErrorText('merge-into', { ok: false, status, data: { code, error } });
ok('L12 wrong typed password (merge-into) names the main account', E('MERGE_LOGIN_FAILED') === "The main account's email or password is incorrect.");
ok('L13 wrong typed password (bring-in) names the other account', L.mergeErrorText('bring-in', { ok: false, status: 403, data: { code: 'MERGE_LOGIN_FAILED' } }) === "The other account's email or password is incorrect.");
ok('L14 wrong current password', E('MERGE_CURRENT_PASSWORD_WRONG') === 'Your password is incorrect.');
ok('L15 same account', E('MERGE_SAME_ACCOUNT', 409) === "That's the account you're signed in with.");
ok('L16 kiosk', E('KIOSK_SCOPE') === "Accounts can't be merged on a kiosk.");
ok('L17 invalid', E('MERGE_INVALID', 400) === 'Please fill in every field.');
for (const [code, st] of [['MERGE_SHARED_AGENCY', 409], ['ACCOUNT_NOT_LINKABLE', 403], ['RESET_CONFIRM_NEEDED', 403], ['INVITE_PERSON_NEEDS_CHECK', 409], ['MERGE_STALE', 409], ['MERGE_NEEDS_CHECK', 409], ['IDENTITY_CONFLICT', 409], ['RATE_LIMITED', 429], ['SAVE_FAILED', 503], ['SIZE_LIMIT', 503]])
  ok(`L18 ${code} shows the server's words`, E(code, st, `words for ${code}`) === `words for ${code}`);
ok('L19 429 without words', L.mergeErrorText('bring-in', { ok: false, status: 429, data: {} }) === 'Too many tries. Please wait a few minutes and try again.');
ok('L20 unknown refusal without words says nothing changed', /Nothing was changed/.test(L.mergeErrorText('bring-in', { ok: false, status: 500, data: {} })));

// F — sheet
const listeners = {};
globalThis.document = { activeElement: null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((x) => x !== fn); }, querySelectorAll() { return []; } };
const esc = () => (listeners.keydown || []).slice().forEach((fn) => fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
const { MergeAccountsSheet } = await import('../../src/components/MergeAccountsSheet.tsx');
function sheet(email) {
  const ev = { merged: [], signIn: 0, closed: 0 };
  const m = mount(MergeAccountsSheet, { isOpen: true, onClose: () => { ev.closed++; }, signedInEmail: email, onMerged: (t, u, l) => ev.merged.push([t, u, l]), onSignInAgain: () => { ev.signIn++; } });
  return { m, ev };
}
const stepOf = (m) => (m.find((e) => e.props['data-merge-step'])[0] || { props: {} }).props['data-merge-step'];
// F1 merge-into happy path
store.clear(); store.set(TOKEN_KEY, 'SESSION-B');
{
  const { m, ev } = sheet(B_EMAIL); await m.render();
  ok('F1 opens on the choice, both ways in', stepOf(m) === 'pick' && m.text().includes('Merge into my main account') && m.text().includes('Bring in another account'));
  ok('F1 dialog semantics', m.find((e) => e.props.role === 'dialog' && e.props['aria-modal'] === 'true').length === 1);
  esc();
  ok('F1b Escape on the choice closes', ev.closed === 1);
  await m.click('Merge into my main account');
  ok('F2 merge-into form: main email, main password, own password', stepOf(m) === 'form' && m.find((e) => e.type === 'input').length === 3 && m.text().includes('Main account email') && m.text().includes('Your password now'));
  serve({ 'POST /api/account/merge-into': success });
  await m.submit();
  ok('F3 empty -> words, nothing sent', m.text().includes('Please fill in every field.') && calls.length === 0);
  await m.type('Main account email', 'EXTRA@shul.test'); await m.type('Main account password', 'pwA'); await m.type(`Password for ${B_EMAIL}`, 'pwB');
  await m.submit();
  ok('F4 own email typed -> refused before sending', m.text().includes("That's the account you're signed in with.") && calls.length === 0 && stepOf(m) === 'form');
  await m.type('Main account email', A_EMAIL);
  await m.submit();
  ok('F5 confirm names who stops and who stays, before anything is sent', stepOf(m) === 'confirm' && calls.length === 0);
  const stops = m.find((e) => e.props['data-merge-stops'])[0]; const keeps = m.find((e) => e.props['data-merge-keeps'])[0];
  ok('F5 "<B> will stop working" / "Use <A> from now on"', /extra@shul\.test\s*will stop working/.test(m.text()) && /Use\s*main@shul\.test\s*from now on/.test(m.text()) && !!stops && !!keeps, m.text().slice(0, 300));
  await m.click('Merge accounts');
  ok('F6 one request with the stored session and the typed fields', calls.length === 1 && calls[0].path === '/api/account/merge-into' && calls[0].auth === 'Bearer SESSION-B' && calls[0].body.email === A_EMAIL && calls[0].body.password === 'pwA' && calls[0].body.currentPassword === 'pwB' && calls[0].body.confirm === true && /^op-/.test(calls[0].body.operationId));
  ok('F7 onMerged(token, user, every agency)', ev.merged.length === 1 && ev.merged[0][0] === 'FRESH-A' && ev.merged[0][1].email === A_EMAIL && ev.merged[0][2].length === 2);
  ok('F8 done: use the main email, both agencies listed, Switch agency hint', stepOf(m) === 'done' && m.find((e) => e.props['data-merged-agency']).length === 2 && /Use\s*main@shul\.test\s*from now on/.test(m.text()) && m.text().includes('"Switch agency"'));
  ok('F8 the sheet itself stores nothing', store.get(TOKEN_KEY) === 'SESSION-B');
  // After the merge App signs in as the main account, so the signed-in email prop becomes A's.
  await m.render({ signedInEmail: A_EMAIL });
  ok('F8b done still names the retired email after the sign-in switches to the main one', /extra@shul\.test no longer works/.test(m.text()) && !/main@shul\.test no longer works/.test(m.text()), m.text().slice(0, 300));
}
// F9 bring-in happy path
store.clear(); store.set(TOKEN_KEY, 'SESSION-A');
{
  const { m, ev } = sheet(A_EMAIL); await m.render();
  await m.click('Bring in another account');
  ok('F9 bring-in form: other email + password only', stepOf(m) === 'form' && m.find((e) => e.type === 'input').length === 2 && m.text().includes('Other account email'));
  await m.type('Other account email', B_EMAIL); await m.type('Other account password', 'pwB');
  await m.submit();
  ok('F10 confirm: the typed (other) email stops, mine stays', /extra@shul\.test\s*will stop working/.test(m.text()) && /Use\s*main@shul\.test\s*from now on/.test(m.text()));
  serve({ 'POST /api/account/bring-in': success });
  await m.click('Merge accounts');
  ok('F11 posts to bring-in without currentPassword', calls.length === 1 && calls[0].path === '/api/account/bring-in' && !('currentPassword' in calls[0].body) && calls[0].body.email === B_EMAIL);
  ok('F12 done', ev.merged.length === 1 && stepOf(m) === 'done');
}
// F13 wrong password -> words, back on the form, nothing stored, new op id next time
store.clear(); store.set(TOKEN_KEY, 'SESSION-B');
{
  const { m, ev } = sheet(B_EMAIL); await m.render();
  await m.click('Merge into my main account');
  await m.type('Main account email', A_EMAIL); await m.type('Main account password', 'nope'); await m.type(`Password for ${B_EMAIL}`, 'pwB');
  await m.submit();
  serve({ 'POST /api/account/merge-into': [403, { code: 'MERGE_LOGIN_FAILED', error: 'Email or password is incorrect.' }] });
  await m.click('Merge accounts');
  const op1 = calls[0].body.operationId;
  ok('F13 wrong password -> plain words on the form, nothing stored, no sign-out', stepOf(m) === 'form' && m.text().includes("The main account's email or password is incorrect.") && ev.merged.length === 0 && ev.signIn === 0 && store.get(TOKEN_KEY) === 'SESSION-B');
  await m.type('Main account password', 'pwA'); await m.submit();
  serve({ 'POST /api/account/merge-into': success });
  await m.click('Merge accounts');
  ok('F14 a new attempt after a refusal uses a new operation id', calls.length === 1 && calls[0].body.operationId !== op1 && ev.merged.length === 1);
}
// F15 lost answer -> "sign in with <A>"
for (const [label, route] of [['network', 'NETWORK'], ['401', [401, { error: 'Sign in required. Please log in again.' }]]]) {
  store.clear(); store.set(TOKEN_KEY, 'SESSION-A');
  const { m, ev } = sheet(A_EMAIL); await m.render();
  await m.click('Bring in another account');
  await m.type('Other account email', B_EMAIL); await m.type('Other account password', 'pwB'); await m.submit();
  serve({ 'POST /api/account/bring-in': route });
  await m.click('Merge accounts');
  ok(`F15 ${label}: "If the merge went through, sign in with <main email>"`, stepOf(m) === 'unknown' && /sign in with\s*main@shul\.test/.test(m.text()) && ev.merged.length === 0);
  esc();
  ok(`F15b ${label}: Escape does NOT dismiss "couldn't confirm" (only Sign in again)`, ev.closed === 0 && stepOf(m) === 'unknown');
  ok(`F15c ${label}: no Close button on that screen`, m.find((e) => e.type === 'button' && e.props['aria-label'] === 'Close').length === 0);
  await m.click('Sign in again');
  ok(`F16 ${label}: Sign in again -> onSignInAgain`, ev.signIn === 1);
}
// F17 confirm Back keeps the fields; close resets
{
  const { m } = sheet(A_EMAIL); await m.render();
  await m.click('Bring in another account');
  await m.type('Other account email', B_EMAIL); await m.type('Other account password', 'pwB'); await m.submit();
  await m.click('Back');
  ok('F17 Back from confirm -> form', stepOf(m) === 'form');
  await m.render({ isOpen: false }); await m.render({ isOpen: true });
  ok('F18 closing resets to the choice', stepOf(m) === 'pick');
}
const shut = mount(MergeAccountsSheet, { isOpen: false, onClose() {}, signedInEmail: A_EMAIL, onMerged() {}, onSignInAgain() {} }); await shut.render();
ok('F19 closed -> nothing rendered', shut.html() === '');

// A — wiring (source)
const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const hdr = fs.readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8');
ok('A1 success: store the fresh token (as #127), set every agency, sign in as the main account', /onMerged=\{\(token, user, list\) => \{[\s\S]{0,300}setSessionToken\(token\);\s*setMemberships\(list\);\s*handleLoginSuccess\(user\);/.test(app));
ok('A2 lost answer: close and sign out so the person signs in with the main email', /onSignInAgain=\{\(\) => \{ setIsMergeAccountsOpen\(false\); handleLogout\(\); \}\}/.test(app));
ok('A3 never on a kiosk', /isOpen=\{isMergeAccountsOpen && !isKiosk\}/.test(app) && /\{!isKiosk && \(\s*<Header/.test(app));
ok('A4 Header: Merge accounts in both menus', (hdr.match(/<span>Merge accounts<\/span>/g) || []).length === 2 && (hdr.match(/onOpenMergeAccounts && \(/g) || []).length === 2);
const src = fs.readFileSync(new URL('../../src/lib/accountMerge.ts', import.meta.url), 'utf8');
ok('A5 the merge call never goes through apiFetch', !/apiFetch/.test(src.replace(/\/\/.*$/gm, '')));

console.log(`10M merge accounts: ${passed} passed, ${failures} failed`);
if (failures) { console.log('FAILED'); process.exit(1); }
