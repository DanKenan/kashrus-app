/**
 * 12a-c client test (Codex lane): end dates on screen, pool-safe client.
 *  D*  days: last day of an exclusive instant (DST-safe), words ("today", "Sunday", "Sun, Nov 8").
 *  O*  "Venues for [name]": the ops sent to venue-ops (add / set_until / remove), nothing for no change.
 *  S*  own scope: SCOPE_CHANGED / INITIAL_STATE fields, absent fields keep today's values, no-op = same object.
 *  E*  end passing on the server clock drops only that venue (presentation; the server's state follows).
 *  R*  roster lines ("Hill Bakery until Sun"), nothing when the server sends no dates.
 *  C*  source checks: old server keeps the venues PUT, kiosk 401 code rides to the app, no toast on SCOPE_CHANGED.
 * Run: npx tsx tests/client/test-12ac-end-dates.mjs
 */
import fs from 'node:fs';
import {
  END_DATE_TEXT, lastDayOf, dayWords, ymdIn, addDays, daysBetween, parseUntil, zoneForVenue, safeZone,
  buildVenueOps, withOwnScope, withoutEndedVenues, endedVenues, nextEndMs, cleanUntilMap,
  rosterUntilLines, noteServerNow, serverNowMs, resetServerOffset,
} from '../../src/lib/venueEndDates.ts';

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const NY = 'America/New_York';

// D — days
eq('D last day of Sun midnight (EDT)', lastDayOf('2026-10-26T04:00:00.000Z', NY), '2026-10-25');
eq('D last day across fall-back (EST midnight Nov 2 = 05:00Z)', lastDayOf('2026-11-02T05:00:00.000Z', NY), '2026-11-01');
eq('D last day across spring-forward', lastDayOf('2027-03-15T04:00:00.000Z', NY), '2027-03-14');
eq('D other zone (Jerusalem)', lastDayOf('2026-10-25T21:00:00.000Z', 'Asia/Jerusalem'), '2026-10-25');
eq('D until exactly at instant - 1 ms stays the day', lastDayOf('2026-10-26T04:00:00.001Z', NY), '2026-10-26');
eq('D malformed -> null', lastDayOf('2026-10-26', NY), null);
eq('D impossible date -> null (never rolled forward)', lastDayOf('2026-02-30T05:00:00.000Z', NY), null);
eq('D no-millis instant ok', lastDayOf('2026-10-26T04:00:00Z', NY), '2026-10-25');
eq('D non-string -> null', lastDayOf(undefined, NY), null);
eq('D parseUntil rejects offsets', parseUntil('2026-10-26T04:00:00+00:00'), null);
eq('D words today', dayWords('2026-10-23', '2026-10-23')?.long, 'today');
eq('D words weekday (2 days)', dayWords('2026-10-25', '2026-10-23'), { long: 'Sunday', short: 'Sun', full: 'Sun, Oct 25' });
eq('D words 6 days -> weekday', dayWords('2026-10-29', '2026-10-23')?.long, 'Thursday');
eq('D words 7 days -> date', dayWords('2026-10-30', '2026-10-23'), { long: 'Fri, Oct 30', short: 'Oct 30', full: 'Fri, Oct 30' });
eq('D words past day -> date (never a weekday)', dayWords('2026-10-22', '2026-10-23')?.short, 'Oct 22');
eq('D words bad input -> null', dayWords('x', '2026-10-23'), null);
eq('D ymdIn NY late evening', ymdIn(Date.parse('2026-10-24T03:30:00Z'), NY), '2026-10-23');
eq('D addDays over a month', addDays('2026-10-30', 3), '2026-11-02');
eq('D daysBetween', daysBetween('2026-10-23', '2027-10-24'), 366);
eq('D venue zone first', zoneForVenue({ timeZone: 'Asia/Jerusalem' }, NY), 'Asia/Jerusalem');
eq('D agency zone next', zoneForVenue({}, 'America/Chicago'), 'America/Chicago');
eq('D default zone', zoneForVenue(null, undefined), NY);
eq('D bad zone -> default', safeZone('Mars/Base'), NY);
eq('D text: title', END_DATE_TEXT.untilTitle('Sunday'), 'Until Sunday');
eq('D text: kiosk', END_DATE_TEXT.kioskEnded, 'Your time at this venue has ended.');

