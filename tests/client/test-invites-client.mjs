/**
 * INVITES CLIENT (design [INVC-DS1] + [INVC-DS2]) — client side of server #114 (10j) and #112 (10k).
 *  S  "Turn on invites" card: admin + flag false only; confirm wording; POST {} ; server words shown verbatim; ON -> re-probe.
 *  I  "Send invite": admin + flag true only; never on self / primary admin; chips; confirm before the POST;
 *     the reviewed record + its version come from ONE fresh GET /api/users (X-State-Version) (B1, [INVC-DS3]);
 *     409 VERSION_CONFLICT -> refresh, then confirm again (a failed refresh = no confirm, retry in the row);
 *     201 -> link card; 409 -> server words; 404 -> "Invites are off" + re-probe.
 *  F  useInviteFlag asks again when rev changes.  A  App wiring (source).
 * Run: npx tsx tests/client/test-invites-client.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import { TeamModal } from '../../src/components/TeamModal.tsx';
import { ConfirmModal } from '../../src/components/ConfirmModal.tsx';
import { useInviteFlag } from '../../src/lib/invites.ts';
import { observeVersion } from '../../src/lib/api.ts';
import { inviteChip, sendMemberInvite, loadMemberForInvite } from '../../src/lib/inviteActions.ts';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const TOK = 'A'.repeat(20) + 'b_c-' + '9'.repeat(19);
const LINK = `/invite#t=${TOK}`;

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    calls.push([method, path, body ?? null]);
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body);
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

const admin = { id: 'u-admin', name: 'Rivka Admin', email: 'rivka@agency.test', role: 'admin', agencyId: 'a1' };
const primary = { id: 'u-primary', name: 'Don Kenan', email: 'kenan@hartfordkashrut.org', role: 'admin', agencyId: 'a1' };
const moshe = { id: 'u-moshe', name: 'Moshe Klein', email: 'moshe@agency.test', role: 'mashgiach', agencyId: 'a1', venueId: 'v1' };
const admin2 = { id: 'u-admin2', name: 'Eli Second', email: 'eli@agency.test', role: 'admin', agencyId: 'a1' };
const coord = { ...admin, id: 'u-coord', role: 'coordinator' };
const users = [admin, primary, moshe, admin2];
const base = { isOpen: true, onClose() {}, users, tasks: [], currentUser: admin, currentVenue: { id: 'v1', name: 'Crown Market' }, venues: [{ id: 'v1', name: 'Crown Market' }], onAddUser: async () => {}, onUpdateUser: async () => {}, onDeleteUser: async () => {}, agencyName: 'Hartford Kashrut' };
const html = (p) => decode(renderToStaticMarkup(React.createElement(TeamModal, { ...base, ...p })));

// ---- S: the switch ----
for (const [flag, want] of [[false, true], [null, false], [true, false], [undefined, false]]) {
  ok(`S switch shown only on flag false (flag=${flag})`, html({ inviteFlag: flag }).includes('data-invites-turn-on') === want);
}
ok('S switch hidden for a coordinator', !html({ inviteFlag: false, currentUser: coord }).includes('data-invites-turn-on'));
{
  const h = html({ inviteFlag: false });
  ok('S card wording', h.includes('Invite links are off') && h.includes('With invites on, you send them a link instead and they choose their own password.') && h.includes('Turn on invites'));
}
{
  let stale = 0;
  const calls = stubFetch({ 'POST /api/agency/invites/enable': { status: 200, body: { ok: true, invitesEnabled: true, alreadyOn: false } } });
  const m = mount(TeamModal, { ...base, inviteFlag: false, onInviteFlagStale: () => { stale++; } });
  await m.render();
  await m.click('Turn on invites');
  const c = confirms(m)[0];
  ok('S confirm before any request', !!c && writes(calls).length === 0);
  ok('S confirm wording', c && c.props.title === 'Turn on invites for Hartford Kashrut?' && c.props.message.includes("you won't set passwords for them anymore") && c.props.message.includes("can't be turned off from the app") && c.props.confirmText === 'Turn on' && c.props.cancelText === 'Not now', c && JSON.stringify([c.props.title, c.props.message]));
  await c.props.onConfirm(); await m.render();
  const w = writes(calls);
  ok('S POST /api/agency/invites/enable with an empty body', w.length === 1 && w[0][1] === '/api/agency/invites/enable' && Object.keys(w[0][2] || {}).filter((k) => k !== 'operationId' && k !== 'expectedVersion').length === 0, JSON.stringify(w));
  ok('S ON -> flag asked again, notice shown, no confirm left', stale === 1 && m.html().includes('data-invites-on-notice') && confirms(m).length === 0);
}
{
  const msg = "Invites can't be turned on yet: the team records need a check first. Please contact Shutfey support.";
  let stale = 0;
  stubFetch({ 'POST /api/agency/invites/enable': { status: 409, body: { error: msg, code: 'INVITES_PRECHECK_FAILED' } } });
  const m = mount(TeamModal, { ...base, inviteFlag: false, onInviteFlagStale: () => { stale++; } });
  await m.render();
  await m.click('Turn on invites');
  await confirms(m)[0].props.onConfirm(); await m.render();
  const h = decode(m.html());
  ok('S 409: the server words, verbatim, as an alert; flag not re-asked', h.includes('role="alert"') && h.includes(msg) && stale === 0, h.slice(0, 300));
}
{
  stubFetch({ 'POST /api/agency/invites/enable': 'THROW' });
  const m = mount(TeamModal, { ...base, inviteFlag: false });
  await m.render();
  await m.click('Turn on invites');
  await confirms(m)[0].props.onConfirm(); await m.render();
  ok('S network error: plain fallback', decode(m.html()).includes("Couldn't turn on invites. Please try again.") || decode(m.html()).includes('connect'), decode(m.html()).slice(0, 300));
}

// ---- I: Send invite ----
{
  const off = html({ inviteFlag: false });
  ok('I hidden while invites are OFF / unknown', !off.includes('data-send-invite') && !html({ inviteFlag: null }).includes('data-send-invite'));
  const on = html({ inviteFlag: true });
  const count = (on.match(/data-send-invite="true"/g) || []).length;
  ok('I shown on Moshe and the other admin only (not self, not primary admin)', count === 2, String(count));
  ok('I hidden for a coordinator view', !html({ inviteFlag: true, currentUser: coord }).includes('data-send-invite'));
  ok('I 44px target', /data-send-invite="true"[^>]*min-h-11|min-h-11[^"]*"[^>]*data-send-invite="true"/.test(on));
}
ok('I chips', inviteChip({ invitePending: true }) === 'Invite sent' && inviteChip({ needsInvite: true }) === "Can't sign in — send an invite" && inviteChip({}) === null);
{
  const h = html({ inviteFlag: true, users: [admin, { ...moshe, needsInvite: true }, { ...admin2, invitePending: true }] });
  ok('I rows show the chips; pending row says "Send new invite"', h.includes("Can't sign in — send an invite") && h.includes('Invite sent') && h.includes('Send new invite'), h.slice(0, 200));
}
const roster = (version, list = users) => ({ status: 200, body: { users: list }, headers: { 'X-State-Version': String(version) } });
{
  const r1 = (stubFetch({ 'GET /api/users': roster(9) }), await loadMemberForInvite('u-moshe'));
  ok('I loadMemberForInvite: the row and the version of that same response', r1.ok && r1.user.id === 'u-moshe' && r1.version === 9, JSON.stringify(r1));
  stubFetch({ 'GET /api/users': { status: 200, body: { users } } });
  ok('I loadMemberForInvite: no version header -> not usable', !(await loadMemberForInvite('u-moshe')).ok);
  stubFetch({ 'GET /api/users': roster(9, [admin]) });
  ok('I loadMemberForInvite: person gone', (await loadMemberForInvite('u-moshe')).message === 'This person is no longer on the team.');
}
{
  // Happy path: a fresh roster at tap, confirm first, ITS version sent (not the global one), link card on 201.
  observeVersion(40);
  const calls = stubFetch({
    'GET /api/users': roster(50),
    'POST /api/users/u-moshe/invite': { status: 201, body: { invite: { id: 'i1', kind: 'setup', memberId: 'u-moshe', email: moshe.email, expiresAt: '2099-01-01T00:00:00Z' }, link: LINK } },
  });
  const m = mount(TeamModal, { ...base, inviteFlag: true });
  await m.render();
  await m.click('Send invite', 0);
  const c = confirms(m)[0];
  ok('I tap -> one fresh GET /api/users, then the confirm; no write yet', !!c && calls.filter(([mm, p]) => mm === 'GET' && p === '/api/users').length === 1 && writes(calls).length === 0, JSON.stringify(calls));
  ok('I confirm wording', c && c.props.title === 'Send Moshe Klein an invite link?' && c.props.message.includes('Moshe Klein (moshe@agency.test)') && c.props.message.includes('Their current password stops working right away') && c.props.message.includes('signed out on their phones') && c.props.message.includes('Their kiosk code keeps working.') && !c.props.message.includes('earlier link') && !c.props.message.includes('details changed'), c && c.props.message);
  observeVersion(57); // the global tracker moves on without the roster: must NOT be the version sent
  await c.props.onConfirm(); await m.render();
  const w = writes(calls);
  ok('I POST /api/users/<id>/invite with the roster response version (50; not global 57, not 40)', w.length === 1 && w[0][1] === '/api/users/u-moshe/invite' && w[0][2].expectedVersion === 50, JSON.stringify(w));
  const h = decode(m.html());
  ok('I 201 -> link card for Moshe, full link, hint', h.includes('data-invite-link-card') && h.includes(`value="https://app.example${LINK}"`) && h.includes('Send this link to Moshe.') && h.includes('Moshe Klein (moshe@agency.test)'), h.slice(0, 300));
  ok('I 201 -> row marked "Invite sent", button says "Send new invite"', h.includes('Invite sent') && h.includes('Send new invite'));
  ok('I nothing stored', store.size === 0, JSON.stringify([...store.keys()]));
}
{
  // The confirm shows the FRESH record (role changed on the server since the list was drawn).
  const calls = stubFetch({ 'GET /api/users': roster(61, [admin, primary, { ...moshe, name: 'Moshe K. Klein' }, admin2]) });
  const m = mount(TeamModal, { ...base, inviteFlag: true });
  await m.render();
  await m.click('Send invite', 0);
  ok('I confirm names the fresh record, not the drawn list', confirms(m)[0].props.title === 'Send Moshe K. Klein an invite link?' && writes(calls).length === 0);
}
{
  // Load failure at tap: no confirm, the row says so and offers a retry.
  const calls = stubFetch({ 'GET /api/users': { status: 500, body: { error: 'boom' } } });
  const m = mount(TeamModal, { ...base, inviteFlag: true });
  await m.render();
  await m.click('Send invite', 0);
  const h = decode(m.html());
  ok('I roster load fails: no confirm, no write, error + "Try again"', confirms(m).length === 0 && writes(calls).length === 0 && h.includes("Couldn't load their details. Please try again.") && h.includes('Try again'), h.slice(0, 200));
}
{
  // 409 VERSION_CONFLICT: nothing sent until a fresh roster + version arrive; then confirm again with the new version.
  let gets = 0; let posts = 0;
  const calls = stubFetch({
    'GET /api/users': () => (++gets === 1 ? roster(70) : roster(72, [admin, primary, { ...moshe, role: 'coordinator' }, admin2])),
    'POST /api/users/u-moshe/invite': () => (++posts === 1 ? { status: 409, body: { error: 'conflict', code: 'VERSION_CONFLICT' } } : { status: 201, body: { link: LINK, invite: {} } }),
  });
  const m = mount(TeamModal, { ...base, inviteFlag: true });
  await m.render();
  await m.click('Send invite', 0);
  await confirms(m)[0].props.onConfirm(); await m.render();
  const c = confirms(m)[0];
  const h = decode(m.html());
  ok('I 409: refreshed (2nd GET) and the sheet re-opens with the lead; nothing marked sent', gets === 2 && c && c.props.message.startsWith('Their details changed since you opened this.') && !h.includes('Invite sent') && !h.includes('data-invite-link-card'), JSON.stringify([gets, c && c.props.message]));
  await c.props.onConfirm(); await m.render();
  const w = writes(calls);
  ok('I after the conflict: the refreshed roster version (72) is sent', w.length === 2 && w[0][2].expectedVersion === 70 && w[1][2].expectedVersion === 72, JSON.stringify(w.map((x) => x[2].expectedVersion)));
}
{
  // 409 then the refresh fails: no confirm, no second POST, retry in the row.
  let gets = 0;
  const calls = stubFetch({
    'GET /api/users': () => (++gets === 1 ? roster(80) : { status: 503, body: {} }),
    'POST /api/users/u-moshe/invite': { status: 409, body: { error: 'conflict', code: 'VERSION_CONFLICT' } },
  });
  const m = mount(TeamModal, { ...base, inviteFlag: true });
  await m.render();
  await m.click('Send invite', 0);
  await confirms(m)[0].props.onConfirm(); await m.render();
  const h = decode(m.html());
  ok('I 409 + failed refresh: sending stays off (no confirm, 1 POST), retry offered', confirms(m).length === 0 && writes(calls).length === 1 && h.includes("Couldn't load their details. Please try again.") && h.includes('Try again'), h.slice(0, 200));
}
{
  const msg = 'An invite link is not available for this person.';
  stubFetch({ 'GET /api/users': roster(90), 'POST /api/users/u-admin2/invite': { status: 409, body: { error: msg, code: 'INVITE_NOT_AVAILABLE' } } });
  const m = mount(TeamModal, { ...base, inviteFlag: true });
  await m.render();
  await m.click('Send invite', 1);
  await confirms(m)[0].props.onConfirm(); await m.render();
  const h = decode(m.html());
  ok('I 409 INVITE_NOT_AVAILABLE: the server words in the row, no card, no "Try again"', h.includes('data-send-invite-error') && h.includes(msg) && !h.includes('data-invite-link-card') && !h.includes('Try again'));
}
{
  let stale = 0;
  stubFetch({ 'GET /api/users': roster(91), 'POST /api/users/u-moshe/invite': { status: 404, body: { error: 'Not found.' } } });
  const m = mount(TeamModal, { ...base, inviteFlag: true, onInviteFlagStale: () => { stale++; } });
  await m.render();
  await m.click('Send invite', 0);
  await confirms(m)[0].props.onConfirm(); await m.render();
  ok('I 404: "Invites are off for your agency." and the flag asked again', decode(m.html()).includes('Invites are off for your agency.') && stale === 1);
}
{
  stubFetch({ 'POST /api/users/u-moshe/invite': { status: 201, body: { link: 'https://evil.example/x', invite: {} } } });
  const r = await sendMemberInvite('u-moshe', 1);
  ok('I 201 without a usable link: plain error', !r.ok && r.message === 'The invite was made, but its link is missing. Please try again.');
}
{
  const list = [admin, primary, moshe, { ...admin2, invitePending: true }];
  stubFetch({ 'GET /api/users': roster(92, list) });
  const m = mount(TeamModal, { ...base, inviteFlag: true, users: list });
  await m.render();
  await m.click('Send new invite', 0);
  ok('I re-send confirm says the earlier link stops working', confirms(m)[0].props.message.includes('The earlier link stops working.'));
}

// ---- F: the flag hook re-asks on rev ----
{
  let gets = 0;
  stubFetch({ 'GET /api/agency/invites': () => { gets++; return { status: 404, body: {} }; } });
  const Probe = (p) => { const f = useInviteFlag('u|a', true, false, p.rev); return React.createElement('i', null, String(f)); };
  const m = mount(Probe, { rev: 0 });
  await m.render();
  await m.render({ rev: 1 });
  ok('F rev change -> a second probe', gets === 2, String(gets));
}

// ---- A: App wiring ----
{
  const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  ok('A App passes rev, the raw flag (null on kiosk), the agency name and a re-probe callback', app.includes('inviteRev,') && app.includes('inviteFlag={isKiosk ? null : inviteFlag}') && app.includes('agencyName={currentUser.agencyName}') && app.includes('onInviteFlagStale={() => setInviteRev((n) => n + 1)}'));
  const team = fs.readFileSync(new URL('../../src/components/TeamModal.tsx', import.meta.url), 'utf8');
  ok('A TeamModal never reads the global version; inviteActions takes it from the roster response', !team.includes('getLastKnownVersion') && !fs.readFileSync(new URL('../../src/lib/inviteActions.ts', import.meta.url), 'utf8').includes('getLastKnownVersion') && fs.readFileSync(new URL('../../src/lib/inviteActions.ts', import.meta.url), 'utf8').includes('versionFromResponse(res)'));
}

console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
