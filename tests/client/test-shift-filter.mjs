import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activeFilterChips, clearActiveFilter } from '../../src/lib/activeFilters.ts';
import { ActiveFilters } from '../../src/components/ActiveFilters.tsx';
import { TaskFilterBar } from '../../src/components/TaskFilterBar.tsx';
import { isMyTask } from '../../src/lib/myTasks.ts';
import { taskAppliesOn } from '../../src/lib/taskDay.ts';
import { matchesShiftFilter, validShiftFilter, sortShiftsByStart, rememberedShiftFilter, shiftFilterCounts, venueShifts, NO_SHIFT_FILTER } from '../../src/lib/shifts.ts';
import { matchesCategories, countTaskCategories } from '../../src/lib/categoryFilter.ts';

const make = (id, startMinutes, extra = {}) => ({ id, venueId: 'v', name: id, startMinutes, endMinutes: 1200, ...extra });
const records = [make('late', 900), make('early', 300),
  { id: 'builtin-morning:v', venueId: 'v', deleted: true },
  make('dated-later', 100, { oneTimeDate: '2026-11-07' }),
  make('dated-early', 200, { oneTimeDate: '2026-11-06' }),
  make('dated-first', 100, { oneTimeDate: '2026-11-06' })];
const options = sortShiftsByStart(venueShifts(records, 'v'));
assert(!options.some((s) => s.deleted || s.id === 'builtin-morning:v'));
assert.deepEqual(sortShiftsByStart(records.filter((s) => !s.deleted)).map((s) => s.id),
  ['early', 'late', 'dated-first', 'dated-early', 'dated-later']);
assert.equal(records[0].id, 'late', 'sorting leaves loaded data untouched');
const tasks = [
  { id: 'a', venueId: 'v', shiftId: 'early', categories: ['Kitchen'] },
  { id: 'b', venueId: 'v', shiftId: 'late', categories: ['Kitchen'] },
  { id: 'c', venueId: 'v', targetTime: 'Any time' },
  { id: 'd', venueId: 'v', targetTime: '5:00 AM', targetTimeMinutes: 300 },
  { id: 'e', venueId: 'v', shiftId: 'builtin-afternoon' },
];
const shown = (pick) => tasks.filter((t) => matchesShiftFilter(t, validShiftFilter(pick, options, true), records)).map((t) => t.id);
assert.deepEqual(shown(''), ['a', 'b', 'c', 'd', 'e']);
assert.deepEqual(shown('early'), ['a']);
assert.deepEqual(shown(NO_SHIFT_FILTER), ['c', 'd']);
assert.deepEqual(shown('unknown'), shown(''));
assert.deepEqual(shown('builtin-morning:v'), shown(''));
assert.deepEqual(shown('builtin-afternoon:v'), ['e'], 'legacy IDs resolve to canonical venue shift');
assert.equal(validShiftFilter(NO_SHIFT_FILTER, options, false), '');
assert.equal(validShiftFilter('early', [], true), '');
assert.deepEqual(tasks.filter((t) => matchesCategories(t, ['Kitchen']) && matchesShiftFilter(t, 'early', records)).map((t) => t.id), ['a']);
assert.equal(matchesShiftFilter({ venueId: 'other', shiftId: 'early' }, 'early', records), false);
assert.equal(matchesShiftFilter({ venueId: 'v', shiftId: 'builtin-morning:v' }, 'builtin-morning:v', records), false);
// Both load orders, including empty tasks and a remembered No shift choice.
for (const pick of [NO_SHIFT_FILTER, 'early', 'unknown']) {
  for (const [shiftsLoaded, tasksLoaded] of [[false, false], [true, false], [false, true]]) {
    assert.equal(rememberedShiftFilter(pick, [], false, shiftsLoaded, tasksLoaded), pick);
  }
}
assert.equal(rememberedShiftFilter(NO_SHIFT_FILTER, options, true, true, true), NO_SHIFT_FILTER);
assert.equal(rememberedShiftFilter(NO_SHIFT_FILTER, options, false, true, true), '');
assert.equal(rememberedShiftFilter('unknown', options, true, true, true), '');
assert.equal(rememberedShiftFilter('early', options, false, true, true), 'early');
const unassigned = [tasks[3], { venueId: 'v', shiftId: 'unknown' },
  { venueId: 'v', shiftId: 'builtin-morning:v' }];
assert(unassigned.every((t) => matchesShiftFilter(t, NO_SHIFT_FILTER, records)));
assert(unassigned.some((t) => matchesShiftFilter(t, NO_SHIFT_FILTER, records)), 'same predicate exposes chip and its tasks');

const today = tasks.map((task, i) => ({ ...task, isCompleted: i % 2 === 0 }));
const isMine = (task) => ['a', 'b', 'd'].includes(task.id);
assert.deepEqual(shiftFilterCounts(today, '', records, isMine),
  { totalTasks: 5, completedTasks: 3, completionRate: 60, myTotal: 3, myCompleted: 1 });
assert.deepEqual(shiftFilterCounts(today, 'early', records, isMine),
  { totalTasks: 1, completedTasks: 1, completionRate: 100, myTotal: 1, myCompleted: 1 });
const noShiftCounts = shiftFilterCounts(today, NO_SHIFT_FILTER, records, isMine);
assert.deepEqual(noShiftCounts,
  { totalTasks: 2, completedTasks: 1, completionRate: 50, myTotal: 1, myCompleted: 0 });