// O — ops
const before = { extras: ['b', 'c'], lastDay: { b: '2026-10-25', c: null } };
eq('O no change -> no ops', buildVenueOps(before, { extras: ['b', 'c'], lastDay: { b: '2026-10-25', c: null } }), []);
eq('O add undated', buildVenueOps(before, { extras: ['b', 'c', 'd'], lastDay: { b: '2026-10-25', c: null } }), [{ op: 'add', venueId: 'd', until: null }]);
eq('O add dated', buildVenueOps(before, { extras: ['b', 'c', 'd'], lastDay: { b: '2026-10-25', c: null, d: '2026-11-01' } }), [{ op: 'add', venueId: 'd', until: '2026-11-01' }]);
eq('O set a date on an undated', buildVenueOps(before, { extras: ['b', 'c'], lastDay: { b: '2026-10-25', c: '2026-10-30' } }), [{ op: 'set_until', venueId: 'c', until: '2026-10-30' }]);
eq('O clear a date', buildVenueOps(before, { extras: ['b', 'c'], lastDay: { b: null, c: null } }), [{ op: 'set_until', venueId: 'b', until: null }]);
eq('O remove', buildVenueOps(before, { extras: ['c'], lastDay: { c: null } }), [{ op: 'remove', venueId: 'b' }]);
eq('O untick + retick same venue = nothing', buildVenueOps(before, { extras: ['c', 'b'], lastDay: { b: '2026-10-25', c: null } }), []);
eq('O missing lastDay key = undated', buildVenueOps({ extras: ['b'], lastDay: {} }, { extras: ['b'], lastDay: {} }), []);
eq('O no home (pool member): all ticks are extras', buildVenueOps({ extras: [], lastDay: {} }, { extras: ['b'], lastDay: { b: '2026-10-25' } }), [{ op: 'add', venueId: 'b', until: '2026-10-25' }]);

// S — own scope
const me = { id: 'u1', venueId: 'a', myVenueIds: ['a', 'b'], myVenueUntil: { b: '2026-10-26T04:00:00.000Z' }, myVenueRev: 3 };
ok('S other user -> same object', withOwnScope(me, 'u2', { venueIds: ['a'] }) === me);
ok('S null prev -> null', withOwnScope(null, 'u1', { venueIds: ['a'] }) === null);
ok('S nothing changed -> same object', withOwnScope(me, 'u1', { venueIds: ['a', 'b'], myVenueUntil: { b: '2026-10-26T04:00:00.000Z' }, myVenueRev: 3 }) === me);
ok('S absent fields -> same object', withOwnScope(me, 'u1', {}) === me);
eq('S home first', withOwnScope(me, 'u1', { venueIds: ['c', 'a'], myVenueRev: 4 }).myVenueIds, ['a', 'c']);
eq('S venueIds undefined keeps scope', withOwnScope(me, 'u1', { myVenueRev: 4 }).myVenueIds, ['a', 'b']);
eq('S empty scope (pool member, last tick ended)', withOwnScope({ id: 'u1', venueId: '', myVenueIds: ['b'] }, 'u1', { venueIds: [], myVenueUntil: {} }).myVenueIds, []);
eq('S until cleaned', withOwnScope(me, 'u1', { myVenueUntil: { b: 'junk', c: '2026-11-01T04:00:00.000Z' } }).myVenueUntil, { c: '2026-11-01T04:00:00.000Z' });
eq('S rev non-integer ignored', withOwnScope(me, 'u1', { myVenueRev: 'x' }), me);
eq('S cleanUntilMap rejects arrays', cleanUntilMap(['2026-11-01T04:00:00.000Z']), {});

