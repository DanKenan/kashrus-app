/**
 * Item 6: the shared work-day helpers (src/lib/workday.ts), pure functions.
 *
 * Proves: local dates, weekdays and minutes come from the zone (not the
 * server or device clock) across US and Israel DST changes and both sides of
 * the date line; invalid zones fall through to the agency zone, then New
 * York; calendar arithmetic ignores DST; the next-reset date never moves
 * before the marker allows (plan B3a).
 */
import {
  workDateIn, weekdayIn, minutesIn, hourIn, addDays, effectiveTimeZone,
  isValidTimeZone, nextResetDate, zoneCityLabel, DEFAULT_TIME_ZONE,
} from '../../src/lib/workday.ts';

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
const at = (iso) => Date.parse(iso);

export default {
  name: 'Item 6: work-day helpers',
  whatItProves:
    'Zone-local dates/weekdays/minutes across DST (US, Israel) and the date line; invalid zones fall through; DST-proof day arithmetic; next-reset date honours the marker.',
  async run() {
    eq(DEFAULT_TIME_ZONE, 'America/New_York', 'default zone');
    // Midnight boundaries
    eq(workDateIn('America/New_York', at('2026-10-21T03:59:59Z')), '2026-10-20', 'NY 23:59:59');
    eq(workDateIn('America/New_York', at('2026-10-21T04:00:00Z')), '2026-10-21', 'NY 00:00');
    eq(workDateIn('Asia/Jerusalem', at('2026-10-20T20:59:59Z')), '2026-10-20', 'JLM 23:59:59 IDT');
    eq(workDateIn('Asia/Jerusalem', at('2026-10-20T21:00:00Z')), '2026-10-21', 'JLM 00:00 IDT');
    eq(workDateIn('Asia/Jerusalem', at('2026-10-25T22:00:00Z')), '2026-10-26', 'JLM 00:00 IST');
    // US fall-back: 01:30 twice, same date
    eq(minutesIn('America/New_York', at('2026-11-01T05:30:00Z')), 90, 'first 01:30');
    eq(minutesIn('America/New_York', at('2026-11-01T06:30:00Z')), 90, 'second 01:30');
    eq(workDateIn('America/New_York', at('2026-11-01T06:30:00Z')), '2026-11-01', 'second 01:30 date');
    // US spring-forward: 01:59 EST -> 03:00 EDT
    eq(minutesIn('America/New_York', at('2027-03-14T06:59:00Z')), 119, '01:59 EST');
    eq(minutesIn('America/New_York', at('2027-03-14T07:00:00Z')), 180, '03:00 EDT');
    eq(hourIn('America/New_York', at('2027-03-14T07:00:00Z')), 3, 'hour 3');
    // Israel spring-forward 2027-03-26 02:00 IST -> 03:00 IDT
    eq(minutesIn('Asia/Jerusalem', at('2027-03-26T00:00:00Z')), 180, 'JLM 03:00 IDT');
    // Date line
    eq(workDateIn('Pacific/Auckland', at('2026-10-21T11:30:00Z')), '2026-10-22', 'Auckland ahead');
    eq(workDateIn('Pacific/Honolulu', at('2026-10-21T09:30:00Z')), '2026-10-20', 'Honolulu behind');
    eq(weekdayIn('America/New_York', at('2026-10-21T02:00:00Z')), 2, 'Tuesday evening NY');
    eq(weekdayIn('Asia/Jerusalem', at('2026-10-21T02:00:00Z')), 3, 'Wednesday morning JLM');
    // Fall-through and validation
    eq(effectiveTimeZone('Bad/Zone', 'Asia/Jerusalem'), 'Asia/Jerusalem', 'venue invalid -> agency');
    eq(effectiveTimeZone(undefined, 'nope'), 'America/New_York', 'both invalid -> default');
    eq(effectiveTimeZone('America/Chicago', 'Asia/Jerusalem'), 'America/Chicago', 'venue wins');
    eq(isValidTimeZone('UTC'), true, 'UTC valid');
    eq(isValidTimeZone('EST5EDT'), false, 'non-Area/City rejected');
    eq(isValidTimeZone(''), false, 'empty rejected');
    eq(isValidTimeZone('A'.repeat(70) + '/B'), false, 'too long rejected');
    eq(workDateIn('Not/AZone', at('2026-10-21T03:59:59Z')), '2026-10-20', 'invalid zone -> New York');
    // Calendar arithmetic
    eq(addDays('2026-10-31', 1), '2026-11-01', 'addDays month');
    eq(addDays('2027-03-13', 1), '2027-03-14', 'addDays spring');
    eq(addDays('2026-01-01', -1), '2025-12-31', 'addDays year back');
    // Next reset (B3a)
    eq(nextResetDate('America/New_York', '2026-10-24', at('2026-10-23T22:00:00Z')), '2026-10-25', 'westward: after marker');
    eq(nextResetDate('America/New_York', '2026-10-23', at('2026-10-23T22:00:00Z')), '2026-10-24', 'normal: tomorrow');
    eq(nextResetDate('America/New_York', null, at('2026-10-23T22:00:00Z')), '2026-10-24', 'no marker: tomorrow');
    eq(zoneCityLabel('America/New_York'), 'New York time', 'label');
    eq(zoneCityLabel('UTC'), 'UTC', 'label UTC');
  },
};
