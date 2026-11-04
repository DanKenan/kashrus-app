import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { ShiftHoursBar } from '../../src/components/ShiftHoursBar.tsx';
import { ShiftsPanel } from '../../src/components/ShiftsPanel.tsx';
import { venueShifts } from '../../src/lib/shifts.ts';
import { detectTimeShift, saveTaskBatch } from '../../src/lib/taskForm.ts';
import { canSeeTask } from '../../src/lib/permissions.ts';
import { taskIsForViewer } from '../../src/lib/taskDay.ts';
import { isMyTask } from '../../src/lib/myTasks.ts';
import { taskOccurrenceDate, taskOccursToday, tasksVisibleOnOccurrence, taskWithOccurrenceTimes } from '../../src/lib/taskOccurrences.ts';
import { whoSeesLabel } from '../../src/lib/whoSees.ts';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-03T18:00:00Z'])); }
  static now() { return new RealDate('2026-11-03T18:00:00Z').getTime(); }
};
const noop = () => {};
const people = [{ id: 'y', email: 'yossi@test', name: 'Yossi' }, { id: 'e', email: 'eli@test', name: 'Eli' }];
const shifts = venueShifts([], 'v');
const afternoon = { ...shifts.find((s) => s.name === 'Afternoon'), userIds: ['y'] };
const base = { id: 't', venueId: 'v', title: 'Check', description: '', category: 'General', categories: ['General'], inputType: 'yes_no', assignedTo: ['yossi@test'], scheduleType: 'recurring', daysOfWeek: [0,1,2,3,4,5,6], targetTime: '2:00 PM', targetTimeMinutes: 840 };
const make = async (props = {}) => { recordFetch({}); const view = mount(TaskModal, { isOpen: true, onClose: noop, onSave: noop, knownWorkers: people, venueId: 'v', shifts: [afternoon], timeZone: 'UTC', ...props }); await view.render(); return view; };
const change = async (view, predicate, value) => { const e = view.find(predicate)[0]; assert.ok(e); await e.props.onChange({ target: { value } }); await view.render(); };
const goWho = async (view) => { if (view.find((e) => e.props['aria-label'] === 'Go to Who').length) await view.click('Go to Who'); else { await view.submit(); await view.submit(); } };
const exact = (text) => (e) => e.props.children === text;

