import assert from 'node:assert/strict';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { TaskTableView } from '../../src/components/TaskTableView.tsx';
import { taskWithShiftTimes, shiftLabel, shiftTaskOverdueAt, tasksVisibleOnShift } from '../../src/lib/shifts.ts';
import { shiftSortProjection } from '../../src/lib/shiftTaskDay.ts';
import { sortTasksByTime } from '../../src/lib/taskDay.ts';
const noop = () => {};
const shift = { id: 'deli', venueId: 'v', name: 'Deli day', area: '', days: Array.from({ length: 7 }, (_, w) => ({ on: w === 0 })), startMinutes: 480, endMinutes: 1080, userId: 'moshe', overrides: [], createdAt: '' };
const byId = new Map([[shift.id, shift]]);
const own = { id: 'own', venueId: 'v', shiftId: shift.id, shiftTime: true, title: 'Deli temperature log', targetTime: '2:00 PM', targetTimeMinutes: 840, assignedTo: ['all'], daysOfWeek: [1], scheduleType: 'recurring', currentStatus: 'pending', isCompleted: false, notes: '', category: 'General', inputType: 'checkbox', createdAt: '' };
const effective = taskWithShiftTimes(own, byId);
assert.deepEqual(effective.daysOfWeek, [0]);
assert.equal(effective.targetTimeMinutes, 840);
assert.equal(effective.targetTime2, undefined);
assert.equal(shiftLabel(shift, 0, own), 'Deli day · 2:00 PM');
const twice = { ...own, targetTime2: '3:00 PM', targetTime2Minutes: 900 };
assert.equal(taskWithShiftTimes(twice, byId).targetTime2Minutes, 900);
assert.equal(shiftLabel(shift, 0, twice), 'Deli day · 2:00 PM · 3:00 PM');
const once = { ...shift, oneTimeDate: '2026-11-08' };
const dated = taskWithShiftTimes(own, new Map([[shift.id, once]]));
assert.deepEqual(dated.specificDates, ['2026-11-08']);
assert.equal(dated.scheduleType, 'specific_dates');
assert.equal(dated.targetTimeMinutes, 840);
const fallback = taskWithShiftTimes({ ...own, shiftTime: false }, byId);
assert.equal(fallback.targetTimeMinutes, 480);
assert.equal(fallback.targetTime2Minutes, 1080);
const noon = { ...own, id: 'noon', shiftId: null, shiftTime: false, targetTime: '12:00 PM', targetTimeMinutes: 720 };
assert.deepEqual(sortTasksByTime(shiftSortProjection([own, noon], byId)).map((t) => t.id), ['noon', 'own']);
// Both own times participate in normal ordering.
assert.equal(shiftSortProjection([twice], byId)[0].targetTime2Minutes, 900);
const other = { ...shift, id: 'kitchen', userId: 'dovid' };
for (const minute of [420, 900, 1200]) {
  assert.equal(tasksVisibleOnShift([own], [shift, other], { id: 'moshe', email: 'moshe@test.local' }, '2026-11-08', 0, minute).length, 1);
  assert.equal(tasksVisibleOnShift([own], [shift, other], { id: 'dovid', email: 'dovid@test.local' }, '2026-11-08', 0, minute).length, 0);
}
assert.equal(shiftTaskOverdueAt(shift, '2026-11-08', 0, 840, own), false);
assert.equal(shiftTaskOverdueAt(shift, '2026-11-08', 0, 841, own), true);
assert.equal(shiftTaskOverdueAt(shift, '2026-11-09', 1, 1000, own), false);
assert.equal(shiftTaskOverdueAt(once, '2026-11-15', 0, 1000, own), false);
assert.equal(shiftTaskOverdueAt(shift, '2026-11-08', 0, 841, fallback), false);
assert.equal(shiftTaskOverdueAt(shift, '2026-11-08', 0, 1081, fallback), true);

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
recordFetch({});
let saved;
const form = mount(TaskModal, { isOpen: true, onClose: noop, onSave: (t) => { saved = t; return false; }, knownWorkers: [], shifts: [shift], timeZone: 'UTC' });
await form.render();
await form.click((e) => e.props.children === 'Shift');
assert.ok(form.buttons().some((b) => b.label === '+ Add time'));
await form.click('+ Add time');
assert.ok(form.buttons().some((b) => b.el.props['aria-label'] === 'Remove time'));
await form.click('🌤️ Afternoon');
await form.find((e) => e.props.id === 'task-title-input')[0].props.onChange({ target: { value: own.title } });
await form.render();
await form.submit();
assert.equal(saved.shiftTime, true);
assert.equal(saved.targetTimeMinutes, 900);
await form.click('+ Second time');
await form.submit();
assert.equal(saved.targetTime2Minutes, 900);
await form.click((e) => e.props['aria-label'] === 'Remove time');
await form.submit();
assert.equal(saved.shiftTime, false);
assert.equal(saved.targetTime, '');
assert.equal(saved.targetTime2, '');
await form.render({ taskToEdit: own });
assert.ok(form.buttons().some((b) => b.el.props['aria-label'] === 'Remove time'));
await form.submit();
assert.equal(saved.targetTimeMinutes, 840);
await form.click((e) => e.props.children === 'Time');
await form.submit();
assert.equal(saved.shiftId, null);
assert.equal(saved.shiftTime, false);
assert.equal(saved.targetTimeMinutes, 840);
await form.click((e) => e.props.children === 'Any time');
await form.click((e) => e.props.children === 'Shift');
await form.submit();
assert.equal(saved.shiftTime, true);
assert.equal(saved.targetTimeMinutes, 840);

const RealDate = Date;
try {
  for (const [at, overdue] of [['2026-11-08T14:00:00Z', false], ['2026-11-08T14:01:00Z', true], ['2026-11-09T15:00:00Z', false]]) {
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return new RealDate(at).getTime(); } };
    for (const View of [TaskCardView, TaskTableView]) {
      const view = mount(View, { tasks: [effective], shiftsById: byId, currentUser: { id: 'moshe', email: 'moshe@test.local', role: 'mashgiach' }, timeZone: 'UTC', onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop });
      await view.render();
      assert.match(view.text(), /Deli day · 2:00 PM/);
      assert.equal(view.html().includes('data-overdue'), overdue, `${View.name} ${at}`);
      await view.render({ tasks: [{ ...effective, isCompleted: true }] });
      assert.equal(view.html().includes('data-overdue'), false);
    }
  }
} finally { globalThis.Date = RealDate; }
console.log('SHIFTTIME: own-time projection, schedule, sorting, labels, visibility, overdue and shared form passed');
