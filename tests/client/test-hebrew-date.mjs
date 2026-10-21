/**
 * D5 — Living Header: hebrewDateFor() against Hebcal.
 *
 * The fixture (hebcal-cases.json) was captured from the Hebcal APIs
 * (https://www.hebcal.com/converter with gs=off/on, and /zmanim sunset) for
 * New York, Jerusalem and Los Angeles on 12 dates, including both US and
 * Israeli DST change days, erev Rosh Hashana and Adar I / Adar II.
 * No network: the test only reads the fixture.
 *
 * Run: npx tsx tests/client/test-hebrew-date.mjs
 */
import fs from 'node:fs';
import { hebrewDateFor, sunsetUtcMs } from '../../src/lib/hebrewDate.ts';

const fx = JSON.parse(fs.readFileSync(new URL('./hebcal-cases.json', import.meta.url), 'utf8'));
const MONTHS = {
  Tishrei: 'תשרי', Cheshvan: 'חשוון', Kislev: 'כסלו', Tevet: 'טבת', "Sh'vat": 'שבט',
  'Adar I': 'אדר א׳', 'Adar II': 'אדר ב׳', Adar: 'אדר', Nisan: 'ניסן', Iyyar: 'אייר',
  Sivan: 'סיוון', Tamuz: 'תמוז', Av: 'אב', Elul: 'אלול',
};

let failures = 0;
let checks = 0;
function check(label, ok, detail = '') {
  checks++;
  if (!ok) { failures++; console.error(`FAIL ${label} ${detail}`); }
}
const MIN = 60000;
/** The instant at which the wall clock in `tz` reads `ymd hh:mm` (two refinement passes). */
function zonedInstant(ymd, hhmm, tz) {
  const wall = Date.parse(`${ymd}T${hhmm}:00Z`);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const wallAt = (ms) => { const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return Date.parse(`${p.year}-${p.month}-${p.day}T${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}:00Z`); };
  let t = wall;
  for (let i = 0; i < 3; i++) t += wall - wallAt(t);
  return t;
}
const same = (r, c) => r && r.day === c.hd && r.year === c.hy && r.month === MONTHS[c.hm];

// 1. Sunset within 2 minutes of Hebcal (Hebcal rounds to the minute).
let worst = 0;
for (const [key, iso] of Object.entries(fx.sunset)) {
  const [city, ymd] = key.split('|');
  const { lat, lng } = fx.cities[city];
  const ms = sunsetUtcMs(ymd, lat, lng, fx.cities[city].tz);
  const diff = ms == null ? Infinity : Math.abs(ms - Date.parse(iso)) / MIN;
  worst = Math.max(worst, diff);
  check(`sunset ${key}`, diff <= 2, `got ${ms && new Date(ms).toISOString()} want ${iso}`);
}

// 2. Around sunset, at local 00:30 and 12:00 — with the venue's coordinates
//    AND with only the zone (zone-city point), for every city and date.
for (const [key, iso] of Object.entries(fx.sunset)) {
  const [city, ymd] = key.split('|');
  const { tz, lat, lng, zoneCity } = fx.cities[city];
  const before = fx.converter[`${ymd}|off`];
  const after = fx.converter[`${ymd}|on`];
  const sunset = Date.parse(iso);
  const local = (hhmm) => zonedInstant(ymd, hhmm, tz); // DST-day safe (00:30 is before the change)
  const modes = [['coords', lat, lng]];
  if (zoneCity) modes.push(['zone', undefined, undefined]); // Kiritimati: explicit coordinates only
  for (const [mode, la, ln] of modes) {
    const cases = [
      ['00:30', local('00:30'), before, false],
      ['12:00', local('12:00'), before, false],
      ['sunset-5', sunset - 5 * MIN, before, false],
      ['sunset+5', sunset + 5 * MIN, after, true],
    ];
    // 23:30 local only when it is clearly after sunset (Anchorage in June sets ~23:43).
    if (local('23:30') > sunset + 5 * MIN) cases.push(['23:30', local('23:30'), after, true]);
    for (const [label, at, want, afterSunset] of cases) {
      const r = hebrewDateFor(new Date(at), tz, la, ln);
      check(`${key} ${mode} ${label}`, same(r, want) && r.afterSunset === afterSunset,
        `got ${JSON.stringify(r)} want ${want.hd} ${want.hm} ${want.hy} afterSunset=${afterSunset}`);
      check(`${key} ${mode} ${label} basis`, r.basis === (mode === 'coords' ? 'coords' : 'zone-city'), r.basis);
    }
  }
}

// 3. Text shape: gematria + month, short form drops the year.
{
  const r = hebrewDateFor(new Date('2026-10-21T16:00:00Z'), 'America/New_York'); // noon NY, 10 Cheshvan 5787
  check('text', r.text === 'י׳ בחשוון תשפ״ז', r.text);
  check('textShort', r.textShort === 'י׳ בחשוון', r.textShort);
  const rh = hebrewDateFor(new Date('2026-09-11T23:30:00Z'), 'America/New_York'); // 7:30 PM NY, after sunset
  check('erev RH -> 1 Tishrei 5787', rh.text === 'א׳ בתשרי תשפ״ז', rh.text);
}

