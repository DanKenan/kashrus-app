import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkInCoversDue, isTaskOverdue } from '../../src/lib/overdue.ts';
import { shiftTaskOverdueAt } from '../../src/lib/shifts.ts';
const day = '2026-11-05', tz = 'America/New_York';
const task = { inputType: 'check_in', targetTime: '6:30 AM', targetTimeMinutes: 390, targetTime2: '5:00 PM', targetTime2Minutes: 1020 };
const checked = (at) => ({ ...task, checkIns: [{ at }] });
const board = (t, minutes) => !checkInCoversDue(t, day, minutes, tz) && isTaskOverdue(t, minutes);
assert.equal(board(task, 748), true);
assert.equal(board(checked('2026-11-05T12:00:00Z'), 748), false);
assert.equal(board(checked('2026-11-04T12:00:00Z'), 748), true);
assert.equal(board(checked('2026-11-06T12:00:00Z'), 748), true);
assert.equal(board(checked('invalid'), 748), true);
assert.equal(board(checked('2026-11-05T10:00:00Z'), 1021), true, 'before first deadline cannot satisfy second');
assert.equal(board(checked('2026-11-05T12:00:00Z'), 1021), false, 'since first deadline satisfies second');
assert.equal(board({ ...checked('2026-11-05T12:00:00Z'), inputType: 'yes_no' }, 748), true);
const shift = { startMinutes: 1320, endMinutes: 360, days: Array.from({ length: 7 }, () => ({ on: true })) };
const night = { inputType: 'check_in', checkIns: [{ at: '2026-11-05T04:00:00Z' }] }; // Nov 4, 11 PM venue time
assert.equal(shiftTaskOverdueAt(shift, day, 4, 420, night, tz), false);
assert.equal(shiftTaskOverdueAt(shift, day, 4, 420, { ...night, checkIns: [{ at: '2026-11-04T20:00:00Z' }] }, tz), true, 'before occurrence start excluded');
const own = { ...night, shiftTime: true, targetTime: '1:00 AM', targetTimeMinutes: 60, targetTime2: '5:00 AM', targetTime2Minutes: 300 };
assert.equal(shiftTaskOverdueAt(shift, day, 4, 120, own, tz), false);
assert.equal(shiftTaskOverdueAt(shift, day, 4, 301, own, tz), true);
assert.equal(shiftTaskOverdueAt(shift, day, 4, 301, { ...own, checkIns: [{ at: '2026-11-05T07:00:00Z' }] }, tz), false);
for (const name of ['TaskCardView', 'TaskTableView']) {
  assert.match(readFileSync(`src/components/${name}.tsx`, 'utf8'), /checkInCoversDue\(task, todayYmd, nowMinutes, timeZone\)/);
}
console.log('PASS check-in overdue: board, two times, venue dates, overnight shift and own times');
