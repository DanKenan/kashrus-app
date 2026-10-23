/**
 * 12b-c client test (Codex lane): the Mashgiach Pool on the client.
 *  R*  rule T on the client: who may open the Pool, which venues an owner/coordinator may tick.
 *  P*  GET /api/pool parsing (fail closed), admin vs manager shape, count, contact invite de-dup.
 *  B*  borrow list parsing (name + main venue only).
 *  L*  row lines: active tick wins, last venue, invite expiry, details only.
 *  F*  Add to Pool form checks (one of phone/email, invite needs email).
 *  O*  owner/coordinator ops are additions only (never touch other venues).
 *  T*  Team tab: Pool-only ids, "From Pool" tag.
 *  C*  source checks: tabs, owner entry, no-venue "+" hidden, POOL_UPDATED event, one text block.
 * Run: npx tsx tests/client/test-12bc-pool.mjs
 */
import fs from 'node:fs';
import {
  POOL_TEXT, mayOpenPool, ownVenuesForPool, parsePool, parseBorrow, poolCount, memberWhereLine, contactStatusLine,
  inviteStatusLine, validateAddForm, tickOps, poolOnlyIds, isFromPool, parseOpenWork, poolErrorText,
} from '../../src/lib/pool.ts';

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const NY = 'America/New_York';
const venues = [
  { id: 'v-a', name: 'Valley Deli' }, { id: 'v-b', name: 'Hill Bakery' }, { id: 'v-c', name: 'River Cafe' },
];
const NOW = Date.parse('2026-10-23T14:00:00.000Z'); // Fri Oct 23, 10 AM New York

// R — rule T
eq('R admin may open', mayOpenPool({ role: 'admin' }), true);
eq('R coordinator may open', mayOpenPool({ role: 'coordinator' }), true);
eq('R owner may open', mayOpenPool({ role: 'owner' }), true);
for (const role of ['mashgiach', 'worker', 'kiosk', '', undefined]) eq(`R ${role} may not`, mayOpenPool({ role }), false);
eq('R kiosk device never', mayOpenPool({ role: 'admin' }, true), false);
eq('R null never', mayOpenPool(null), false);
eq('R admin: every venue', ownVenuesForPool({ role: 'admin' }, venues).map((v) => v.id), ['v-a', 'v-b', 'v-c']);
eq('R owner: home only', ownVenuesForPool({ role: 'owner', venueId: 'v-b' }, venues).map((v) => v.id), ['v-b']);
eq('R owner with no home: none', ownVenuesForPool({ role: 'owner', venueId: '' }, venues).map((v) => v.id), []);
eq('R coordinator: own scope (server scope wins)', ownVenuesForPool({ role: 'coordinator', venueId: 'v-a', venueIds: ['v-a', 'v-b'], myVenueRev: 3, myVenueIds: ['v-a'] }, venues).map((v) => v.id), ['v-a']);
eq('R coordinator: legacy scope', ownVenuesForPool({ role: 'coordinator', venueId: 'v-a', venueIds: ['v-c'] }, venues).map((v) => v.id), ['v-a', 'v-c']);
eq('R coordinator with no venue: none', ownVenuesForPool({ role: 'coordinator', venueId: '', myVenueRev: 2, myVenueIds: [] }, venues).map((v) => v.id), []);
eq('R mashgiach: none', ownVenuesForPool({ role: 'mashgiach', venueId: 'v-a' }, venues).map((v) => v.id), []);

