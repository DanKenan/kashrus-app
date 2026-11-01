/**
 * 10M part 2 source checks (design files/shutfey-10M-design.txt v4-v6):
 * every persisted state key is either rewritten by the merge (explicit email
 * schema) or explicitly skipped; both routes share one function; passwords are
 * checked before the commit; the person merge is the only identity change.
 */
import fs from 'node:fs';
import { MERGE_EMAIL_FIELDS, MERGE_USER_ID_FIELDS, MERGE_REWRITE_COLLECTIONS, MERGE_SKIP_KEYS, rewriteEmailRefs, recordOwnerAgency } from '../../src/server/account-merge.ts';
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ FAILED: ${name}`); } };
const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
// stateSnapshot() keys
const snapAt = src.indexOf('function stateSnapshot()');
const snapBody = src.slice(snapAt, src.indexOf('\n}\n', snapAt));
const keys = [...snapBody.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*[:,]/gm)].map((m) => m[1]);
check('stateSnapshot keys found', keys.length >= 25 && keys.includes('users') && keys.includes('handoffNotes'));
const rw = new Set(MERGE_REWRITE_COLLECTIONS);
const sk = new Set(MERGE_SKIP_KEYS);
check('every stateSnapshot key is in the rewrite or the skip list', keys.every((k) => rw.has(k) || sk.has(k)));
check('no key is in both lists', [...rw].every((k) => !sk.has(k)));
check('every listed key exists in stateSnapshot', [...rw, ...sk].every((k) => keys.includes(k)));
check('users, invites, resetLinks, passwordResets, pushSubscriptions are never rewritten by the schema', ['users', 'invites', 'resetLinks', 'passwordResets', 'pushSubscriptions'].every((k) => sk.has(k) && !rw.has(k)));
check('every schema collection names at least one email or user-id field', MERGE_REWRITE_COLLECTIONS.every((c) => (MERGE_EMAIL_FIELDS[c] || []).length + (MERGE_USER_ID_FIELDS[c] || []).length > 0));
check('shifts are rewritten, never skipped', rw.has('shifts') && !sk.has('shifts'));
// routes
const fnAt = src.indexOf('async function accountMergeRoute(');
const fn = src.slice(fnAt, src.indexOf("\napp.post('/api/account/merge-into'", fnAt));
check('one shared route function', fnAt > 0 && fn.length > 0);
check('merge-into uses it', /app\.post\('\/api\/account\/merge-into', \(req, res\) => accountMergeRoute\(req, res, 'merge-into'\)\)/.test(src));
check('bring-in uses it', /app\.post\('\/api\/account\/bring-in', \(req, res\) => accountMergeRoute\(req, res, 'bring-in'\)\)/.test(src));
check('neither route is public', !/path: '\/account\/(merge-into|bring-in)'/.test(src));
check('typed-email failures share the register-existing limiter and key (M3)', /const typedFailKey = `register-existing\|\$\{typedEmail\}`;/.test(fn) && /registerExistingFailLimiter\.blocked\(typedFailKey/.test(fn) && /registerExistingFailLimiter\.hit\(typedFailKey/.test(fn) && !/mergeFailLimiter\.(hit|blocked)\(typedFailKey/.test(fn));
check('passwords are checked before the commit', fn.indexOf('checkPassword(') > 0 && fn.lastIndexOf('checkPassword(') < fn.indexOf('commitOrRespond('));
check('the commit declares personMerge', /personMerge: \{ fromPersonId: B, toPersonId: A, email: survivorEmail \}/.test(fn));
check('the idempotency key is scoped to the calling row', /idempotencyKey: `account-merge\|\$\{verified\.callerId\}\|\$\{operationId\}`/.test(fn));
check('the payload hash never includes a password', /update\(JSON\.stringify\(\{ via, email: typedEmail \}\)\)/.test(fn));
check('the audit line carries no email', /\[audit\] account-merge via=/.test(fn) && !/\[audit\] account-merge[^\n]*Email/.test(fn));
// pure helper sanity
const venues = new Map([['v-hkc', ['agency-hkc']], ['v-x', ['agency-x']], ['v-dup', ['agency-hkc', 'agency-hkc']]]);
check('owner: explicit agencyId', recordOwnerAgency('tasks', { agencyId: 'agency-x', venueId: 'v-hkc' }, venues) === 'agency-x');
check('owner: legacy, no venue -> hkc', recordOwnerAgency('tasks', {}, venues) === 'agency-hkc');
check('owner: legacy, hkc venue -> hkc', recordOwnerAgency('tasks', { venueId: 'v-hkc' }, venues) === 'agency-hkc');
check('owner: legacy, other-agency venue -> ambiguous', recordOwnerAgency('tasks', { venueId: 'v-x' }, venues) === null);
check('owner: legacy, missing venue -> ambiguous', recordOwnerAgency('tasks', { venueId: 'nope' }, venues) === null);
check('owner: legacy, duplicated venue -> ambiguous', recordOwnerAgency('tasks', { venueId: 'v-dup' }, venues) === null);
check('owner: agencies use the id', recordOwnerAgency('agencies', { id: 'agency-x' }, venues) === 'agency-x');
const doc = {
  venues: [{ id: 'v-b', agencyId: 'ag-b' }, { id: 'v-x', agencyId: 'ag-x' }],
  tasks: [
    { id: 't1', agencyId: 'ag-b', assignedTo: ['B@x.io', 'a@x.io', 'o@x.io'], createdByEmail: ' b@x.io ', notes: 'b@x.io', meta: { createdByEmail: 'b@x.io' } },
    { id: 't2', agencyId: 'ag-x', createdByEmail: 'b@x.io' },
  ],
  handoffNotes: [{ id: 'n1', venueId: 'v-x', authorEmail: 'o@x.io' }],
};
const out = rewriteEmailRefs(doc, new Set(['ag-b']), 'b@x.io', 'a@x.io');
check('rewrite ok', out.ok === true);
const t1 = out.patch.tasks.find((t) => t.id === 't1');
check('list: B -> A, A once, others kept in order', JSON.stringify(t1.assignedTo) === JSON.stringify(['a@x.io', 'o@x.io']));
check('scalar field rewritten (trim + case)', t1.createdByEmail === 'a@x.io');
check('non-schema fields untouched (text, nested unknown)', t1.notes === 'b@x.io' && t1.meta.createdByEmail === 'b@x.io');
check('other agency untouched', out.patch.tasks.find((t) => t.id === 't2').createdByEmail === 'b@x.io');
check('ambiguous record without B untouched', !out.patch.handoffNotes);
check('input not mutated', doc.tasks[0].createdByEmail === ' b@x.io ');
const bad = rewriteEmailRefs({ ...doc, handoffNotes: [{ id: 'n2', venueId: 'v-x', authorEmail: 'B@x.io' }] }, new Set(['ag-b']), 'b@x.io', 'a@x.io');
check('ambiguous record holding B -> refused', bad.ok === false && bad.collection === 'handoffNotes' && bad.recordId === 'n2');
// Shift assignments use user row ids, including dated replacements.
const shiftDoc = {
  shifts: [
    { id: 's1', agencyId: 'ag-b', userId: 'source', days: Array.from({ length: 7 }, (_, w) => ({ on: w === 0, userId: w === 0 ? 'source' : null })), overrides: [{ date: '2026-11-01', userId: 'source' }, { date: '2026-11-02', userId: null }, { date: '2026-11-03', userId: 'other' }], name: 'source', area: 'source' },
    { id: 's2', agencyId: 'ag-x', userId: 'source', overrides: [{ date: '2026-11-01', userId: 'source' }] },
    { id: 's3', agencyId: 'ag-b', userId: 'Source', overrides: [] },
  ],
};
const userIds = new Map([['source', 'target']]);
const shifted = rewriteEmailRefs(shiftDoc, new Set(['ag-b']), 'b@x.io', 'a@x.io', userIds);
check('shift rewrite succeeds', shifted.ok === true);
const s1 = shifted.patch.shifts[0];
check('shift usual person source -> target', s1.userId === 'target');
check('shift override source -> target', s1.overrides[0].userId === 'target');
check('shift null and unrelated override unchanged', s1.overrides[1].userId === null && s1.overrides[2].userId === 'other');
check('shift free text unchanged', s1.name === 'source' && s1.area === 'source');
check('other agency shift unchanged', shifted.patch.shifts[1] === shiftDoc.shifts[1]);
check('user ids match exactly, case-sensitive', shifted.patch.shifts[2] === shiftDoc.shifts[2]);
check('shift input not mutated', shiftDoc.shifts[0].userId === 'source' && shiftDoc.shifts[0].overrides[0].userId === 'source');
check('shift weekday person source -> target', s1.days[0].userId === 'target' && s1.days[1].userId === null);
check('shift references counted', shifted.replaced === 3);
const ambiguousShift = rewriteEmailRefs({ shifts: [{ id: 'ambiguous', venueId: 'missing', userId: null, overrides: [{ date: '2026-11-01', userId: 'source' }] }] }, new Set(['ag-b']), 'b@x.io', 'a@x.io', userIds);
check('ambiguous shift holding source id -> refused', ambiguousShift.ok === false && ambiguousShift.collection === 'shifts');
// The real merge keeps B's agency memberships, changing only personId/email.
const membershipDoc = {
  users: [{ id: 'row-a', agencyId: 'ag-a', personId: 'A', email: 'a@x.io' }, { id: 'row-b', agencyId: 'ag-b', personId: 'B', email: 'b@x.io' }],
  shifts: [{ id: 'b-shift', agencyId: 'ag-b', userId: 'row-b', days: [{ on: true, userId: 'row-b' }], overrides: [{ date: '2026-11-01', userId: 'row-b' }] }],
};
const keptUsers = membershipDoc.users.map((u) => u.personId === 'B' ? { ...u, personId: 'A', email: 'a@x.io' } : u);
const keptRewrite = rewriteEmailRefs(membershipDoc, new Set(['ag-b']), 'b@x.io', 'a@x.io');
const keptShift = (keptRewrite.patch.shifts || membershipDoc.shifts)[0];
check('cross-agency merge keeps the source membership id on every shift reference', keptShift.userId === 'row-b' && keptShift.days[0].userId === 'row-b' && keptShift.overrides[0].userId === 'row-b');
check('kept shift person resolves to the merged person in its own agency', keptUsers.some((u) => u.id === keptShift.userId && u.agencyId === keptShift.agencyId && u.personId === 'A'));
check('merge route retains membership ids and supplies no row-id redirection', /const newUsers = fu\.map/.test(fn) && /\{ \.\.\.u, personId: A, email: survivorEmail \}/.test(fn) && /rewriteEmailRefs\(freshDoc, bAgencyIds, retiredEmail, survivorEmail\)/.test(fn) && !/bIds\]\.map\(\(id\) => \[id, String\(fSurvivor\.id\)\]/.test(fn));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
