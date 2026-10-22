/**
 * 10b unit test: identity invariants (src/server/identity.ts) — plan v4 10b, C1, C2, C6.
 * Run: npx tsx tests/client/test-identity-invariants.mjs
 */
import fs from 'node:fs';
import {
  enforceIdentityFields, checkMembershipInvariants, identityGroups, groupIssues,
  identityOptionsFromOutcome, stripServerOnlyUserFields, SERVER_ONLY_USER_FIELDS, CREDENTIAL_ORIGINS,
  legacyPushSubIsUnambiguous, isLegacyPushSub,
} from '../../src/server/identity.ts';

let failures = 0, passed = 0;
function check(label, cond) { if (!cond) { console.error(`FAIL ${label}`); failures++; } else { passed++; } }

const H = '$2b$10$' + 'a'.repeat(53); // bcrypt-shaped
const H2 = '$2b$10$' + 'b'.repeat(53);
const AG = [{ id: 'ag-x' }, { id: 'ag-y' }];
const codes = (issues) => issues.map((i) => i.code).sort().join(',');
const row = (id, email, extra = {}) => ({ id, agencyId: 'ag-x', email, name: id, role: 'mashgiach', password: H, personId: id, ...extra });

// ---- 1. server-only list covers the 10b credential fields; strip removes them
{
  for (const f of ['credentialOwner', 'credentialOrigin', 'recoveryCodeHashes', 'recoveryFailures', 'joinedAt', 'personId', 'tokenEpoch'])
    check(`SERVER_ONLY_USER_FIELDS has ${f}`, SERVER_ONLY_USER_FIELDS.includes(f));
  const s = stripServerOnlyUserFields({ id: 'u', credentialOrigin: 'admin', credentialOwner: true, recoveryCodeHashes: ['h'], recoveryFailures: 2, joinedAt: 5, name: 'n' });
  check('strip removes every credential field, keeps others', Object.keys(s).sort().join(',') === 'id,name');
  check('origins are exactly the four C1 values', CREDENTIAL_ORIGINS.join(',') === 'self-registered,admin,invite-new,agency-reset');
}

// ---- 2. groups: shared email (case/space-insensitive) or shared personId
{
  const g = identityGroups([row('a', 'A@x.com'), row('b', ' a@X.com '), row('c', 'c@x.com'), row('d', 'd@x.com', { personId: 'c' }), row('e', 'e@x.com')]);
  const s = g.map((x) => x.join('+')).sort().join(' ');
  check(`groups by email and by personId (${s})`, s === 'a+b c+d e');
  check('rows with no email and no personId are singletons', identityGroups([{ id: 'p' }, { id: 'q' }]).length === 2);
}

// ---- 3. single-row and legacy shapes are never evaluated (no behaviour change)
{
  const legacy = [{ id: 'l1', email: 'l@x.com', agencyId: 'ag-x', password: 'plain' }, { id: 'adm', email: 'adm@x.com', agencyId: 'ag-x', password: '', needsSetup: true }];
  const r = checkMembershipInvariants(legacy, legacy.map((u) => ({ ...u, name: 'changed' })), AG);
  check('single legacy rows and a needsSetup admin: nothing refused', r.refused.length === 0 && r.preexisting.length === 0);
  const one = [row('a', 'a@x.com')];
  check('a single migrated row with a password change: nothing refused', checkMembershipInvariants(one, [{ ...one[0], password: H2 }], AG).refused.length === 0);
  check('a new single row: nothing refused', checkMembershipInvariants(one, [...one, row('n', 'n@x.com')], AG).refused.length === 0);
  check('a row deleted: nothing refused', checkMembershipInvariants([...one, row('n', 'n@x.com')], one, AG).refused.length === 0);
}

