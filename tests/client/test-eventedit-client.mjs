/**
 * EVENTEDIT CLIENT (Don, Oct 28 2026: "When a task created in an event, it can't be edited. Fix it.").
 *  P  lib/eventPermissions.mayEditEventTaskWording: the people who may edit an ordinary task at the
 *     venue — event managers (admin, coordinator in their list, owner/manager at home) and anyone
 *     granted "can assign tasks" whose venue list holds the event's venue; nobody else; fail closed.
 *  M  EventsModal: an "Edit task" pencil on every event task for those people only; tapping it opens
 *     the name + details form in place; Save sends ONE PATCH with only the changed fields (trimmed),
 *     each with the wording the form opened with (baseTitle / baseDescription, RV1 P2), and hands the
 *     saved event up; nothing changed -> no request; Cancel / Escape (from any field) send nothing and
 *     are ignored while saving; a blank name is not sent; a server refusal shows its own words by the
 *     form and keeps it open; opening another event closes the draft, and a save that fails after
 *     that reports through onEventTaskSaveError (RV1 #3). Checking a task still works.
 *  L  lib/eventTaskEdit.editEventTask: PATCH /api/events/:id/tasks/:taskId; refusal in the server's words.
 * Run: npx tsx tests/client/test-eventedit-client.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import { EventsModal } from '../../src/components/EventsModal.tsx';
import { mayEditEventTaskWording } from '../../src/lib/eventPermissions.ts';
import { editEventTask } from '../../src/lib/eventTaskEdit.ts';
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
    calls.push([method, path, body ?? null]);
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body);
    if (r && typeof r.then === 'function') r = await r;
    r = r || { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, clone() { return this; }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}
setSessionToken('t-eventedit');

// ---- P: who may change an event task's wording ----
const ag = 'ag1';
const admin = { id: 'u-a', name: 'Ada Admin', email: 'ada@x.test', role: 'admin', agencyId: ag };
const coord = { id: 'u-c', name: 'Cal Coord', email: 'cal@x.test', role: 'coordinator', agencyId: ag, venueId: 'v1' };
const owner = { id: 'u-o', name: 'Ora Owner', email: 'ora@x.test', role: 'owner', agencyId: ag, venueId: 'v1' };
const manager = { id: 'u-g', name: 'Gil Manager', email: 'gil@x.test', role: 'manager', agencyId: ag, venueId: 'v1' };
const mashAssign = { id: 'u-ma', name: 'Mia M', email: 'mia@x.test', role: 'mashgiach', agencyId: ag, venueId: 'v1', permissions: { canFillTasks: true, canAssignTasks: true } };
const mash = { id: 'u-m', name: 'Moshe M', email: 'moshe@x.test', role: 'mashgiach', agencyId: ag, venueId: 'v1' };
const worker = { id: 'u-w', name: 'Wes W', email: 'wes@x.test', role: 'worker', agencyId: ag, venueId: 'v1' };
const ownerAssign = { ...owner, id: 'u-oa', venueId: 'v2', permissions: { canAssignTasks: true } };
const vAll = [{ id: 'v1', agencyId: ag }, { id: 'v2', agencyId: ag }];
const vOne = [{ id: 'v1', agencyId: ag }];
const ev1 = { id: 'e1', venueId: 'v1', agencyId: ag };
const ev2 = { id: 'e2', venueId: 'v2', agencyId: ag };
const evB = { id: 'eb', venueId: 'v1', agencyId: 'ag2' };
ok('P admin: any listed venue', mayEditEventTaskWording(admin, ev1, vAll) && mayEditEventTaskWording(admin, ev2, vAll));
ok('P coordinator: own listed venue only', mayEditEventTaskWording(coord, ev1, vOne) && !mayEditEventTaskWording(coord, ev2, vOne));
ok('P owner / manager: own venue (they manage the event)', mayEditEventTaskWording(owner, ev1, vOne) && mayEditEventTaskWording(manager, ev1, vOne));
ok('P owner / manager: not another venue', !mayEditEventTaskWording(owner, ev2, vAll) && !mayEditEventTaskWording(manager, ev2, vAll));
ok('P mashgiach granted "can assign tasks": own venue', mayEditEventTaskWording(mashAssign, ev1, vOne));
ok('P mashgiach granted "can assign tasks": a venue not in their list -> no', !mayEditEventTaskWording(mashAssign, ev2, vOne));
ok('P check-only mashgiach / worker -> no', !mayEditEventTaskWording(mash, ev1, vOne) && !mayEditEventTaskWording(worker, ev1, vOne));
ok('P owner granted "can assign tasks" at their own other venue', mayEditEventTaskWording(ownerAssign, ev2, [{ id: 'v2', agencyId: ag }]));
ok('P another agency\'s event -> no (even an admin)', !mayEditEventTaskWording(admin, evB, vAll));
ok('P fail closed: no user / no event / no venue / no role', !mayEditEventTaskWording(null, ev1, vAll) && !mayEditEventTaskWording(admin, null, vAll) &&
  !mayEditEventTaskWording(admin, { id: 'x', venueId: '' }, vAll) && !mayEditEventTaskWording({ ...admin, role: undefined }, ev1, vAll) &&
  !mayEditEventTaskWording(admin, ev1, null));

// ---- M: EventsModal ----
const venues = [{ id: 'v1', name: 'Crown Market', agencyId: ag }, { id: 'v2', name: 'Rosen Deli', agencyId: ag }];
const tasks = [
  { id: 'et1', title: 'Check the fish', description: 'scales and fins', isCompleted: false },
  { id: 'et2', title: 'Seal the ovens', isCompleted: true, completedByName: 'Moshe M', notes: 'seal 12' },
];
const ev = { id: 'e1', agencyId: ag, title: 'Cohen wedding', venueId: 'v1', date: '2099-01-01', location: 'Hall A', tasks, mashgiachType: 'unassigned', status: 'confirmed' };
const toggles = []; const saved = [];
const base = (user, allVenues = venues) => ({ isOpen: true, onClose() {}, events: [ev], currentUser: user, currentVenue: venues[0], allVenues, availableMashgichim: [], onOpenCreateEvent() {}, onToggleEventTask: async (...a) => { toggles.push(a); }, onUpdateEvent: async () => {}, onEventTaskSaved: (e) => saved.push(e) });
const html = (user, allVenues) => decode(renderToStaticMarkup(React.createElement(EventsModal, base(user, allVenues))));
for (const [label, user, want] of [['admin', admin, true], ['coordinator', coord, true], ['owner', owner, true], ['manager', manager, true], ['mashgiach with can-assign', mashAssign, true], ['check-only mashgiach', mash, false], ['worker', worker, false]]) {
  const h = html(user);
  const n = (h.match(/data-event-task-edit-button/g) || []).length;
  ok(`M ${label}: Edit task ${want ? 'on every task' : 'hidden'}`, want ? n === 2 : n === 0, `count ${n}`);
  if (want) ok(`M ${label}: the pencil names its task`, h.includes('aria-label="Edit task: Check the fish"') && h.includes('aria-label="Edit task: Seal the ovens"'));
}
ok('M coordinator, event venue not in their list -> no Edit task', !html(coord, [venues[1]]).includes('data-event-task-edit-button'));
{
  // the pencil is a 44px target
  const h = html(coord);
  const btn = h.slice(h.indexOf('data-event-task-edit-button') - 400, h.indexOf('data-event-task-edit-button') + 400);
  ok('M the pencil is a 44px target', /w-11/.test(btn) && /h-11/.test(btn));
}
{
  const savedEvent = { ...ev, tasks: [{ ...tasks[0], title: 'Check every fish', description: 'scales' }, tasks[1]] };
  const calls = stubFetch({ 'PATCH /api/events/e1/tasks/et1': { status: 200, body: { success: true, event: savedEvent, task: savedEvent.tasks[0] } } });
  const m = mount(EventsModal, base(coord));
  await m.render();
  await m.click('Edit task: Check the fish');
  let h = decode(m.html());
  ok('M tap Edit task -> the form opens with the name and details', h.includes('data-event-task-edit') && h.includes('value="Check the fish"') && h.includes('scales and fins') && h.includes('Task name') && h.includes('Details (optional)'));
  ok('M only that task is in edit mode', (h.match(/data-event-task-edit=""/g) || h.match(/<form data-event-task-edit/g) || []).length === 1);
  await m.click('Cancel');
  h = decode(m.html());
  ok('M Cancel closes the form and sends nothing', !h.includes('<form') && calls.length === 0);
  await m.click('Edit task: Check the fish');
  await m.type('etask-title-et1', '   ');
  await m.submit();
  h = decode(m.html());
  ok('M blank name: not sent, says so', calls.length === 0 && h.includes('Give the task a name.'));
  await m.type('etask-title-et1', '  Check every fish ');
  await m.type('etask-desc-et1', 'scales ');
  await m.submit();
  const patches = calls.filter(([mm, p]) => mm === 'PATCH' && p === '/api/events/e1/tasks/et1');
  const b = patches[0]?.[2] || {};
  const keys = Object.keys(b).filter((k) => !['expectedVersion', 'operationId'].includes(k)).sort();
  ok('M Save -> one PATCH with the changed fields + the wording the form opened with, trimmed', patches.length === 1 && calls.length === 1 &&
    JSON.stringify(keys) === '["baseDescription","baseTitle","description","title"]' && b.title === 'Check every fish' && b.description === 'scales' &&
    b.baseTitle === 'Check the fish' && b.baseDescription === 'scales and fins', JSON.stringify(calls));
  h = decode(m.html());
  ok('M after Save the form closes and the saved event goes up', !h.includes('<form') && saved.length === 1 && saved[0].tasks[0].title === 'Check every fish');
}
{
  const calls = stubFetch({ 'PATCH /api/events/e1/tasks/et2': { status: 403, body: { error: "You can't edit this event's tasks.", code: 'EVENT_TASK_EDIT_FORBIDDEN' } } });
  const before = saved.length;
  const m = mount(EventsModal, base(admin));
  await m.render();
  await m.click('Edit task: Seal the ovens');
  await m.type('etask-title-et2', 'Seal all ovens');
  await m.submit();
  const h = decode(m.html());
  ok('M refusal: the server\'s words by the form, form stays open, nothing handed up', calls.length === 1 && h.includes("You can't edit this event's tasks.") && h.includes('<form') && saved.length === before);
}
{
  // only the name changed -> only the name (and its base) is sent; nothing changed -> no request
  const calls = stubFetch({ 'PATCH /api/events/e1/tasks/et1': { status: 200, body: { success: true, event: ev } } });
  const m = mount(EventsModal, base(coord));
  await m.render();
  await m.click('Edit task: Check the fish');
  await m.type('etask-title-et1', 'Check the fish twice');
  await m.submit();
  const b = calls[0]?.[2] || {};
  ok('M only the name changed -> { title, baseTitle } only', calls.length === 1 && JSON.stringify(Object.keys(b).filter((k) => !['expectedVersion', 'operationId'].includes(k)).sort()) === '["baseTitle","title"]', JSON.stringify(calls));
  const before = saved.length;
  await m.click('Edit task: Check the fish');
  await m.type('etask-title-et1', ' Check the fish ');
  await m.submit();
  ok('M nothing changed -> no request, the form closes, nothing handed up', calls.length === 1 && !decode(m.html()).includes('<form') && saved.length === before);
}
{
  // Escape from the details field closes; while saving, Escape and Cancel do nothing
  let release;
  const calls = stubFetch({ 'PATCH /api/events/e1/tasks/et1': () => new Promise((res) => { release = () => res({ status: 200, body: { success: true, event: ev } }); }) });
  const m = mount(EventsModal, base(coord));
  await m.render();
  await m.click('Edit task: Check the fish');
  const esc = () => m.find((e) => e.type === 'form')[0].props.onKeyDown({ key: 'Escape', preventDefault() {} });
  esc(); await m.render();
  ok('M Escape (from any field of the form) closes it, nothing sent', !decode(m.html()).includes('<form') && calls.length === 0);
  await m.click('Edit task: Check the fish');
  await m.type('etask-desc-et1', 'scales, fins and skin');
  await m.submit();
  let h = decode(m.html());
  ok('M while saving: Saving… and the buttons are disabled', h.includes('Saving…') && /disabled=""[^>]*>Cancel|<button[^>]*disabled=""[^>]*>\s*Cancel/.test(h), h.slice(h.indexOf('<form'), h.indexOf('<form') + 300));
  esc(); await m.render();
  await m.click('Cancel');
  ok('M while saving: Escape and Cancel do not close it', decode(m.html()).includes('<form') && calls.length === 1);
  release(); await new Promise((r) => setTimeout(r, 10)); await m.render();
  ok('M after the save the form closes', !decode(m.html()).includes('<form'));
}
{
  // opening another event closes the draft; a save failing after that reports through onEventTaskSaveError
  const errors = [];
  let release;
  const ev2 = { ...ev, id: 'e2', title: 'Rosen bar mitzvah', tasks: [{ id: 'et9', title: 'Kasher the grill', isCompleted: false }] };
  stubFetch({ 'PATCH /api/events/e1/tasks/et1': () => new Promise((res) => { release = () => res({ status: 409, body: { error: 'Conflict: this event task was changed by someone else. Please refresh and try again.' } }); }) });
  const m = mount(EventsModal, { ...base(coord), events: [ev, ev2], onEventTaskSaveError: (msg) => errors.push(msg) });
  await m.render();
  await m.click('Edit task: Check the fish');
  await m.click('Rosen bar mitzvah');
  ok('M opening another event closes the draft', !decode(m.html()).includes('<form'));
  await m.click('Cohen wedding');
  ok('M coming back: no stale draft', !decode(m.html()).includes('<form'));
  await m.click('Edit task: Check the fish');
  await m.type('etask-title-et1', 'Check every fish');
  await m.submit();
  await m.click('Rosen bar mitzvah');
  release(); await new Promise((r) => setTimeout(r, 10)); await m.render();
  ok('M a save that fails after its form closed reports through onEventTaskSaveError', errors.length === 1 && /changed by someone else/.test(errors[0]) && !decode(m.html()).includes('<form'), JSON.stringify(errors));
}
{
  toggles.length = 0;
  stubFetch({});
  const m = mount(EventsModal, base(coord));
  await m.render();
  await m.click('Check the fish');
  ok('M tapping a task still checks it (one toggle, not the editor)', toggles.length === 1 && toggles[0][1] === 'et1' && toggles[0][2] === true && !decode(m.html()).includes('<form'));
}

// ---- L: lib/eventTaskEdit ----
{
  const calls = stubFetch({ 'PATCH /api/events/e%201/tasks/t%2F1': { status: 409, body: { error: 'Conflict: this event task was changed by someone else. Please refresh and try again.' } } });
  const r = await editEventTask('e 1', 't/1', { title: ' A ', description: '' }, { title: 'B', description: '' });
  ok('L ids are encoded in the path; base sent; refusal in the server\'s words', calls.length === 1 && calls[0][0] === 'PATCH' && calls[0][1] === '/api/events/e%201/tasks/t%2F1' &&
    calls[0][2].title === 'A' && calls[0][2].baseTitle === 'B' && calls[0][2].description === undefined && r.ok === false && /changed by someone else/.test(r.message || ''), JSON.stringify(calls));
  const same = await editEventTask('e1', 't1', { title: ' B ', description: '' }, { title: 'B', description: '' });
  ok('L nothing changed -> no request', same.ok === true && same.unchanged === true && calls.length === 1);
  const blank = await editEventTask('e1', 't1', { title: '  ', description: 'x' }, { title: 'B', description: '' });
  ok('L a blank name is never sent', blank.ok === false && blank.message === 'Give the task a name.' && calls.length === 1);
}

console.log(`eventedit client: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
