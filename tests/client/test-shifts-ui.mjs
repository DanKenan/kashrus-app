import assert from 'node:assert/strict';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { ShiftsPanel } from '../../src/components/ShiftsPanel.tsx';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { getPhoneNavState, PhoneNav } from '../../src/components/PhoneNav.tsx';
import { sheetAllowed } from '../../src/lib/screenMemory.ts';
const HostDate = globalThis.Date;
// Noon in New York keeps the default form selection inside Deli day hours.
globalThis.Date = class extends HostDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-03T17:00:00Z'])); }
  static now() { return new HostDate('2026-11-03T17:00:00Z').getTime(); }
};
try {
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
const shift = { id: 's', venueId: 'v', name: 'Deli day', area: 'Deli', days: Array.from({ length: 7 }, (_, w) => ({ on: w < 6 })), startMinutes: 480, endMinutes: 1080, userId: 'u', userName: 'Moshe L.', overrides: [], createdAt: '' };
const noop = () => {};
const saveForm = async (view) => {
  for (let i = 0; i < 2 && view.find((e) => e.props['data-task-form-current-step'])[0]?.props['data-task-form-current-step'] !== 'Who'; i++) await view.submit();
  if (view.find((e) => e.props.id === 'save-task-submit-btn')[0].props.disabled) await view.click((e) => e.props['aria-label'] === 'Everyone at the venue');
  await view.submit();
};
let saved;
recordFetch({});
const form = mount(TaskModal, { isOpen: true, onClose: noop, onSave: (t) => { saved = t; }, knownWorkers: [{ id: 'u', name: 'Moshe L.' }], venueId: 'v', shifts: [shift], timeZone: 'America/New_York' });
await form.render();
await form.click((e) => e.props['aria-label'] === 'A shift');
assert.match(form.text(), /Usual for Deli day/);
const title = form.find((e) => e.type === 'input' && e.props.required)[0];
assert.ok(title);
await title.props.onChange({ target: { value: 'Check deli' } });
await form.render();
await saveForm(form);
assert.equal(saved.shiftId, 's');
assert.deepEqual(saved.assignedTo, ['all']);
assert.equal(saved.scheduleType, 'recurring');
assert.equal(saved.targetTime, '');
assert.equal(saved.targetTime2, '');
assert.equal(saved.isPrivate, false);
await form.render({ taskToEdit: { ...saved, id: 't', shiftId: 's' } });
assert.equal(form.buttons().find((b) => b.el.props['aria-label'] === 'A shift').el.props['aria-pressed'], true);
await form.render({ shifts: [] });
assert.equal(form.buttons().some((b) => b.el.props['aria-label'] === 'A shift'), true, 'built-in shifts remain available');
const panel = mount(ShiftsPanel, { shifts: [shift], venueId: 'v', timeZone: 'America/New_York', people: [{ id: 'u', name: 'Moshe L.' }], onChange: noop });
await panel.render();
assert.match(panel.text(), /Sun–Fri · 8:00 AM – 6:00 PM/);
await panel.click('Deli day');
assert.match(panel.text(), /Area \(type anything\)/);
assert.match(panel.text(), /Changes for a date/);
for (const role of ['mashgiach', 'owner', 'manager']) {
  const user = { id: 'u', role, permissions: { canAssignTasks: true } };
  assert.equal(getPhoneNavState(user, true).showBar, true);
  assert.equal(sheetAllowed(user, 'team'), true);
  const nav = mount(PhoneNav, { user, hasVenues: true, onOpenTaskModal: noop, onOpenShiftNote: noop, onOpenVenues: noop, onOpenTeam: noop, onOpenEvents: noop, onOpenHistory: noop });
  await nav.render();
  assert.ok(nav.buttons().some((b) => b.label === 'Team'));
  assert.equal(sheetAllowed({ ...user, permissions: {} }, 'team'), false);
}
console.log('Shifts UI: task payload, edit mode, list, and permission checks passed');
// The server's refusal stays in the editor; a successful response supplies local state.
await panel.find((e) => e.type === 'input' && e.props.maxLength === 40)[0].props.onChange({ target: { value: 'Edited deli' } }); await panel.render();
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'This venue is outside your scope.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
await panel.submit();
assert.match(panel.text(), /This venue is outside your scope\./);
assert.match(panel.text(), /Edit shift/);
let changed;
await panel.render({ onChange: (s) => { changed = s; } });
globalThis.fetch = async () => new Response(JSON.stringify({ ...shift, name: 'Saved shift' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
await panel.submit();
assert.equal(changed.name, 'Saved shift');
assert.match(panel.text(), /Optional — without shifts the app works as today\./);
console.log('Shifts UI: inline refusal and confirmed-save checks passed');

// Rejected writes keep the edit sheet and expose a retryable inline message.
await panel.click('Deli day');
await panel.find((e) => e.type === 'input' && e.props.maxLength === 40)[0].props.onChange({ target: { value: 'Retry deli' } }); await panel.render();
globalThis.fetch = async () => {
  const response = new Response('{}', { status: 200 });
  response.json = () => { throw new TypeError('Connection interrupted'); };
  return response;
};
await panel.submit();
assert.match(panel.text(), /Couldn't save the shift\. Check the connection and try again\./);
assert.match(panel.text(), /Edit shift/);
await panel.click('Delete shift');
const confirmation = panel.tree().props.children.find((child) => child?.props?.title === 'Delete shift?');
await confirmation.props.onConfirm();
await panel.render();
assert.match(panel.text(), /Couldn't delete the shift\. Check the connection and try again\./);
assert.equal(panel.buttons().find((b) => b.label === 'Save').el.props.disabled, false);

// Render the actual card/table badges with a venue-local fake clock.
const { TaskCardView } = await import('../../src/components/TaskCardView.tsx');
const { TaskTableView } = await import('../../src/components/TaskTableView.tsx');
const { shiftTaskAppliesAt, shiftTaskOverdueAt, tasksVisibleOnShift } = await import('../../src/lib/shifts.ts');
const { taskWithShiftTimes } = await import('../../src/lib/shifts.ts');
const daytime = { ...shift, days: Array.from({ length: 7 }, (_, w) => ({ on: w === 0 })), endMinutes: 960 };
const night = { ...shift, id: 'night', userId: 'usual-person', days: Array.from({ length: 7 }, (_, w) => ({ on: w === 0 })), startMinutes: 1320, endMinutes: 360, overrides: [{ date: '2026-11-08', userId: 'u' }] };
const user = { id: 'u', email: 'moshe@demo.test', name: 'Moshe', role: 'mashgiach' };
const baseTask = { id: 'timing', venueId: 'v', title: 'Demo timing check', category: 'General', categories: ['General'], inputType: 'checkbox', assignedTo: ['all'], daysOfWeek: [0], currentStatus: 'pending', isCompleted: false, notes: '', createdAt: '', updatedAt: null };
const RealDate = Date;
try {
  for (const [s, at, overdue] of [
    [daytime, '2026-11-08T14:00:00Z', false], // 9 AM EST
    [daytime, '2026-11-08T21:00:00Z', false], // exact 4 PM end
    [daytime, '2026-11-08T21:01:00Z', true],
    [night, '2026-11-09T04:00:00Z', false], // Sunday 11 PM
    [night, '2026-11-09T06:00:00Z', false], // Monday 1 AM
    [night, '2026-11-09T11:00:00Z', false], // exact 6 AM end
    [night, '2026-11-09T11:01:00Z', true],
  ]) {
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [at])); }
      static now() { return new RealDate(at).getTime(); }
    };
    const shiftsById = new Map([[s.id, s]]);
    const task = taskWithShiftTimes({ ...baseTask, shiftId: s.id }, shiftsById);
    for (const View of [TaskCardView, TaskTableView]) {
      const view = mount(View, { tasks: [task], shiftsById, currentUser: user, timeZone: 'America/New_York', onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop });
      await view.render();
      assert.equal(view.html().includes('data-overdue'), overdue, `${View.name}: ${at}`);
      await view.render({ tasks: [{ ...task, isCompleted: true }] });
      assert.equal(view.html().includes('data-overdue'), false, 'completed tasks never overdue');
    }
  }
} finally { globalThis.Date = RealDate; }
assert.equal(shiftTaskAppliesAt(night, '2026-11-09', 1, 60), true);
assert.equal(shiftTaskAppliesAt(night, '2026-11-09', 1, 360), false);
assert.equal(shiftTaskOverdueAt(night, '2026-11-09', 1, 361), true);
const nightTask = { ...baseTask, id: 'night-task', shiftId: night.id };
const morningTask = { ...baseTask, id: 'morning-task', daysOfWeek: [1], targetTime: '9:00 AM', targetTimeMinutes: 540 };
assert.deepEqual(tasksVisibleOnShift([nightTask, morningTask], [night], user, '2026-11-09', 1, 60).map((t) => t.id), ['night-task'], 'Sunday override applies on Monday continuation');
console.log('Shifts UI: rejected writes, end-time badges, boundaries, and overnight continuation passed');


// Weekday edits serialize inheritance, explicit Nobody, own hours, and resets.
recordFetch({});
let weekPayload;
globalThis.fetch = async (_url, init) => {
  weekPayload = JSON.parse(init.body);
  return new Response(JSON.stringify({ ...shift, ...weekPayload }), { status: 200 });
};
const weekPanel = mount(ShiftsPanel, { shifts: [shift], venueId: 'v', timeZone: 'America/New_York', people: [{ id: 'u', name: 'Moshe L.' }, { id: 'd', name: 'Dovid R.' }], onChange: noop });
await weekPanel.render(); await weekPanel.click('Deli day');
const change = async (aria, value) => {
  const input = weekPanel.find((e) => e.props['aria-label'] === aria && typeof e.props.onChange === 'function')[0];
  assert.ok(input, aria); input.props.onChange({ target: { value, selectedOptions: [{ value }] } }); await weekPanel.render();
};
await weekPanel.click((e) => e.props['aria-label'] === 'Mon people');
await weekPanel.find((e) => e.props['aria-label'] === 'Mon people choices')[0].props.children[0].props.onClick(); await weekPanel.render();
await weekPanel.find((e) => e.props['aria-label'] === 'Mon people choices')[0].props.children.flat(Infinity).find((e) => Array.isArray(e?.props?.children) && e.props.children.includes('Dovid R.')).props.onClick(); await weekPanel.render();
await weekPanel.click((e) => e.props['aria-label'] === 'Tue people');
await weekPanel.find((e) => e.props['aria-label'] === 'Tue people choices')[0].props.children[0].props.onClick(); await weekPanel.render();
await weekPanel.click((e) => e.props['aria-label'] === 'Wed hours');
await change('Wed From', '10:00'); await change('Wed Until', '16:00');
await weekPanel.submit();
assert.equal(weekPayload.days.length, 7);
assert.equal(weekPayload.days[0].userId, undefined);
assert.equal(weekPayload.days[1].userId, 'd');
assert.equal(weekPayload.days[2].userId, null);
assert.deepEqual([weekPayload.days[3].startMinutes, weekPayload.days[3].endMinutes], [600, 960]);
assert.equal(weekPayload.days[6].on, false);
assert.equal(weekPayload.daysOfWeek, undefined);

const { shiftHoursOn, shiftPersonOn, shiftWeekdays, shiftVariesByDay, shiftLabel } = await import('../../src/lib/shifts.ts');
const { shiftDisplayWeekday, shiftSortProjection, restoreShiftWindows } = await import('../../src/lib/shiftTaskDay.ts');
const { groupTasksByDay, sortTasksByTime } = await import('../../src/lib/taskDay.ts');
const varying = { ...shift, days: weekPayload.days, overrides: [{ date: '2026-11-10', userId: 'u' }] };
assert.equal(shiftPersonOn(varying, '2026-11-09'), 'd');
assert.equal(shiftPersonOn(varying, '2026-11-10'), 'u');
assert.equal(shiftPersonOn({ ...varying, overrides: [] }, '2026-11-10'), null);
assert.equal(shiftPersonOn({ ...varying, overrides: [{ date: '2026-11-09', userId: null }] }, '2026-11-09'), null);
await weekPanel.render({ shifts: [varying] }); await weekPanel.click('Deli day');
await weekPanel.click('Same as general');
assert.equal(weekPanel.find((e) => e.props['aria-label'] === 'Mon people')[0].props['aria-expanded'], false);
await weekPanel.submit();
assert.equal(weekPayload.days[1].userId, undefined);
assert.equal(shiftVariesByDay(varying), true);
assert.deepEqual(shiftHoursOn(varying, 3), { startMinutes: 600, endMinutes: 960 });
assert.equal(shiftLabel(varying, 3), 'Deli day · 10:00 AM – 4:00 PM');
assert.deepEqual(shiftWeekdays(varying), [0, 1, 2, 3, 4, 5]);
const variedTask = { ...baseTask, id: 'deli', shiftId: varying.id };
const atNine = { ...baseTask, id: 'nine', daysOfWeek: [], targetTimeMinutes: 540 };
const byId = new Map([[varying.id, varying]]);
for (const [weekday, expected] of [[0, ['deli', 'nine']], [3, ['nine', 'deli']]]) {
  const all = groupTasksByDay(shiftSortProjection([variedTask, atNine], byId), '2026-11-08');
  const section = all.find((s) => s.key === `weekday-${weekday}`);
  const result = restoreShiftWindows(sortTasksByTime(shiftSortProjection(section.tasks, byId, weekday)), byId, weekday);
  assert.deepEqual(result.map((t) => t.id), expected);
}
const sundayNight = { ...varying, days: varying.days.map((d, w) => w === 0 ? { on: true, startMinutes: 1320, endMinutes: 360 } : d) };
assert.equal(shiftDisplayWeekday(sundayNight, '2026-11-09', 1, 60), 0);
assert.equal(shiftDisplayWeekday(sundayNight, '2026-11-09', 1, 60, 'weekday-3'), 3);
console.log('Shifts UI: weekly inheritance, Nobody, date precedence, per-section order and overnight display passed');

const nextPerson = { ...user, id: 'd', email: 'dovid@demo.test' };
const acrossDays = { ...sundayNight, days: sundayNight.days.map((d, w) => w === 0 ? { ...d, userId: 'u' } : w === 1 ? { ...d, userId: 'd' } : d), overrides: [] };
assert.deepEqual(tasksVisibleOnShift([variedTask], [acrossDays], nextPerson, '2026-11-09', 1, 60), [], 'Monday person cannot see Sunday overnight occurrence by shared shift ID');
const eleven = { ...atNine, id: 'eleven', targetTimeMinutes: 660 };
assert.deepEqual(tasksVisibleOnShift([variedTask, atNine, eleven], [varying], user, '2026-11-11', 3, 540).map((t) => t.id), ['deli', 'eleven']);

// One-time creation reuses the sheet and sends general hours/person plus the venue date.
const { shiftIsUpcoming } = await import('../../src/lib/shifts.ts');
assert.equal(shiftIsUpcoming(shift, '2026-11-09'), true);
assert.equal(shiftIsUpcoming({ ...shift, oneTimeDate: '2026-11-08' }, '2026-11-08'), true);
assert.equal(shiftIsUpcoming({ ...shift, oneTimeDate: '2026-11-08' }, '2026-11-09'), false);
const inline = mount(ShiftsPanel, { shifts: [shift], venueId: 'v', timeZone: 'America/New_York', people: [{ id: 'u', name: 'Moshe L.' }], createOnly: true, onChange: (s) => { changed = s; } });
await inline.render();
assert.equal(inline.find((e) => e.props['aria-label'] === 'Save for next weeks')[0].props['aria-checked'], true);
await inline.click((e) => e.props['aria-label'] === 'Save for next weeks');
assert.equal(inline.find((e) => e.props['aria-label'] === 'Week').length, 0);
const datedInput = inline.find((e) => e.type === 'input' && e.props.type === 'date')[0];
assert.ok(datedInput.props.value);
await inline.find((e) => e.type === 'input' && e.props.maxLength === 40)[0].props.onChange({ target: { value: 'Catering setup' } });
await inline.render();
let oneTimeBody;
globalThis.fetch = async (_url, options) => { oneTimeBody = JSON.parse(options.body); return new Response(JSON.stringify({ ...shift, ...oneTimeBody, id: 'once' }), { status: 201, headers: { 'Content-Type': 'application/json' } }); };
await inline.submit();
assert.equal(oneTimeBody.oneTimeDate, datedInput.props.value);
assert.deepEqual(oneTimeBody.overrides, []);
assert.equal(changed.id, 'once');
await form.render({ taskToEdit: null, shifts: [shift, { ...shift, id: 'past', name: 'Expired shift', oneTimeDate: '2000-01-01' }], venueId: 'v' });
await form.click((e) => e.props['aria-label'] === 'A shift');
assert.doesNotMatch(form.text(), /Expired shift/);
assert.ok(form.buttons().some((b) => b.label === '+ New'));
await form.click('+ New');
assert.ok(form.find((e) => e.props.role === 'dialog' && e.props['aria-label'] === 'New shift').length);
const child = (() => { const walk = (e) => { if (!e || typeof e !== 'object') return null; if (Array.isArray(e)) { for (const c of e) { const v = walk(c); if (v) return v; } return null; } if (e.type === ShiftsPanel) return e; return walk(e.props?.children); }; return walk(form.tree()); })();
assert.ok(child);
await child.props.onChange({ ...shift, id: 'newly-created', name: 'Catering setup', oneTimeDate: datedInput.props.value });
await form.render();
await form.find((e) => e.type === 'input' && e.props.required)[0].props.onChange({ target: { value: 'Set up catering' } });
await form.render();
await saveForm(form);
assert.equal(saved.shiftId, 'newly-created');
console.log('Shifts UI: one-time payload, expiry, shared sheet and automatic task selection passed');

assert.equal(saved.scheduleType, 'specific_dates');
assert.deepEqual(saved.specificDates, [datedInput.props.value]);
const expiredPanel = mount(ShiftsPanel, { shifts: [{ ...shift, name: 'Past one-time', oneTimeDate: '2000-01-01' }, { ...shift, id: 'future', name: 'Future one-time', oneTimeDate: '2099-01-01' }], venueId: 'v', timeZone: 'America/New_York', people: [], onChange: noop });
await expiredPanel.render();
assert.doesNotMatch(expiredPanel.text(), /Past one-time/);
assert.match(expiredPanel.text(), /One-time.*Future one-time/);

// Existing saved and one-time shifts cannot change kind; new shifts can.
const namedWeek = { ...shift, days: shift.days.map((d, w) => w === 1 ? { ...d, userId: 'd' } : w === 3 ? { ...d, userId: null } : d), dayUserNames: [null, 'Dovid R.', null, null, null, null, null] };
const reviewPanel = mount(ShiftsPanel, { shifts: [namedWeek], venueId: 'v', timeZone: 'America/New_York', people: [], onChange: noop });
await reviewPanel.render();
assert.match(reviewPanel.text(), /Mon: Dovid R\. · Wed: Nobody/);
const peopleLine = reviewPanel.find((e) => e.type === 'span' && e.props.title === 'Mon: Dovid R. · Wed: Nobody')[0];
assert.ok(peopleLine.props.className.includes('truncate'));
await reviewPanel.click('Deli day');
assert.equal(reviewPanel.find((e) => e.props['aria-label'] === 'Save for next weeks')[0].props.disabled, true);
assert.match(reviewPanel.text(), /Can't change after the shift is created\./);
await reviewPanel.click((e) => e.props['aria-label'] === 'Close');
await reviewPanel.click('+ New shift');
assert.equal(reviewPanel.find((e) => e.props['aria-label'] === 'Save for next weeks')[0].props.disabled, false);
assert.doesNotMatch(reviewPanel.text(), /Can't change after the shift is created/);
const oncePanel = mount(ShiftsPanel, { shifts: [{ ...namedWeek, oneTimeDate: '2099-01-01' }], venueId: 'v', timeZone: 'America/New_York', people: [], onChange: noop });
await oncePanel.render();
assert.doesNotMatch(oncePanel.text(), /Mon: Dovid/);
await oncePanel.click('Deli day');
const kindToggle = oncePanel.find((e) => e.props['aria-label'] === 'Save for next weeks')[0];
assert.equal(kindToggle.props.disabled, true);
assert.equal(kindToggle.props['aria-checked'], false);
console.log('Shifts UI: immutable kind and compact weekday-person summary passed');

const { shiftAssigneeLabel } = await import('../../src/lib/shiftTaskDay.ts');
assert.equal(shiftAssigneeLabel(shift, false, '2026-11-08', 0, 600), 'Deli day shift');
assert.equal(shiftAssigneeLabel(shift, true, '2026-11-08', 0, 600), 'Deli day · today: Moshe L.');
assert.equal(shiftAssigneeLabel(namedWeek, true, '2026-11-09', 1, 600), 'Deli day · today: Dovid R.');
assert.equal(shiftAssigneeLabel(namedWeek, true, '2026-11-11', 3, 600), 'Deli day · today: Nobody');
assert.equal(shiftAssigneeLabel({ ...shift, overrides: [{ date: '2026-11-08', userId: 'd', userName: 'Dovid R.' }] }, true, '2026-11-08', 0, 600), 'Deli day · today: Dovid R.');
assert.equal(shiftAssigneeLabel(shift, true, '2026-11-14', 6, 600), 'Deli day shift');
try {
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-08T15:00:00Z'])); }
    static now() { return new RealDate('2026-11-08T15:00:00Z').getTime(); }
  };
  for (const View of [TaskCardView, TaskTableView]) {
    const view = mount(View, { tasks: [{ ...baseTask, shiftId: shift.id }], shiftsById: new Map([[shift.id, shift]]), currentUser: user, timeZone: 'America/New_York', onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop });
    await view.render();
    assert.match(view.html(), /Because you&#x27;re on Deli day/);
    assert.doesNotMatch(view.html(), /Team Roster|Assigned: Team/);
    await view.render({ currentUser: { ...user, role: 'coordinator' } });
    assert.match(view.html(), /Deli day shift · today: Moshe L\./);
    await view.render({ isKiosk: true });
    assert.match(view.html(), /Deli day shift/);
    assert.doesNotMatch(view.html(), /today: Moshe/);
    await view.render({ tasks: [baseTask] });
    assert.match(view.html(), /Assigned to everyone/);
  }
} finally { globalThis.Date = RealDate; }
console.log('Shifts UI: shift assignees, weekday/date names, Nobody, kiosk and ordinary team fallback passed');

// RV5: names must belong to the occurrence's resolved ID, including overnight.
const rivkaOverride = { ...shift, days: shift.days.map((d) => ({ ...d, userId: shift.userId })), dayUserNames: Array(7).fill('Moshe L.'), overrides: [{ date: '2026-11-09', userId: 'rivka', userName: 'Rivka Cohen' }] };
assert.equal(shiftAssigneeLabel(rivkaOverride, true, '2026-11-09', 1, 60), 'Deli day · today: Rivka Cohen');
const unnamedOverride = { ...rivkaOverride, overrides: [{ date: '2026-11-09', userId: 'rivka' }] };
assert.equal(shiftAssigneeLabel(unnamedOverride, true, '2026-11-09', 1, 60, [{ id: 'rivka', name: 'Rivka Cohen' }]), 'Deli day · today: Rivka Cohen');
assert.equal(shiftAssigneeLabel(unnamedOverride, true, '2026-11-09', 1, 60), 'Deli day · today: someone else');
const overnightPeople = { ...shift, days: Array.from({ length: 7 }, (_, w) => w === 0 ? { on: true, userId: 'u', startMinutes: 1320, endMinutes: 120 } : w === 1 ? { on: true, userId: 'rivka', startMinutes: 480, endMinutes: 960 } : { on: false }), dayUserNames: ['Moshe Levin', 'Rivka Cohen', null, null, null, null, null], overrides: [] };
assert.equal(shiftAssigneeLabel(overnightPeople, true, '2026-11-09', 1, 60), 'Deli day · today: Moshe Levin');
const mondayOff = { ...overnightPeople, days: overnightPeople.days.map((d, w) => w === 1 ? { on: false } : d) };
assert.equal(shiftAssigneeLabel(mondayOff, true, '2026-11-09', 1, 60), 'Deli day · today: Moshe Levin');
assert.equal(shiftAssigneeLabel(mondayOff, true, '2026-11-10', 2, 600), 'Deli day shift');
assert.equal(shiftAssigneeLabel({ ...mondayOff, overrides: [{ date: '2026-11-08', userId: null }] }, true, '2026-11-09', 1, 60), 'Deli day · today: Nobody');
try {
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-09T06:00:00Z'])); }
    static now() { return new RealDate('2026-11-09T06:00:00Z').getTime(); }
  };
  for (const View of [TaskCardView, TaskTableView]) {
    const view = mount(View, { tasks: [{ ...baseTask, shiftId: shift.id }], shiftsById: new Map([[shift.id, overnightPeople]]), currentUser: { ...user, role: 'coordinator' }, timeZone: 'America/New_York', onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop });
    await view.render();
    assert.match(view.html(), /Deli day shift · today: Moshe Levin/);
    assert.doesNotMatch(view.html(), /today: Rivka/);
    await view.render({ shiftsById: new Map([[shift.id, mondayOff]]) });
    assert.match(view.html(), /Deli day shift · today: Moshe Levin/);
    await view.render({ shiftsById: new Map([[shift.id, unnamedOverride]]), roster: [{ id: 'rivka', name: 'Rivka Cohen' }] });
    assert.match(view.html(), /Deli day shift · today: Rivka Cohen/);
    assert.doesNotMatch(view.html(), /today: Moshe/);
  }
} finally { globalThis.Date = RealDate; }
console.log('Shifts UI: RV5 occurrence person, ID-bound names, roster and unknown-person fallback passed');
} finally { globalThis.Date = HostDate; }