// P — parsing
const adminPayload = {
  members: [
    { id: 'u2', name: 'Moshe Adler', role: 'mashgiach', email: 'm@x.test', hasKioskPin: true, venueIds: [], venueRevision: 4, lastVenueId: 'v-b', lastVenueName: 'Hill Bakery', lastVenueTo: '2026-10-26T04:00:00.000Z' },
    { id: 'u1', name: 'Dana Stein', role: 'mashgiach', venueIds: ['v-a'], venueUntil: { 'v-a': '2026-10-26T04:00:00.000Z' }, venueRevision: 2 },
    { id: 7, name: 'bad id' }, null, 'x',
  ],
  invites: [
    { id: 'i1', name: 'Eli Gold', email: 'eli@x.test', role: 'mashgiach', expiresAt: '2026-10-30T14:00:00.000Z' },
    { id: 'i2', name: 'Rina Katz', email: 'RINA@x.test', role: 'mashgiach', expiresAt: '2026-10-29T14:00:00.000Z' },
  ],
  contacts: [
    { id: 'c1', name: 'Rina Katz', email: 'rina@x.test', status: 'invited', createdAt: 'a', updatedAt: 'b' },
    { id: 'c2', name: 'Avi Levin', phone: '+15551230000', note: 'Weekends', status: 'details', createdAt: 'a', updatedAt: 'b' },
    { id: 'c3', name: 'Old Invite', email: 'old@x.test', status: 'invited', inviteExpired: true, createdAt: 'a', updatedAt: 'b' },
    { name: 'no id' },
  ],
};
const P = parsePool(adminPayload);
eq('P malformed members dropped, sorted', P.members.map((m) => m.id), ['u1', 'u2']);
eq('P full shape', P.full, true);
eq('P contact invite not listed twice (case-insensitive email)', P.invites.map((i) => i.id), ['i1']);
eq('P contact carries its invite expiry', P.contacts.find((c) => c.id === 'c1').inviteExpiresAt, '2026-10-29T14:00:00.000Z');
eq('P contacts sorted, malformed dropped', P.contacts.map((c) => c.id), ['c2', 'c3', 'c1']);
eq('P count = members + contacts + invites (admin)', poolCount(P), 2 + 3 + 1);
const M = parsePool({ members: [{ id: 'u2', name: 'Moshe Adler', role: 'mashgiach', venueRevision: 4, lastVenueId: 'v-b', lastVenueName: 'Hill Bakery', lastVenueTo: 'x', email: 'leak@x.test' }] });
eq('P manager shape: not full, no contacts/invites', [M.full, M.contacts.length, M.invites.length], [false, 0, 0]);
eq('P manager count = members only', poolCount(M), 1);
eq('P garbage -> empty', parsePool(null), { members: [], invites: [], contacts: [], full: false });
eq('P count of null', poolCount(null), 0);
ok('P unknown status is details', parsePool({ contacts: [{ id: 'c', name: 'n', status: 'weird' }] }).contacts[0].status === 'details');

// B — borrow
eq('B parse', parseBorrow({ people: [{ id: 'u9', name: 'Yael Brandt', homeVenueId: 'v-c', homeVenueName: 'River Cafe', venueRevision: 1, email: 'no@x' }, { id: 'u8' }] }),
  [{ id: 'u9', name: 'Yael Brandt', homeVenueId: 'v-c', homeVenueName: 'River Cafe', venueRevision: 1 }]);
eq('B garbage', parseBorrow({}), []);

// L — lines
eq('L active tick wins with its end', memberWhereLine(P.members[0], venues, NY, NOW), 'At Valley Deli until Sunday');
eq('L last venue with last day', memberWhereLine(P.members[1], venues, NY, NOW), 'Last at Hill Bakery until Sunday');
eq('L never at a venue', memberWhereLine({ id: 'z', name: 'Z', role: 'mashgiach' }, venues, NY, NOW), POOL_TEXT.neverAt);
eq('L active undated', memberWhereLine({ id: 'z', name: 'Z', role: 'mashgiach', venueIds: ['v-c', 'v-a'] }, venues, NY, NOW), 'At Valley Deli +1');
eq('L deleted venue ignored', memberWhereLine({ id: 'z', name: 'Z', role: 'mashgiach', venueIds: ['gone'] }, venues, NY, NOW), POOL_TEXT.neverAt);
eq('L details only', contactStatusLine(P.contacts.find((c) => c.id === 'c2')), 'Details only');
eq('L invite expired', contactStatusLine(P.contacts.find((c) => c.id === 'c3')), 'Invite expired');
ok('L invite sent with day', /^Invite sent · expires /.test(contactStatusLine(P.contacts.find((c) => c.id === 'c1'), NY, NOW)), contactStatusLine(P.contacts.find((c) => c.id === 'c1'), NY, NOW));
eq('L invite past -> expired', inviteStatusLine({ id: 'i', name: 'n', email: 'e', role: '', expiresAt: '2026-10-01T00:00:00.000Z' }, NY, NOW), 'Invite expired');
eq('L invite malformed -> expired', inviteStatusLine({ id: 'i', name: 'n', email: 'e', role: '', expiresAt: 'soon' }, NY, NOW), 'Invite expired');

