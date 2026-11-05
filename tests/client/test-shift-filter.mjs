import assert from 'node:assert/strict';
import { matchesShiftFilter, validShiftFilter, sortShiftsByStart, venueShifts, NO_SHIFT_FILTER } from '../../src/lib/shifts.ts';
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
assert.deepEqual(shown(NO_SHIFT_FILTER), ['c']);
assert.deepEqual(shown('unknown'), shown(''));
assert.deepEqual(shown('builtin-morning:v'), shown(''));
assert.deepEqual(shown('builtin-afternoon:v'), ['e'], 'legacy IDs resolve to canonical venue shift');
assert.equal(validShiftFilter(NO_SHIFT_FILTER, options, false), '');
assert.equal(validShiftFilter('early', [], true), '');
assert.deepEqual(tasks.filter((t) => matchesCategories(t, ['Kitchen']) && matchesShiftFilter(t, 'early', records)).map((t) => t.id), ['a']);
assert.equal(matchesShiftFilter({ venueId: 'other', shiftId: 'early' }, 'early', records), false);
assert.equal(matchesShiftFilter({ venueId: 'v', shiftId: 'builtin-morning:v' }, 'builtin-morning:v', records), false);
console.log('SHIFT-FILTER client: all assertions passed');
