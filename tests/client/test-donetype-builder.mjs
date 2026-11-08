import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
// mini-render does not enforce React's hook count, so guard the source too.
const modalSource = readFileSync(new URL('../../src/components/TaskModal.tsx', import.meta.url), 'utf8');
const closedReturn = modalSource.indexOf('if (!isOpen) return');
assert.ok(closedReturn >= 0);
assert.doesNotMatch(modalSource.slice(closedReturn), /\buse[A-Z]\w*\s*\(/, 'TaskModal must call every hook before its closed-modal return');
const make = async (assignedTo = ['yossi@example.test', 'eli@example.test']) => {
  const saves = [];
  const view = mount(TaskModal, { isOpen: true, onClose() {}, onSave(payload) { saves.push(payload); return false; },
    taskToEdit: { id: 't', title: 'Inspect', venueId: 'v', assignedTo, inputType: 'status_select', customStatusOptions: ['Pending', 'Passed'], completedStatusValues: ['Passed'], scheduleType: 'recurring', daysOfWeek: [0,1,2,3,4,5,6] },
    knownWorkers: [{ email: 'yossi@example.test', name: 'Yossi' }, { email: 'eli@example.test', name: 'Eli' }], venueId: 'v', shifts: [] });
  await view.render(); return { view, saves };
};
const { view, saves } = await make();
assert.match(view.text(), /Yossi will see:/);
const add = () => view.click((e) => e.type === 'button' && Array.isArray(e.props.children) && e.props.children.includes('Add'));
await view.type('Add an option', '  '); await add();
await view.type('Add an option', 'pending'); await add();
assert.equal(view.find((e) => e.props.className === 'own-options-row').length, 2);
await view.type('Add an option', ' Needs review '); await add();
await view.type('Add an option', 'Rejected');
let prevented = false;
await view.find((e) => e.props.id === 'task-status-option')[0].props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true; } });
await view.render(); assert.ok(prevented);
await view.click((e) => e.props['aria-label'] === 'Remove Rejected');
const choose = async (option, label, target = view) => {
  const group = target.find((e) => e.props.role === 'group' && e.props['aria-label'] === option)[0];
  const button = group.props.children.find((e) => e.props.children === label || (Array.isArray(e.props.children) && e.props.children.includes(label)));
  await button.props.onClick(); await target.render();
};
await choose('Passed', 'Stays open');
assert.ok(view.find((e) => e.props.role === 'alert' && e.props.children === 'Pick at least one option that counts as done.').length);
await view.find((e) => e.type === 'details' && e.props.className === 'task-done-disclosure')[0].props.onToggle({ currentTarget: { open: false } });
await view.render();
await view.click('Go to Who');
await view.submit(); assert.equal(saves.length, 0);
assert.equal(view.find((e) => e.props['data-task-form-current-step'] === 'What').length, 1);
assert.equal(view.find((e) => e.type === 'details' && e.props.className === 'task-done-disclosure')[0].props.open, true);
await choose('Needs review', 'Counts as done');
await view.click((e) => e.props['aria-label'] === 'Remove Pending');
await view.submit(); assert.equal(saves.length, 1);
assert.deepEqual(saves[0].customStatusOptions, ['Passed', 'Needs review']);
assert.deepEqual(saves[0].completedStatusValues, ['Needs review']);
await view.click((e) => e.props['aria-label'] === 'Remove Needs review');
await view.click((e) => e.props['aria-label'] === 'Remove Passed');
await view.submit(); assert.equal(saves.length, 1);
assert.match(view.text(), /Add at least one option\./);
for (const assignees of [[], ['all']]) {
  const fallback = await make(assignees);
  assert.match(fallback.view.text(), /The mashgiach will see:/);
}
console.log('own-options builder: add, Enter, duplicates, removal, done/open, payload, validation, and assignee preview passed');

const newSaves = [];
const fresh = mount(TaskModal, { isOpen: false, onClose() {}, onSave(payload) { newSaves.push(payload); }, knownWorkers: [], venueId: 'v', shifts: [] });
await fresh.render();
assert.equal(fresh.find((e) => e.type === 'form').length, 0);
await fresh.render({ isOpen: true });
assert.equal(fresh.find((e) => e.type === 'form').length, 1);
await fresh.type('task-title-input', 'Check equipment');
if (fresh.find((e) => e.type === 'input' && e.props.type === 'radio' && e.props.value === 'status_select').length) {
  await fresh.click((e) => e.type === 'input' && e.props.value === 'status_select');
} else {
  await fresh.type('task-input-type-select', 'status_select');
}
await choose('Completed', 'Stays open', fresh);
const next = fresh.find((e) => e.props.id === 'save-task-submit-btn')[0];
assert.match(fresh.text(), /Next: When/);
assert.equal(next.props.disabled, true);
await fresh.submit();
assert.equal(newSaves.length, 0);
assert.equal(fresh.find((e) => e.props['data-task-form-current-step'] === 'What').length, 1);
assert.equal(fresh.find((e) => e.type === 'details' && e.props.className === 'task-done-disclosure')[0].props.open, true);
assert.ok(fresh.find((e) => e.props.role === 'alert' && e.props.children === 'Pick at least one option that counts as done.').length);
await choose('Completed', 'Counts as done', fresh);
assert.equal(fresh.find((e) => e.props.id === 'save-task-submit-btn')[0].props.disabled, false);
await fresh.submit();
assert.equal(fresh.find((e) => e.props['data-task-form-current-step'] === 'When').length, 1);
const preview = fresh.find((e) => e.props.className === 'own-options-preview')[0];
assert.ok(preview.props.children[1].props.children.every((option) => option.type === 'span' && option.props.tabIndex === undefined && option.props.onClick === undefined));
console.log('own-options validation: new-task Next blocked, repair advances, and later edit save reveals What alert');
