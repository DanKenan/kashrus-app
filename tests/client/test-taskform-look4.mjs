import assert from 'node:assert/strict';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { ShiftHoursBar } from '../../src/components/ShiftHoursBar.tsx';
import { venueShifts } from '../../src/lib/shifts.ts';
const shifts = venueShifts([], 'v');
const night = shifts.find((shift) => shift.name === 'Night');
const make = async (time) => {
  const view = mount(TaskModal, { isOpen: true, onClose() {}, onSave: () => false, knownWorkers: [], venueId: 'v', shifts, taskToEdit: { id: 't', title: 'Check', venueId: 'v', assignedTo: ['all'], targetTime: time, scheduleType: 'recurring', daysOfWeek: [0,1,2,3,4,5,6] } });
  await view.render(); await view.click('Go to When'); return view;
};
for (const [before, after] of [['11:30 PM', '12:00 AM'], ['11:30 AM', '12:00 PM']]) {
  const view = await make(before);
  await view.click('Later time');
  assert.match(view.html(), new RegExp(`task-time-readout[^>]*>${after}`));
  await view.click('Earlier time');
  assert.match(view.html(), new RegExp(`task-time-readout[^>]*>${before}`));
}
const view = await make('11:30 AM');
function clock(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const found = clock(child); if (found) return found; } }
  if (typeof node.type === 'function' && node.type.name === 'TimePickerRow') return node;
  return clock(node.props?.children);
}
const control = clock(view.tree()); assert.ok(control);
const picker = mount(control.type, control.props); await picker.render(); await picker.click('PM'); await view.render();
assert.match(view.html(), /task-time-readout[^>]*>11:30 PM/);
const calls = recordFetch({ 'PUT /api/shifts': (_path, body) => ({ ...night, ...body }) });
const bar = mount(ShiftHoursBar, { shift: night, onSaved() {} }); await bar.render();
const start = () => bar.find((e) => e.props['aria-label'] === 'Shift start')[0];
start().props.onPointerDown();
for (const value of [1410,1440,1470]) { start().props.onChange({ target: { value } }); await bar.render(); }
assert.equal(calls.length, 0);
start().props.onPointerUp(); await bar.render();
assert.equal(calls.length, 1); assert.equal(calls[0][0], 'PUT');
assert.equal(calls[0][2].startMinutes, 30); assert.equal(calls[0][2].endMinutes, 360);
start().props.onBlur(); await bar.render(); assert.equal(calls.length, 1);
console.log('task form review: noon/midnight time controls, AM/PM, and one Night save across midnight passed');
