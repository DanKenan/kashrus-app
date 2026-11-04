import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-03T18:00:00Z'])); }
  static now() { return new RealDate('2026-11-03T18:00:00Z').getTime(); }
};
function clock(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const found = clock(child); if (found) return found; } }
  if (typeof node.type === 'function' && node.type.name === 'TimePickerRow') return node;
  return clock(node.props?.children);
}
try {
  const saves = [];
  const task = { id: 't', title: 'Check', venueId: 'v', assignedTo: ['all'], targetTime: '6:37 PM', targetTimeMinutes: 1117, scheduleType: 'recurring', daysOfWeek: [0,1,2,3,4,5,6] };
  const view = mount(TaskModal, { isOpen: true, onClose() {}, onSave(payload) { saves.push(payload); return false; }, taskToEdit: task, knownWorkers: [], venueId: 'v' });
  await view.render(); await view.click('Go to When');
  for (const invalid of ['-1', '60', '', '7.5', 'not a minute']) {
    const control = clock(view.tree()); assert.ok(control);
    const picker = mount(control.type, control.props); await picker.render();
    const target = { value: invalid };
    await picker.find((e) => e.props['aria-label'] === 'Minute')[0].props.onChange({ target });
    assert.equal(target.value, '37');
    await view.render(); await view.submit();
    assert.equal(saves.at(-1).targetTime, '6:37 PM');
    assert.equal(saves.at(-1).targetTimeMinutes, 1117);
  }
  const people = [{ name: 'Yossi Cohen', email: 'yossi@test' }, { name: 'Eli Weiss', email: 'eli@test' }, { name: 'Moshe Gold', email: 'moshe@test' }];
  const swap = mount(TaskModal, { isOpen: true, onClose() {}, onSave() {}, venueId: 'v', knownWorkers: people, taskToEdit: { ...task, assignmentMode: 'task', assignedTo: ['yossi@test'], dayAssignees: { '5': ['eli@test'] }, assigneeSwaps: [{ date: '2026-11-06', assignedTo: ['moshe@test'] }] } });
  await swap.render(); await swap.click('Go to Who');
  const friday = swap.find((e) => e.props['aria-label']?.startsWith?.('Fri:'))[0]; assert.ok(friday);
  assert.match(friday.props['aria-label'], /Moshe Gold, just Nov 6, usually Eli Weiss/);
  assert.equal(friday.props.children[2].props.children.props.children, 'Moshe');
  assert.equal(friday.props.children[3].props.children, '1×');
  assert.equal(swap.find((e) => e.props.className === 'task-day-short-summary')[0].props.children, 'Fri Nov 6: Moshe, just this once (usually Eli)');
  console.log('task form review: invalid minutes retain the saved minute, compact swap tile and full accessible context passed');
} finally { globalThis.Date = RealDate; }