try {
  assert.equal(detectTimeShift(shifts, 60, 2)?.name, 'Night');
  assert.equal(detectTimeShift(shifts, 360, 2)?.name, 'Morning');
  assert.equal(detectTimeShift(shifts, 840, 2)?.name, 'Afternoon');
  assert.equal(detectTimeShift([afternoon], 60, 2), undefined);
  const view = await make();
  await view.type('task-title-input', 'Check kitchen');
  assert.equal(view.find((e) => e.props['aria-label'] === 'When')[0].props.hidden, true);
  await view.submit();
  assert.equal(view.find((e) => e.props['aria-label'] === 'Who')[0].props.hidden, true);
  await view.click('A shift');
  assert.match(view.text(), /usual for Afternoon/);
  await view.click('A time');
  assert.match(view.text(), /During the Afternoon shift/);
  await view.click('Back');
  assert.equal(view.find((e) => e.props['data-task-form-current-step'])[0].props['data-task-form-current-step'], 'What');

  let saved;
  const daily = await make({ onSave: (task) => { saved = task; return false; } });
  await daily.type('task-title-input', 'Check'); await goWho(daily);
  assert.doesNotMatch(daily.text(), /usual for Afternoon/);
  await daily.click((e) => e.type === 'button' && e.props.children?.[0]?.props?.children === 'Fri');
  await daily.click((e) => e.props['aria-label'] === 'Pick Yossi');
  await daily.click((e) => e.props['aria-label'] === 'Pick Eli');
  await daily.submit();
  assert.deepEqual(saved.dayAssignees, { '5': ['eli@test'] });
  assert.equal(saved.assignmentMode, 'task');
  const edit = await make({ taskToEdit: { ...base, assignmentMode: 'task' }, onSave: (t) => { saved = t; return false; } });
  await goWho(edit);
  await edit.click((e) => e.type === 'button' && e.props.children?.[0]?.props?.children === 'Fri');
  await edit.click('Just this Friday, Nov 6');
  await edit.click((e) => e.props['aria-label'] === 'Pick Yossi');
  await edit.click((e) => e.props['aria-label'] === 'Pick Eli');
  await edit.submit();
  assert.deepEqual(saved.assigneeSwaps, [{ date: '2026-11-06', assignedTo: ['eli@test'] }]);
  assert.equal(saved.dayAssignees, undefined);

  const legacy = await make({ taskToEdit: base, onSave: (t) => { saved = t; return false; } });
  await goWho(legacy); await legacy.submit();
  assert.deepEqual(saved, { id: 't', title: 'Check', description: '', category: 'General', categories: ['General'], shiftId: null, shiftTime: false, isPrivate: undefined, inputType: 'yes_no', customStatusOptions: undefined, completedStatusValues: undefined, targetTime: '2:00 PM', targetTimeMinutes: 840, targetTime2: '', targetTime2Minutes: null, priority: 'medium', enableOverdueAlert: false, assignedTo: ['yossi@test'], scheduleType: 'recurring', daysOfWeek: [0,1,2,3,4,5,6], specificDates: undefined });

  const taskOwned = { ...base, shiftId: afternoon.id, assignmentMode: 'task', dayAssignees: { '5': ['eli@test'] } };
  const unchangedOwned = await make({ taskToEdit: taskOwned, onSave: (t) => { saved = t; return false; } });
  await goWho(unchangedOwned); await unchangedOwned.submit();
  assert.deepEqual(saved.assignedTo, taskOwned.assignedTo);
  assert.deepEqual(saved.dayAssignees, taskOwned.dayAssignees);
  const legacyShift = await make({ taskToEdit: { ...base, shiftId: afternoon.id, shiftTime: false, assignedTo: ['all'] }, onSave: (t) => { saved = t; return false; } });
  await goWho(legacyShift); await legacyShift.submit();
  assert.equal(saved.assignmentMode, undefined); assert.equal(saved.dayAssignees, undefined); assert.equal(saved.assigneeSwaps, undefined);
  assert.deepEqual(saved.assignedTo, ['all']); assert.equal(saved.targetTime, '');

  const batch = await make({ onSaveMany: (tasks) => saveTaskBatch(tasks, 'v', 'owner@test').then((r) => r.ok) });
  await batch.type('task-title-input', 'One');
  await batch.click('Add another task'); await change(batch, (e) => e.props['aria-label'] === 'Task 2 name', 'Two');
  await batch.click('Add another task'); await change(batch, (e) => e.props['aria-label'] === 'Task 3 name', 'Three');
  await goWho(batch); assert.match(batch.text(), /Applies to all 3 tasks/);
  const calls = recordFetch({ 'POST /api/tasks': (_path, body) => body.tasks.map((t, i) => ({ ...t, id: String(i) })) });
  await batch.submit();
  assert.equal(calls.length, 1); assert.equal(calls[0][2].tasks.length, 3);
  assert.deepEqual(calls[0][2].tasks.map((t) => t.title), ['One', 'Two', 'Three']);
  assert.ok(calls[0][2].tasks.every((t) => t.assignmentMode === 'task'));

  let changed;
  const bar = mount(ShiftHoursBar, { shift: afternoon, onSaved: (s) => { changed = s; } }); await bar.render();
  const dragCalls = recordFetch({ 'PUT /api/shifts': (_path, body) => ({ ...afternoon, ...body }) });
  const range = () => bar.find((e) => e.props['aria-label'] === 'Shift start')[0];
  range().props.onPointerDown();
  for (const value of [870,900,930]) { range().props.onChange({ target: { value } }); await bar.render(); }
  assert.equal(dragCalls.length, 0);
  range().props.onPointerUp(); await bar.render(); await bar.render();
  assert.equal(dragCalls.length, 1); assert.equal(changed.startMinutes, 930);
  range().props.onBlur(); await bar.render(); assert.equal(dragCalls.length, 1);
  assert.equal(dragCalls[0][2].venueId, 'v');

  let failedWrites = 0;
  globalThis.fetch = async () => { failedWrites++; return new Response(JSON.stringify({ error: 'Try again' }), { status: 400 }); };
  range().props.onPointerDown(); range().props.onChange({ target: { value: 960 } }); await bar.render();
  range().props.onPointerUp(); await bar.render(); await bar.render();
  range().props.onBlur(); await bar.render();
  assert.equal(failedWrites, 1, 'a failed release is not silently retried by blur');

  const shiftPanel = mount(ShiftsPanel, { shifts: [], venueId: 'v', timeZone: 'UTC', people, onChange: noop });
  await shiftPanel.render(); assert.match(shiftPanel.text(), /Morning/); assert.match(shiftPanel.text(), /Afternoon/); assert.match(shiftPanel.text(), /Night/);
  await shiftPanel.click('Morning');
  const deleteCalls = recordFetch({ 'DELETE /api/shifts': {} });
  await shiftPanel.click('Delete shift');
  const confirmation = shiftPanel.tree().props.children.find((e) => e?.props?.title === 'Delete shift?');
  assert.equal(deleteCalls.length, 0); await confirmation.props.onConfirm(); await shiftPanel.render();
  assert.equal(deleteCalls.length, 1); assert.equal(deleteCalls[0][2].venueId, 'v');
  await shiftPanel.render({ shifts: [{ id: shifts.find((s) => s.name === 'Morning').id, venueId: 'v', deleted: true }] });
  assert.doesNotMatch(shiftPanel.text(), /Morning/, 'deleted built-in stays removed');

  const night = shifts.find((s) => s.name === 'Night');
  const task = { ...base, shiftId: night.id, assignmentMode: 'task', isPrivate: true, assignedTo: ['yossi@test'], dayAssignees: { '5': ['eli@test'] } };
  const byId = new Map([[night.id, night]]);
  const eli = { id: 'e', email: 'eli@test', role: 'mashgiach', venueId: 'v' };
  const composed = (date, weekday, minute, user, t = task) => {
    if (!canSeeTask(t, user, date, taskOccurrenceDate(t, byId, date, weekday, minute))) return [];
    if (!taskOccursToday(t, byId, date, weekday, minute)) return [];
    const occurrence = taskOccurrenceDate(t, byId, date, weekday, minute);
    return tasksVisibleOnOccurrence([t].filter((t) => taskIsForViewer(t, user.email, occurrence)), [night], user, date, weekday, minute).filter((t) => isMyTask(t, user, occurrence));
  };
  assert.equal(composed('2026-11-07',6,60,eli).length, 1);
  assert.equal(composed('2026-11-07',6,361,eli).length, 1, 'overdue tail retains Friday people');
  assert.equal(composed('2026-11-07',6,60,{ ...eli, email: 'yossi@test' }).length, 0);
  const swapTask = { ...task, dayAssignees: undefined, assigneeSwaps: [{ date: '2026-11-06', assignedTo: ['eli@test'] }] };
  assert.equal(canSeeTask(swapTask, eli, '2026-11-06'), true);
  assert.equal(canSeeTask(swapTask, eli, '2026-11-07'), false, 'past swaps no longer grant private visibility');
  assert.equal(composed('2026-11-07',6,60,eli,swapTask).length, 1, 'private replacement survives its Night continuation');
  assert.equal(taskIsForViewer(swapTask, 'yossi@test', '2026-11-13'), true, 'one-time replacement returns to usual');
  const label = whoSeesLabel(task, { mode: 'kiosk', shiftsById: byId, roster: people, todayYmd: '2026-11-07', todayWeekday: 6, nowMinutes: 60 });
  assert.equal(label.text, 'Private · Yossi · Fri: Eli');
  const ownSchedule = { ...task, daysOfWeek: [5] };
  assert.deepEqual(taskWithOccurrenceTimes(ownSchedule, byId).daysOfWeek, [5]);
  assert.equal(taskOccursToday(ownSchedule, byId, '2026-11-09',1,1400), false);
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  for (const needle of ['taskIsForViewer(task, currentUser?.email, taskOccurrenceDate(task))', 'isMyTask(t, currentUser, taskOccurrenceDate(t))', 'isMyTask(task, currentUser, taskOccurrenceDate(task))']) assert.ok(app.includes(needle));
  console.log('TASKFORM-B: steps, Night detection, day people, swap, legacy payload, one batch, one release save, private and occurrence filters, and tag passed');
} finally { globalThis.Date = RealDate; }
