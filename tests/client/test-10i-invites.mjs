/**
 * Item 10i client (invite links), server contract = PR #108.
 *  L  lib: token / link / path helpers; the flag is the server's answer (200 ON, 404 OFF, else unknown).
 *  T  Add member: flag OFF = today's form (password, 4 roles, same request); flag ON = name/email/phone/role
 *     (mashgiach or coordinator), no password, and the returned link with Copy + "Send this link to the person".
 *  V  New venue: flag ON = no owner password, the owner's link is shown and the modal stays open; OFF unchanged.
 *  P  Invite page: two buttons; each server answer shown (generic error, can't connect yet, used/expired link).
 *  A  App wiring (source): pending answer -> link; invite page before the sign-in screens; flag passed to both forms.
 * Run: npx tsx tests/client/test-10i-invites.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import { readInviteToken, fullInviteLink, isInvitePath, fetchInviteFlag, useInviteFlag } from '../../src/lib/invites.ts';
import { TeamModal } from '../../src/components/TeamModal.tsx';
import { CreateVenueModal } from '../../src/components/CreateVenueModal.tsx';
import { InvitePage, INVITE_INVALID_TITLE } from '../../src/components/InvitePage.tsx';
import { InviteLinkCard } from '../../src/components/InviteLinkCard.tsx';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const TOK = 'A'.repeat(20) + 'b_c-' + '9'.repeat(19); // 43 chars
const LINK = `/invite#t=${TOK}`;

// Answers by "METHOD /path" -> { status, body } (or a function). Records [method, path, headers, body].
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    const h = opts.headers instanceof Headers ? Object.fromEntries(opts.headers.entries()) : Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push([method, path, h, body ?? null]);
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body, h);
    if (r === 'THROW') throw new TypeError('network');
    r = r || { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, clone() { return this; }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}

// ---- L ----
ok('L token from #t=', readInviteToken(`#t=${TOK}`) === TOK);
ok('L token: wrong length -> null', readInviteToken('#t=abc') === null && readInviteToken('') === null && readInviteToken(`#t=${TOK}x`) === null);
ok('L token: bad characters -> null', readInviteToken(`#t=${TOK.slice(0, 42)}!`) === null);
ok('L full link from the server path', fullInviteLink(LINK, 'https://shutfey.app') === `https://shutfey.app${LINK}`);
ok('L full link: anything else -> null', fullInviteLink('https://evil.example/invite#t=' + TOK, 'x') === null && fullInviteLink('/invite#t=short', 'x') === null && fullInviteLink(undefined, 'x') === null);
ok('L invite path', isInvitePath('/invite') && isInvitePath('/invite/') && !isInvitePath('/') && !isInvitePath('/invites'));
for (const [status, want] of [[200, true], [404, false], [403, null], [500, null]]) {
  const calls = stubFetch({ 'GET /api/agency/invites': { status, body: {} } });
  const got = await fetchInviteFlag();
  ok(`L flag: ${status} -> ${want}`, got === want && calls.length === 1 && calls[0][1] === '/api/agency/invites', String(got));
}
stubFetch({ 'GET /api/agency/invites': 'THROW' });
ok('L flag: offline -> unknown', (await fetchInviteFlag()) === null);

// ---- F: useInviteFlag ([10IC-RV1] B1): every probe applies its own answer; a new key is "not known" at once ----
{
  let answer = { status: 200, body: {} }; let pending = false;
  let probes = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/api/agency/invites')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    probes++;
    if (pending) return new Promise(() => {});
    if (answer === 'THROW') throw new TypeError('network');
    return { ok: answer.status === 200, status: answer.status, headers: { get: () => null }, clone() { return this; }, json: async () => ({}) };
  };
  const Probe = (p) => React.createElement('i', null, String(useInviteFlag(p.k, p.team, p.venue)));
  const m = mount(Probe, { k: 'u1|agency-a', team: false, venue: false });
  await m.render();
  ok('F admin sign-in: probe -> ON', m.text() === 'true' && probes === 1, m.text());
  answer = { status: 500, body: {} };
  await m.render({ team: true });
  ok('F ON then a failed refresh -> not known (today\'s form)', m.text() === 'null' && probes === 2, m.text());
  answer = { status: 200, body: {} };
  await m.render({ team: false });
  ok('F back ON', m.text() === 'true');
  answer = 'THROW';
  await m.render({ venue: true });
  ok('F ON then offline -> not known', m.text() === 'null', m.text());
  answer = { status: 200, body: {} }; await m.render({ venue: false });
  answer = { status: 404, body: {} };
  await m.render({ team: true });
  ok('F ON then OFF -> OFF', m.text() === 'false', m.text());
  answer = { status: 200, body: {} }; await m.render({ team: false });
  ok('F ON again before the switch', m.text() === 'true');
  // Another admin / agency: null in the same render, before its probe answers.
  pending = true;
  await m.render({ k: 'u2|agency-b' });
  ok('F another admin/agency: not known while its probe runs (no carry-over)', m.text() === 'null', m.text());
  pending = false; answer = { status: 404, body: {} };
  await m.render({ team: true });
  ok('F other agency OFF -> OFF', m.text() === 'false', m.text());
  await m.render({ k: null });
  ok('F not an admin -> not known, no probe', m.text() === 'null');
}

// ---- T: Add member ----
const admin = { id: 'u1', name: 'Ada Admin', email: 'ada@hkc.test', role: 'admin', agencyId: 'agency-hkc' };
const teamBase = { isOpen: true, onClose() {}, users: [admin], tasks: [], currentUser: admin, currentVenue: { id: 'v1', name: 'Crown Market' }, venues: [{ id: 'v1', name: 'Crown Market' }], onUpdateUser: async () => {}, onDeleteUser: async () => {} };
const teamHtml = (p) => decode(renderToStaticMarkup(React.createElement(TeamModal, { ...teamBase, onAddUser: async () => {}, ...p })));
{
  const off = teamHtml({});
  ok('T OFF: identical markup with inviteMode={false}', off === teamHtml({ inviteMode: false }));
  ok('T OFF: password field kept', off.includes('id="new-member-password-input"') && off.includes('Min 6 characters'));
  ok('T OFF: 4 roles kept', ['Mashgiach (Field Inspector)', 'Coordinator (Can Add Tasks)', 'Restaurant / Venue Owner', 'Administrator (Full Control)'].every((t) => off.includes(t)));
  ok('T OFF: button "Add Team Member", no invite note', off.includes('Add Team Member') && !off.includes('data-invite-mode-note') && !off.includes('Create invite link'));
  ok('T OFF: 3-column fields as today', (off.match(/sm:col-span-3/g) || []).length === 4 && (off.match(/sm:col-span-4/g) || []).length === 1);
  const on = teamHtml({ inviteMode: true });
  ok('T ON: no password field', !on.includes('new-member-password-input') && !on.includes('type="password"'));
  ok('T ON: roles = mashgiach, coordinator only', on.includes('Mashgiach (Field Inspector)') && on.includes('Coordinator (Can Add Tasks)') && !on.includes('Restaurant / Venue Owner') && !on.includes('Administrator (Full Control)'));
  ok('T ON: name, email, phone kept', on.includes('new-member-name-input') && on.includes('new-member-email-input') && on.includes('new-member-phone-input'));
  ok('T ON: note + "Create invite link"', on.includes('data-invite-mode-note') && on.includes('No password needed') && on.includes('Create invite link'));
  const coord = teamHtml({ inviteMode: true, currentUser: { ...admin, role: 'coordinator', venueId: 'v1' } });
  ok('T coordinator view: still no add form', !coord.includes('new-member-name-input'));
}
async function team(p) {
  const adds = [];
  const m = mount(TeamModal, { ...teamBase, onAddUser: async (u) => { adds.push(u); return p.answer; }, ...p.props });
  await m.render();
  await m.type('Full name', 'Dana Cohen');
  await m.type('dcohen@', 'Dana@Example.org');
  return { m, adds };
}
{
  // OFF: password still required; the same request as today.
  const { m, adds } = await team({ props: {} });
  await m.submit();
  ok('T OFF: password required (today\'s message)', adds.length === 0 && m.text().includes('Please provide name, email, and an initial password.'), m.text().slice(0, 200));
  await m.type('Min 6 characters', 'secret1');
  await m.submit();
  ok('T OFF: request carries the password, role, venue, permissions', adds.length === 1 && adds[0].password === 'secret1' && adds[0].role === 'mashgiach' && adds[0].venueId === 'v1' && adds[0].email === 'dana@example.org' && JSON.stringify(adds[0].permissions) === '{"canFillTasks":true,"canAssignTasks":false}', JSON.stringify(adds));
  ok('T OFF: no link card after a normal add', !m.html().includes('data-invite-link-card'));
}
{
  const answer = { link: `https://app.example${LINK}`, name: 'Dana Cohen', email: 'dana@example.org' };
  const { m, adds } = await team({ props: { inviteMode: true }, answer });
  const role = m.find((e) => e.type === 'select' && e.props.id === 'new-member-role-select')[0];
  await role.props.onChange({ target: { value: 'coordinator' } }); await m.render();
  await m.type('For sending the kiosk code', '(860) 555-0101');
  await m.submit();
  ok('T ON: one add, no password, coordinator, phone', adds.length === 1 && !('password' in adds[0]) && adds[0].role === 'coordinator' && typeof adds[0].phoneNumber === 'string' && adds[0].name === 'Dana Cohen', JSON.stringify(adds));
  const h = decode(m.html());
  ok('T ON: link card with the full link, Copy, and the hint', h.includes('data-invite-link-card') && h.includes(`value="https://app.example${LINK}"`) && h.includes('Copy link') && h.includes('Send this link to the person.') && h.includes('Dana Cohen (dana@example.org)'), h.slice(0, 400));
  ok('T ON: the form is replaced by the card', !h.includes('new-member-name-input'));
  // Copy uses the clipboard.
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true });
  const cards = [...(function* walk(n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { for (const c of n) yield* walk(c); return; } if (!React.isValidElement(n)) return; yield n; yield* walk(n.props?.children); })(m.tree())].filter((e) => e.type === InviteLinkCard);
  ok('T ON: one card', cards.length === 1 && cards[0].props.link === `https://app.example${LINK}`);
  const c = mount(InviteLinkCard, cards[0].props); await c.render();
  await c.click((e) => e.props['data-invite-copy'] !== undefined);
  ok('T card: Copy writes the link and says so', copied.length === 1 && copied[0] === `https://app.example${LINK}` && c.text().includes('Copied') && c.text().includes('Link copied.'), c.text());
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, configurable: true });
  const c2 = mount(InviteLinkCard, cards[0].props); await c2.render();
  await c2.click((e) => e.props['data-invite-copy'] !== undefined);
  ok('T card: no clipboard -> plain fallback words', c2.text().includes("Couldn't copy here"), c2.text());
  ok('T ON: card offers "Add another person"', cards[0].props.doneLabel === 'Add another person');
  await cards[0].props.onDone(); await m.render();
  ok('T ON: "Add another person" brings the empty form back', m.html().includes('new-member-name-input') && !m.html().includes('data-invite-link-card'));
  await m.render({ isOpen: false }); await m.render({ isOpen: true });
  ok('T: closing clears a shown link', !m.html().includes('data-invite-link-card'));
}
{
  const { m, adds } = await team({ props: { inviteMode: true }, answer: undefined });
  await m.type('Full name', ' ');
  await m.submit();
  ok('T ON: name required, plain words', adds.length === 0 && m.text().includes('Please provide a name and an email.'), m.text().slice(0, 200));
}
{
  // Flag not yet known (OFF form) but the server answers with an invite: the link is still shown.
  const answer = { link: `https://app.example${LINK}`, name: 'Dana Cohen', email: 'dana@example.org' };
  const { m } = await team({ props: {}, answer });
  await m.type('Min 6 characters', 'secret1');
  await m.submit();
  ok('T: an invite answer to the OFF form still shows the link', m.html().includes('data-invite-link-card'));
}

// ---- V: New venue ----
const venueBase = { isOpen: true, onClose() {}, onVenueCreated() {}, adminEmail: 'ada@hkc.test', agencyName: 'HKC' };
const agencyRoute = { 'GET /api/agencies/current': { status: 200, body: { agency: { id: 'agency-hkc', name: 'HKC', certificationOptions: ['Dairy'] } } } };
{
  stubFetch(agencyRoute);
  const mk = async (p) => { const m = mount(CreateVenueModal, { ...venueBase, ...p }); await m.render(); return decode(m.html()); };
  const off = await mk({});
  ok('V OFF: identical markup with inviteMode={false}', off === (await mk({ inviteMode: false })));
  ok('V OFF: owner password field kept', off.includes('type="password"') && off.includes('sm:grid-cols-3'));
  const on = await mk({ inviteMode: true });
  ok('V ON: no owner password, note shown', !on.includes('type="password"') && on.includes('data-invite-mode-note') && on.includes('sm:grid-cols-2'));
}
async function venue(p, answer) {
  const calls = stubFetch({ ...agencyRoute, 'POST /api/venues': answer });
  const closed = []; const created = [];
  const m = mount(CreateVenueModal, { ...venueBase, onClose: () => closed.push(1), onVenueCreated: (v) => created.push(v), ...p });
  await m.render();
  await m.type('Establishment Name', 'Rosen Deli');
  await m.type('Email', 'owner@rosen.test');
  return { m, calls, closed, created };
}
{
  const s = await venue({}, { status: 201, body: { venue: { id: 'v9', name: 'Rosen Deli' } } });
  await s.m.submit();
  ok('V OFF: owner password still required (today\'s message)', !s.calls.some(([m]) => m === 'POST') && s.m.text().includes('Please specify an initial password for the venue owner.'), s.m.text().slice(0, 300));
  await s.m.type('Password', 'ownerpw1');
  await s.m.submit();
  const post = s.calls.find(([m]) => m === 'POST');
  ok('V OFF: request carries ownerPassword; modal closes', !!post && post[3].ownerPassword === 'ownerpw1' && post[3].ownerEmail === 'owner@rosen.test' && s.closed.length === 1, JSON.stringify(post?.[3]));
}
{
  const s = await venue({ inviteMode: true }, { status: 201, body: { success: true, venue: { id: 'v9', name: 'Rosen Deli' }, owner: null, ownerInvite: { id: 'inv_1', email: 'owner@rosen.test', name: 'Rosen Deli Owner', role: 'owner', venueIds: ['v9'], expiresAt: 'x' }, ownerInviteLink: LINK } });
  await s.m.submit();
  const post = s.calls.find(([m]) => m === 'POST');
  ok('V ON: no ownerPassword sent', !!post && !('ownerPassword' in post[3]) && post[3].ownerEmail === 'owner@rosen.test', JSON.stringify(post?.[3]));
  const h = decode(s.m.html());
  ok('V ON: venue created + owner link card, modal stays open', s.created.length === 1 && s.closed.length === 0 && h.includes('Venue created') && h.includes(`https://app.example${LINK}`) && h.includes('Send this link to the venue owner.') && h.includes('Rosen Deli Owner (owner@rosen.test)'), h.slice(0, 500));
  const vcard = [...(function* walk(n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { for (const c of n) yield* walk(c); return; } if (!React.isValidElement(n)) return; yield n; yield* walk(n.props?.children); })(s.m.tree())].filter((e) => e.type === InviteLinkCard)[0];
  await vcard.props.onDone(); await s.m.render();
  ok('V ON: Done closes', s.closed.length === 1);
}
{
  // ON, but the email is already an owner in this agency: no invite, closes as today.
  const s = await venue({ inviteMode: true }, { status: 201, body: { success: true, venue: { id: 'v9', name: 'Rosen Deli' }, owner: { id: 'o1' } } });
  await s.m.submit();
  ok('V ON: no invite in the answer -> closes as today', s.closed.length === 1 && !s.m.html().includes('data-invite-link-card'));
}

// ---- P: Invite page ----
async function page(routes, token = TOK) {
  const calls = stubFetch(routes); const logins = []; const left = [];
  store.clear();
  const m = mount(InvitePage, { token, onLoginSuccess: (u) => logins.push(u), onLeave: () => left.push(1), darkMode: false, onToggleDarkMode() {} });
  await m.render();
  return { m, calls, logins, left };
}
const PREVIEW = { 'GET /api/invites/preview': { status: 200, body: { kind: 'member', agencyName: 'Hartford Kashrut Commission', role: 'mashgiach', name: 'Dana Cohen' } } };
{
  const s = await page(PREVIEW, null);
  ok('P no token -> not valid, no request', s.m.text().includes(INVITE_INVALID_TITLE) && s.calls.length === 0);
}
{
  const s = await page({ 'GET /api/invites/preview': { status: 404, body: { error: 'This invite link is not valid anymore.' } } });
  ok('P used/expired link -> clear words + help', s.m.text().includes(INVITE_INVALID_TITLE) && s.m.text().includes('used already, or it expired'), s.m.text());
  await s.m.click('Go to sign in');
  ok('P "Go to sign in" leaves the page', s.left.length === 1);
}
{
  const s = await page({ 'GET /api/invites/preview': 'THROW' });
  ok('P offline -> try again', s.m.text().includes("Couldn't reach Shutfey") && s.m.html().includes('Try again'));
}
{
  const s = await page(PREVIEW);
  const pv = s.calls[0];
  ok('P preview: token in the header, never the URL; no session header', pv[1] === '/api/invites/preview' && pv[2]['x-invite-token'] === TOK && !('authorization' in pv[2]), JSON.stringify(pv));
  const t = s.m.text();
  ok('P one screen: agency, name, role', t.includes('Hartford Kashrut Commission') && t.includes('Dana Cohen') && t.includes('Mashgiach'), t);
  const labels = s.m.buttons().map((b) => b.label);
  ok('P two buttons with the agreed words', labels.includes('New to Shutfey? Choose a password') && labels.includes('Already use Shutfey? Sign in'), JSON.stringify(labels));
  ok('P nothing on the page says whether the email has an account', !/already has an account|no account/i.test(t));
}
{
  const s = await page({ ...PREVIEW, 'POST /api/invites/accept': { status: 200, body: { success: true, user: { id: 'u9', name: 'Dana Cohen', role: 'mashgiach' }, token: 'session.jwt' } } });
  await s.m.click('New to Shutfey? Choose a password');
  await s.m.type('invite-new-password', 'short');
  await s.m.submit();
  ok('P new: 8+ characters, checked before sending', s.m.text().includes('at least 8 characters') && !s.calls.some(([m]) => m === 'POST'));
  await s.m.type('invite-new-password', 'dana-own-password');
  await s.m.type('invite-new-confirm', 'dana-own-passwor');
  await s.m.submit();
  ok('P new: passwords must match', s.m.text().includes('do not match') && !s.calls.some(([m]) => m === 'POST'));
  await s.m.type('invite-new-confirm', 'dana-own-password');
  await s.m.submit();
  const post = s.calls.find(([m]) => m === 'POST');
  ok('P new: one accept { token, mode: new, password }, no session header', !!post && post[1] === '/api/invites/accept' && JSON.stringify(post[3]) === JSON.stringify({ token: TOK, mode: 'new', password: 'dana-own-password' }) && !('authorization' in post[2]), JSON.stringify(post));
  ok('P new: signed in with the returned session', s.logins.length === 1 && s.logins[0].id === 'u9' && store.get('shutfey_session_token') !== undefined, JSON.stringify([...store.entries()]));
}
{
  const GEN = "We couldn't accept the invite with these details. If you already use Shutfey, sign in with that password.";
  const s = await page({ ...PREVIEW, 'POST /api/invites/accept': { status: 401, body: { error: GEN, code: 'INVITE_ACCEPT_FAILED' } } });
  await s.m.click('Already use Shutfey? Sign in');
  await s.m.submit();
  ok('P existing: password required', s.m.text().includes('Please enter your password.') && !s.calls.some(([m]) => m === 'POST'));
  await s.m.type('invite-existing-password', 'wrong-one');
  store.set('shutfey_session_token', 'someone-else.jwt');
  await s.m.submit();
  const post = s.calls.find(([m]) => m === 'POST');
  ok('P existing: accept { mode: existing }', !!post && post[3].mode === 'existing' && post[3].password === 'wrong-one');
  ok('P generic error shown as the server says it, form stays', s.m.text().includes(GEN) && s.m.html().includes('invite-existing-password') && s.logins.length === 0, s.m.text());
  ok('P a failed accept does not touch a stored session', store.get('shutfey_session_token') === 'someone-else.jwt');
}
{
  const s = await page({ ...PREVIEW, 'POST /api/invites/accept': { status: 403, body: { error: "This account can't be connected to another agency yet.", code: 'INVITE_ACCOUNT_NOT_LINKABLE' } } });
  await s.m.click('Already use Shutfey? Sign in');
  await s.m.type('invite-existing-password', 'right-one');
  await s.m.submit();
  ok("P can't connect yet: its own screen", s.m.html().includes('data-invite-state="not-linkable"') && s.m.text().includes("Can't connect yet") && s.m.text().includes("can't be connected to another agency yet") && s.logins.length === 0, s.m.text());
}
{
  const s = await page({ ...PREVIEW, 'POST /api/invites/accept': { status: 404, body: { error: 'This invite link is not valid anymore.' } } });
  await s.m.click('New to Shutfey? Choose a password');
  await s.m.type('invite-new-password', 'a-valid-password'); await s.m.type('invite-new-confirm', 'a-valid-password');
  await s.m.submit();
  ok('P link used meanwhile -> not valid screen', s.m.text().includes(INVITE_INVALID_TITLE) && s.m.html().includes('data-invite-state="invalid"') && !s.m.html().includes('invite-new-password'));
}
{
  const s = await page({ ...PREVIEW, 'POST /api/invites/accept': { status: 429, body: { error: 'Too many requests. Please try again in 15 minute(s).', code: 'RATE_LIMITED' } } });
  await s.m.click('New to Shutfey? Choose a password');
  await s.m.type('invite-new-password', 'a-valid-password'); await s.m.type('invite-new-confirm', 'a-valid-password');
  await s.m.submit();
  ok('P too many tries -> the server words', s.m.text().includes('Too many requests'));
}
{
  const s = await page({
    ...PREVIEW,
    'POST /api/invites/accept': { status: 200, body: { success: true, chooseMembership: true, token: 'choose.jwt', memberships: [{ membershipId: 'r1', agencyId: 'a1', agencyName: 'Star Vaad', role: 'mashgiach' }, { membershipId: 'r2', agencyId: 'agency-hkc', agencyName: 'Hartford Kashrut Commission', role: 'mashgiach' }] } },
    'POST /api/auth/activate': (b, h) => (h.authorization === 'Bearer choose.jwt' && b.membershipId === 'r2' ? { status: 200, body: { token: 'session2.jwt', user: { id: 'r2', name: 'Dana Cohen' } } } : { status: 403, body: { error: 'nope' } }),
  });
  await s.m.click('Already use Shutfey? Sign in');
  await s.m.type('invite-existing-password', 'right-one');
  await s.m.submit();
  ok('P two agencies now -> pick which to open', s.m.text().includes('Which agency do you want to open now?') && s.m.text().includes('Star Vaad') && s.m.text().includes('Hartford Kashrut Commission'), s.m.text());
  await s.m.click('Hartford Kashrut Commission');
  ok('P pick -> activate with the choose token, signed in', s.logins.length === 1 && s.logins[0].id === 'r2' && store.get('shutfey_session_token') === 'session2.jwt', JSON.stringify(s.calls.map((c) => c[1])));
}
{
  const src = fs.readFileSync(new URL('../../src/components/InvitePage.tsx', import.meta.url), 'utf8');
  ok('P no recovery codes anywhere (design v3.1)', !/recovery/i.test(src));
  ok('P plain fetch only (no apiFetch: never sends or clears the session)', !src.includes('apiFetch'));
}

// ---- A: App wiring (source) ----
{
  const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  ok('A pending answer -> full link returned', /data\.pending === true[\s\S]{0,200}fullInviteLink\(data\.link\)/.test(app));
  ok('A today\'s add path unchanged after it', app.includes("setKnownUsers((prev) => (prev.some((u) => u.id === data.user.id) ? prev : [...prev, data.user]));"));
  const iInvite = app.indexOf('if (invitePage && !isKiosk)'); const iAuth = app.indexOf('if (!currentUser) {\n    // Kiosk tablets');
  ok('A invite page before the sign-in screens', iInvite > 0 && iAuth > iInvite);
  ok('A flag passed to both forms', (app.match(/inviteMode=\{inviteFlag === true\}/g) || []).length === 2);
  ok('A flag read only for an admin (user + agency key), not on a kiosk, refreshed when a form opens', /useInviteFlag\(\s*!isKiosk && currentUser\?\.role === 'admin' \? `\$\{currentUser\.id\}\|\$\{currentUser\.agencyId \|\| ''\}` : null,\s*isTeamModalOpen,\s*isCreateVenueOpen,\s*(inviteRev,?\s*)?\)/.test(app));
}

console.log(`\n${passed} passed, ${failures} failed.`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
