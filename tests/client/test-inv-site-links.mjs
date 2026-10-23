/**
 * Invite-site (client): invite links on the agency's own address, and after CHOOSING a
 * password on the invite page nobody is signed in (Don, Oct 23): the accept answer's token
 * is never stored and is ended on the server (Bearer only, no cookies); the app shows the
 * welcome / home page signed out. "Already use Shutfey? Sign in and join" is unchanged.
 * Run: npx tsx tests/client/test-inv-site-links.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: () => null, length: 0 };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.window ??= { location: { hostname: 'app.valley.test', origin: 'https://app.valley.test', pathname: '/invite', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const L = await import('../../src/lib/invites.ts');
const { InvitePage } = await import('../../src/components/InvitePage.tsx');
const api = await import('../../src/lib/api.ts');

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const TOK = 'A'.repeat(20) + 'b_c-' + '9'.repeat(19);
const LINK = `/invite#t=${TOK}`;

// ---- inviteLinkOrigin + fullInviteLink ----
ok('origin: https site origin kept', L.inviteLinkOrigin('https://app.valley.test') === 'https://app.valley.test');
ok('origin: local http test host with port kept', L.inviteLinkOrigin('http://site-a.test:3490') === 'http://site-a.test:3490');
for (const bad of [null, undefined, '', 42, {}, 'app.valley.test', 'https://app.valley.test/', 'https://app.valley.test/x', 'https://app.valley.test?x=1', 'javascript:alert(1)', 'ftp://app.valley.test', 'https://user@app.valley.test', 'https://APP.valley.test']) {
  ok(`origin: not a plain origin -> undefined (${JSON.stringify(bad)})`, L.inviteLinkOrigin(bad) === undefined);
}
ok('link: site origin used', L.fullInviteLink(LINK, L.inviteLinkOrigin('https://app.valley.test')) === `https://app.valley.test${LINK}`);
ok('link: no origin -> this page\'s origin (as today)', L.fullInviteLink(LINK, L.inviteLinkOrigin(null)) === `https://app.valley.test${LINK}`);
ok('link: a bad origin never changes the host', L.fullInviteLink(LINK, L.inviteLinkOrigin('https://evil.example/x')) === `https://app.valley.test${LINK}`);

// ---- every caller passes the server's origin ----
const src = (p) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');
ok('caller: team invite (App)', src('App.tsx').includes('fullInviteLink(data.link, inviteLinkOrigin(data.linkOrigin))'));
ok('caller: venue owner invite', src('components/CreateVenueModal.tsx').includes('fullInviteLink(data.ownerInviteLink, inviteLinkOrigin(data.ownerInviteLinkOrigin))'));
ok('caller: send invite again', src('lib/inviteActions.ts').includes('fullInviteLink(r.data?.link, inviteLinkOrigin(r.data?.linkOrigin))'));
ok('caller: pool invite card gets the full link', /function poolInviteLink[\s\S]{0,300}fullInviteLink\(d\.link, inviteLinkOrigin\(d\.linkOrigin\)\)/.test(src('components/PoolPanel.tsx')) && (src('components/PoolPanel.tsx').match(/link: poolInviteLink\(/g) || []).length === 2);

// ---- InvitePage: choosing a password signs nobody in ----
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    calls.push({ method, path, body: body ?? null, opts });
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body);
    r = r || { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, clone() { return this; }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}
const USER = { id: 'usr-1', name: 'Yossi Katz', email: 'yossi@example.org', role: 'mashgiach', agencyId: 'agency-vv' };
async function run({ kind = 'member', pick, chosen = true, answer }) {
  store.clear();
  const calls = stubFetch({
    'GET /api/invites/preview': { status: 200, body: { kind, agencyName: 'Valley Vaad', role: 'mashgiach', name: 'Yossi Katz' } },
    'POST /api/invites/accept': answer || { status: 200, body: { success: true, user: USER, token: 'accept.session.token' } },
    'POST /api/auth/logout': { status: 200, body: { success: true } },
  });
  const logins = []; const chosenCalls = [];
  const props = { token: TOK, onLoginSuccess: (u) => logins.push(u), onLeave() {}, darkMode: false, onToggleDarkMode() {} };
  if (chosen) props.onPasswordChosen = () => chosenCalls.push(1);
  const m = mount(InvitePage, props);
  await m.render();
  await m.click(pick === 'existing' ? 'Already use Shutfey? Sign in' : 'New to Shutfey? Choose a password');
  if (pick === 'existing') await m.type('invite-existing-password', 'old-pass-123');
  else { await m.type('invite-new-password', 'new-pass-123'); await m.type('invite-new-confirm', 'new-pass-123'); }
  await m.submit();
  await new Promise((r) => setTimeout(r, 0));
  return { calls, logins, chosenCalls, stored: api.getSessionToken() };
}
{
  const r = await run({ pick: 'new' });
  const acc = r.calls.find((c) => c.path === '/api/invites/accept');
  const out = r.calls.find((c) => c.path === '/api/auth/logout');
  ok('new: accept sent with mode new', acc && acc.body.mode === 'new');
  ok('new: not signed in (no onLoginSuccess)', r.logins.length === 0);
  ok('new: onPasswordChosen called once', r.chosenCalls.length === 1);
  ok('new: the token is never stored', !r.stored, String(r.stored));
  ok('new: that session is ended on the server with its own Bearer', out && out.method === 'POST' && out.opts.headers.Authorization === 'Bearer accept.session.token');
  ok('new: no cookies on that call (credentials omit)', out && out.opts.credentials === 'omit');
}
{
  const r = await run({ kind: 'setup', pick: 'new' });
  ok('setup link: also signed out + session ended', r.logins.length === 0 && r.chosenCalls.length === 1 && !r.stored && r.calls.some((c) => c.path === '/api/auth/logout'));
}
{
  const r = await run({ kind: 'setup', pick: 'existing' });
  ok('setup link via the other button: still choosing a password -> signed out', r.logins.length === 0 && r.chosenCalls.length === 1 && !r.stored);
}
{
  const r = await run({ pick: 'existing' });
  ok('existing: today\'s behaviour, signed straight in', r.logins.length === 1 && r.chosenCalls.length === 0 && r.stored === 'accept.session.token');
  ok('existing: no logout call', !r.calls.some((c) => c.path === '/api/auth/logout'));
}
{
  const r = await run({ pick: 'existing', answer: { status: 200, body: { success: true, chooseMembership: true, token: 'choose.tok', memberships: [{ membershipId: 'm1', agencyId: 'a', agencyName: 'A', role: 'admin' }, { membershipId: 'm2', agencyId: 'b', agencyName: 'B', role: 'mashgiach' }] } } });
  ok('existing on the shared address with two agencies: chooser as today', r.logins.length === 0 && r.chosenCalls.length === 0 && !r.calls.some((c) => c.path === '/api/auth/logout'));
}
{
  const r = await run({ pick: 'new', chosen: false });
  ok('without onPasswordChosen: today\'s behaviour (signed in)', r.logins.length === 1 && r.stored === 'accept.session.token' && !r.calls.some((c) => c.path === '/api/auth/logout'));
}

// ---- App wiring (source pins) ----
const app = src('App.tsx');
ok('app: onPasswordChosen wired on the invite page', /onPasswordChosen=\{\(\) => \{[\s\S]{0,700}leaveInvitePage\(\);[\s\S]{0,200}if \(currentUser\) \{ quietLogoutRef\.current = true; handleLogout\(\); \}[\s\S]{0,200}setAuthView\(initialAuthView\(\)\);[\s\S]{0,200}showToast\(PASSWORD_SET_TOAST, 9000\)/.test(app));
ok('app: quiet sign-out keeps the full server sign-out but no toast and no sign-in form', /const handleLogout = \(\) => \{\s*clearLogoCache\(\);\s*const quiet = quietLogoutRef\.current;\s*quietLogoutRef\.current = false;/.test(app) && /if \(!quiet\) \{\s*if \(!kioskMode\) setAuthView\('auth'\);\s*if \(serverSignOut\) showToast\('Signed out successfully\.'\);\s*\}/.test(app) && /if \(serverSignOut\) void endServerSession\(getSessionToken\(\)\);/.test(app));
ok('app: toast text', L.PASSWORD_SET_TOAST === 'Your password is set. Tap Sign in and use your email and new password.');
ok('invite page: restyled sign-in look hooks', /className="shf-signin min-h-screen/.test(src('components/InvitePage.tsx')) && src('components/InvitePage.tsx').includes('shf-signin-card') && src('components/InvitePage.tsx').includes('shf-signin-top'));
ok('invite page: no "See how the app works" button', !/how the app works/i.test(src('components/InvitePage.tsx')));

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
