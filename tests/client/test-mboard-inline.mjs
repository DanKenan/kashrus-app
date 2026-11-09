import assert from 'node:assert/strict';
import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
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
    const chevron = () => [...walk(title())].find((e) => e.type === ChevronDown);
    assert.equal(!!chevron(), inputType === 'checklist');
    assert.equal([...walk(title())].some((e) => e.type === ChevronRight), false);
    if (chevron()) assert.doesNotMatch(chevron().props.className, /rotate-180|rtl:/);
    assert.ok(title()); assert.equal(title().props['aria-expanded'], false);
    if (inputType === 'checklist') assert.match(view.text(), /Open/);
    else assert.doesNotMatch(view.text(), /Open/);
    assert.equal(title().props['aria-label'], `Open ${task.title}`);
    assert.equal(title().props['aria-controls'], 'mboard-task-later');
    for (const button of view.find((e) => e.type === 'button')) assert.equal([...walk(button.props.children)].some((e) => e.type === 'button'), false);
    const button = (label) => view.buttons().find((b) => b.label === label).el;
    const clickLabel = (label) => view.click((e) => e === view.buttons().find((b) => b.label === label)?.el);
    if (inputType === 'checkbox' || inputType === 'toggle') {
      assert.equal(button('Done').props['aria-label'], `Mark ${task.title} done`);
      await clickLabel('Done'); assert.deepEqual(calls.pop(), ['later', 'completed', true]);
    } else if (inputType === 'check_in') {
      assert.equal(button('Check in').props['aria-label'], `Check in: ${task.title}`);
      await clickLabel('Check in'); assert.deepEqual(calls.pop(), ['later']);
    } else if (inputType === 'yes_no') {
      assert.equal(button('Yes').props['aria-label'], `Answer Yes: ${task.title}`);
      assert.equal(button('No').props['aria-label'], `Answer No: ${task.title}`);
      await clickLabel('Yes'); assert.deepEqual(calls.pop(), ['later', 'yes', true]);
      await view.render({ tasks: [first, Object.assign(later, { currentStatus: 'no' })] });
      assert.equal(view.buttons().find((b) => b.label === 'No').el.props['aria-pressed'], true);
      assert.equal(button('No').props['aria-label'], `Clear answer No: ${task.title}`);
      assert.match(button('No').props.className, /aria-\[pressed=true\]:bg-sunken/);
      assert.match(button('No').props.className, /aria-\[pressed=true\]:border-ink/);
      assert.doesNotMatch(button('No').props.className, /bad|red/);
      await clickLabel('No'); assert.deepEqual(calls.pop(), ['later', 'pending', false]);
      later.currentStatus = 'pending'; await view.render();
      await clickLabel('No'); assert.deepEqual(calls.pop(), ['later', 'no', false]);
      // A confirmed Yes leaves Later on the next render. Exercise the captured
      // handler before that render too, to check the card's exact undo branch.
      later.currentStatus = 'yes'; await view.render();
      assert.equal(view.buttons().find((b) => b.label === 'Yes').el.props['aria-pressed'], true);
      assert.equal(button('Yes').props['aria-label'], `Answer Yes: ${task.title}`);
      later.isCompleted = true;
      // Progress excludes completed tasks; expose completion after its filters
      // to exercise the same transient undo branch as the captured handler.
      let reads = 0;
      const completedYes = { ...later, get isCompleted() { return ++reads > 2; } };
      // mount settles twice, so reset the getter before each board invocation.
      const undoOnce = mount((p) => { reads = 0; return MashgiachBoard(p); }, { ...props, tasks: [first, completedYes] });
      await undoOnce.render();
      assert.equal(undoOnce.buttons().find((b) => b.label === 'Yes').el.props['aria-label'], `Clear answer Yes: ${task.title}`);
      await clickLabel('Yes'); assert.deepEqual(calls.pop(), ['later', 'pending', false]);
      later.isCompleted = false; await view.render();
    } else assert.equal(view.buttons().filter((b) => ['Done', 'Check in', 'Yes', 'No'].includes(b.label)).length, 0);
    assert.equal(title().props['aria-expanded'], false);
    await view.click((e) => e === title());
    assert.equal(title().props['aria-expanded'], true);
    if (chevron()) assert.match(chevron().props.className, /(?:^| )rotate-180(?: |$)/);
    if (chevron()) assert.doesNotMatch(chevron().props.className, /rtl:/);
    assert.equal(view.find((e) => e.props.id === title().props['aria-controls']).length, 1);
    await view.click((e) => e === title());
    assert.equal(title().props['aria-expanded'], false);
    if (chevron()) assert.doesNotMatch(chevron().props.className, /rotate-180/);
    await view.click((e) => e === title());
    assert.equal(title().props['aria-controls'], 'mboard-task-later');
    assert.equal(view.find((e) => e.props.id === title().props['aria-controls']).length, 1);
    assert.ok([...walk(view.tree())].some((e) => e.type === TaskCardView && e.props.tasks[0].id === 'later'));
    await view.render({ currentUser: { ...user, permissions: { canFillTasks: false } } });
    assert.equal(view.buttons().filter((b) => ['Done', 'Check in', 'Yes', 'No'].includes(b.label)).length, 0);
    assert.equal(view.find((e) => e.type === 'select').length, 0);
    if (inputType === 'checklist') assert.match(view.text(), /Open/);
    else assert.doesNotMatch(view.text(), /Open/);
  }
  for (const settings of [
    { currentStatus: 'Pending', options: ['Pending', 'In Progress', 'Blocked', 'Completed'], done: 'Completed', open: 'Pending' },
    { currentStatus: 'Ready', customStatusOptions: ['Ready', 'Completed'], completedStatusValues: ['Ready'], options: ['Ready', 'Completed'], done: 'Ready', open: 'Completed' },
    { currentStatus: 'Review', customStatusOptions: ['Review', 'APPROVED'], completedStatusValues: [], options: ['Review', 'APPROVED'], done: 'APPROVED', open: 'Review' },
  ]) {
    const calls = [];
    const statusTask = { ...task, ...settings, inputType: 'status_select' };
    const props = { tasks: [first, statusTask], currentUser: user, timeZone: 'UTC', onUpdateStatus: (...args) => calls.push(args), onCheckIn() {}, onUpdateNotes() {}, onEditTask() {}, onDeleteTask() {} };
    const view = mount(MashgiachBoard, props); await view.render();
    const select = () => view.find((e) => e.type === 'select')[0];
    assert.equal(select().props['aria-label'], `Status: ${task.title}`);
    assert.equal(select().props.value, '');
    assert.match(select().props.className, /min-h-\[46px\]/);
    assert.match(select().props.className, /w-full/);
    const options = [...walk(select())].filter((e) => e.type === 'option');
    assert.equal(options[0].props.value, ''); assert.equal(options[0].props.disabled, true);
    assert.equal(options[0].props.children, 'Pick status');
    assert.deepEqual(options.slice(1).map((e) => e.props.value), settings.options);
    const card = mount(TaskCardView, { ...props, tasks: [statusTask], focused: false }); await card.render();
    const cardSelect = [...walk(card.tree())].find((e) => e.props.id === 'mobile-task-select-later');
    for (const value of [settings.options[0], settings.done, settings.open]) {
      select().props.onChange({ target: { value } });
      const inlineCall = calls.pop();
      cardSelect.props.onChange({ target: { value } });
      assert.deepEqual(inlineCall, calls.pop());
      assert.deepEqual(inlineCall, ['later', value, value === settings.done]);
    }
    for (const attribution of [{ updatedByEmail: 'u@test' }, { updatedByName: 'Don' }]) {
      await view.render({ tasks: [first, { ...statusTask, ...attribution }] });
      assert.equal(select().props.value, settings.currentStatus);
    }
    assert.doesNotMatch(view.text(), /Open/);
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
