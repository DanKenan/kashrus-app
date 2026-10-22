/**
 * QA2S2 CLIENT — screens for server #126 (QA2 #9 #15 #27 #31).
 *  E  lib/eventPermissions: mayManageEventAt / mayCreateEvents (admin any venue; coordinator own venues; owner own venue; others never).
 *  M  EventsModal: Create event / Copy / Delete / assignee picker only for those people; Notify again on an assigned event.
 *  N  lib/eventNotify: POST /api/events/:id/notify {}; attempted 0 -> "They have no phone with notifications on."; refusals in the server's words.
 *  S  AgencySettingsSheet: loads the admin view; PUT /api/agency/settings with only the changed fields + version; server words on refusal.
 *  P  ChangePasswordModal keeps the fresh token from the answer (#15).
 * Run: npx tsx tests/client/test-qa2s2-client.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import { EventsModal } from '../../src/components/EventsModal.tsx';
import { AgencySettingsForm } from '../../src/components/AgencySettingsSheet.tsx';
import { mayManageEventAt, mayCreateEvents } from '../../src/lib/eventPermissions.ts';
import { notifyEventAssignee, NOTIFY_NO_DEVICE_TEXT, NOTIFY_FALLBACK_TEXT, NOTIFY_OFFLINE_TEXT } from '../../src/lib/eventNotify.ts';
import { setSessionToken } from '../../src/lib/api.ts';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

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

// ---- E: who may manage events ----
const admin = { id: 'u-a', name: 'Ada Admin', email: 'ada@x.test', role: 'admin', agencyId: 'ag1' };
const coord = { id: 'u-c', name: 'Cal Coord', email: 'cal@x.test', role: 'coordinator', agencyId: 'ag1', venueId: 'v1' };
const owner = { id: 'u-o', name: 'Ora Owner', email: 'ora@x.test', role: 'owner', agencyId: 'ag1', venueId: 'v1' };
const mash = { id: 'u-m', name: 'Moshe M', email: 'moshe@x.test', role: 'mashgiach', agencyId: 'ag1', venueId: 'v1' };
const worker = { id: 'u-w', name: 'Wes W', email: 'wes@x.test', role: 'worker', agencyId: 'ag1', venueId: 'v1' };
// The venue lists GET /api/venues gives each caller (the server's own scope cut).
const vAdmin = [{ id: 'v1', agencyId: 'ag1' }, { id: 'v2', agencyId: 'ag1' }, { id: 'v3', agencyId: 'ag1' }];
const vCoordHome = [{ id: 'v1', agencyId: 'ag1' }];
const vCoordMulti = [{ id: 'v1', agencyId: 'ag1' }, { id: 'v3', agencyId: 'ag1' }];
ok('E admin: any venue in the list', mayManageEventAt(admin, 'v1', vAdmin) && mayManageEventAt(admin, 'v3', vAdmin));
ok('E admin: a venue not in the list (deleted / unknown) -> no', !mayManageEventAt(admin, 'v9', vAdmin));
ok('E coordinator: home venue only when that is all the server listed', mayManageEventAt(coord, 'v1', vCoordHome) && !mayManageEventAt(coord, 'v2', vCoordHome) && !mayManageEventAt(coord, 'v3', vCoordHome));
ok('E coordinator: the extra venues the server listed', mayManageEventAt(coord, 'v3', vCoordMulti) && !mayManageEventAt(coord, 'v2', vCoordMulti));
ok('E coordinator: raw venueIds / venueAccess on the user never grant (stale access)', !mayManageEventAt({ ...coord, venueIds: ['v2'], venueAccess: ['v1', 'v2'] }, 'v2', vCoordHome));
ok('E coordinator: home venue the server did not list (moved to another agency / mismatched home) -> no', !mayManageEventAt(coord, 'v1', [{ id: 'v3', agencyId: 'ag1' }]) && !mayManageEventAt({ ...coord, venueId: 'v7' }, 'v7', vCoordMulti));
ok('E venue of another agency in the list -> no, for every role', !mayManageEventAt(admin, 'vx', [{ id: 'vx', agencyId: 'ag2' }]) && !mayManageEventAt(coord, 'v1', [{ id: 'v1', agencyId: 'ag2' }]) && !mayManageEventAt(owner, 'v1', [{ id: 'v1', agencyId: 'ag2' }]));
ok('E missing agency ids fall back to the same default on both sides', mayManageEventAt({ ...admin, agencyId: undefined }, 'v1', [{ id: 'v1' }]) && !mayManageEventAt(admin, 'v1', [{ id: 'v1' }]));
ok('E owner: own venue only; extra listed venues never widen it', mayManageEventAt(owner, 'v1', vCoordMulti) && !mayManageEventAt(owner, 'v3', vCoordMulti) && !mayManageEventAt({ ...owner, venueId: 'v1' }, 'v1', [{ id: 'v3', agencyId: 'ag1' }]));
ok('E mashgiach / worker / unknown / none: never', !mayManageEventAt(mash, 'v1', vAdmin) && !mayManageEventAt(worker, 'v1', vAdmin) && !mayManageEventAt({ ...admin, role: 'kiosk' }, 'v1', vAdmin) && !mayManageEventAt(null, 'v1', vAdmin) && !mayManageEventAt(admin, '', vAdmin) && !mayManageEventAt(admin, 'v1', null) && !mayManageEventAt({ ...admin, role: undefined }, 'v1', vAdmin));
ok('E create: admin / coordinator / owner with a listed venue; nobody with an empty list; never mashgiach / worker', mayCreateEvents(admin, vAdmin) && mayCreateEvents(coord, vCoordHome) && mayCreateEvents(owner, vCoordHome) && !mayCreateEvents(owner, [{ id: 'v3', agencyId: 'ag1' }]) && !mayCreateEvents(admin, []) && !mayCreateEvents(coord, undefined) && !mayCreateEvents(mash, vAdmin) && !mayCreateEvents(worker, vAdmin) && !mayCreateEvents(null, vAdmin));

// ---- M: EventsModal ----
const venues = [{ id: 'v1', name: 'Crown Market', agencyId: 'ag1' }, { id: 'v2', name: 'Rosen Deli', agencyId: 'ag1' }];
const evAssigned = { id: 'e1', title: 'Cohen wedding', venueId: 'v1', date: '2099-01-01', location: 'Hall A', tasks: [], mashgiachType: 'assigned_user', assignedMashgiachEmail: 'moshe@x.test', assignedMashgiachName: 'Moshe M' };
const evOther = { ...evAssigned, id: 'e2', title: 'Rosen bar mitzvah', venueId: 'v2', mashgiachType: 'unassigned', assignedMashgiachEmail: undefined, assignedMashgiachName: undefined };
const mBase = (user, events = [evAssigned]) => ({ isOpen: true, onClose() {}, events, currentUser: user, currentVenue: venues[0], allVenues: venues, availableMashgichim: [mash], onOpenCreateEvent() {}, onToggleEventTask: async () => {}, onUpdateEvent: async () => {}, onDeleteEvent: async () => {}, onCopyEvent() {} });
const mHtml = (user, events, allVenues) => decode(renderToStaticMarkup(React.createElement(EventsModal, { ...mBase(user, events), ...(allVenues ? { allVenues } : {}) })));
for (const [label, user, want] of [['admin', admin, true], ['coordinator at the venue', coord, true], ['owner of the venue', owner, true], ['mashgiach', mash, false], ['worker', worker, false]]) {
  const h = mHtml(user);
  ok(`M ${label}: Create event ${want ? 'shown' : 'hidden'}`, h.includes('id="open-create-event-btn"') === want);
  ok(`M ${label}: Copy / Delete ${want ? 'shown' : 'hidden'}`, h.includes('Copy event') === want && h.includes('Delete Event') === want);
  ok(`M ${label}: assignee picker ${want ? 'editable' : 'read only'}`, h.includes('<select') === want);
  ok(`M ${label}: Notify again ${want ? 'shown' : 'hidden'}`, h.includes('data-notify-again') === want);
}
{
  // A coordinator's venue list from GET /api/venues is their scope (here: v1 only).
  const h = mHtml(coord, [evOther], [venues[0]]);
  ok('M coordinator, event at a venue outside their list: no Copy / Delete / Notify / picker', !h.includes('Copy event') && !h.includes('Delete Event') && !h.includes('data-notify-again') && !h.includes('<select'));
  const h2 = mHtml(admin, [evOther]);
  ok('M unassigned event: no Notify again (admin)', !h2.includes('data-notify-again') && h2.includes('Delete Event'));
}
{
  const calls = stubFetch({ 'POST /api/events/e1/notify': { status: 200, body: { notified: true, attempted: 2 } } });
  const m = mount(EventsModal, mBase(admin));
  await m.render();
  await m.click('Notify again');
  const h = decode(m.html());
  ok('M Notify again -> one POST, then "Sent to Moshe M again."', calls.filter(([mm, p]) => mm === 'POST' && p === '/api/events/e1/notify').length === 1 && h.includes('Sent to Moshe M again.'), h.slice(0, 200));
}

// ---- N: lib/eventNotify ----
{
  let calls = stubFetch({ 'POST /api/events/e1/notify': { status: 200, body: { notified: true, attempted: 0 } } });
  let r = await notifyEventAssignee('e1', 'Moshe M');
  ok('N attempted 0 -> ok + "They have no phone with notifications on."', r.ok && r.message === NOTIFY_NO_DEVICE_TEXT);
  ok('N POST with an empty JSON body', calls.length === 1 && calls[0][0] === 'POST' && JSON.stringify(calls[0][2]) === '{}');
  for (const [status, code, words] of [[403, 'EVENT_FORBIDDEN', 'Only admins, venue owners and coordinators can create events.'], [409, 'EVENT_NO_ASSIGNEE', 'This event has no assigned mashgiach to notify.'], [409, 'EVENT_ASSIGNEE_UNAVAILABLE', "The assigned mashgiach can't be notified right now."], [429, 'NOTIFY_TOO_SOON', 'Please wait a minute before notifying again.']]) {
    stubFetch({ 'POST /api/events/e1/notify': { status, body: { code, error: words } } });
    r = await notifyEventAssignee('e1', 'Moshe M');
    ok(`N ${status} ${code}: the server words`, !r.ok && r.message === words, r.message);
  }
  stubFetch({ 'POST /api/events/e1/notify': { status: 500, body: null } });
  ok('N no words -> plain fallback', (await notifyEventAssignee('e1')).message === NOTIFY_FALLBACK_TEXT);
  stubFetch({ 'POST /api/events/e1/notify': 'THROW' });
  ok('N offline -> plain words', (await notifyEventAssignee('e1')).message === NOTIFY_OFFLINE_TEXT);
}

// ---- S: AgencySettingsSheet ----
const agencyRoute = (v = 7) => ({ status: 200, body: { agency: { id: 'ag1', name: 'Hartford Kashrut', contactPhone: '+18605550100', timeZone: 'America/New_York' } }, headers: { 'X-State-Version': String(v) } });
async function sheet(putAnswer) {
  const calls = stubFetch({ 'GET /api/agencies/current': agencyRoute(7), 'PUT /api/agency/settings': putAnswer });
  const saved = []; const closed = [];
  const m = mount(AgencySettingsForm, { isOpen: true, onClose: () => closed.push(1), onSaved: (a) => saved.push(a) });
  await m.render(); await new Promise((r) => setTimeout(r, 0)); await m.render();
  return { m, calls, saved, closed };
}
{
  const s = await sheet({ status: 200, body: { agency: { id: 'ag1', name: 'Hartford Kashrut Council', contactPhone: '+18605550100', timeZone: 'America/New_York' } } });
  const h = decode(s.m.html());
  ok('S loads the current name and phone', h.includes('value="Hartford Kashrut"') && h.includes('value="+18605550100"'), h.slice(0, 300));
  const nameInput = s.m.find((e) => e.type === 'input' && e.props.value === 'Hartford Kashrut')[0];
  await nameInput.props.onChange({ target: { value: 'Hartford Kashrut Council' } }); await s.m.render();
  await s.m.submit();
  const put = s.calls.find(([mm, p]) => mm === 'PUT' && p === '/api/agency/settings');
  ok('S PUT carries only the changed field', !!put && JSON.stringify(Object.keys(put[2]).filter((k) => k !== 'operationId' && k !== 'expectedVersion').sort()) === '["name"]' && put[2].name === 'Hartford Kashrut Council', JSON.stringify(put?.[2]));
  const ver = put && (put[3]['x-expected-version'] ?? put[3]['if-match'] ?? put[2].expectedVersion);
  ok('S PUT carries the loaded version', String(ver).includes('7'), JSON.stringify(put?.[3]));
  ok('S saved + closed', s.saved.length === 1 && s.saved[0].name === 'Hartford Kashrut Council' && s.closed.length === 1);
}
{
  const words = 'Please enter a valid phone number.';
  const s = await sheet({ status: 400, body: { code: 'SETTINGS_INVALID', error: words } });
  const phoneInput = s.m.find((e) => e.type === 'input' && e.props.type === 'tel')[0];
  await phoneInput.props.onChange({ target: { value: '12' } }); await s.m.render();
  await s.m.submit();
  const h = decode(s.m.html());
  ok('S 400: the server words as an alert; stays open', h.includes(words) && h.includes('role="alert"') && s.closed.length === 0);
}
{
  const s = await sheet({ status: 200, body: {} });
  const h = decode(s.m.html());
  ok('S Save disabled until something changes', /<button type="submit" disabled=""/.test(h) || /type="submit"[^>]*disabled/.test(h), h.slice(-400));
}

// ---- P: ChangePasswordModal keeps the fresh token (source) ----
{
  const src = fs.readFileSync(new URL('../../src/components/ChangePasswordModal.tsx', import.meta.url), 'utf8');
  ok('P change-password stores data.token when present', /if \(typeof data\.token === 'string' && data\.token\) setSessionToken\(data\.token\);/.test(src));
}

console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
console.log('ALL PASS');