// ---- 4. 10b–10h: ANY new group of 2+ rows is refused (C2, C6)
{
  const base = [row('a', 'a@x.com'), row('b', 'b@x.com', { agencyId: 'ag-y' })];
  const r1 = checkMembershipInvariants(base, [...base, row('n', 'a@x.com', { agencyId: 'ag-y' })], AG);
  check('new row with an email used in another agency -> group-created', codes(r1.refused) === 'group-created');
  check('refusal carries row ids only, sorted', JSON.stringify(r1.refused[0].rowIds) === '["a","n"]');
  const r2 = checkMembershipInvariants(base, [base[0], { ...base[1], email: 'A@X.com' }], AG);
  check('existing row changes its email to another row\'s -> group-created', codes(r2.refused) === 'group-created');
  const r3 = checkMembershipInvariants(base, [base[0], { ...base[1], personId: 'a' }], AG);
  check('existing row given another row\'s personId -> group-created', codes(r3.refused) === 'group-created');
  const r4 = checkMembershipInvariants(base, [...base, row('n', 'n@x.com', { personId: 'a', agencyId: 'ag-y' })], AG);
  check('new row with another row\'s personId (no shared email) -> group-created', codes(r4.refused) === 'group-created');
  const r5 = checkMembershipInvariants([], [row('n1', 'z@x.com'), row('n2', 'z@x.com', { agencyId: 'ag-y' })], AG);
  check('two new rows with one email in one commit -> group-created', codes(r5.refused) === 'group-created');
  const leg = [{ id: 'l1', email: 'l@x.com', agencyId: 'ag-x' }];
  const r6 = checkMembershipInvariants(leg, [...leg, row('n', 'L@x.com')], AG);
  check('new row sharing a LEGACY row\'s email -> group-created', codes(r6.refused) === 'group-created');
  const r7 = checkMembershipInvariants(base, [...base, row('n', 'a@x.com', { agencyId: 'ag-y' })], AG, { allowGrowthRowIds: new Set(['zzz']) });
  check('an allowance for another row id does not help', codes(r7.refused) === 'group-created');
}

// ---- 5. preexisting legacy duplicates never freeze writes (C2)
{
  const dup = [{ id: 'l1', email: 'd@x.com', agencyId: 'ag-x', password: 'p' }, { id: 'l2', email: 'd@x.com', agencyId: 'ag-y', password: 'q' }];
  const r = checkMembershipInvariants(dup, [{ ...dup[0], password: 'p2', name: 'x' }, dup[1]], AG);
  check('legacy shared-email pair without personId: never evaluated (writes go on)', r.refused.length === 0 && r.preexisting.length === 0);
  const r2 = checkMembershipInvariants(dup, [...dup, row('n', 'D@x.com')], AG);
  check('but a THIRD row joining it is a grown group -> refused', codes(r2.refused) === 'group-created');
  const r3 = checkMembershipInvariants(dup, [dup[0]], AG);
  check('deleting one row of the pair is allowed', r3.refused.length === 0);
}

