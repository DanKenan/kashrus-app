/**
 * 8h unit test: admin export projection, ownership and secret scrub.
 * Run: npx tsx tests/client/test-admin-export.mjs
 */
import { buildAdminExport, isExportSecretKey, scrubSecrets, ownedByAgency } from '../../src/server/admin-export.ts';

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: expected ${e}, got ${a}`); failures++; } else console.log(`ok ${label}`);
}

for (const k of ['password', 'passwordHash', 'kioskPin', 'kioskPinHash', 'secretHash', 'apiKey', 'api_key', 'accessToken', 'refreshToken', 'domainVerificationToken', 'resetPepper', 'jwtSecret', 'vapidKeys', 'privateKey', 'pairingCode', 'pairingCodeHash', 'resetCode', 'codeHash', 'userPassword', 'clientSecret', 'webhookSecret', 'pin', 'otp', 'emailVerificationToken', 'oauthCredentials'])
  check(`secret ${k}`, isExportSecretKey(k), true);
for (const k of ['id', 'name', 'email', 'shortCode', 'agencyId', 'venueId', 'title', 'notes', 'kioskPinSetAt', 'kioskPinRev', 'tokenCount', 'pinned', 'hasApiKey', 'baseId', 'zipCode', 'status', 'createdAt', 'permissions'])
  check(`not secret ${k}`, isExportSecretKey(k), false);

check('nested scrub', scrubSecrets({ a: 1, list: [{ x: 1, apiKey: 'K', deep: { refreshToken: 'R', ok: 2 } }], meta: { passwordHash: 'H' } }), { a: 1, list: [{ x: 1, deep: { ok: 2 } }], meta: {} });

check('keys.auth scrub (Web Push bundle, nested)', scrubSecrets({ metadata: { keys: { p256dh: 'pub', auth: 'AUTH-SECRET' } }, sub: [{ endpoint: 'e', keys: { auth: 'X' } }], pushKeys: { auth: 'Y', p256dh: 'q' }, auth: 'top-level auth word kept' }), { metadata: { keys: { p256dh: 'pub' } }, sub: [{ endpoint: 'e', keys: {} }], pushKeys: { p256dh: 'q' }, auth: 'top-level auth word kept' });

const venueAgency = new Map([['vA', 'A'], ['vB', 'B']]);
check('owned: agency match', ownedByAgency({ agencyId: 'A' }, 'A', venueAgency), true);
check('owned: agency mismatch', ownedByAgency({ agencyId: 'B' }, 'A', venueAgency), false);
check('owned: agency A but venue of B (inconsistent) -> omit', ownedByAgency({ agencyId: 'A', venueId: 'vB' }, 'A', venueAgency), false);
check('owned: unknown venue -> omit', ownedByAgency({ agencyId: 'A', venueId: 'vX' }, 'A', venueAgency), false);
check('owned: no agency, own venue', ownedByAgency({ venueId: 'vA' }, 'A', venueAgency), true);
check('owned: no agency, other venue', ownedByAgency({ venueId: 'vB' }, 'A', venueAgency), false);
check('owned: no owner at all -> omit', ownedByAgency({ title: 'x' }, 'A', venueAgency), false);
check('owned: venueId all + agency', ownedByAgency({ agencyId: 'A', venueId: 'all' }, 'A', venueAgency), true);

const snap = {
  _v: 7, currentWorkDate: '2026-10-21', isDemoCleared: true, venueWorkDates: { vA: '2026-10-21', vB: '2026-10-20' },
  jwtSecret: 'J', vapidKeys: { privateKey: 'P' }, resetPepper: 'PEP', passwordResets: [{ email: 'x' }], pushSubscriptions: [{ endpoint: 'e', keys: { auth: 'a' } }], kioskPinLockouts: {}, kioskPairings: {}, futureSecretBlob: { a: 1 },
  agencies: [{ id: 'agency-hkc', adminEmail: 'don@h.org', name: 'HKC', shortCode: 'HKC' }, { id: 'A', name: 'A', shortCode: 'AA', domainVerificationToken: 'DVT' }, { id: 'B', name: 'B' }],
  venues: [{ id: 'vA', agencyId: 'A' }, { id: 'vB', agencyId: 'B' }, { id: 'vL' }],
  tasks: [{ id: 't1', agencyId: 'A', venueId: 'vA' }, { id: 't2', agencyId: 'B', venueId: 'vB' }, { id: 't3', venueId: 'vA' }, { id: 't4' }],
  users: [{ id: 'u1', agencyId: 'A', email: 'a@a', password: 'P', kioskPinHash: 'H', phoneNumber: '+1', newSecretToken: 'S' }, { id: 'u2', agencyId: 'B' }, { id: 'u3', email: 'legacy@h' }],
  airtableConfigs: [{ id: 'c1', agencyId: 'A', apiKey: 'PAT', baseId: 'app1' }, { id: 'c2', agencyId: 'B', apiKey: 'PAT2' }],
  kioskDevices: [{ id: 'd1', agencyId: 'A', venueId: 'vA', name: 'tab', secretHash: 'SH' }],
  events: [{ id: 'e1', agencyId: 'A', venueId: 'vA', extra: { webhookSecret: 'W', note: 'n' }, metadata: { keys: { p256dh: 'pub', auth: 'EVT-AUTH-SECRET' } } }],
};
const ea = buildAdminExport(snap, { role: 'admin', agencyId: 'A', email: 'a@a' });
check('agency scope marker', [ea.exportScope, ea.exportAgencyId, ea.restorable, '_v' in ea, 'currentWorkDate' in ea, 'isDemoCleared' in ea], ['agency', 'A', false, false, false, false]);
check('agency: agencies', ea.agencies.map((a) => a.id), ['A']);
check('agency: token scrubbed from agency', 'domainVerificationToken' in ea.agencies[0], false);
check('agency: venues', ea.venues.map((v) => v.id), ['vA']);
check('agency: tasks (t3 via own venue)', ea.tasks.map((t) => t.id), ['t1', 't3']);
check('agency: users', ea.users.map((u) => u.id), ['u1']);
check('agency: user fields', Object.keys(ea.users[0]).sort(), ['agencyId', 'email', 'id', 'phoneNumber']);
check('agency: airtable', ea.airtableConfigs, [{ id: 'c1', agencyId: 'A', baseId: 'app1', hasApiKey: true }]);
check('agency: device', Object.keys(ea.kioskDevices[0]).sort(), ['agencyId', 'id', 'name', 'venueId']);
check('agency: nested secret scrubbed', ea.events[0].extra, { note: 'n' });
check('agency: work dates own venues only', ea.venueWorkDates, { vA: '2026-10-21' });
const body = JSON.stringify(ea);
for (const s of ['EVT-AUTH-SECRET', 'PAT', 'PEP', 'SH', 'DVT', 'futureSecretBlob', 'pushSubscriptions', 'jwtSecret', '"B"', 'u2', 't2', 'legacy@h']) check(`agency body lacks ${s}`, body.includes(s), false);

// No cross-agency export for anyone: the home agency's primary admin gets the home agency only.
const eh = buildAdminExport(snap, { role: 'admin', agencyId: 'agency-hkc', email: 'don@h.org' });
check('home primary admin: agency scope', [eh.exportScope, eh.exportAgencyId, eh.restorable, '_v' in eh], ['agency', 'agency-hkc', false, false]);
check('home primary admin: no other agency', [eh.agencies.map((a) => a.id), eh.tasks.length, eh.users.length, eh.venues.length], [['agency-hkc'], 0, 0, 0]);
const hbody = JSON.stringify(eh);
for (const s of ['"A"', '"B"', 't1', 't2', 'u1', 'legacy@h', 'PAT', 'PEP', 'futureSecretBlob', 'jwtSecret']) check(`home body lacks ${s}`, hbody.includes(s), false);
const en = buildAdminExport(snap, { role: 'admin', agencyId: '' });
check('no agency -> nothing', [en.agencies.length, en.tasks.length, en.users.length], [0, 0, 0]);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall admin-export checks passed');
