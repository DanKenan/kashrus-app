import assert from 'node:assert/strict';
import { validateSchedule, dueState, calendarDate, alertDecision } from '../../src/server/inspections/schedule.ts';
const visit = date => ({ at: date.includes('T') ? date : date + 'T12:00:00Z', reportId: 'r', mashgiachName: 'Test person' });
const every = (start, n = 1, unit = 'month') => ({ kind: 'every', start, n, unit });
const due = (s, from, last, today = '2026-01-01', tz = 'UTC') => dueState(s, from, last && visit(last), today, tz);
for (const invalid of [undefined, {}, [], { ...every('2026-01-01'), n: 0 }, { ...every('2026-01-01'), n: 366 }, { ...every('2026-01-01'), unit: 'year' }, every('2026-02-29'), { kind: 'per_year', n: 53, start: '2026-01-01' }, { kind: 'dates', dates: [] }, { kind: 'dates', dates: ['2026-02-01', '2026-01-01'] }, { kind: 'dates', dates: ['2026-01-01', '2026-01-01'] }, { ...every('2026-01-01'), extra: true }]) assert.throws(() => validateSchedule(invalid));
assert.equal(validateSchedule(null), null);
for (const s of [every('2026-01-31'), every('2026-01-01', 365, 'day'), { kind: 'per_year', n: 52, start: '2026-01-01' }, { kind: 'dates', dates: ['2026-01-01'] }]) assert.deepEqual(validateSchedule(s), s);
assert.equal(due(null, 'planned', null).status, 'none');
assert.equal(due(every('2026-01-31'), 'last_visit', '2026-01-31').nextDue, '2026-02-28');
assert.equal(due(every('2024-01-31'), 'last_visit', '2024-01-31').nextDue, '2024-02-29');
assert.equal(due(every('2024-02-29', 12), 'planned', '2024-02-29').nextDue, '2025-02-28');
assert.equal(due(every('2026-01-31'), 'planned', '2026-02-28').nextDue, '2026-03-31');
assert.equal(due(every('2026-01-31'), 'last_visit', '2026-02-28').nextDue, '2026-03-28');
for (const from of ['last_visit', 'planned']) {
  assert.equal(due(every('2026-01-01', 2, 'week'), from, '2026-01-01').nextDue, '2026-01-15');
  assert.equal(due(every('2026-01-01', 3, 'day'), from, '2026-01-01').nextDue, '2026-01-04');
  assert.equal(due({ kind: 'per_year', n: 4, start: '2026-01-31' }, from, '2026-01-31').nextDue, '2026-04-30');
  assert.equal(due({ kind: 'per_year', n: 5, start: '2026-01-01' }, from, '2026-01-01').nextDue, '2026-03-15');
  assert.equal(due(every('2026-01-31'), from, null).nextDue, '2026-01-31');
  const dates = { kind: 'dates', dates: ['2026-01-01', '2026-02-01'] };
  assert.equal(due(dates, from, null).nextDue, '2026-01-01');
  assert.equal(due(dates, from, '2026-01-01').nextDue, '2026-02-01');
  assert.equal(due(dates, from, '2026-02-01').status, 'none');
}
assert.deepEqual(due(every('2026-01-01'), 'planned', null), { nextDue: '2026-01-01', status: 'overdue', overdueDays: 0 });
assert.equal(calendarDate('2026-11-01T03:30:00Z', 'America/New_York'), '2026-10-31');
assert.equal(calendarDate('2026-11-01T03:30:00Z', 'Asia/Jerusalem'), '2026-11-01');
assert.equal(due(every('2026-01-01', 1, 'day'), 'last_visit', '2026-11-01T03:30:00Z', '2026-11-01', 'America/New_York').nextDue, '2026-11-01');
assert.equal(due(every('2026-01-01', 1, 'day'), 'last_visit', '2026-11-01T03:30:00Z', '2026-11-01', 'Asia/Jerusalem').nextDue, '2026-11-02');
for (const [tz, dates] of [['America/New_York', ['2026-03-08', '2026-11-01']], ['Asia/Jerusalem', ['2026-03-27', '2026-10-25']]]) for (const date of dates) for (const from of ['last_visit', 'planned']) {
  const next = due(every(date, 1, 'week'), from, date, date, tz).nextDue;
  assert.equal(new Date(next).getUTCDay(), new Date(date).getUTCDay());
  assert.equal((Date.parse(next) - Date.parse(date)) / 86400000, 7);
}
const base = { nextDue: '2026-11-03', today: '2026-11-03', hour: 9, mute: null, alert: null };
const first = alertDecision(base); assert.equal(first.kind, 'first');
assert.equal(alertDecision({ ...base, alert: first.alert }), null);
assert.equal(alertDecision({ ...base, today: '2026-11-09', alert: first.alert }), null);
const reminder = alertDecision({ ...base, today: '2026-11-10', alert: first.alert }); assert.equal(reminder.kind, 'reminder');
const missed = alertDecision({ ...base, today: '2026-11-24', alert: first.alert }); assert.equal(missed.alert.count, 2);
assert.equal(alertDecision({ ...base, today: '2026-11-24', alert: missed.alert }), null);
for (const hour of [0, 7, 21, 23]) assert.equal(alertDecision({ ...base, hour }), null);
for (const hour of [8, 20]) assert.equal(alertDecision({ ...base, hour }).kind, 'first');
for (const until of [null, '2026-11-03', '2026-11-04']) assert.equal(alertDecision({ ...base, mute: { until, by: 'u', at: '2026-11-01T12:00:00Z' } }), null);
assert.equal(alertDecision({ ...base, mute: { until: '2026-11-02', by: 'u', at: '2026-11-01T12:00:00Z' } }).kind, 'first');
console.log('inspection schedule: validation, calendar recurrence, agency TZ/DST and alert decisions passed');