// ---- 6. invariant rules (i)–(iv) on a person group (the shape 10i will create)
{
  const ok = [
    { ...row('a', 'p@x.com', { personId: 'P', credentialOwner: true, credentialOrigin: 'self-registered' }) },
    { id: 'b', agencyId: 'ag-y', email: 'P@x.com', personId: 'P', role: 'admin', name: 'b' },
  ];
  check('a valid two-membership person has no issues', groupIssues(ok, AG).length === 0);
  check('(i) different personIds -> person-mismatch', codes(groupIssues([ok[0], { ...ok[1], personId: 'Q' }], AG)).includes('person-mismatch'));
  check('(i) a row without personId -> person-mismatch', codes(groupIssues([ok[0], { ...ok[1], personId: undefined }], AG)).includes('person-mismatch'));
  check('(i) different emails in one person -> email-mismatch', codes(groupIssues([ok[0], { ...ok[1], email: 'other@x.com' }], AG)).includes('email-mismatch'));
  check('(ii) two rows of one person in one agency -> agency-duplicate', codes(groupIssues([ok[0], { ...ok[1], agencyId: 'ag-x' }], AG)).includes('agency-duplicate'));
  check('(iii) no owner -> owner-count', codes(groupIssues([{ ...ok[0], credentialOwner: undefined }, ok[1]], AG)).includes('owner-count'));
  check('(iii) two owners -> owner-count', codes(groupIssues([ok[0], { ...ok[1], credentialOwner: true, password: H }], AG)).includes('owner-count'));
  check('(iii) owner without a bcrypt password -> owner-no-password', codes(groupIssues([{ ...ok[0], password: 'plain' }, ok[1]], AG)).includes('owner-no-password'));
  check('(iii) owner with an empty password -> owner-no-password', codes(groupIssues([{ ...ok[0], password: '' }, ok[1]], AG)).includes('owner-no-password'));
  check('(iii) a non-owner holding a password -> non-owner-credential', codes(groupIssues([ok[0], { ...ok[1], password: H2 }], AG)).includes('non-owner-credential'));
  check('(iii) a non-owner holding an origin -> non-owner-credential', codes(groupIssues([ok[0], { ...ok[1], credentialOrigin: 'admin' }], AG)).includes('non-owner-credential'));
  check('(iii) a non-owner holding recovery hashes -> non-owner-credential', codes(groupIssues([ok[0], { ...ok[1], recoveryCodeHashes: ['h'] }], AG)).includes('non-owner-credential'));
  check('(iv) a row whose agency is gone -> agency-missing', codes(groupIssues([ok[0], ok[1]], [{ id: 'ag-x' }])).includes('agency-missing'));

  // the 10i allowance: growth by a NEW row named in allowGrowthRowIds, and it must pass every rule
  const before = [ok[0]];
  const good = checkMembershipInvariants(before, ok, AG, { allowGrowthRowIds: new Set(['b']) });
  check('10i allowance: a new valid membership is accepted', good.refused.length === 0);
  const bad = checkMembershipInvariants(before, [ok[0], { ...ok[1], password: H2 }], AG, { allowGrowthRowIds: new Set(['b']) });
  check('10i allowance: an invalid result is still refused', codes(bad.refused) === 'non-owner-credential');
  const moved = checkMembershipInvariants([ok[0], { ...ok[1], id: 'b', email: 'b@x.com', personId: 'b', password: H2 }], ok, AG, { allowGrowthRowIds: new Set(['b']) });
  check('10i allowance never covers an EXISTING row joining', codes(moved.refused) === 'group-created');

  // preexisting invalid person group: logged, not blocking, while unchanged
  const inv = [ok[0], { ...ok[1], agencyId: 'ag-x' }];
  const pre = checkMembershipInvariants(inv, inv.map((u) => ({ ...u, name: 'renamed' })), AG);
  check('preexisting invalid group, identity unchanged -> preexisting only', pre.refused.length === 0 && codes(pre.preexisting) === 'agency-duplicate');
  const ch = checkMembershipInvariants(inv, [{ ...inv[0], password: H2 }, inv[1]], AG);
  check('preexisting invalid group CHANGED -> refused', codes(ch.refused) === 'agency-duplicate');
  const fixed = checkMembershipInvariants(inv, [inv[0], { ...inv[1], agencyId: 'ag-y' }], AG);
  check('a change that repairs it is allowed', fixed.refused.length === 0);
  // owner row removed without a transfer -> refused (10d does the transfer in the same commit)
  const three = [ok[0], ok[1], { id: 'c', agencyId: 'ag-z', email: 'p@x.com', personId: 'P', name: 'c' }];
  const shrink = checkMembershipInvariants(three, [ok[1], three[2]], [...AG, { id: 'ag-z' }]);
  check('removing the owner row with no transfer -> owner-count', codes(shrink.refused) === 'owner-count');
}

