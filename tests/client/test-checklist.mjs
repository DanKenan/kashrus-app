import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { TaskChecklist } from '../../src/components/TaskChecklist.tsx';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { KioskTaskPanel } from '../../src/components/KioskTaskPanel.tsx';
import { TaskTableView } from '../../src/components/TaskTableView.tsx';

const items = ['Sink', 'Oven', 'Seals'];
const task = { id: 't', title: 'Kitchen', description: '', category: 'General', inputType: 'checklist', checklistItems: items, checklistTicks: [], assignedTo: ['all'], targetTime: '', scheduleType: 'recurring', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isCompleted: false, currentStatus: 'pending', notes: '' };
const saves = [];
const view = mount(TaskModal, { isOpen: true, onClose() {}, onSave(p) { saves.push(p); return false; }, onSaveMany(ps) { saves.push(...ps); return false; }, knownWorkers: [], venueId: 'v' });
await view.render();
await view.type('task-title-input', 'Kitchen');
const radio = view.find((e) => e.type === 'input' && e.props.value === 'checklist')[0];
radio.props.onChange(); await view.render();
assert.equal(view.find((e) => e.props.value === 'checklist')[0].props.checked, true);
assert.ok(view.text().includes('Add at least 2 items'));
await view.submit(); assert.equal(saves.length, 0);
assert.equal(view.find((e) => e.props.id === 'save-task-submit-btn')[0].props.disabled, true);
await view.type('task-checklist-item', ' Sink ');
await view.click((e) => e.type === 'button' && e.props.children === 'Add');
await view.type('task-checklist-item', 'Oven');
let prevented = false;
view.find((e) => e.props.id === 'task-checklist-item')[0].props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true; } }); await view.render();
assert.equal(prevented, true);
assert.ok(!view.text().includes('Add at least 2 items'));
await view.click('Remove Oven');
assert.ok(view.text().includes('Add at least 2 items'));
await view.type('task-checklist-item', 'Oven'); await view.click((e) => e.type === 'button' && e.props.children === 'Add');
await view.click('Add another task');
view.find((e) => e.props['aria-label'] === 'Task 2 name')[0].props.onChange({ target: { value: 'Second' } }); await view.render();
await view.submit(); await view.submit(); await view.click('Everyone at the venue'); await view.submit();
assert.equal(saves.length, 2);
for (const save of saves) { assert.equal(save.inputType, 'checklist'); assert.deepEqual(save.checklistItems, ['Sink', 'Oven']); }
const editSaves = [];
const edit = mount(TaskModal, { isOpen: true, taskToEdit: task, onClose() {}, onSave(p) { editSaves.push(p); return false; }, knownWorkers: [], venueId: 'v' });
await edit.render(); await edit.submit(); assert.deepEqual(editSaves[0].checklistItems, items);

let current = { ...task };
let controls;
const calls = recordFetch({ 'POST /api/tasks/t/checklist': (_, body) => {
  const checklistTicks = current.checklistTicks.filter((tick) => tick.item !== body.item);
  if (body.ticked) checklistTicks.push({ item: body.item, byName: 'Yossi Cohen', byEmail: 'y@test', at: '2026-11-08T07:02:00Z' });
  current = { ...current, checklistTicks, isCompleted: checklistTicks.length === 3 };
  return current;
} });
controls = mount(TaskChecklist, { task: current, canFill: true, onUpdated(updated) { current = updated; } });
const refresh = () => controls.render({ task: current });
await refresh(); assert.match(controls.text(), /0 of 3/);
assert.equal(controls.find((e) => e.type === 'progress')[0].props.value, 0);
assert.match(controls.text(), /Tap when done/);
for (let item = 0; item < 3; item++) {
  await controls.click((e) => e.props.role === 'checkbox' && e.props['aria-label'] === items[item]);
  await refresh();
  assert.deepEqual(calls.at(-1), ['POST', '/api/tasks/t/checklist', { item, ticked: true }]);
  assert.equal(controls.find((e) => e.props.role === 'checkbox')[item].props['aria-checked'], true);
  if (item === 1) { assert.match(controls.text(), /2 of 3/); assert.match(controls.text(), /Yossi · 7:02 AM/); assert.equal(controls.find((e) => e.type === 'progress')[0].props.value, 2); }
}
assert.equal(current.isCompleted, true); assert.match(controls.text(), /3 of 3 · Done/);
await controls.click('Sink'); await refresh();
assert.deepEqual(calls.at(-1), ['POST', '/api/tasks/t/checklist', { item: 0, ticked: false }]);
assert.equal(current.isCompleted, false);
await controls.render({ canFill: false });
assert.equal(controls.find((e) => e.type === 'button').length, 0);
assert.ok(!controls.text().includes('Tap when done'));
assert.equal(controls.find((e) => e.props.role === 'checkbox').length, 3);
const common = { tasks: [current], currentUser: { name: 'Admin', email: 'a@test', role: 'admin' }, onCheckIn() {}, onUpdateStatus() {}, onUpdateNotes() {}, onEditTask() {}, onDeleteTask() {}, roster: [], shiftsById: new Map() };
const card = mount(TaskCardView, common); await card.render(); assert.match(card.html(), /2 of 3/);
const table = mount(TaskTableView, common); await table.render(); assert.match(table.text(), /Checklist 2\s*\/\s*3/);
const kiosk = renderToStaticMarkup(React.createElement(KioskTaskPanel, { ...common, venueName: 'Kitchen', view: 'list', categories: [] }));
assert.match(kiosk.replace(/<!--.*?-->/g, ''), /Checklist 2\/3/);
console.log('checklist: builder, validation, batch/edit saves, tick/untick, attribution, done, readonly and board counts passed');
