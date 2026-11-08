import assert from 'node:assert/strict';
import React from 'react';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { MashgiachBoard } from '../../src/components/MashgiachBoard.tsx';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { TaskChecklist } from '../../src/components/TaskChecklist.tsx';
import { mashgiachProgress, mashgiachHeader, usesMashgiachBoard } from '../../src/lib/mashgiachBoard.ts';
const task = { id: 't', title: 'Check sink', description: 'Wash carefully', category: 'General', inputType: 'checkbox', assignedTo: ['all'], daysOfWeek: [], currentStatus: 'pending', isCompleted: false, notes: '', targetTime: '' };
const make = (id, targetTime, isCompleted = false) => ({ ...task, id, targetTime, isCompleted });
const list = [make('none', ''), make('later', '5:00 PM'), make('early', '8:00 AM'), make('late', '10:00 AM'), make('tie', '8:00 AM')];
assert.deepEqual(mashgiachProgress(list, (t) => t.id === 'late').open.map((t) => t.id), ['late', 'early', 'tie', 'later', 'none']);
const six = Array.from({ length: 6 }, (_, i) => make(String(i), '', i < 3));
assert.equal(mashgiachProgress(six, () => false).completed, 3);
const shift = { id: 's', name: 'Evening', startMinutes: 960, endMinutes: 1380, days: Array.from({ length: 7 }, () => ({ on: true })), userIds: ['u'], overrides: [] };
assert.equal(mashgiachHeader([], 'u', '2026-11-08', 0, 1000).title, 'Your tasks today');
assert.equal(mashgiachHeader([shift], 'u', '2026-11-08', 0, 1000).title, 'Your evening shift');
assert.equal(mashgiachHeader([shift], 'u', '2026-11-08', 0, 800).title, 'Your evening shift');
assert.equal(mashgiachHeader([shift], 'u', '2026-11-08', 0, 1400).title, 'Your tasks today');
assert.equal(mashgiachHeader([shift, { ...shift, name: 'Next', startMinutes: 1100 }], 'u', '2026-11-08', 0, 1000).title, 'Your evening shift');
for (const role of ['admin', 'coordinator', 'owner', 'worker']) assert.equal(usesMashgiachBoard({ role }, false, 'today'), false);
assert.equal(usesMashgiachBoard({ role: 'mashgiach' }, true, 'today'), false);
assert.equal(usesMashgiachBoard({ role: 'mashgiach' }, false, 'all'), false);
assert.equal(usesMashgiachBoard({ role: 'mashgiach' }, false, 'today'), true);
const calls = [];
const props = { tasks: six, currentUser: { id: 'u', name: 'User', email: 'u@test', role: 'mashgiach' }, timeZone: 'UTC', onUpdateStatus: (...a) => calls.push(a), onCheckIn: (...a) => calls.push(a), onChecklistUpdated: (...a) => calls.push(a), onUpdateNotes() {}, onEditTask() {}, onDeleteTask() {} };
const view = mount(MashgiachBoard, props); await view.render();
assert.match(view.text(), /3 of 6 done/);
assert.equal(view.find((e) => e.props['aria-controls'] === 'mboard-done')[0].props['aria-expanded'], false);
assert.equal(view.find((e) => e.props.id === 'mboard-done')[0].props.hidden, true);
assert.match(view.text(), /Done today · 3/);
await view.click('Done today'); assert.equal(view.find((e) => e.props.id === 'mboard-done')[0].props.hidden, false);
await view.render({ tasks: [] }); assert.equal(view.text(), 'Nothing for you today');
await view.render({ tasks: six.slice(0, 3) }); assert.match(view.text(), /All done for today/); assert.doesNotMatch(view.text(), /Do this next/);
function* walk(node) { if (Array.isArray(node)) { for (const n of node) yield* walk(n); } else if (React.isValidElement(node)) { yield node; yield* walk(node.props.children); } }
for (const [type, label, expected] of [
  ['checkbox', 'Tap when done', ['t', 'completed', true]],
  ['toggle', '', ['t', 'completed', true]],
  ['check_in', 'Log check', ['t']],
  ['yes_no', 'Yes', ['t', 'yes', true]],
  ['yes_no', 'No', ['t', 'no', false]],
  ['status_select', 'Ready', ['t', 'Ready', true]],
  ['status_select', 'Waiting', ['t', 'Waiting', false]],
]) {
  await view.render({ tasks: [{ ...task, inputType: type, customStatusOptions: ['Ready', 'Waiting'], completedStatusValues: ['Ready'] }] });
  const card = [...walk(view.tree())].find((e) => e.type === TaskCardView);
  assert.equal(card.props.focused, true);
  const control = mount(TaskCardView, card.props); await control.render();
  if (type === 'toggle') await control.click((e) => e.props.id === 'mobile-task-toggle-t');
  else await control.click(label);
  assert.deepEqual(calls.at(-1), expected);
}
await view.render({ tasks: [{ ...task, inputType: 'checklist', checklistItems: ['Sink', 'Oven'] }] });
const card = [...walk(view.tree())].find((e) => e.type === TaskCardView);
const control = mount(TaskCardView, card.props); await control.render();
const checklist = [...walk(control.tree())].find((e) => e.type === TaskChecklist);
assert.equal(checklist.props.onUpdated, props.onChecklistUpdated);
const updates = [];
const requests = recordFetch({ 'POST /api/tasks/t/checklist': { ...task, isCompleted: true } });
const ticks = mount(TaskChecklist, { ...checklist.props, onUpdated: (...args) => updates.push(args) }); await ticks.render(); await ticks.click('Sink');
assert.deepEqual(requests.at(-1), ['POST', '/api/tasks/t/checklist', { item: 0, ticked: true }]);
assert.equal(updates[0][0].isCompleted, true);
for (const options of [{ currentUser: { ...props.currentUser, role: 'admin' } }, { isKiosk: true }]) {
  const old = mount(TaskCardView, { ...props, tasks: [task], ...options }); await old.render();
  assert.doesNotMatch(old.text(), /Do this next|Tap when done/); assert.match(old.text(), /Sign & Complete Inspection/);
}
const checkView = mount(TaskCardView, { ...props, focused: true, tasks: [{ ...task, inputType: 'check_in', checkIns: [{ id: 'old', at: '2020-01-01T12:00:00Z' }, { id: 'new', at: new Date().toISOString() }] }] });
await checkView.render(); assert.match(checkView.text(), /1 today · last/);
assert.doesNotMatch(checkView.text(), /checks logged|last by/);
console.log('mboard: ordering, progress, header, folding, empty states, handler parity and old views passed');