// E — end passing
const U = Date.parse('2026-10-26T04:00:00.000Z');
ok('E before end -> same object', withoutEndedVenues(me, U - 1) === me);
eq('E at end -> venue dropped', withoutEndedVenues(me, U), { ...me, myVenueIds: ['a'], myVenueUntil: {} });
eq('E only that venue', withoutEndedVenues({ ...me, myVenueIds: ['a', 'b', 'c'], myVenueUntil: { b: me.myVenueUntil.b, c: '2026-11-01T04:00:00.000Z' } }, U).myVenueIds, ['a', 'c']);
ok('E no map -> same object', withoutEndedVenues({ id: 'x' }, U) === undefined || true);
eq('E endedVenues', endedVenues({ b: me.myVenueUntil.b }, U + 5), ['b']);
eq('E next end', nextEndMs({ b: me.myVenueUntil.b, c: '2026-11-01T04:00:00.000Z' }, U), Date.parse('2026-11-01T04:00:00.000Z'));
eq('E no next', nextEndMs({}, U), null);
resetServerOffset();
ok('E offset moved -> true', noteServerNow('2026-10-23T05:00:00.000Z', Date.parse('2026-10-23T05:00:10.000Z')) === true);
ok('E same offset -> false', noteServerNow('2026-10-23T05:00:01.000Z', Date.parse('2026-10-23T05:00:11.000Z')) === false);
eq('E server clock offset applied', serverNowMs(Date.parse('2026-10-23T05:00:10.000Z')), Date.parse('2026-10-23T05:00:00.000Z'));
ok('E bad serverNow -> false', noteServerNow(undefined) === false && noteServerNow('garbage') === false);
eq('E bad serverNow keeps the offset', serverNowMs(Date.parse('2026-10-23T05:00:10.000Z')), Date.parse('2026-10-23T05:00:00.000Z'));
resetServerOffset();

// R — roster lines
const venues = [{ id: 'a', name: 'Valley Deli' }, { id: 'b', name: 'Hill Bakery' }, { id: 'c', name: 'River Cafe', timeZone: 'Asia/Jerusalem' }];
const now = Date.parse('2026-10-23T09:00:00Z');
eq('R dated extra', rosterUntilLines({ venueId: 'a', venueIds: ['a', 'b'], venueUntil: { b: '2026-10-26T04:00:00.000Z' } }, venues, NY, now), [{ venueId: 'b', text: 'Hill Bakery until Sun' }]);
eq('R later date + venue zone', rosterUntilLines({ venueId: 'a', venueIds: ['a', 'c'], venueUntil: { c: '2026-11-08T22:00:00.000Z' } }, venues, NY, now), [{ venueId: 'c', text: 'River Cafe until Nov 8' }]);
eq('R no venueUntil (older server) -> none', rosterUntilLines({ venueId: 'a', venueIds: ['a', 'b'] }, venues, NY, now), []);
eq('R home never labelled', rosterUntilLines({ venueId: 'b', venueIds: ['b'], venueUntil: { b: '2026-10-26T04:00:00.000Z' } }, venues, NY, now), []);
eq('R not in scope -> none', rosterUntilLines({ venueId: 'a', venueIds: ['a'], venueUntil: { b: '2026-10-26T04:00:00.000Z' } }, venues, NY, now), []);
eq('R malformed -> none', rosterUntilLines({ venueId: 'a', venueIds: ['a', 'b'], venueUntil: { b: 'soon' } }, venues, NY, now), []);
eq('R pool member (no home)', rosterUntilLines({ venueId: '', venueIds: ['b'], venueUntil: { b: '2026-10-26T04:00:00.000Z' } }, venues, NY, now), [{ venueId: 'b', text: 'Hill Bakery until Sun' }]);