// ---- 7. enforceIdentityFields: credential fields (C1, D1)
{
  const viol = [];
  const onViolation = (id, f) => viol.push(`${id}:${f}`);
  const origins = [];
  const onOriginChange = (id, a, b) => origins.push(`${id}:${a}->${b}`);
  const before = [
    { id: 'a', email: 'a@x.com', password: H, personId: 'a', credentialOrigin: 'self-registered', credentialOwner: true, recoveryCodeHashes: ['h1'], recoveryFailures: 1, joinedAt: 7 },
    { id: 'b', email: 'b@x.com', password: H, personId: 'b' },
  ];
  // a mutator (= a request body) tries to set or change every credential field
  const tampered = [
    { ...before[0], credentialOrigin: 'admin', credentialOwner: false, recoveryCodeHashes: [], recoveryFailures: 0, joinedAt: 1 },
    { ...before[1], credentialOrigin: 'self-registered', credentialOwner: true, recoveryCodeHashes: ['x'], joinedAt: 2 },
  ];
  const out = enforceIdentityFields(before, tampered, AG, { onViolation, onOriginChange });
  check('existing row keeps its origin', out[0].credentialOrigin === 'self-registered');
  check('existing row keeps credentialOwner/recovery/joinedAt exactly', out[0].credentialOwner === true && JSON.stringify(out[0].recoveryCodeHashes) === '["h1"]' && out[0].recoveryFailures === 1 && out[0].joinedAt === 7);
  check('a row with none gets none of them', ['credentialOrigin', 'credentialOwner', 'recoveryCodeHashes', 'recoveryFailures', 'joinedAt'].every((f) => out[1][f] === undefined));
  check('every tamper is reported', ['a:credentialOrigin', 'a:credentialOwner', 'a:recoveryCodeHashes', 'a:recoveryFailures', 'a:joinedAt', 'b:credentialOrigin', 'b:credentialOwner', 'b:recoveryCodeHashes', 'b:joinedAt'].every((v) => viol.includes(v)));
  check('no origin change happened', origins.length === 0);

  // new rows: origin only through credentialOriginSetById
  viol.length = 0; origins.length = 0;
  const n = enforceIdentityFields(before, [...before, { id: 'n', email: 'n@x.com', password: H, credentialOrigin: 'self-registered', credentialOwner: true }], AG, { onViolation, onOriginChange });
  check('a new row cannot bring its own origin/owner', n[2].credentialOrigin === undefined && n[2].credentialOwner === undefined && viol.includes('n:credentialOrigin') && viol.includes('n:credentialOwner'));
  const n2 = enforceIdentityFields(before, [...before, { id: 'n', email: 'n@x.com', password: H }], AG, { credentialOriginSetById: new Map([['n', 'self-registered']]), onOriginChange });
  check('credentialOriginSetById sets a new row\'s origin, audited', n2[2].credentialOrigin === 'self-registered' && origins.includes('n:null->self-registered'));
  viol.length = 0;
  const n3 = enforceIdentityFields(before, [...before, { id: 'n', email: 'n@x.com', password: H }], AG, { credentialOriginSetById: new Map([['n', 'verified-by-magic']]), onViolation });
  check('an unknown origin value is ignored and reported', n3[2].credentialOrigin === undefined && viol.includes('n:credentialOrigin'));

  // password changes: keep only through passwordKeepsOriginIds; otherwise dropped (fail closed)
  origins.length = 0;
  const pw = [{ ...before[0], password: H2 }, before[1]];
  const drop = enforceIdentityFields(before, pw, AG, { onOriginChange });
  check('a password change outside the keep list drops the origin', drop[0].credentialOrigin === undefined && origins.includes('a:self-registered->null'));
  const keep = enforceIdentityFields(before, pw, AG, { passwordKeepsOriginIds: new Set(['a']) });
  check('change-password (keep list) keeps the origin', keep[0].credentialOrigin === 'self-registered');
  const reset = enforceIdentityFields(before, pw, AG, { credentialOriginSetById: new Map([['a', 'agency-reset']]) });
  check('agency-assisted reset sets agency-reset', reset[0].credentialOrigin === 'agency-reset');
  const same = enforceIdentityFields(before, [{ ...before[0], name: 'x' }, before[1]], AG, {});
  check('no password change -> origin kept', same[0].credentialOrigin === 'self-registered');
}

// ---- 8. newMembership: the only way a new row joins an existing person
{
  const viol = [];
  const onViolation = (id, f) => viol.push(`${id}:${f}`);
  const before = [{ id: 'a', email: 'p@x.com', personId: 'a', agencyId: 'ag-x', password: H }];
  const ok = enforceIdentityFields(before, [...before, { id: 'n', email: 'P@X.com', agencyId: 'ag-y' }], AG, { newMembership: new Map([['n', 'a']]) });
  check('newMembership with the same email joins the person', ok[1].personId === 'a');
  const wrongEmail = enforceIdentityFields(before, [...before, { id: 'n', email: 'q@x.com', agencyId: 'ag-y' }], AG, { newMembership: new Map([['n', 'a']]), onViolation });
  check('newMembership with another email is reverted + reported', wrongEmail[1].personId === 'n' && viol.includes('n:newMembership'));
  viol.length = 0;
  const noPerson = enforceIdentityFields(before, [...before, { id: 'n', email: 'p@x.com', agencyId: 'ag-y' }], AG, { newMembership: new Map([['n', 'ghost']]), onViolation });
  check('newMembership naming no existing person is reverted + reported', noPerson[1].personId === 'n' && viol.includes('n:newMembership'));
  viol.length = 0;
  const existing = enforceIdentityFields([...before, { id: 'b', email: 'p2@x.com', personId: 'b' }], [...before, { id: 'b', email: 'p2@x.com', personId: 'b' }], AG, { newMembership: new Map([['b', 'a']]), onViolation });
  check('newMembership never re-points an EXISTING row', existing[1].personId === 'b' && viol.includes('b:newMembership'));
  const plain = enforceIdentityFields(before, [...before, { id: 'n', email: 'p@x.com', agencyId: 'ag-y', personId: 'a' }], AG, {});
  check('without newMembership a new row is its own person even if it claims another', plain[1].personId === 'n');
  // and the checker refuses the result in 10b (the commit path passes no allowance)
  check('…and that shared-email result is refused by the checker', codes(checkMembershipInvariants(before, plain, AG).refused) === 'group-created');
}

