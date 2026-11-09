import assert from 'node:assert/strict';
import React from 'react';
import { mount } from './lib/mini-render.mjs';
import { MashgiachBoard } from '../../src/components/MashgiachBoard.tsx';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { mashgiachProgress, mashgiachTaskTimeKey, mashgiachCheckInCovered } from '../../src/lib/mashgiachBoard.ts';
import { shiftTaskOverdueAt } from '../../src/lib/shifts.ts';

const task = { id: 'later', title: 'A long task title that wraps on a narrow screen', category: 'General', inputType: 'checkbox', targetTime: '7:00 AM', assignedTo: ['all'], daysOfWeek: [], isCompleted: false, currentStatus: 'pending', notes: '' };
const first = { ...task, id: 'first', targetTime: '6:00 AM' };
const user = { id: 'u', role: 'mashgiach', email: 'u@test' };
function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); }
  else if (React.isValidElement(node)) { yield node; yield* walk(node.props.children); }
}
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-11-09T06:52:00Z'])); } };
try {
  for (const inputType of ['checkbox', 'toggle', 'check_in', 'yes_no', 'status_select', 'checklist']) {
    const calls = [];
    const later = { ...task, inputType };
    const props = { tasks: [first, later], currentUser: user, timeZone: 'UTC', onUpdateStatus: (...args) => calls.push(args), onCheckIn: (...args) => calls.push(args), onUpdateNotes() {}, onEditTask() {}, onDeleteTask() {} };
    const view = mount(MashgiachBoard, props); await view.render();
    const title = () => view.find((e) => e.type === 'button' && e.props['aria-expanded'] !== undefined && [...walk(e)].some((n) => n.props.children === task.title))[0];
    assert.ok(title()); assert.equal(title().props['aria-expanded'], false);
    assert.match(view.text(), /Open/);
    for (const button of view.find((e) => e.type === 'button')) assert.equal([...walk(button.props.children)].some((e) => e.type === 'button'), false);
    const clickLabel = (label) => view.click((e) => e === view.buttons().find((b) => b.label === label)?.el);
    if (inputType === 'checkbox' || inputType === 'toggle') {
      await clickLabel('Done'); assert.deepEqual(calls.pop(), ['later', 'completed', true]);
    } else if (inputType === 'check_in') {
      await clickLabel('Check in'); assert.deepEqual(calls.pop(), ['later']);
    } else if (inputType === 'yes_no') {
      await clickLabel('Yes'); assert.deepEqual(calls.pop(), ['later', 'yes', true]);
      await view.render({ tasks: [first, Object.assign(later, { currentStatus: 'no' })] });
      assert.equal(view.buttons().find((b) => b.label === 'No').el.props['aria-pressed'], true);
      await clickLabel('No'); assert.deepEqual(calls.pop(), ['later', 'pending', false]);
      later.currentStatus = 'pending'; await view.render();
      await clickLabel('No'); assert.deepEqual(calls.pop(), ['later', 'no', false]);
      // A confirmed Yes leaves Later on the next render. Exercise the captured
      // handler before that render too, to check the card's exact undo branch.
      later.currentStatus = 'yes'; await view.render();
      assert.equal(view.buttons().find((b) => b.label === 'Yes').el.props['aria-pressed'], true);
      later.isCompleted = true;
      await clickLabel('Yes'); assert.deepEqual(calls.pop(), ['later', 'pending', false]);
      later.isCompleted = false; await view.render();
    } else assert.equal(view.buttons().filter((b) => ['Done', 'Check in', 'Yes', 'No'].includes(b.label)).length, 0);
    assert.equal(title().props['aria-expanded'], false);
    await view.click((e) => e === title());
    assert.equal(title().props['aria-expanded'], true);
    assert.ok([...walk(view.tree())].some((e) => e.type === TaskCardView && e.props.tasks[0].id === 'later'));
    await view.render({ currentUser: { ...user, permissions: { canFillTasks: false } } });
    assert.equal(view.buttons().filter((b) => ['Done', 'Check in', 'Yes', 'No'].includes(b.label)).length, 0);
    assert.match(view.text(), /Open/);
  }
  // Compare the card handlers directly, including completed Yes undo (which
  // normally lives in Done today rather than Later).
  for (const [inputType, currentStatus, isCompleted, control, expected] of [
    ['checkbox', 'pending', false, 'check', ['later', 'completed', true]],
    ['toggle', 'pending', false, 'toggle', ['later', 'completed', true]],
    ['check_in', 'pending', false, 'checkin', ['later']],
    ['yes_no', 'pending', false, 'yes', ['later', 'yes', true]],
    ['yes_no', 'yes', true, 'yes', ['later', 'pending', false]],
    ['yes_no', 'yes', false, 'yes', ['later', 'yes', true]],
    ['yes_no', 'pending', false, 'no', ['later', 'no', false]],
    ['yes_no', 'no', false, 'no', ['later', 'pending', false]],
  ]) {
    const calls = [];
    const card = mount(TaskCardView, { tasks: [{ ...task, inputType, currentStatus, isCompleted }], currentUser: user, timeZone: 'UTC', focused: true,
      onUpdateStatus: (...args) => calls.push(args), onCheckIn: (...args) => calls.push(args), onUpdateNotes() {}, onEditTask() {}, onDeleteTask() {} });
    await card.render();
    const button = [...walk(card.tree())].find((e) => e.props.id === `mobile-task-${control}-later`);
    assert.ok(button); button.props.onClick(); assert.deepEqual(calls, [expected]);
  }
} finally { globalThis.Date = RealDate; }

const shift = { id: 'kitchen', name: 'Kitchen', startMinutes: 390, endMinutes: 870, days: Array.from({ length: 7 }, () => ({ on: true })), userIds: ['u'], overrides: [] };
// App's taskWithShiftTimes supplies the shift window for a task with no own time.
const fridge = { ...task, id: 'fridge', title: 'Check refrigerators', inputType: 'check_in', shiftId: shift.id, shiftTime: false, targetTime: '6:30 AM', targetTime2: '2:30 PM', checkIns: [] };
const later = { ...task, id: 'seven' };
const day = '2026-11-09', weekday = 1, minutes = 412;
const key = (t) => mashgiachTaskTimeKey(t, t.shiftId ? shift : undefined, day, weekday, minutes);
const covered = (t) => mashgiachCheckInCovered(t, t.shiftId ? shift : undefined, day, weekday, minutes, 'UTC');
const overdue = (t) => t.shiftId ? shiftTaskOverdueAt(shift, day, weekday, minutes, t, 'UTC') : false;
assert.equal(covered(fridge), false); assert.equal(overdue(fridge), false); assert.equal(key(fridge).minutes, 390);
assert.equal(mashgiachProgress([later, fridge], overdue, covered, key).next.id, 'fridge');
for (const [competitor, late] of [
  [{ ...task, id: 'overdue' }, true],
  [{ ...task, id: 'earlier', targetTime: '6:00 AM' }, false],
  [{ ...task, id: 'equal', targetTime: '6:30 AM' }, false],
]) {
  const board = mashgiachProgress([competitor, fridge, later], (t) => late && t === competitor, covered, key);
  assert.equal(board.next.id, competitor.id); assert.equal(board.later[0].id, 'fridge');
}
assert.equal(mashgiachProgress([fridge, { ...task, targetTime: '6:30 AM' }], overdue, covered, key).next.id, 'fridge');
console.log('mboard inline: actions, undo, permissions, expansion, sibling buttons and refrigerator ordering passed');
