import assert from 'node:assert/strict';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { ShiftsPanel } from '../../src/components/ShiftsPanel.tsx';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { getPhoneNavState, PhoneNav } from '../../src/components/PhoneNav.tsx';
import { sheetAllowed } from '../../src/lib/screenMemory.ts';
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
const shift = { id: 's', venueId: 'v', name: 'Deli day', area: 'Deli', daysOfWeek: [0, 1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 1080, userId: 'u', userName: 'Moshe L.', overrides: [], createdAt: '' };
const noop = () => {};
let saved;
recordFetch({});
const form = mount(TaskModal, { isOpen: true, onClose: noop, onSave: (t) => { saved = t; }, knownWorkers: [{ id: 'u', name: 'Moshe L.' }], shifts: [shift], timeZone: 'America/New_York' });
await form.render();
await form.click((e) => e.props.children === 'Shift');
assert.match(form.text(), /Goes to whoever is on Deli day that day \(usually Moshe L\.\)/);
const title = form.find((e) => e.type === 'input' && e.props.required)[0];
assert.ok(title);
await title.props.onChange({ target: { value: 'Check deli' } });
await form.render();
await form.submit();
assert.equal(saved.shiftId, 's');
assert.deepEqual(saved.assignedTo, ['all']);
assert.equal(saved.scheduleType, 'recurring');
assert.equal(saved.targetTime, '');
assert.equal(saved.targetTime2, '');
assert.equal(saved.isPrivate, false);
await form.render({ taskToEdit: { ...saved, id: 't', shiftId: 's' } });
assert.equal(form.buttons().find((b) => b.label === 'Shift').el.props['aria-pressed'], true);
await form.render({ shifts: [] });
assert.equal(form.buttons().some((b) => b.label === 'Shift'), false);
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
const daytime = { ...shift, daysOfWeek: [0], endMinutes: 960 };
const night = { ...shift, id: 'night', userId: 'usual-person', daysOfWeek: [0], startMinutes: 1320, endMinutes: 360, overrides: [{ date: '2026-11-08', userId: 'u' }] };
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