// ---- 9. identityOptionsFromOutcome reads exactly the outcome fields
{
  const o = identityOptionsFromOutcome({ credentialOriginSetById: { a: 'admin' }, passwordKeepsOriginIds: ['b'], newMembership: { n: 'a' }, doc: {} });
  check('origin map', o.credentialOriginSetById.get('a') === 'admin');
  check('keep set', o.passwordKeepsOriginIds.has('b'));
  check('newMembership map', o.newMembership.get('n') === 'a');
  const e = identityOptionsFromOutcome({ doc: {}, result: {} });
  check('absent fields -> undefined', e.credentialOriginSetById === undefined && e.passwordKeepsOriginIds === undefined && e.newMembership === undefined);
}

// ---- 10. source tests (C6): no 10b route may use newMembership; origin writers are exactly the C1 ones
{
  const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  // 10d (B3): the ONLY producer of an outcome newMembership before 10i is the
  // isTestMode-only builder hook; the allowance is derived from accepted joins.
  // 10i: exactly two producers — the isTestMode-only builder hook and the
  // public accept handler (design v3 C2(e)).
  const producers = [...src.matchAll(/newMembership:\s*\{/g)].map((m) => m.index);
  const hookAt = src.indexOf("app.post('/api/__test__/identity-build-person'");
  const hookEnd = hookAt >= 0 ? src.indexOf('\n  app.', hookAt + 10) : -1;
  const acceptAt = src.indexOf("app.post('/api/invites/accept'");
  const acceptEnd = acceptAt >= 0 ? src.indexOf('\napp.', acceptAt + 10) : -1;
  check(`newMembership is produced exactly twice in server.ts (found ${producers.length})`, producers.length === 2);
  check('…once inside the test-mode identity-build-person hook', producers.some((p) => hookAt >= 0 && p > hookAt && p < hookEnd));
  check('…and once inside the 10i accept handler', producers.some((p) => acceptAt >= 0 && p > acceptAt && p < acceptEnd));
  const owners = [...src.matchAll(/firstMultiOwnerIds:\s*\[/g)].map((m) => m.index);
  check(`firstMultiOwnerIds is produced only by the accept handler (found ${owners.length})`, owners.length === 1 && owners[0] > acceptAt && owners[0] < acceptEnd);
  check('the growth allowance is derived from the joins the enforcement accepted', /allowGrowthRowIds: acceptedJoins/.test(src) && !/allowGrowthRowIds:\s*(req|body|new Set\(\s*req)/.test(src));
  const setters = [...src.matchAll(/credentialOriginSetById:\s*\{\s*\[([A-Za-z.]+)\]:\s*'([a-z-]+)'/g)].map((m) => m[2]).sort();
  check(`origin writers in server.ts are register, add-member, owner creation, agency reset, 10i accept (found ${setters.join(',')})`,
    setters.join(',') === 'admin,admin,agency-reset,invite-new,self-registered');
  check("'self-registered' appears in exactly one writer", (src.match(/\]:\s*'self-registered'/g) || []).length === 1);
  check("'invite-new' has exactly one writer (10i accept, new person)", (src.match(/\]:\s*'invite-new'/g) || []).length === 1);
  const keepers = (src.match(/passwordKeepsOriginIds:/g) || []).length;
  check(`passwordKeepsOriginIds used only by change-password, the login hash upgrade and 10f recovery (found ${keepers})`, keepers === 3);
  check('commitState runs the checker in applyIdentityInvariant', /checkMembershipInvariants\(beforeUsers, users, agencies, acceptedJoins\.size/.test(src));
  check('both commit paths call applyIdentityInvariant', (src.match(/outcome\.doc = applyIdentityInvariant\(/g) || []).length === 2);
}

// ---- 10c (A1/A2/A4): a legacy push subscription is attributable only to a unique email
{
  const one = [row('x', 'P@x.com'), row('z', 'z@x.com')];
  const two = [row('x', 'p@x.com'), row('y', ' P@X.com ', { agencyId: 'ag-y' }), row('z', 'z@x.com')];
  check('10c legacy: exactly one row with the email → attributable (case/space-insensitive)', legacyPushSubIsUnambiguous(' p@X.COM', one) === true);
  check('10c legacy: two rows (two memberships) share the email → ambiguous', legacyPushSubIsUnambiguous('p@x.com', two) === false);
  check('10c legacy: no row with the email → not attributable', legacyPushSubIsUnambiguous('nobody@x.com', one) === false);
  check('10c legacy: empty / non-string email → not attributable', legacyPushSubIsUnambiguous('', one) === false && legacyPushSubIsUnambiguous(undefined, one) === false);
  check('10c legacy: tolerates holes in the list', legacyPushSubIsUnambiguous('z@x.com', [null, undefined, { id: 'q' }, ...one]) === true);
  check('10c legacy: a record with no userId is legacy', isLegacyPushSub({ userEmail: 'p@x.com', endpoint: 'e' }) === true);
  check('10c legacy: a bound record is not legacy', isLegacyPushSub({ userEmail: 'p@x.com', userId: 'x', agencyId: 'ag-x', endpoint: 'e' }) === false);
}

// ---- 10c source contract (server.ts): no email-keyed push, membership-aware cleanup, agency-scoped owner lookup
{
  const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  check('10c A1: the email-keyed sendPushToUser is gone', !/sendPushToUser/.test(src));
  const members = (src.match(/sendPushToMember\(\s*\n?\s*(r|target|admin|assigneeRow),/g) || []).length;
  check(`10c A1: alert, announcement, reset-code and event-assignment pushes go to a row (found ${members})`, members === 4);
  check('10c A1: legacy delivery checks uniqueness across ALL rows', /legacyPushSubIsUnambiguous\(row\.email, users\)/.test(src));
  check('10c A2: unsubscribe evaluates legacy ambiguity on FRESH users', /legacyPushSubIsUnambiguous\(callerEmail, freshDoc\.users \|\| \[\]\)/.test(src));
  check('10c A2: unsubscribe no longer matches by email alone', !/s\.endpoint !== endpoint \|\| \(callerEmail && s\.userEmail !== callerEmail\)/.test(src));
  check('10c A4: delete evaluates legacy ambiguity on FRESH users', /legacyPushSubIsUnambiguous\(targetEmail, freshUsers\)/.test(src));
  check('10c A5: venue-owner email resolved by one agency-scoped resolver, cached and fresh', (src.match(/resolveVenueOwnerEmail\((users|newUsers)\)/g) || []).length === 2);
  check('10c A5: no global first-match owner lookup remains', !/users\.find\(\(u\) => typeof u\.email === 'string' && u\.email\.trim\(\)\.toLowerCase\(\) === cleanOwnerEmail\)/.test(src) && !/newUsers\.findIndex\(\(u\) => typeof u\.email === 'string' && u\.email\.trim\(\)\.toLowerCase\(\) === cleanOwnerEmail\)/.test(src));
}

// ---- 10i ([10I-RV1] B1): flag-ON venue creation never hashes ownerPassword
{
  const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  check('10i venue owner: the hash is computed only off the invite path', /const ownerPasswordHash: string \| null = ownerInviteMode\s*\?\s*null\s*:/.test(src));
  check('10i venue owner: ownerPasswordHash is the only owner-password hash site', (src.match(/bcrypt\.hashSync\(ownerPassword/g) || []).length === 1);
  check('10i venue owner: a missing hash refuses instead of creating a passwordless owner', /if \(!ownerPasswordHash\) return \{ conflict:/.test(src));
}

console.log(`${passed} passed, ${failures} failed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log(`ALL ${passed} passed`);
