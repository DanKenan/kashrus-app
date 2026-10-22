/**
 * 10L CLIENT (reset-password links) — client side of server #118.
 *  L  lib: readResetToken / isResetPath / fullResetLink / canMakeResetLink (who sees the button).
 *  T  Team: "Reset password link" per allowed row (admin; coordinator for people at their venue);
 *     no confirm (it changes nothing until used); POST with a fresh version; one VERSION_CONFLICT retry;
 *     link card with 24-hour wording; server words on refusal; "Asked for a password reset" list;
 *     "Paused" chip + admin "Confirm" (confirm sheet, POST confirm-reset).
 *  P  /reset page lib: preview/accept use the X-Reset-Token header, never a URL query, no session header.
 *  A  App wiring + Forgot password wording (source).
 * Run: npx tsx tests/client/test-reset-links-client.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import { TeamModal } from '../../src/components/TeamModal.tsx';
import { ResetPage } from '../../src/components/ResetPage.tsx';
import { ConfirmModal } from '../../src/components/ConfirmModal.tsx';
import { readResetToken, isResetPath, fullResetLink, canMakeResetLink, makeResetLink, loadResetRequests, confirmPausedMember, previewResetLink, acceptResetLink } from '../../src/lib/resetLinks.ts';
import { setSessionToken } from '../../src/lib/api.ts';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const TOK = 'A'.repeat(20) + 'b_c-' + '9'.repeat(19);
const LINK = `/reset#t=${TOK}`;

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const raw = String(url);
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    const h = opts.headers instanceof Headers ? Object.fromEntries(opts.headers.entries()) : Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push([method, path, body ?? null, h, raw]);
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body, h);
    if (r === 'THROW') throw new TypeError('network');
    r = r || { status: 200, body: {} };
    const hdr = r.headers || {};
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => hdr[k] ?? null }, clone() { return this; }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}
function* walk(node) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) yield* walk(c); return; }
  if (!React.isValidElement(node)) return;
  yield node; yield* walk(node.props?.children);
}
const confirms = (m) => [...walk(m.tree())].filter((e) => e.type === ConfirmModal && e.props.isOpen);
const writes = (calls) => calls.filter(([m]) => m !== 'GET');

// ---- L ----
ok('L token from hash', readResetToken(`#t=${TOK}`) === TOK && readResetToken(`t=${TOK}`) === TOK);
ok('L bad tokens refused', readResetToken('#t=short') === null && readResetToken('') === null && readResetToken(`#x=${TOK}`) === null && readResetToken(`#t=${TOK}!`) === null);
ok('L /reset path', isResetPath('/reset') && isResetPath('/reset/') && !isResetPath('/reset2') && !isResetPath('/invite'));
ok('L full link from the server path', fullResetLink(LINK, 'https://a.b') === `https://a.b${LINK}`);
ok('L non-reset paths refused', fullResetLink('/invite#t=' + TOK, 'x') === null && fullResetLink('https://evil.example/reset#t=' + TOK, 'x') === null && fullResetLink(null) === null && fullResetLink('/reset#t=bad') === null);

const admin = { id: 'u-admin', name: 'Rivka Admin', email: 'rivka@agency.test', role: 'admin', agencyId: 'a1' };
const primary = { id: 'u-primary', name: 'Don Kenan', email: 'kenan@hartfordkashrut.org', role: 'admin', agencyId: 'a1' };
const moshe = { id: 'u-moshe', name: 'Moshe Klein', email: 'moshe@agency.test', role: 'mashgiach', agencyId: 'a1', venueId: 'v1' };
const yossi = { id: 'u-yossi', name: 'Yossi Far', email: 'yossi@agency.test', role: 'mashgiach', agencyId: 'a1', venueId: 'v2' };
const admin2 = { id: 'u-admin2', name: 'Eli Second', email: 'eli@agency.test', role: 'admin', agencyId: 'a1' };
const coord = { id: 'u-coord', name: 'Chana Coord', email: 'chana@agency.test', role: 'coordinator', agencyId: 'a1', venueId: 'v1' };
const coord2 = { id: 'u-coord2', name: 'Dov Coord', email: 'dov@agency.test', role: 'coordinator', agencyId: 'a1', venueId: 'v1' };
const owner = { id: 'u-owner', name: 'Sam Owner', email: 'sam@agency.test', role: 'owner', agencyId: 'a1', venueId: 'v1' };

ok('L admin -> mashgiach / coordinator / owner', canMakeResetLink(admin, moshe) && canMakeResetLink(admin, coord) && canMakeResetLink(admin, owner));
ok('L never self, an admin, the primary admin', !canMakeResetLink(admin, admin) && !canMakeResetLink(admin, admin2) && !canMakeResetLink(admin, { ...moshe, isPrimaryAdmin: true }) && !canMakeResetLink(admin2, primary));
ok('L coordinator -> people at a shared venue only', canMakeResetLink(coord, moshe) && canMakeResetLink(coord, owner) && !canMakeResetLink(coord, yossi));
ok('L coordinator never -> admin or coordinator', !canMakeResetLink(coord, admin) && !canMakeResetLink(coord, coord2));
ok('L coordinator via venueIds', canMakeResetLink({ ...coord, venueId: undefined, venueIds: ['v2'] }, yossi) && !canMakeResetLink({ ...coord, venueId: undefined, venueIds: [] }, moshe));
ok('L mashgiach / owner / nobody -> no', !canMakeResetLink(moshe, owner) && !canMakeResetLink(owner, moshe) && !canMakeResetLink(null, moshe) && !canMakeResetLink(admin, null));

const users = [admin, primary, moshe, admin2, coord, owner];
const base = { isOpen: true, onClose() {}, users, tasks: [], currentUser: admin, currentVenue: { id: 'v1', name: 'Crown Market' }, venues: [{ id: 'v1', name: 'Crown Market' }, { id: 'v2', name: 'Elm Deli' }], onAddUser: async () => {}, onUpdateUser: async () => {}, onDeleteUser: async () => {} };
const html = (p) => decode(renderToStaticMarkup(React.createElement(TeamModal, { ...base, ...p })));
const roster = (version, list = users) => ({ status: 200, body: { users: list }, headers: { 'X-State-Version': String(version) } });

// ---- T: buttons ----
{
  const h = html({});
  const n = (h.match(/data-reset-link="true"/g) || []).length;
  ok('T admin: button on Moshe, coordinator, owner (not self, admin2, primary)', n === 3, String(n));
  ok('T 44px target', /data-reset-link="true"[^>]*min-h-11|min-h-11[^"]*"[^>]*data-reset-link="true"/.test(h));
  ok('T label', h.includes('Reset password link'));
  const hc = html({ currentUser: coord, users: [coord, moshe, owner, coord2, admin] });
  const nc = (hc.match(/data-reset-link="true"/g) || []).length;
  ok('T coordinator: Moshe + owner only', nc === 2, String(nc));
  ok('T a member waiting for an invite has no reset button', (html({ users: [admin, { ...moshe, needsInvite: true }, { ...owner, invitePending: true }] }).match(/data-reset-link="true"/g) || []).length === 0);
  ok('T mashgiach view (no Team rights) has no button', !html({ currentUser: moshe }).includes('data-reset-link'));
}
{
  // Happy path: no confirm, GET roster version then POST, link card.
  const calls = stubFetch({
    'GET /api/agency/reset-requests': { status: 200, body: { requests: [] } },
    'GET /api/users': roster(31),
    'POST /api/users/u-moshe/reset-link': { status: 201, body: { resetLink: { id: 'rst_1', memberId: 'u-moshe', expiresAt: '2099-01-01T00:00:00Z' }, link: LINK } },
  });
  const m = mount(TeamModal, { ...base });
  await m.render();
  await m.click('Reset password link', 0);
  await m.render();
  ok('T no confirm sheet', confirms(m).length === 0);
  const w = writes(calls);
  ok('T POST /api/users/<id>/reset-link with the fresh roster version', w.length === 1 && w[0][1] === '/api/users/u-moshe/reset-link' && w[0][2].expectedVersion === 31, JSON.stringify(w.map((x) => x.slice(0, 3))));
  const h = decode(m.html());
  ok('T link card: title, full link, 24 hours, nothing changes until used', h.includes('Reset link ready') && h.includes(`https://app.example${LINK}`) && h.includes('The link works once, for 24 hours.') && h.includes('Until then, nothing changes.') && h.includes('Send this link to Moshe.'), h.slice(0, 400));
  ok('T card is not the invite wording', !h.includes('Invite link ready') && !h.includes('for 7 days'));
  ok('T the token is never in a request URL', calls.every(([, , , , raw]) => !raw.includes(TOK)));
}
{
  // One version conflict is retried on a fresh version; then server words on refusal.
  let n = 0;
  const calls = stubFetch({
    'GET /api/agency/reset-requests': { status: 200, body: { requests: [] } },
    'GET /api/users': () => roster(40 + n),
    'POST /api/users/u-moshe/reset-link': () => (++n === 1 ? { status: 409, body: { error: 'Changed', code: 'VERSION_CONFLICT' } } : { status: 201, body: { resetLink: { id: 'r', memberId: 'u-moshe', expiresAt: 'x' }, link: LINK } }),
  });
  const r = await makeResetLink('u-moshe');
  const w = writes(calls);
  ok('T VERSION_CONFLICT -> one retry on a fresh version', r.ok && w.length === 2 && w[0][2].expectedVersion === 40 && w[1][2].expectedVersion === 41, JSON.stringify(w.map((x) => x[2])));
  stubFetch({ 'GET /api/users': roster(1), 'POST /api/users/u-moshe/reset-link': { status: 409, body: { error: 'Changed', code: 'VERSION_CONFLICT' } } });
  const r2 = await makeResetLink('u-moshe');
  ok('T two conflicts -> stop, no third try', !r2.ok);
  const msg = 'A reset link is not available for this person.';
  stubFetch({ 'GET /api/users': roster(1), 'POST /api/users/u-moshe/reset-link': { status: 409, body: { error: msg, code: 'RESET_LINK_UNAVAILABLE' } } });
  ok('T 409: server words', (await makeResetLink('u-moshe')).message === msg);
  stubFetch({ 'GET /api/users': roster(1), 'POST /api/users/u-moshe/reset-link': { status: 201, body: { link: 'https://evil.example/x' } } });
  ok('T 201 with a bad link -> not shown', !(await makeResetLink('u-moshe')).ok);
  stubFetch({ 'GET /api/users': roster(1), 'POST /api/users/u-moshe/reset-link': 'THROW' });
  const rn = await makeResetLink('u-moshe');
  ok('T network -> plain words, no link', !rn.ok && !rn.link && typeof rn.message === 'string' && /connection|try again/i.test(rn.message), rn.message);
}
{
  const msg = "You can't make a reset link for this person.";
  stubFetch({ 'GET /api/agency/reset-requests': { status: 200, body: { requests: [] } }, 'GET /api/users': roster(2), 'POST /api/users/u-moshe/reset-link': { status: 403, body: { error: msg } } });
  const m = mount(TeamModal, { ...base });
  await m.render();
  await m.click('Reset password link', 0); await m.render();
  const h = decode(m.html());
  ok('T refusal shown in the row as an alert, no card', h.includes('data-reset-link-error') && h.includes(msg) && !h.includes('Reset link ready'));
}

// ---- T: asked for a reset ----
{
  const now = new Date().toISOString();
  const calls = stubFetch({ 'GET /api/agency/reset-requests': { status: 200, body: { requests: [{ memberId: 'u-moshe', name: 'Moshe Klein', requestedAt: now, linkLive: false }, { memberId: 'u-gone', name: 'Not Here', requestedAt: now, linkLive: false }] } } });
  const m = mount(TeamModal, { ...base });
  await m.render(); await m.render();
  const h = decode(m.html());
  ok('T asked list loaded on open (admin)', calls.some(([mm, p]) => mm === 'GET' && p === '/api/agency/reset-requests'));
  ok('T asked list shows people on this team only', h.includes('Asked for a password reset') && h.includes('data-reset-request') && !h.includes('Not Here'), h.slice(0, 300));
  ok('T row chip "Asked for reset"', h.includes('Asked for reset'));
}
{
  const calls = stubFetch({ 'GET /api/agency/reset-requests': { status: 200, body: { requests: [] } } });
  const m = mount(TeamModal, { ...base, currentUser: moshe });
  await m.render();
  ok('T mashgiach: the list is never asked for', !calls.some(([, p]) => p === '/api/agency/reset-requests'));
  stubFetch({ 'GET /api/agency/reset-requests': { status: 403, body: { error: 'no' } } });
  ok('T list: refusal -> empty', (await loadResetRequests()).length === 0);
  stubFetch({ 'GET /api/agency/reset-requests': { status: 200, body: { requests: [{ memberId: 7 }, null, { memberId: 'x', requestedAt: 'y', linkLive: 'yes' }] } } });
  const l = await loadResetRequests();
  ok('T list: junk rows dropped, linkLive strict', l.length === 1 && l[0].linkLive === false);
}

// ---- T: paused + confirm ----
{
  const pausedUsers = [admin, { ...moshe, resetConfirmNeeded: true }];
  const h = html({ users: pausedUsers });
  ok('T paused chip + note + Confirm (admin)', h.includes('data-reset-paused') && h.includes('access here is paused') && h.includes('data-reset-confirm'));
  const hc = html({ currentUser: coord, users: [coord, { ...moshe, resetConfirmNeeded: true }] });
  ok('T coordinator sees the pause but no Confirm', hc.includes('data-reset-paused') && !hc.includes('data-reset-confirm') && hc.includes('An admin needs to confirm it.'));
  const calls = stubFetch({ 'GET /api/agency/reset-requests': { status: 200, body: { requests: [] } }, 'GET /api/users': roster(12), 'POST /api/users/u-moshe/confirm-reset': { status: 200, body: { ok: true, confirmed: true } } });
  const m = mount(TeamModal, { ...base, users: pausedUsers });
  await m.render();
  await m.click('Confirm', 0);
  const c = confirms(m)[0];
  ok('T Confirm opens a sheet first; no write yet', !!c && writes(calls).length === 0);
  ok('T sheet wording', c && c.props.title === 'Confirm Moshe Klein?' && c.props.message.includes('reset link from another agency') && c.props.message.includes('really them') && c.props.confirmText === 'Confirm');
  await c.props.onConfirm(); await m.render();
  const w = writes(calls);
  ok('T POST confirm-reset with a fresh version', w.length === 1 && w[0][1] === '/api/users/u-moshe/confirm-reset' && w[0][2].expectedVersion === 12, JSON.stringify(w.map((x) => x.slice(0, 3))));
  ok('T after confirm the chip is gone', !decode(m.html()).includes('data-reset-paused'));
  stubFetch({ 'GET /api/users': roster(1), 'POST /api/users/u-moshe/confirm-reset': { status: 403, body: { error: 'Only administrators can perform this action.' } } });
  ok('T confirm refusal: server words', (await confirmPausedMember('u-moshe')).message === 'Only administrators can perform this action.');
}

// ---- P: the public page lib ----
{
  setSessionToken('SESSION-SECRET');
  const calls = stubFetch({ 'GET /api/reset-links/preview': { status: 200, body: { firstName: 'Moshe', agencyName: 'HKC', expiresAt: 'z' } } });
  const p = await previewResetLink(TOK);
  const [m, path, , h, raw] = calls[0];
  ok('P preview: header token, no query, no session header', p.state === 'ok' && p.firstName === 'Moshe' && m === 'GET' && path === '/api/reset-links/preview' && h['x-reset-token'] === TOK && !raw.includes(TOK) && !h.authorization, JSON.stringify(h));
  stubFetch({ 'GET /api/reset-links/preview': { status: 404, body: { error: 'This link has expired or was already used.' } } });
  ok('P preview 404 -> invalid', (await previewResetLink(TOK)).state === 'invalid');
  stubFetch({ 'GET /api/reset-links/preview': { status: 429, body: { error: 'Too many tries. Please wait.' } } });
  const p3 = await previewResetLink(TOK);
  ok('P preview 429 -> server words, retry offered', p3.state === 'error' && p3.message === 'Too many tries. Please wait.');
  stubFetch({ 'GET /api/reset-links/preview': 'THROW' });
  ok('P preview network -> error', (await previewResetLink(TOK)).state === 'error');
}
{
  const calls = stubFetch({ 'POST /api/reset-links/accept': { status: 200, body: { success: true, user: { id: 'u-moshe' }, token: 'NEWTOKEN' } } });
  const r = await acceptResetLink(TOK, 'longenough1');
  const [, path, body, h, raw] = calls[0];
  ok('P accept: header token, body only newPassword, no session header', r.state === 'ok' && r.token === 'NEWTOKEN' && path === '/api/reset-links/accept' && h['x-reset-token'] === TOK && !h.authorization && Object.keys(body).join() === 'newPassword' && !raw.includes(TOK), JSON.stringify(body));
  stubFetch({ 'POST /api/reset-links/accept': { status: 404, body: { error: 'x' } } });
  ok('P accept 404 -> invalid', (await acceptResetLink(TOK, 'longenough1')).state === 'invalid');
  const paused = "Your password was changed, but your access to this agency is paused after a password reset. Ask that agency's admin to confirm it.";
  stubFetch({ 'POST /api/reset-links/accept': { status: 403, body: { error: paused, code: 'RESET_CONFIRM_NEEDED', passwordChanged: true } } });
  const r3 = await acceptResetLink(TOK, 'longenough1');
  ok('P accept 403 passwordChanged -> changed, server words', r3.state === 'changed-no-session' && r3.message === paused);
  stubFetch({ 'POST /api/reset-links/accept': { status: 400, body: { error: 'Password must be at least 8 characters.', code: 'PASSWORD_TOO_SHORT' } } });
  const r4 = await acceptResetLink(TOK, 'short');
  ok('P accept 400 -> server words', r4.state === 'error' && r4.message === 'Password must be at least 8 characters.');
  stubFetch({ 'POST /api/reset-links/accept': { status: 200, body: { success: true } } });
  ok('P accept 200 without a token -> not signed in', (await acceptResetLink(TOK, 'longenough1')).state === 'error');
}
{
  const page = (token) => decode(renderToStaticMarkup(React.createElement(ResetPage, { token, onLoginSuccess() {}, onLeave() {}, darkMode: false, onToggleDarkMode() {} })));
  ok('P page first paint: loading', page(TOK).includes('Opening your reset link'));
  stubFetch({ 'GET /api/reset-links/preview': { status: 200, body: { firstName: 'Moshe', agencyName: 'Hartford Kashrut', expiresAt: 'z' } }, 'POST /api/reset-links/accept': { status: 200, body: { success: true, user: { id: 'u-moshe', name: 'Moshe' }, token: 'NEWTOKEN' } } });
  let signedIn = null;
  const m = mount(ResetPage, { token: TOK, onLoginSuccess: (u) => { signedIn = u; }, onLeave() {}, darkMode: false, onToggleDarkMode() {} });
  await m.render(); await m.render();
  const h = decode(m.html());
  ok('P page form: name, agency, sign-out note', h.includes('Choose a new password, Moshe') && h.includes('Hartford Kashrut') && h.includes('your other phones are signed out'), h.slice(0, 300));
  const pm = mount(ResetPage, { token: null, onLoginSuccess() {}, onLeave() {}, darkMode: false, onToggleDarkMode() {} });
  await pm.render(); await pm.render();
  ok('P no token -> not valid + ask admin', decode(pm.html()).includes('This reset link is not valid anymore.') && decode(pm.html()).includes('Ask your agency admin for a new link.'));
}

// ---- A: source wiring ----
{
  const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  ok('A App routes /reset to ResetPage (not on a kiosk), before the sign-in screens', /if \(resetPage && !isKiosk\)/.test(app) && app.indexOf('if (resetPage && !isKiosk)') < app.indexOf('if (!currentUser) {\n    // Kiosk tablets'));
  ok('A App reads the token from the hash only', app.includes('readResetToken(window.location.hash)') && !/readResetToken\(window\.location\.search/.test(app));
  ok('A leaving the page clears the URL', /leaveResetPage[\s\S]{0,120}replaceState\(null, '', '\/'\)/.test(app));
  const fp = fs.readFileSync(new URL('../../src/components/ForgotPasswordModal.tsx', import.meta.url), 'utf8');
  ok('A Forgot password says the admin can send a reset link', fp.includes('can send you a reset link'));
  const rp = fs.readFileSync(new URL('../../src/components/ResetPage.tsx', import.meta.url), 'utf8');
  ok('A ResetPage never uses apiFetch / apiWrite (no session header)', !/apiFetch|apiWrite/.test(rp));
  const lib = fs.readFileSync(new URL('../../src/lib/resetLinks.ts', import.meta.url), 'utf8');
  ok('A the link is never stored', !/localStorage|sessionStorage/.test(lib) && !/localStorage|sessionStorage/.test(rp));
}

console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
