/**
 * E1 client test: Create Event "Known Mashgiach" list and venue resolution.
 *
 * Don's bug (Oct 21): one venue (Crown Market) with 6 on its team; the
 * dropdown showed only the admin. Cause: the dialog stays mounted and took
 * its venue once, before App's venue list arrived, so venueId stayed '' and
 * the filter kept only venue-less users (admins). These helpers are what the
 * dialog now derives on every render.
 *
 * Run: npx tsx tests/client/test-create-event-mashgichim.mjs
 */
import {
  groupAssignableMashgichim,
  orderedMashgichim,
  resolveEventVenueId,
  resolveMashgiachEmail,
} from '../../src/components/CreateEventModal.tsx';

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}: expected ${e}, got ${a}`);
    failures++;
  } else {
    console.log(`ok ${label}`);
  }
}

const A = 'agency-e1';
const CROWN = 'venue-crown';
const BAKERY = 'venue-bakery';
const venues = [
  { id: CROWN, name: 'Crown Market', agencyId: A },
  { id: BAKERY, name: 'Elm Bakery', agencyId: A },
];
const u = (id, name, role, venueId, agencyId = A) => ({ id, name, role, venueId, agencyId, email: `${id}@t.local` });
const don = u('don', 'Don Kenan', 'admin', undefined);
// Don's case: 1 venue, 6 on the team (Don + 5 added through Team Roster).
const crownTeam = [
  don,
  u('avi', 'Avi Cohen', 'mashgiach', CROWN),
  u('ben', 'Ben Levi', 'mashgiach', CROWN),
  u('chaya', 'Chaya Katz', 'mashgiach', CROWN),
  u('dov', 'Dov Stern', 'coordinator', CROWN),
  u('eli', 'Eli Gold', 'worker', CROWN),
];
const names = (list) => list.map((x) => x.name);

// --- 1. The bug: venues arrive AFTER the first render -----------------------
// First render: App's venues are still [] -> no venue yet.
check('venue before venues load', resolveEventVenueId('', null, []), '');
// The OLD filter with venueId '' kept only venue-less users = the admin.
const oldFilter = (vid) => crownTeam.filter((m) => !m.venueId || m.venueId === vid);
check('old behaviour reproduced: only the admin with venueId ""', names(oldFilter('')), ['Don Kenan']);
// Venues arrive: the venue now resolves without anyone touching the form.
const crownOnly = [venues[0]];
const vid = resolveEventVenueId('', CROWN, crownOnly);
check('venue resolves once venues arrive', vid, CROWN);
check('venue resolves with no current venue (first venue)', resolveEventVenueId('', null, crownOnly), CROWN);
const g1 = groupAssignableMashgichim(crownTeam, don, vid);
check('admin sees all 6 of Crown Market', orderedMashgichim(g1).length, 6);
check('this venue first, then agency-wide', names(orderedMashgichim(g1)), [
  'Avi Cohen', 'Ben Levi', 'Chaya Katz', 'Dov Stern', 'Eli Gold', 'Don Kenan',
]);
check('groups', [g1.thisVenue.length, g1.agencyWide.length, g1.otherVenues.length], [5, 1, 0]);

// --- 2. Admin = whole agency (Don, 12:39 AM) ----------------------------------
const twoVenueTeam = [...crownTeam, u('fay', 'Fay Bloom', 'mashgiach', BAKERY), u('gil', 'Gil Roth', 'coordinator', BAKERY)];
const g2 = groupAssignableMashgichim(twoVenueTeam, don, CROWN);
check('admin: other venues listed last', names(g2.otherVenues), ['Fay Bloom', 'Gil Roth']);
check('admin: total', orderedMashgichim(g2).length, 8);
const g2b = groupAssignableMashgichim(twoVenueTeam, don, BAKERY);
check('admin on the bakery: bakery first', names(g2b.thisVenue), ['Fay Bloom', 'Gil Roth']);

// --- 3. Rule T: coordinator = own venue (+ admins), fail closed --------------
const dov = twoVenueTeam.find((x) => x.id === 'dov');
const g3 = groupAssignableMashgichim(twoVenueTeam, dov, CROWN);
check('coordinator: never other venues', g3.otherVenues.length, 0);
check('coordinator: own venue + admins', names(orderedMashgichim(g3)), [
  'Avi Cohen', 'Ben Levi', 'Chaya Katz', 'Dov Stern', 'Eli Gold', 'Don Kenan',
]);
const venueLessCoord = u('x', 'No Venue', 'coordinator', undefined);
check('coordinator without a venue: nobody', orderedMashgichim(groupAssignableMashgichim(twoVenueTeam, venueLessCoord, CROWN)).length, 0);
check('no signed-in user: nobody', orderedMashgichim(groupAssignableMashgichim(twoVenueTeam, null, CROWN)).length, 0);

// --- 4. Agency boundary and roles -------------------------------------------
const outsider = u('zed', 'Zed Other', 'mashgiach', CROWN, 'agency-other');
const owner = u('own', 'Olga Owner', 'owner', CROWN);
const g4 = groupAssignableMashgichim([...crownTeam, outsider, owner], don, CROWN);
check('other agency never listed', names(orderedMashgichim(g4)).includes('Zed Other'), false);
check('venue owner not assignable', names(orderedMashgichim(g4)).includes('Olga Owner'), false);
const legacy = { ...u('leg', 'Lea Legacy', 'mashgiach', CROWN), agencyId: undefined };
const hkcAdmin = { ...don, agencyId: undefined };
check('missing agencyId = agency-hkc on both sides', names(orderedMashgichim(groupAssignableMashgichim([hkcAdmin, legacy], hkcAdmin, CROWN))), ['Lea Legacy', 'Don Kenan']);
check('missing agencyId never leaks into another agency', names(orderedMashgichim(groupAssignableMashgichim([legacy], don, CROWN))), []);

// --- 5. Deliberate picks survive refreshes; stale ones are repaired ----------
check('valid deliberate venue survives a list refresh', resolveEventVenueId(BAKERY, CROWN, venues), BAKERY);
check('invalid picked venue is repaired', resolveEventVenueId('venue-gone', CROWN, venues), CROWN);
check('current venue not in list -> first venue', resolveEventVenueId('', 'venue-gone', venues), CROWN);
const ordered = orderedMashgichim(g1);
check('default mashgiach = first listed person', resolveMashgiachEmail('', ordered), 'avi@t.local');
check('manual pick kept (case-insensitive)', resolveMashgiachEmail('ELI@t.local', ordered), 'eli@t.local');
check('placeholder email never submitted', resolveMashgiachEmail('kenan@hartfordkashrut.org', ordered), 'avi@t.local');
check('empty list -> no one', resolveMashgiachEmail('avi@t.local', []), '');
const noEmails = ordered.map(({ email, ...rest }) => rest);
check('no emails in the roster -> no one', resolveMashgiachEmail('', noEmails), '');

if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