// 4. Fallback: UTC has no sunset point -> switches exactly at midnight UTC.
{
  const a = hebrewDateFor(new Date('2026-10-21T23:59:00Z'), 'UTC');
  const b = hebrewDateFor(new Date('2026-10-22T00:00:00Z'), 'UTC');
  check('UTC basis', a.basis === 'midnight' && b.basis === 'midnight', `${a.basis} ${b.basis}`);
  check('UTC 23:59 = 10 Cheshvan', a.day === 10 && a.afterSunset === false, JSON.stringify(a));
  check('UTC 00:00 = 11 Cheshvan', b.day === 11, JSON.stringify(b));
}

// 5. Invalid zone falls back to New York (workday rule), never throws.
{
  let r; let threw = false;
  try { r = hebrewDateFor(new Date('2026-10-21T22:30:00Z'), 'Not/AZone'); } catch { threw = true; }
  check('invalid tz no throw', !threw);
  check('invalid tz = New York after sunset', r && r.day === 11 && r.basis === 'zone-city', JSON.stringify(r));
}

// 6. Coordinates beat the zone city: Boston on America/New_York sets ~16 min before NYC on 2026-06-21.
{
  const boston = sunsetUtcMs('2026-06-21', 42.3601, -71.0589);
  const nyc = sunsetUtcMs('2026-06-21', 40.71427, -74.00597);
  check('Boston sets before NYC', boston < nyc, `${boston} ${nyc}`);
  const mid = new Date(Math.round((boston + nyc) / 2));
  const withCoords = hebrewDateFor(mid, 'America/New_York', 42.3601, -71.0589);
  const zoneOnly = hebrewDateFor(mid, 'America/New_York');
  check('coords after sunset', withCoords.afterSunset === true && withCoords.basis === 'coords', JSON.stringify(withCoords));
  check('zone-city still before sunset', zoneOnly.afterSunset === false, JSON.stringify(zoneOnly));
}

// 7. Out-of-range coordinates are ignored (zone city), sunsetUtcMs returns null for them.
{
  for (const [la, ln] of [[95, 35], [-91, 35], [31.7, 181], [31.7, -180.5]]) {
    const r = hebrewDateFor(new Date('2026-10-21T16:00:00Z'), 'Asia/Jerusalem', la, ln);
    check(`invalid coords ${la},${ln} -> zone-city`, r.basis === 'zone-city', r.basis);
    check(`sunsetUtcMs invalid ${la},${ln} -> null`, sunsetUtcMs('2026-10-21', la, ln, 'Asia/Jerusalem') === null);
  }
}

// 8. Polar day: no sunset -> midnight fallback, never a NaN date.
{
  const r = hebrewDateFor(new Date('2026-06-21T22:00:00Z'), 'Europe/Oslo', 78.22, 15.65); // Longyearbyen, midnight sun
  check('polar day -> midnight', r.basis === 'midnight' && r.afterSunset === false && Number.isFinite(r.day), JSON.stringify(r));
}

// 9. Every zone in COMMON_TIME_ZONES except UTC has a sunset point.
{
  const { COMMON_TIME_ZONES } = await import('../../src/lib/workday.ts');
  for (const { tz } of COMMON_TIME_ZONES) {
    const r = hebrewDateFor(new Date('2026-10-21T16:00:00Z'), tz);
    check(`zone point ${tz}`, r.basis === (tz === 'UTC' ? 'midnight' : 'zone-city'), r.basis);
  }
}

// 10. Half a coordinate pair is ignored (uses the zone city), NaN never leaks.
{
  const r = hebrewDateFor(new Date('2026-10-21T16:00:00Z'), 'Asia/Jerusalem', 31.77, undefined);
  check('half coords -> zone-city', r.basis === 'zone-city', r.basis);
  const n = hebrewDateFor(new Date('2026-10-21T16:00:00Z'), 'Asia/Jerusalem', NaN, NaN);
  check('NaN coords -> zone-city', n.basis === 'zone-city', n.basis);
}

// 11. An engine without the Hebrew calendar must not show the Gregorian date as if it were Hebrew
//     (Intl silently falls back to another calendar). Simulate it and expect the empty fallback.
{
  const Real = Intl.DateTimeFormat;
  try {
    const Fake = function (locales, options) {
      const f = new Real(locales, options);
      if (String(locales).includes('ca-hebrew')) {
        const g = new Real('he', options); // Gregorian formatter wearing the Hebrew locale tag
        return {
          format: (d) => g.format(d),
          formatToParts: (d) => g.formatToParts(d),
          resolvedOptions: () => ({ ...g.resolvedOptions(), calendar: 'gregory' }),
        };
      }
      return f;
    };
    Fake.supportedLocalesOf = Real.supportedLocalesOf;
    Intl.DateTimeFormat = Fake;
    const r = hebrewDateFor(new Date('2026-10-21T16:00:00Z'), 'Asia/Jerusalem');
    check('no hebrew calendar -> empty text', r.text === '' && r.textShort === '' && r.day === 0, JSON.stringify(r));
  } finally {
    Intl.DateTimeFormat = Real;
  }
  const back = hebrewDateFor(new Date('2026-10-21T16:00:00Z'), 'Asia/Jerusalem');
  check('hebrew calendar restored', back.text === 'י״א בחשוון תשפ״ז', back.text); // 16:00Z is after Jerusalem's 15:00Z sunset
}

console.log(`hebrew-date: ${checks - failures}/${checks} passed (worst sunset diff ${worst.toFixed(2)} min)`);
process.exit(failures ? 1 : 0);
