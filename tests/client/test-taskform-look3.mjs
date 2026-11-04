import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TaskModal } from '../../src/components/TaskModal.tsx';
import { venueShifts } from '../../src/lib/shifts.ts';

const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-03T18:00:00Z'])); }
  static now() { return new RealDate('2026-11-03T18:00:00Z').getTime(); }
};
const people = [{ id: 'y', name: 'Yossi Cohen', email: 'yossi@test', venueId: 'v' }, { id: 'e', name: 'Eli Weiss', email: 'eli@test', venueId: 'v' }, { id: 'm', name: 'Moshe Gold', email: 'moshe@test', venueId: 'other' }];
const shifts = venueShifts([], 'v').map((shift) => shift.name === 'Afternoon' ? { ...shift, userIds: ['y'] } : shift);
const afternoon = shifts.find((shift) => shift.name === 'Afternoon');
const make = async (props = {}) => {
  recordFetch({});
  const view = mount(TaskModal, { isOpen: true, onClose() {}, onSave: () => false, knownWorkers: people, venueId: 'v', venueName: 'Kitchen', shifts, timeZone: 'UTC', ...props });
  await view.render(); return view;
};
try {
  let saved;
  const legacy = { id: 't', title: 'Check sink', venueId: 'v', assignedTo: ['all'], isPrivate: true, scheduleType: 'recurring', daysOfWeek: [0,1,2,3,4,5,6], targetTime: '12:00 PM', targetTimeMinutes: 720 };
  const edit = await make({ taskToEdit: legacy, onSave: (payload) => { saved = payload; return false; } });
  assert.match(edit.html(), /task-edit-tabs/);
  assert.match(edit.html(), /Other tasks stay as they are/);
  assert.match(edit.html(), /task-form-nav-title truncate">Check sink/);
  assert.match(edit.html(), /✓ Save changes/);
  await edit.click('Go to Who');
  assert.match(edit.html(), /Who does it\?/); assert.match(edit.html(), /Pick who does it/);
  assert.equal(edit.find((e) => e.props['aria-label'] === 'People by day').length, 0);
  await edit.click('Go to When');
  await edit.click('A shift');
  for (const hours of ['2–10 PM', '6 AM–2 PM', '10 PM–6 AM']) assert.ok(edit.html().includes(hours));
  await edit.click('A time'); await edit.click('Go to What'); await edit.submit();
  assert.deepEqual(saved.assignedTo, ['all']); assert.equal(saved.isPrivate, true);
  assert.equal(saved.assignmentMode, undefined); assert.equal(saved.dayAssignees, undefined); assert.equal(saved.assigneeSwaps, undefined);

  const form = await make(); await form.type('task-title-input', 'Check eggs'); await form.submit(); await form.click('A shift');
  await form.click((e) => e.props['aria-pressed'] !== undefined && e.props.className === 'task-when-shift-pick pressable' && e.props.children[0].props.children.includes('Afternoon'));
  await form.submit();
  assert.match(form.html(), /Pre-filled from the Afternoon shift/);
  assert.match(form.html(), /usual for Afternoon/);
  assert.match(form.html(), /All 2 at Kitchen/);
  assert.match(form.html(), /task-who-person/);
  await form.click((e) => e.type === 'button' && e.props.children?.[0]?.props?.children === 'Fri');
  assert.match(form.html(), /role="dialog" aria-modal="true" aria-label="Choose people"/);
  assert.match(form.html(), /Friday · who does it\?/);
  assert.match(form.html(), /Every Friday\. The other days stay with Yossi Cohen/);
  await form.click((e) => e.props['aria-label'] === 'Pick Yossi Cohen');
  await form.click((e) => e.props['aria-label'] === 'Pick Eli Weiss');
  await form.click((e) => e.props.className === 'task-people-done pressable');
  assert.doesNotMatch(form.html(), /task-people-scrim/);
  assert.match(form.html(), /every day but Fri/);
  assert.match(form.html(), /task-who-day pressable is-different/);

  const swappedEdit = await make({ taskToEdit: { ...legacy, assignmentMode: 'task', assignedTo: ['yossi@test'], dayAssignees: { '5': ['eli@test'] } } });
  await swappedEdit.click('Go to Who');
  await swappedEdit.click((e) => e.type === 'button' && e.props.children?.[0]?.props?.children === 'Fri');
  await swappedEdit.click('Just this Friday, Nov 6');
  assert.match(swappedEdit.html(), /The other Fridays stay with Eli Weiss/);

  let batches = 0;
  const batch = await make({ onSaveMany: async () => { batches++; return true; } });
  await batch.type('task-title-input', 'Check eggs'); await batch.click('Add another task');
  await batch.find((e) => e.props['aria-label'] === 'Task 2 name')[0].props.onChange({ target: { value: 'Check sink' } });
  await batch.render(); await batch.submit(); await batch.submit(); await batch.click((e) => e.props['aria-label'] === 'Everyone at the venue'); await batch.submit(); await batch.render({ isOpen: false });
  assert.equal(batches, 1); assert.match(batch.html(), /2 tasks saved/);
  assert.equal((batch.html().match(/role="status"/g) || []).length, 1);
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const saves = app.slice(app.indexOf('const handleSaveTask ='), app.indexOf('// Delete Task'));
  assert.doesNotMatch(saves, /showToast\(`(?:Updated assignment|Created assignment|Created \$)/);
  assert.match(saves, /showToast\(result.error/);
  console.log('task form look: edit tabs/save, unchanged legacy people, short hours, Who cards/day sheet, venue count, and one success notice passed');
} finally { globalThis.Date = RealDate; }
