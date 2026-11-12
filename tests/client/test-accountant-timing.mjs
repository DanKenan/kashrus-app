import assert from 'node:assert/strict';
import { accountantPeriod as period, nextAccountantDate, buildAccountantMessage } from '../../src/server/inspections/accountant.ts';
import { localMidnight } from '../../src/server/inspections/store.ts';
const clock = s => new Date(s), zone = 'America/New_York';
const dates = { mode: 'dates', days: [1, 15, 'last'] };
assert.equal(period(dates, null, clock('2026-11-01T11:59:00Z'), zone), null);
assert.deepEqual(period(dates, null, clock('2026-11-01T12:00:00Z'), zone), { from: '2026-10-01', to: '2026-10-31' });
assert.deepEqual(period(dates, { at: '2026-11-01T12:00:00Z', periodEnd: '2026-10-31' }, clock('2026-11-15T12:00:00Z'), zone), { from: '2026-11-01', to: '2026-11-14' });
assert.equal(period(dates, { at: '2026-11-01T12:00:00Z', periodEnd: '2026-10-31' }, clock('2026-11-01T18:00:00Z'), zone), null);
for (const [end, next] of [['2026-02-28', '2026-03-01'], ['2024-02-29', '2024-03-01'], ['2026-04-30', '2026-05-01'], ['2026-12-31', '2027-01-01']]) {
 assert.equal(period({ mode: 'dates', days: ['last'] }, null, clock(end + 'T14:00:00Z'), zone), null);
 assert.equal(period({ mode: 'dates', days: ['last'] }, null, new Date(Date.parse(localMidnight(next, zone)) + 7 * 3600000 - 1), zone), null);
 assert.equal(period({ mode: 'dates', days: ['last'] }, null, new Date(Date.parse(localMidnight(next, zone)) + 7 * 3600000), zone).to, end);
}
assert.equal(period(dates, null, clock('2026-11-02T14:00:00Z'), zone), null);
assert.deepEqual(period({ mode: 'every_days', everyDays: 3 }, null, clock('2026-11-10T01:00:00Z'), 'UTC'), { from: '2026-11-07', to: '2026-11-09' });
const last = { at: '2026-11-10T10:00:00Z', periodEnd: '2026-11-09' };
assert.equal(period({ mode: 'every_days', everyDays: 3 }, last, clock('2026-11-12T12:00:00Z'), zone), null);
assert.deepEqual(period({ mode: 'every_days', everyDays: 3 }, last, clock('2026-11-13T12:00:00Z'), zone), { from: '2026-11-10', to: '2026-11-12' });
assert.equal(period({ mode: 'after_report' }, last, clock('2026-11-10T10:09:59Z'), zone, true), null);
assert.deepEqual(period({ mode: 'after_report' }, last, clock('2026-11-10T10:10:00Z'), zone, true), { from: '2026-11-01', to: '2026-11-10' });
assert.equal(period({ mode: 'after_report' }, { at: '2026-11-10T10:00:00Z', periodEnd: '2026-11-10' }, clock('2026-11-10T11:00:00Z'), zone, true), null);
assert.equal(period({ mode: 'after_report' }, null, clock('2026-11-10T12:00:00Z'), zone), null);
assert.equal(nextAccountantDate({ mode: 'dates', days: ['last'] }, null, clock('2026-11-10T12:00:00Z'), zone), '2026-12-01');
const table = { from: '2026-10-01', to: '2026-10-31', by: 'place', rows: [], totals: { visits: 0, paid: 0, companies: 0, left: 0 }, mismatches: 2 };
const message = buildAccountantMessage('Test <Agency>', 'accountant@example.test', table);
assert.equal(message.subject, 'Test <Agency> pay summary – October 2026'); assert.ok(message.html.includes('Test &lt;Agency&gt;')); assert.ok(message.text.includes('Open mismatches: 2')); assert.equal(message.attachments.length, 2);
assert.ok(buildAccountantMessage('Test Agency', '', { ...table, to: '2026-10-15' }).subject.endsWith('2026-10-01 to 2026-10-15'));
console.log('accountant: fixed clocks, DST/time zone, chosen dates, last, intervals, debounce and message passed');