// F — form
const f = (o) => ({ name: 'Avi Levin', phone: '', email: '', note: '', ...o });
eq('F needs phone or email', validateAddForm(f({}), false), POOL_TEXT.oneRequired);
eq('F phone only, keep details: ok', validateAddForm(f({ phone: '555 123 0000' }), false), null);
eq('F phone only, invite: needs email', validateAddForm(f({ phone: '555' }), true), POOL_TEXT.inviteNeedsEmail);
eq('F email + invite: ok', validateAddForm(f({ email: 'a@b.co' }), true), null);
eq('F bad email', validateAddForm(f({ email: 'nope' }), false), 'Enter a valid email address.');
eq('F empty name', validateAddForm(f({ name: '  ', email: 'a@b.co' }), false), 'Enter a name.');
eq('F long name', validateAddForm(f({ name: 'x'.repeat(81), email: 'a@b.co' }), false), 'Names can be up to 80 characters.');
eq('F long note', validateAddForm(f({ email: 'a@b.co', note: 'x'.repeat(141) }), false), 'Notes can be up to 140 characters.');

// O — ops
eq('O additions only', tickOps([{ venueId: 'v-a', lastDay: '2026-10-25' }, { venueId: 'v-b', lastDay: null }]),
  [{ op: 'add', venueId: 'v-a', until: '2026-10-25' }, { op: 'add', venueId: 'v-b', until: null }]);
eq('O nothing picked = no ops', tickOps([]), []);
eq('O error words: already ticked', poolErrorText({ ok: false, status: 409, data: null, error: 'x', code: 'ALREADY_TICKED' }), POOL_TEXT.alreadyThere);
eq('O error words: changed', poolErrorText({ ok: false, status: 409, data: null, error: 'x', code: 'VENUES_CHANGED' }), POOL_TEXT.changed);
eq('O error words: server text', poolErrorText({ ok: false, status: 400, data: null, error: 'Choose an end date for borrowed help.', code: 'UNTIL_REQUIRED' }), 'Choose an end date for borrowed help.');
eq('O open work parse', parseOpenWork({ openWork: { tasks: [{ id: 't', title: 'T', venueId: 'v-a' }, null], events: 'x' } }), { tasks: [{ id: 't', title: 'T', venueId: 'v-a' }], events: [] });
eq('O open work garbage', parseOpenWork(null), { tasks: [], events: [] });

// T — Team tab
eq('T Pool-only ids are members with no venue now', [...poolOnlyIds(P)], ['u2']);
eq('T none without data', [...poolOnlyIds(null)], []);
eq('T From Pool: member holding a venue', isFromPool({ id: 'u1', role: 'mashgiach', venueId: '', venueIds: ['v-a'] }, P), true);
eq('T not From Pool: has a main venue', isFromPool({ id: 'u1', role: 'mashgiach', venueId: 'v-a', venueIds: ['v-a'] }, P), false);
eq('T not From Pool: venue-removed row the server does not list', isFromPool({ id: 'q', role: 'mashgiach', venueId: '', venueIds: ['v-a'] }, P), false);
eq('T not From Pool: no data', isFromPool({ id: 'u1', role: 'mashgiach', venueId: '', venueIds: ['v-a'] }, null), false);

// C — source checks
const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const team = fs.readFileSync(new URL('../../src/components/TeamModal.tsx', import.meta.url), 'utf8');
const header = fs.readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../../src/components/PoolPanel.tsx', import.meta.url), 'utf8');
ok('C no-venue screen hides the gold "+" (PhoneNav hasVenues)', /hasVenues=\{venues\.length > 0 && !noVenueInScope\}/.test(app));
ok('C POOL_UPDATED becomes a window event', /msg\.type === 'POOL_UPDATED'[\s\S]{0,200}POOL_UPDATED_EVENT/.test(app));
ok('C owner Pool entry only for owners, never kiosk', /onOpenPool=\{currentUser\?\.role === 'owner' && !isKiosk/.test(app));
ok('C Pool modal mounted for owners only', /currentUser\.role === 'owner' && !isKiosk && \(\s*<PoolModal/.test(app));
ok('C Header shows Pool only when given', /\{onOpenPool && \(/.test(header));
ok('C Team tabs only for admin/coordinator', /showPoolTab = currentUser\?\.role === 'admin' \|\| currentUser\?\.role === 'coordinator'/.test(team));
ok('C Move to Pool admin only', /currentUser\?\.role === 'admin' && \(user\.role === 'mashgiach' \|\| user\.role === 'worker'\)/.test(team));
ok('C borrow list never for admins', /!isAdmin && borrow &&/.test(panel));
ok('C contacts and invites admin only', /isAdmin && data\.invites\.map/.test(panel) && /isAdmin && data\.contacts\.map/.test(panel));
ok('C labels come from POOL_TEXT (no stray "Add to Pool" literal in components)', !/>\s*Add to Pool\s*</.test(panel + team));
ok('C borrow requires an end date (no remove-end button when required)', /\{!required && \(/.test(panel) && /missingEnd = required && ids\.some/.test(panel));

console.log(`12b-c pool client: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
