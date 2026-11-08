import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { venueShifts } from '../../src/lib/shifts.ts';
const shifts = venueShifts([], 'v');
const afternoon = shifts.find((shift) => shift.name === 'Afternoon');
const night = shifts.find((shift) => shift.name === 'Night');
const task = { id: 't', title: 'Check sink', venueId: 'v', assignedTo: ['all'], targetTime: '6:30 PM', targetTimeMinutes: 1110, scheduleType: 'recurring', daysOfWeek: [0,1,2,3,4,5,6] };
const make = async (changes = {}) => {
  const saves = [];
  const view = mount(TaskModal, { isOpen: true, onClose() {}, onSave(payload) { saves.push(payload); return false; }, taskToEdit: { ...task, ...changes }, knownWorkers: [], venueId: 'v', shifts });
  await view.render(); return { view, saves };
};
const done = await make();
assert.equal(done.view.find((e) => e.type === 'details' && e.props.className === 'task-done-disclosure')[0].props.open, undefined);
done.view.find((e) => e.type === 'input' && e.props.value === 'checkbox')[0].props.onChange({ target: { value: 'checkbox', checked: true } });
await done.view.render(); await done.view.submit();
assert.equal(done.saves.length, 1); assert.equal(done.saves[0].inputType, 'checkbox');
const shift = await make({ shiftId: afternoon.id, shiftTime: false });
await shift.view.click('Go to When');
assert.equal(shift.view.find((e) => e.type === 'details' && e.props.className === 'task-change-shift')[0].props.open, false);
await shift.view.click((e) => e.props.className === 'task-when-shift-pick pressable' && e.props.children[0].props.children.includes('Night'));
await shift.view.submit();
assert.equal(shift.saves.length, 1); assert.equal(shift.saves[0].shiftId, night.id); assert.equal(shift.saves[0].targetTime, '');
await shift.view.click('By a set time');
assert.equal(shift.view.find((e) => e.props['aria-label'] === 'Selected task time').length, 0);
await shift.view.click((e) => e.props['aria-label'] === 'Change time');
assert.equal(shift.view.find((e) => e.props['aria-label'] === 'Selected task time').length, 1);
const second = await make(); await second.view.click('Go to When'); await second.view.click('+ Second time'); await second.view.submit();
assert.equal(second.saves.length, 1); assert.equal(second.saves[0].targetTime2, '3:00 PM'); assert.equal(second.saves[0].targetTime2Minutes, 900);
const exact = await make(); await exact.view.click('Go to When');
function clock(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const found = clock(child); if (found) return found; } }
  if (typeof node.type === 'function' && node.type.name === 'TimePickerRow') return node;
  return clock(node.props?.children);
}
const control = clock(exact.view.tree()); assert.ok(control);
const picker = mount(control.type, control.props); await picker.render();
await picker.find((e) => e.props['aria-label'] === 'Minute')[0].props.onChange({ target: { value: '37' } }); await exact.view.render(); await exact.view.submit();
assert.equal(exact.saves.length, 1); assert.equal(exact.saves[0].targetTime, '6:37 PM'); assert.equal(exact.saves[0].targetTimeMinutes, 1117);
console.log('task form final review: done type, changed shift, second deadline, exact minute, and edit time disclosure save paths passed');
