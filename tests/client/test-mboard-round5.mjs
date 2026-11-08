import assert from 'node:assert/strict';
import React from 'react';
import { mount } from './lib/mini-render.mjs';
import { MashgiachBoard } from '../../src/components/MashgiachBoard.tsx';
import { TaskCardView } from '../../src/components/TaskCardView.tsx';
import { TaskEmptyState } from '../../src/components/TaskEmptyState.tsx';
import { mashgiachProgress, mashgiachTaskTimeKey, mashgiachCheckInSummary, mashgiachCheckInCovered } from '../../src/lib/mashgiachBoard.ts';
const shift = { id: 'night', name: 'Night', startMinutes: 1320, endMinutes: 360, days: Array.from({ length: 7 }, (_, w) => ({ on: true, ...(w === 0 ? { startMinutes: 540, endMinutes: 1020 } : {}) })), userIds: ['u'], overrides: [] };
const task = { id: 'late', title: 'Overnight check', category: 'General', inputType: 'checkbox', shiftId: 'night', shiftTime: true, targetTime: '11:00 PM', assignedTo: ['all'], daysOfWeek: [], isCompleted: false, currentStatus: 'pending', notes: '' };
const early = { ...task, id: 'early', targetTime: '2:00 AM' };
const key = (t) => mashgiachTaskTimeKey(t, shift, '2026-11-08', 0, 120);
assert.equal(key(task).minutes, -60);
assert.equal(key(early).minutes, 120);
assert.deepEqual(mashgiachProgress([early, task], () => false, () => false, key).open.map((t) => t.id), ['late', 'early']);
assert.equal(mashgiachProgress([early, task], (t) => t.id === 'early', () => false, key).next.id, 'early');
const saturdayKey = (t) => mashgiachTaskTimeKey(t, shift, '2026-11-07', 6, 1320);
assert.equal(saturdayKey(early).minutes, 1560);
assert.equal(mashgiachProgress([early, task], () => false, () => false, saturdayKey).next.id, 'late');
assert.equal(mashgiachTaskTimeKey({ ...task, targetTime: '' }, undefined, '2026-11-08', 0, 120).rank, 2);
const checks = { ...task, inputType: 'check_in', checkIns: [
  { id: 'old', at: '2026-11-06T23:00:00Z' }, { id: 'before', at: '2026-11-07T21:59:00Z' },
  { id: 'sat', at: '2026-11-07T23:00:00Z' }, { id: 'sun', at: '2026-11-08T01:00:00Z' }, { id: 'future', at: '2026-11-08T03:00:00Z' },
] };
const now = new Date('2026-11-08T02:00:00Z');
assert.equal(mashgiachCheckInSummary(checks, now, 'UTC', false, shift), '2 checks this shift · last 1:00 AM');
assert.equal(mashgiachCheckInSummary(checks, now, 'UTC', true, shift), '2 checks this shift · last 1:00 AM');
assert.equal(mashgiachCheckInCovered(checks, shift, '2026-11-08', 0, 120, 'UTC'), true);
assert.equal(mashgiachCheckInSummary({ ...checks, checkIns: [checks.checkIns[2]] }, now, 'UTC', false, shift), '1 check this shift · last 11:00 PM');
assert.equal(mashgiachCheckInSummary({ ...checks, shiftId: undefined, checkIns: [checks.checkIns[2], checks.checkIns[3]] }, now, 'UTC'), '1 check today · last 1:00 AM');
function* walk(node) { if (Array.isArray(node)) { for (const n of node) yield* walk(n); } else if (React.isValidElement(node)) { yield node; yield* walk(node.props.children); } }
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-11-08T02:00:00Z'])); } };
try {
  let cleared = 0;
  const props = { tasks: [], currentUser: { id: 'u', role: 'mashgiach', email: 'u@test' }, timeZone: 'UTC', shiftsById: new Map([['night', shift]]), headerShifts: [shift], onClearFilters: () => cleared++, onUpdateStatus() {}, onCheckIn() {}, onUpdateNotes() {}, onEditTask() {}, onDeleteTask() {} };
  const view = mount(MashgiachBoard, props); await view.render();
  assert.match(view.text(), /Your night shift/); assert.match(view.text(), /10:00 PM – 6:00 AM/);
  assert.match(view.text(), /0 of 0 done Nothing for you today/);
  assert.doesNotMatch(view.text(), /All done|Done today|Do this next/);
  assert.equal(view.find((e) => e.props.role === 'progressbar')[0].props['aria-valuemax'], 1);
  await view.render({ hasActiveFilters: true });
  assert.match(view.text(), /Your night shift/);
  const empty = [...walk(view.tree())].find((e) => e.type === TaskEmptyState);
  assert.equal(empty.props.onClearFilters, props.onClearFilters);
  const filter = mount(TaskEmptyState, empty.props); await filter.render();
  assert.match(filter.text(), /Nothing matches these filters/); await filter.click('Clear all'); assert.equal(cleared, 1);
  await view.render({ tasks: [checks], hasActiveFilters: false });
  assert.match(view.text(), /2 checks this shift · last 1:00 AM/);
  const big = mount(TaskCardView, { ...props, tasks: [checks], focused: true }); await big.render();
  assert.match(big.text(), /2 checks this shift · last 1:00 AM/);
} finally { globalThis.Date = RealDate; }
console.log('mboard round 5: overnight order and weekday, occurrence summaries, filtered empty action and persistent empty header passed');
