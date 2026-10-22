/**
 * QA2 batch B client test (Codex lane).
 *  T*  #4 clock times: "16:00 PM" -> "4:00 PM", 24-hour -> 12-hour, unknown text kept.
 *  V*  #7 venue edit: only changed fields, trimmed; empty name/type refused; Other type.
 *  R*  #6 report failure text: 403 is a plain reason, never empty.
 *  N*  #8 no venue: admins get the setup screen, others one plain message; VENUE_REMOVED sign-in text.
 *  S*  source checks: defaults and wiring in the components.
 * Run: npx tsx tests/client/test-qa2-batch-b.mjs
 */
import fs from 'node:fs';
import { formatClockTime, formatTimeRange } from '../../src/lib/clockTime.ts';
import { venueEdits, VENUE_TYPES } from '../../src/components/EditVenueSheet.tsx';
import { reportFailText } from '../../src/components/SubmitAuditReportModal.tsx';
import { noVenueMessage, signInErrorText, VENUE_REMOVED_TEXT, NO_VENUE_TEXT } from '../../src/lib/venueRemoved.ts';

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const eq = (label, a, b) => ok(label, a === b, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// T — clock times
const T = [
  ['16:00 PM', '4:00 PM'], ['14:30 PM', '2:30 PM'], ['08:30 AM', '8:30 AM'], ['11:00 AM', '11:00 AM'],
  ['16:00', '4:00 PM'], ['9:05', '9:05 AM'], ['12:00', '12:00 PM'], ['00:15', '12:15 AM'], ['12:00 AM', '12:00 AM'],
  ['7pm', '7:00 PM'], ['7 p.m.', '7:00 PM'], ['7:30pm', '7:30 PM'], ['  4:00 pm ', '4:00 PM'], ['13:00 AM', '1:00 PM'],
  ['after Maariv', 'after Maariv'], ['7', '7'], ['25:00', '25:00'], ['10:75', '10:75'], ['', ''],
];
for (const [i, o] of T) eq(`T formatClockTime(${JSON.stringify(i)})`, formatClockTime(i), o);
eq('T non-string -> empty', formatClockTime(undefined), '');
eq('T range both', formatTimeRange('11:00 AM', '16:00 PM'), '11:00 AM – 4:00 PM');
eq('T range start only (no dangling dash)', formatTimeRange('18:00', ''), '6:00 PM');
eq('T range none', formatTimeRange('', undefined), '');

// V — venue edits
const v = { name: 'Crown Market', address: '2471 Albany Ave', category: 'Restaurant' };
const f = (o) => ({ name: v.name, address: v.address, type: 'Restaurant', otherType: '', ...o });
eq('V nothing changed -> null', venueEdits(v, f({})), null);
eq('V whitespace only change -> null', venueEdits(v, f({ name: '  Crown Market ' })), null);
ok('V name change only', JSON.stringify(venueEdits(v, f({ name: ' Crown Deli ' }))) === JSON.stringify({ name: 'Crown Deli' }));
ok('V address change only', JSON.stringify(venueEdits(v, f({ address: '1 Main St' }))) === JSON.stringify({ address: '1 Main St' }));
ok('V type change', JSON.stringify(venueEdits(v, f({ type: 'Bakery' }))) === JSON.stringify({ category: 'Bakery' }));
ok('V Other type uses the typed text', JSON.stringify(venueEdits(v, f({ type: 'Other', otherType: ' Butcher ' }))) === JSON.stringify({ category: 'Butcher' }));
eq('V empty name refused', venueEdits(v, f({ name: '   ' })), 'Enter the venue name.');
eq('V empty Other type refused', venueEdits(v, f({ type: 'Other', otherType: ' ' })), 'Enter the venue type.');
ok('V long name refused', typeof venueEdits(v, f({ name: 'x'.repeat(121) })) === 'string');
ok('V address can be cleared', JSON.stringify(venueEdits(v, f({ address: '' }))) === JSON.stringify({ address: '' }));
ok('V types match New Venue', ['Industrial', 'Food Service', 'Restaurant', 'Catering', 'Bakery'].every((t) => VENUE_TYPES.includes(t)));

// R — report failure text
ok('R 403 is a plain reason', /can't file this report/.test(reportFailText(403, 'You can only submit factory reports at your own venue.')));
eq('R other status keeps the server words', reportFailText(400, 'venueId is required to submit a factory report.'), 'venueId is required to submit a factory report.');
ok('R no server words -> not empty', reportFailText(500).length > 10);
ok('R network -> connection hint', /connection/.test(reportFailText(0)));

// N — no venue
eq('N admin -> null (setup screen)', noVenueMessage({ role: 'admin', venueId: 'v1' }), null);
eq('N owner whose venue is gone', noVenueMessage({ role: 'owner', venueId: 'gone' }), VENUE_REMOVED_TEXT);
eq('N staff with venueIds', noVenueMessage({ role: 'mashgiach', venueIds: ['gone'] }), VENUE_REMOVED_TEXT);
eq('N staff never given a venue', noVenueMessage({ role: 'worker' }), NO_VENUE_TEXT);
eq('N no user -> null', noVenueMessage(null), null);
eq('N sign-in VENUE_REMOVED', signInErrorText({ code: 'VENUE_REMOVED', error: 'x' }, 'fb'), VENUE_REMOVED_TEXT);
eq('N sign-in other error kept', signInErrorText({ error: 'Invalid email or password.' }, 'fb'), 'Invalid email or password.');
eq('N sign-in no body -> fallback', signInErrorText(null, 'fb'), 'fb');

// S — source wiring
const src = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const cem = src('src/components/CreateEventModal.tsx');
ok('S new event: no "16:00 PM" default', !cem.includes("'16:00 PM'") && cem.includes("useState('4:00 PM')"));
ok('S new event: times tidied on save', cem.includes('startTime: formatClockTime(startTime)') && cem.includes('endTime: formatClockTime(endTime)'));
const sar = src('src/components/SubmitAuditReportModal.tsx');
ok('S audit form: no "14:30 PM"/"08:30 AM"', !sar.includes('14:30 PM') && !sar.includes('08:30 AM'));
ok('S audit form: error sits above the buttons', sar.indexOf('role="alert"') > sar.indexOf('Signature Block') && sar.indexOf('role="alert"') < sar.indexOf('{/* Actions */}'));
const evm = src('src/components/EventsModal.tsx');
ok('S events list/details use the formatter', evm.includes('formatClockTime(evt.startTime)') && evm.includes('formatTimeRange(activeEvent.startTime, activeEvent.endTime)'));
const app = src('src/App.tsx');
ok('S App: no-venue notice before the admin setup screen', app.indexOf('noVenueMessage(currentUser) ?') > 0 && app.indexOf('noVenueMessage(currentUser) ?') < app.indexOf('Establish First Kosher Venue'));
const hdr = src('src/components/Header.tsx');
ok('S header: venue name is no longer hidden on phones with a logo', !hdr.includes("agencyLogoSrc ? ' max-sm:hidden'"));
const vdm = src('src/components/VenuesDirectoryModal.tsx');
ok('S venues: Edit venue opens the sheet (admin only)', vdm.includes('data-edit-venue') && vdm.includes('<EditVenueSheet'));
{ const btn = (vdm.match(/<button[^]*?data-edit-venue[^]*?className="([^"]*)"/) || [])[1] || '';
  ok('S venues: Edit venue is a 44px target on phones (min-h-11 min-w-11)', btn.split(' ').includes('min-h-11') && btn.split(' ').includes('min-w-11'), btn); }

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
