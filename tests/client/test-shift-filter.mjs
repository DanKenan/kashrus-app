import assert from 'node:assert/strict';
import { matchesShiftFilter, validShiftFilter, sortShiftsByStart, rememberedShiftFilter, shiftFilterCounts, venueShifts, NO_SHIFT_FILTER } from '../../src/lib/shifts.ts';
import { matchesCategories } from '../../src/lib/categoryFilter.ts';

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
console.log('SHIFT-FILTER client: all assertions passed');
