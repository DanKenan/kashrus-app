import assert from 'node:assert/strict';
import { venueShifts, shiftDeadlineExisted, shiftTaskOverdueAt, shiftOwnTimeOverdueDay } from '../../src/lib/shifts.ts';
const shifts = venueShifts([], 'v');
const night = shifts.find((s) => s.name === 'Night');
const afternoon = shifts.find((s) => s.name === 'Afternoon');
const zone = 'America/New_York';
const created = { createdAt: '2026-11-03T20:00:00.000Z' }; // 3 PM at the venue
assert.equal(shiftTaskOverdueAt(night, '2026-11-03', 2, 900, created, zone), false);
assert.equal(shiftTaskOverdueAt(night, '2026-11-04', 3, 375, created, zone), true);
assert.equal(shiftTaskOverdueAt(afternoon, '2026-11-03', 2, 900, created, zone), false);
assert.equal(shiftTaskOverdueAt(afternoon, '2026-11-03', 2, 1335, created, zone), true);
assert.equal(shiftTaskOverdueAt(night, '2026-11-03', 2, 900, {}, zone), true);
const own = { ...created, shiftTime: true, targetTime: '5:00 AM', targetTimeMinutes: 300 };
assert.equal(shiftOwnTimeOverdueDay(night, '2026-11-03', 2, 900, own, zone), null);
assert.equal(shiftOwnTimeOverdueDay(night, '2026-11-04', 3, 375, own, zone), '2026-11-03');
assert.equal(shiftTaskOverdueAt(night, '2026-11-03', 2, 900, own, zone), false);
assert.equal(shiftOwnTimeOverdueDay(night, '2026-11-03', 2, 900, { ...own, createdAt: undefined }, zone), '2026-11-02');
// Compare actual instants, including seconds, date boundaries and DST folds.
assert.equal(shiftDeadlineExisted({ createdAt: '2026-11-03T11:00:00Z' }, '2026-11-02', 1800, zone), true);
assert.equal(shiftDeadlineExisted({ createdAt: '2026-11-03T11:00:00.001Z' }, '2026-11-02', 1800, zone), false);
assert.equal(shiftDeadlineExisted({ createdAt: '2026-11-04T00:30:00Z' }, '2026-11-03', 1320, zone), true);
assert.equal(shiftDeadlineExisted({ createdAt: '2026-11-04T00:30:00Z' }, '2026-11-03', 1320, 'UTC'), false);
assert.equal(shiftDeadlineExisted({ createdAt: '2026-11-01T06:15:00Z' }, '2026-10-31', 1530, zone), false);
assert.equal(shiftDeadlineExisted({ createdAt: 'invalid' }, '2026-11-02', 1800, zone), true);
console.log('PASS NIGHTFIX: Night, own times, Afternoon, legacy creation dates, venue zones and instant boundaries');