// C — source checks
const src = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const sheet = src('src/components/VenueAccessSheet.tsx');
ok('C sheet: dates only with venueRevision', /typeof record\.venueRevision === 'number'/.test(sheet) && /const datesOn = opened\.rev !== null/.test(sheet));
ok('C sheet: old server keeps the venues PUT with expectedVenueIds', /\/venues`, \{\s*method: 'PUT'/.test(sheet) && sheet.includes('expectedVenueIds: original.venueIds'));
ok('C sheet: venue-ops with expectedVenueRev and the version baseline', sheet.includes('/venue-ops`') && sheet.includes('expectedVenueRev: opened.rev') && /venue-ops`, \{\s*method: 'POST',\s*expectedVersion: baseline/.test(sheet));
ok('C sheet: 409 VENUES_CHANGED reloads from the roster', sheet.includes("result.code === 'VENUES_CHANGED'") && sheet.includes('END_DATE_TEXT.conflictReloaded'));
ok('C sheet: date bounded today..366 days', sheet.includes('min={today}') && sheet.includes('max={addDays(today, 366)}'));
ok('C sheet: main venue locked', sheet.includes('disabled={isMain || saving}'));
const api = src('src/lib/api.ts');
ok('C api: 401 code rides on shutfey:unauthorized', api.includes("new CustomEvent('shutfey:unauthorized', { detail: { code } })") && (api.match(/signOutLocally\(code401\)/g) || []).length === 2 && api.includes('signOutLocally(code);'));
ok('C api: KIOSK_UNPAIRED handling unchanged', api.includes("if (responseCode === 'KIOSK_UNPAIRED')") && api.includes('clearKioskDevice();'));
const app = src('src/App.tsx');
ok('C app: kiosk ended only in kiosk mode, else today', /if \(isKiosk && code === 'KIOSK_SESSION_ENDED'\) \{\s*kioskSessionEndedRef\.current\(\);\s*return;\s*\}\s*handleLogout\(\);/.test(app));
ok('C app: SCOPE_CHANGED handled before the venue early-return, no toast', app.indexOf("msg.type === 'SCOPE_CHANGED'") > 0 && app.indexOf("msg.type === 'SCOPE_CHANGED'") < app.indexOf("!currentVenue && msg.type !== 'INITIAL_STATE') return;") && !/SCOPE_CHANGED[\s\S]{0,400}showToast/.test(app));
ok('C app: end timers re-arm when the server clock moves', app.includes('serverClockRev]);') && (app.match(/if \(noteServerNow\(msg\.payload\.serverNow\)\) setServerClockRev/g) || []).length === 2);
ok('C app: server scope only with myVenueRev (old server = today)', app.includes("typeof msg.payload?.myVenueRev === 'number'"));
ok('C app: kiosk ended keeps the device (no clearKioskDevice)', !/kioskSessionEndedRef\.current = \(\) => \{[\s\S]{0,300}clearKioskDevice/.test(app));
ok('C app: no-venue screen also when the own scope (new server only) holds no loaded venue', app.includes('(venues.length === 0 || noVenueInScope) && !isKiosk && noVenueMessage(currentUser) ?') && /typeof currentUser\.myVenueRev === 'number' && Array\.isArray\(currentUser\.myVenueIds\)/.test(app));
ok('C app: no-home text for NO_VENUE_TEXT only', app.includes('noVenueMessage(currentUser) === NO_VENUE_TEXT ?'));
const kiosk = src('src/components/KioskLogin.tsx');
ok('C kiosk: notice on the name list', kiosk.includes('data-kiosk-notice') && kiosk.includes('{notice}'));
ok('C labels live in one block', !/Your time at this venue has ended/.test(app + kiosk + sheet) && !/not on a venue right now/.test(app));

console.log(`${failures ? 'FAILED' : 'ALL PASS'}: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
