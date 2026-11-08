import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
const task = { id: 't', title: 'Check sink', venueId: 'v', assignedTo: ['all'], targetTime: '', scheduleType: 'recurring', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
async function make(taskToEdit) {
  const saves = [];
  const view = mount(TaskModal, { isOpen: true, onClose() {}, onSave(payload) { saves.push(payload); return false; }, onSaveMany(payloads) { saves.push(...payloads); return false; }, taskToEdit, knownWorkers: [], venueId: 'v' });
  await view.render();
  assert.equal(view.find((e) => e.props.id === 'task-input-type-select')[0].props.role, 'radiogroup');
  return { view, saves };
}
const radios = (view) => view.find((e) => e.type === 'input' && e.props.name === 'task-done-type');
const pick = async (view, value) => {
  const radio = radios(view).find((e) => e.props.value === value);
  assert.equal(radio.props.onClick, undefined);
  radio.props.onChange({ target: { value, checked: true } });
  await view.render();
};
const previewOptions = (view) => view.find((e) => e.props.className === 'task-done-preview-options')[0].props.children;
for (const [options, done, expected] of [
  [['Pending', 'In Progress', 'Blocked', 'Completed'], ['Completed'], ['Pending', 'In Progress', 'Completed']],
  [['Pending', 'Completed', 'Blocked', 'Other'], ['Completed'], ['Pending', 'Completed', 'Blocked']],
  [['Pending', 'Blocked', 'Other', 'Later'], [], ['Pending', 'Blocked', 'Other']],
  [['Pending', 'Completed'], ['Completed'], ['Pending', 'Completed']],
]) {
  const { view } = await make({ ...task, customStatusOptions: options, completedStatusValues: done });
  const preview = previewOptions(view);
  assert.deepEqual(preview.map((e) => e.props.children[1].props.children), expected);
  assert.equal(preview.some((e) => e.props.className === 'is-done'), done.length > 0);
}
for (const value of ['checkbox', 'check_in', 'yes_no', 'status_select']) {
  const { view, saves } = await make();
  assert.deepEqual(radios(view).map((e) => e.props.value), ['checkbox', 'check_in', 'yes_no', 'status_select', 'checklist']);
  await view.type('task-title-input', 'Check sink');
  await pick(view, value);
  assert.equal(radios(view).filter((e) => e.props.checked)[0].props.value, value);
  await view.submit(); await view.submit();
  await view.click('Everyone at the venue');
  await view.submit();
  assert.equal(saves.length, 1); assert.equal(saves[0].inputType, value);
}
const legacy = await make({ ...task, inputType: 'toggle' });
assert.equal(radios(legacy.view).find((e) => e.props.value === 'toggle').props.checked, true);
assert.equal(radios(legacy.view).find((e) => e.props.value === 'toggle').props['aria-label'], 'On / Off switch');
await legacy.view.submit();
assert.equal(legacy.saves.length, 1); assert.equal(legacy.saves[0].inputType, 'toggle');
const batch = await make();
await batch.view.type('task-title-input', 'First');
for (let n = 2; n <= 3; n++) {
  await batch.view.click('Add another task');
  const input = batch.view.find((e) => e.props['aria-label'] === `Task ${n} name`)[0];
  input.props.onChange({ target: { value: `Task ${n}` } }); await batch.view.render();
}
await pick(batch.view, 'check_in');
assert.ok(batch.view.text().includes('Check many times · all 3'));
await batch.view.submit(); await batch.view.submit();
await batch.view.click('Everyone at the venue'); await batch.view.submit();
assert.equal(batch.saves.length, 3);
assert.deepEqual(batch.saves.map((t) => t.inputType), ['check_in', 'check_in', 'check_in']);
assert.deepEqual(batch.saves.map((t) => t.title), ['First', 'Task 2', 'Task 3']);
console.log('done-type cards: choices, legacy toggle preservation, and three-task batch passed');
