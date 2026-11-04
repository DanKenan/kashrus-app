import assert from 'node:assert/strict';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { TaskTableView } from '../../src/components/TaskTableView.tsx';
import { taskWithShiftTimes, shiftOwnTimeOverdueDay, shiftLabel, shiftTaskOverdueAt, tasksVisibleOnShift } from '../../src/lib/shifts.ts';
import { shiftSortProjection, restoreShiftWindows } from '../../src/lib/shiftTaskDay.ts';
import { sortTasksByTime } from '../../src/lib/taskDay.ts';
const noop = () => {};
const saveForm = async (view) => {
  if (view.find((e) => e.props['aria-label'] === 'Go to Who').length) await view.click('Go to Who');
  for (let i = 0; i < 2 && view.find((e) => e.props['data-task-form-current-step'])[0]?.props['data-task-form-current-step'] !== 'Who'; i++) await view.submit();
  if (view.find((e) => e.props.id === 'save-task-submit-btn')[0].props.disabled) await view.click((e) => e.props['aria-label'] === 'Everyone at the venue');
  await view.submit();
};
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
const form = mount(TaskModal, { isOpen: true, onClose: noop, onSave: (t) => { saved = t; return false; }, knownWorkers: [], venueId: 'v', shifts: [shift], timeZone: 'UTC' });
await form.render();
await form.click((e) => e.props['aria-label'] === 'A shift');
assert.ok(form.buttons().some((b) => b.el.props['aria-label'] === 'By a set time'));
await form.click('By a set time');
assert.ok(form.buttons().some((b) => b.el.props['aria-label'] === 'Any time during the shift'));
const clock = form.tree();
// The clock is a child component; select its hour through the rendered element.
const findClock = (e) => !e || typeof e !== 'object' ? null : Array.isArray(e) ? e.map(findClock).find(Boolean) : e.props?.value?.ampm ? e : findClock(e.props?.children);
findClock(clock).props.onChange({ hour: 3, minute: 0, ampm: 'PM' });
await form.render();
await form.find((e) => e.props.id === 'task-title-input')[0].props.onChange({ target: { value: own.title } });
await form.render();
await saveForm(form);
assert.equal(saved.shiftTime, true);
assert.equal(saved.targetTimeMinutes, 900);
await form.click('+ Second time');
await saveForm(form);
assert.equal(saved.targetTime2Minutes, 900);
await form.click('Any time during the shift');
await saveForm(form);
assert.equal(saved.shiftTime, false);
assert.equal(saved.targetTime, '');
assert.equal(saved.targetTime2, '');
await form.render({ taskToEdit: own });
assert.ok(form.buttons().some((b) => b.el.props['aria-label'] === 'Any time during the shift'));
await saveForm(form);
assert.equal(saved.targetTimeMinutes, 840);
await form.click((e) => e.props['aria-label'] === 'A time');
await saveForm(form);
assert.equal(saved.shiftId, null);
assert.equal(saved.shiftTime, false);
assert.equal(saved.targetTimeMinutes, 840);
await form.click((e) => e.props['aria-label'] === 'Any time');
await form.click((e) => e.props['aria-label'] === 'A shift');
await saveForm(form);
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

// Overnight own times belong to the start-date occurrence, including its morning.
const night = { ...shift, startMinutes: 1320, endMinutes: 120, userIds: ['moshe', 'yossi'] };
const late = { ...own, id: 'late', targetTime: '11:30 PM', targetTimeMinutes: 1410 };
const early = { ...own, id: 'early', targetTime: '1:00 AM', targetTimeMinutes: 60 };
for (const [date, weekday, minute, lateDue, earlyDue] of [
  ['2026-11-08', 0, 1380, false, false], ['2026-11-08', 0, 1425, true, false],
  ['2026-11-09', 1, 30, true, false], ['2026-11-09', 1, 90, true, true],
  ['2026-11-09', 1, 120, true, true], ['2026-11-09', 1, 121, true, true],
  ['2026-11-09', 1, 720, true, true], ['2026-11-09', 1, 1320, false, false],
]) {
  for (const [task, due] of [[late, lateDue], [early, earlyDue]]) {
    assert.equal(shiftTaskOverdueAt(night, date, weekday, minute, task), due);
    assert.equal(shiftOwnTimeOverdueDay(night, date, weekday, minute, task), due ? '2026-11-08' : null);
    const at = `${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00Z`;
    try {
      globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return new RealDate(at).getTime(); } };
      for (const View of [TaskCardView, TaskTableView]) {
        const view = mount(View, { tasks: [task], shiftsById: new Map([[night.id, night]]), timeZone: 'UTC', currentUser: { id: 'moshe', role: 'mashgiach' }, onUpdateStatus: noop, onUpdateNotes: noop, onCheckIn: noop, onEditTask: noop, onDeleteTask: noop });
        await view.render();
        assert.equal(view.html().includes('data-overdue'), due, `${View.name} ${task.title} ${at}`);
      }
    } finally { globalThis.Date = RealDate; }
  }
}
const nightMap = new Map([[night.id, night]]);
const projected = sortTasksByTime(shiftSortProjection([early, late], nightMap, 0));
assert.deepEqual(projected.map((t) => t.id), ['late', 'early']);
assert.equal(restoreShiftWindows(projected, nightMap, 0)[1].targetTimeMinutes, 60);
assert.equal(shiftLabel(night, 0, early), 'Deli day · 1:00 AM (next day)');
console.log('Overnight own times: start-date deadlines, boundaries, ordering and clock restoration passed');

// A Monday occurrence supersedes Sunday at its start, not at midnight or Sunday’s end.
const consecutiveNights = { ...night, days: Array.from({ length: 7 }, (_, w) => ({ on: w < 2 })) };
assert.equal(shiftOwnTimeOverdueDay(consecutiveNights, '2026-11-09', 1, 121, early), '2026-11-08');
assert.equal(shiftOwnTimeOverdueDay(consecutiveNights, '2026-11-09', 1, 1380, early), null);
assert.equal(shiftOwnTimeOverdueDay(consecutiveNights, '2026-11-10', 2, 90, early), '2026-11-09');