assert.equal(noShiftCounts.totalTasks - noShiftCounts.completedTasks, 1, 'Pending uses scoped totals');
assert.deepEqual(shiftFilterCounts([], '', records, isMine),
  { totalTasks: 0, completedTasks: 0, completionRate: 0, myTotal: 0, myCompleted: 0 });
// Today stays the count boundary even when the board browses All days.
// An overnight occurrence's swap must decide Mine using its start date.
const currentUser = { role: 'admin', email: 'admin@test' };
const taskOccurrenceDate = (task) => task.occurrenceDate;
const countTasks = [
  { id: 'swap-in', venueId: 'v', shiftId: 'early', daysOfWeek: [6], assignedTo: ['other@test'],
    occurrenceDate: '2026-11-06', assigneeSwaps: [{ date: '2026-11-06', assignedTo: ['admin@test'] }], isCompleted: true },
  { id: 'swap-out', venueId: 'v', shiftId: 'early', daysOfWeek: [6], assignedTo: ['admin@test'],
    occurrenceDate: '2026-11-06', assigneeSwaps: [{ date: '2026-11-06', assignedTo: ['other@test'] }] },
  { id: 'team', venueId: 'v', shiftId: 'late', daysOfWeek: [6], assignedTo: ['all'], occurrenceDate: '2026-11-07' },
  { id: 'tomorrow', venueId: 'v', shiftId: 'early', daysOfWeek: [0], assignedTo: ['admin@test'], occurrenceDate: '2026-11-08' },
];
const todayTasks = countTasks.filter((task) => taskAppliesOn(task, '2026-11-07', 6));
const countMine = (task) => isMyTask(task, currentUser, taskOccurrenceDate(task));
assert.deepEqual(shiftFilterCounts(todayTasks, '', records, countMine),
  { totalTasks: 3, completedTasks: 1, completionRate: 33, myTotal: 1, myCompleted: 1 });
assert.deepEqual(shiftFilterCounts(todayTasks, 'early', records, countMine),
  { totalTasks: 2, completedTasks: 1, completionRate: 50, myTotal: 1, myCompleted: 1 });
assert.equal(isMyTask(countTasks[0], currentUser), false, 'without occurrence date the swap-in is missed');
assert.equal(isMyTask(countTasks[1], currentUser), true, 'without occurrence date the swap-out is wrongly counted');
const defaults = { dayView: 'today', quickFilter: 'all' };
const baseFilters = { ...defaults, categories: [], search: '' };
for (const shift of [{ id: 'early', label: 'Early' }, { id: NO_SHIFT_FILTER, label: 'No shift' }]) {
  const picked = { ...baseFilters, shift };
  assert.deepEqual(activeFilterChips(picked, defaults), [{ key: 'shift', label: shift.label }]);
  assert.equal(activeFilterChips(picked, defaults).length > 0, true, 'shift alone activates filtered empty state');
  const html = renderToStaticMarkup(React.createElement(ActiveFilters, { state: picked, defaults, onChange() {} }));
  assert(html.includes(`Turn off ${shift.label}`) && html.includes('Clear all'));
  assert.equal(clearActiveFilter(picked, defaults, 'shift').shift, undefined);
  const cleared = clearActiveFilter({ ...picked, categories: ['General'], search: 'test' }, defaults, 'all');
  assert.deepEqual(cleared, baseFilters);
  assert.deepEqual(shown(cleared.shift?.id || ''), shown(''), 'Clear all restores every shift');
}
const categoryTasks = [
  { venueId: 'v', shiftId: 'early', categories: ['Kitchen', 'General'] },
  { venueId: 'v', shiftId: 'early', category: 'General' },
  { venueId: 'v', shiftId: 'late', category: 'Kitchen' },
  { venueId: 'v', category: 'General' },
];
for (const [pick, total, expected] of [
  ['', 4, { Kitchen: 2, General: 3 }],
  ['early', 2, { Kitchen: 1, General: 2 }],
  [NO_SHIFT_FILTER, 1, { Kitchen: 0, General: 1 }],
]) {
  const scoped = categoryTasks.filter((task) => matchesShiftFilter(task, pick, records));
  const counts = countTaskCategories(scoped, ['Kitchen', 'General']);
  assert.deepEqual(counts, expected);
  const html = renderToStaticMarkup(React.createElement(TaskFilterBar, {
    searchQuery: '', onSearchChange() {}, selectedCategories: [], onCategoryChange() {},
    categories: ['Kitchen', 'General'], categoryCounts: counts, taskCount: scoped.length,
    viewMode: 'cards', onViewModeChange() {}, dayView: 'today', onDayViewChange() {}, onOpenTaskModal() {}, isAdmin: true,
  }));
  const buttons = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0].replace(/<[^>]+>/g, ''));
  for (const label of [`All${total}`, `Kitchen${expected.Kitchen}`, `General${expected.General}`]) assert(buttons.includes(label), label);
}
const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
assert(app.includes("changeShift(next.shift?.id || '')"), 'summary and Clear all persist the changed shift');
assert(app.includes('shift: selectedShift ?'), 'summary includes the effective shift');
assert(app.includes('countTaskCategories(shiftCategoryTasks, categories)') && app.includes('taskCount={shiftCategoryTasks.length}'));
assert(/dayTasks.filter\(\(task\) => matchesShiftFilter\(\s*task, selectedShift,/.test(app));
console.log('SHIFT-FILTER client: all assertions passed');
