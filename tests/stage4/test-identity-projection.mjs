/**
 * 10d (plan v4 10d; "Agreed — 10d design v2"): projections from whole person
 * groups + owner transfer. No server.
 *
 * Proves:
 *  P identityProjection: single row = owner; legacy row maps itself; a valid
 *    multi-row person projects from its credentialOwner row (people, emails,
 *    usersByEmail -> owner); no owner / two owners / any invariant issue ->
 *    'no-valid-owner' and NO projection (no smallest-id fallback); an email
 *    shared by two identities -> 'email-shared', unmapped. Never throws.
 *  M m4Successor: earliest joinedAt (missing = earliest), tie -> smallest id.
 *  T applyOwnerTransfer: copies the credential from the fresh source (mutator
 *    destination values overwritten, membership fields kept); refuses every
 *    broken condition; refuses an owner removal with no transfer; the single
 *    survivor is checked explicitly. enforceIdentityFields keeps the moved
 *    credential (incl. credentialOrigin) only on the declared destination.
 *  D dualwrite: a person growing to 2 rows changes no projection; an owner
 *    transfer with the same name/email moves ONLY usersByEmail (N2); the last
 *    row retires people + emails; a newly invalid group aborts; an untouched
 *    stored invalid group is tolerated with no identity write; a new shared
 *    email still aborts ("Duplicate email").
 *  C perEntityStatus: a valid 2-row person with owner-derived docs is clean;
 *    usersByEmail pointing at the non-owner is reported.
 */
import crypto from 'crypto';
import {
  identityProjection, m4Successor, applyOwnerTransfer, enforceIdentityFields, newProjectionProblems, emailKey,
} from '../../src/server/identity.ts';
import { dualWriteChangedEntities } from '../../src/server/dualwrite.ts';
import { runConsistencyCheck } from '../../src/server/consistency.ts';
import { createMockDb, venue } from './test-consistency.mjs';

function assert(c, m) { if (!c) throw new Error(m); }
const J = (x) => JSON.stringify(x);
const H = '$2b$10$' + 'a'.repeat(53);
const AG = [{ id: 'agency-hkc' }, { id: 'ag-y' }, { id: 'ag-z' }];
const row = (id, email, extra = {}) => ({ id, agencyId: 'agency-hkc', email, name: 'P', role: 'mashgiach', avatarColor: '#fff', personId: id, ...extra });
const ownerX = () => row('x', 'p@x.com', { password: H, credentialOwner: true, credentialOrigin: 'self-registered', recoveryCodeHashes: ['h1'], kioskPinHash: 'kx', joinedAt: '2026-01-01T00:00:00Z' });
const memberY = (extra = {}) => row('y', 'p@x.com', { agencyId: 'ag-y', personId: 'x', role: 'coordinator', kioskPinHash: 'ky', joinedAt: '2026-02-01T00:00:00Z', ...extra });

function mockTx(existing = {}) {
  const writes = [];
  return {
    writes,
    async get(ref) { const d = existing[`${ref._collection}/${ref._id}`]; return { exists: !!d, data: () => d }; },
    set(ref, data) { writes.push({ op: 'set', collection: ref._collection, id: ref._id, data }); },
    delete(ref) { writes.push({ op: 'delete', collection: ref._collection, id: ref._id }); },
  };
}
const mockDb = { collection(name) { return { doc(id) { return { _collection: name, _id: id }; } }; } };
const idWrites = (tx) => tx.writes.filter((w) => ['people', 'emails', 'usersByEmail'].includes(w.collection));
const doc = (users) => ({ tasks: [], venues: [], users, agencies: AG });

export default {
  name: '10d: identity projections from person groups + owner transfer',
  whatItProves: 'usersByEmail/people/emails come from one owner-derived projection; invalid groups fail closed when introduced and are tolerated untouched; owner transfer is validated, copied from the fresh source, and moves only the lookup when nothing else changes; the read-only check uses the same function.',

  async run() {
    // ---- P ----
    {
      const p1 = identityProjection([ownerX()], AG);
      assert(p1.problems.length === 0 && p1.persons.get('x')?.ownerRowId === 'x' && p1.lookup.get('p@x.com') === 'x', `single row ${J([...p1.persons])}`);
      const leg = identityProjection([{ id: 'l', email: ' L@X.com ', name: 'L' }], AG);
      assert(leg.lookup.get('l@x.com') === 'l' && leg.persons.size === 0 && leg.problems.length === 0, 'legacy row maps itself, no person');
      const ok = identityProjection([ownerX(), memberY({ name: 'Other' })], AG);
      const pp = ok.persons.get('x');
      assert(ok.problems.length === 0 && pp.ownerRowId === 'x' && pp.name === 'P' && J(pp.rowIds) === J(['x', 'y']), `valid multi ${J(pp)}`);
      assert(ok.lookup.get('p@x.com') === 'x' && ok.emailPerson.get(emailKey('p@x.com')) === 'x', 'lookup -> owner, emails -> person');
      // Y listed first in the array: still the owner, not "last row wins"
      const order = identityProjection([memberY(), ownerX()], AG);
      assert(order.persons.get('x').ownerRowId === 'x', 'owner independent of row order');
      const none = identityProjection([{ ...ownerX(), credentialOwner: undefined }, memberY()], AG);
      assert(none.persons.size === 0 && none.problems.length === 1 && none.problems[0].code === 'no-valid-owner' && !none.lookup.has('p@x.com'), `no owner -> problem, no projection ${J(none.problems)}`);
      const two = identityProjection([ownerX(), memberY({ credentialOwner: true, password: H })], AG);
      assert(two.persons.size === 0 && two.problems[0].code === 'no-valid-owner', 'two owners -> problem');
      const shared = identityProjection([ownerX(), row('z', 'P@x.com', { agencyId: 'ag-z' })], AG);
      assert(shared.problems.some((q) => q.code === 'email-shared') && !shared.lookup.has('p@x.com') && !shared.emailPerson.has(emailKey('p@x.com')), 'two persons share an email -> email-shared, unmapped');
      const mixed = identityProjection([ownerX(), { id: 'leg', email: 'p@x.com' }], AG);
      assert(mixed.problems.some((q) => q.code === 'email-shared'), 'person + legacy row share an email -> email-shared');
      assert(!J(none.problems).includes('p@x.com') || none.problems.every((q) => q.code !== 'no-valid-owner' || q.email === undefined), 'no-valid-owner carries no email');
      console.log('  ✓ P projection rules');
    }
    // ---- M ----
    {
      assert(m4Successor([{ id: 'b', joinedAt: '2026-01-02' }, { id: 'a', joinedAt: '2026-01-03' }]).id === 'b', 'earliest joinedAt');
      assert(m4Successor([{ id: 'b', joinedAt: '2026-01-02' }, { id: 'c' }]).id === 'c', 'missing joinedAt = earliest');
      assert(m4Successor([{ id: 'd' }, { id: 'c' }]).id === 'c', 'tie -> smallest id');
      assert(m4Successor([]) === null, 'empty -> null');
      console.log('  ✓ M m4Successor');
    }
    // ---- T ----
    {
      const before = [ownerX(), memberY()];
      const afterDel = [memberY({ password: 'forged', credentialOrigin: 'admin', role: 'coordinator' })];
      const t = applyOwnerTransfer(before, afterDel, AG, { fromId: 'x', toId: 'y' });
      assert(t.ok, `valid transfer ok ${J(t)}`);
      const y = t.users.find((u) => u.id === 'y');
      assert(y.password === H && y.credentialOwner === true && y.credentialOrigin === 'self-registered' && J(y.recoveryCodeHashes) === J(['h1']), `credential copied from the fresh source (mutator values overwritten) ${J(y)}`);
      assert(y.kioskPinHash === 'ky' && y.role === 'coordinator' && y.joinedAt === '2026-02-01T00:00:00Z' && y.agencyId === 'ag-y', 'membership fields stay the destination\'s own');
      const enforced = enforceIdentityFields(before, t.users, AG, { ownerTransferIds: t.transferIds });
      const ye = enforced.find((u) => u.id === 'y');
      assert(ye.credentialOwner === true && ye.credentialOrigin === 'self-registered' && J(ye.recoveryCodeHashes) === J(['h1']) && ye.personId === 'x' && ye.joinedAt === '2026-02-01T00:00:00Z', `enforcement keeps the moved credential on the destination ${J(ye)}`);
      const noOpt = enforceIdentityFields(before, t.users, AG, {});
      const yn = noOpt.find((u) => u.id === 'y');
      assert(yn.credentialOwner === undefined && yn.credentialOrigin === undefined, 'without the declared transfer the enforcement reverts the credential fields');
      const refuse = (label, b, a, tr) => { const r = applyOwnerTransfer(b, a, AG, tr); assert(!r.ok, `${label} must be refused: ${J(r)}`); return r.reason; };
      assert(refuse('owner removed, no transfer', before, [memberY()], undefined) === 'owner-removed-without-transfer', 'reason');
      refuse('source still present', before, [ownerX(), memberY()], { fromId: 'x', toId: 'y' });
      refuse('destination missing', before, [], { fromId: 'x', toId: 'y' });
      refuse('destination other person', [ownerX(), memberY(), row('w', 'w@x.com')], [memberY(), row('w', 'w@x.com')], { fromId: 'x', toId: 'w' });
      refuse('source not owner', [ownerX(), memberY(), row('v', 'p@x.com', { agencyId: 'ag-z', personId: 'x' })], [ownerX(), row('v', 'p@x.com', { agencyId: 'ag-z', personId: 'x' })], { fromId: 'y', toId: 'v' });
      refuse('source group invalid', [ownerX(), memberY({ password: H })], [memberY({ password: H })], { fromId: 'x', toId: 'y' });
      const three = [ownerX(), memberY(), row('v', 'p@x.com', { agencyId: 'ag-z', personId: 'x', joinedAt: '2026-03-01T00:00:00Z' })];
      assert(refuse('not the M4 successor', three, [memberY(), three[2]], { fromId: 'x', toId: 'v' }) === 'transfer-not-m4-successor', 'M4 enforced');
      const t3 = applyOwnerTransfer(three, [memberY(), three[2]], AG, { fromId: 'x', toId: 'y' });
      assert(t3.ok && t3.users.find((u) => u.id === 'v').credentialOwner === undefined, 'M4 successor of three: y, v untouched');
      refuse('source without bcrypt password', [{ ...ownerX(), password: 'plain' }, memberY()], [memberY()], { fromId: 'x', toId: 'y' });
      // the person's whole group removed: no survivor, no transfer needed
      const gone = applyOwnerTransfer(before, [], AG, undefined);
      assert(gone.ok, 'removing every row of a person needs no transfer');
      // a non-owner removed: no transfer needed
      assert(applyOwnerTransfer(before, [ownerX()], AG, undefined).ok, 'removing the non-owner needs no transfer');
      console.log('  ✓ T owner transfer validated, copied, refused when broken');
    }
    // ---- D ----
    {
      const key = emailKey('p@x.com');
      // grow: X alone -> X + Y (Y joins person x)
      let tx = mockTx();
      await dualWriteChangedEntities(tx, mockDb, doc([ownerX()]), doc([ownerX(), memberY()]));
      assert(idWrites(tx).length === 0, `growing a person changes no projection ${J(idWrites(tx))}`);
      // owner transfer, same name/email: ONLY usersByEmail moves
      const yOwner = { ...memberY(), password: H, credentialOwner: true, credentialOrigin: 'self-registered', recoveryCodeHashes: ['h1'] };
      tx = mockTx({ 'people/x': { id: 'x', name: 'P', primaryEmail: 'p@x.com', status: 'active', _v: 1 }, [`emails/${key}`]: { personId: 'x', status: 'active' } });
      await dualWriteChangedEntities(tx, mockDb, doc([ownerX(), memberY()]), doc([yOwner]));
      const w = idWrites(tx);
      assert(w.length === 1 && w[0].collection === 'usersByEmail' && w[0].op === 'set' && w[0].data.userId === 'y', `owner transfer moves only the lookup (N2) ${J(w)}`);
      // last row gone: retire people + emails, delete the lookup
      tx = mockTx({ 'people/x': { id: 'x', name: 'P', primaryEmail: 'p@x.com', status: 'active', _v: 2 }, [`emails/${key}`]: { personId: 'x', status: 'active' } });
      await dualWriteChangedEntities(tx, mockDb, doc([yOwner]), doc([]));
      const w2 = idWrites(tx);
      assert(w2.some((x) => x.collection === 'people' && x.data.status === 'retired') && w2.some((x) => x.collection === 'emails' && x.data.status === 'retired') && w2.some((x) => x.collection === 'usersByEmail' && x.op === 'delete'), `last row retires ${J(w2)}`);
      // removing the non-owner of a 2-row person: nothing to project
      tx = mockTx();
      await dualWriteChangedEntities(tx, mockDb, doc([ownerX(), memberY()]), doc([ownerX()]));
      assert(idWrites(tx).length === 0, `non-owner removal changes no projection ${J(idWrites(tx))}`);
      // newly invalid group aborts
      const bad = [{ ...ownerX(), credentialOwner: undefined }, memberY()];
      let threw = '';
      try { await dualWriteChangedEntities(mockTx(), mockDb, doc([ownerX()]), doc(bad)); } catch (e) { threw = e.message; }
      assert(/Identity conflict/.test(threw), `newly invalid group must abort, got "${threw}"`);
      // untouched stored invalid group: an unrelated change passes, no identity write
      tx = mockTx();
      const unrelatedAfter = { ...doc(bad), venues: [venue] };
      await dualWriteChangedEntities(tx, mockDb, doc(bad), unrelatedAfter);
      assert(idWrites(tx).length === 0 && tx.writes.some((x) => x.collection === 'venues'), 'tolerated: unrelated commit passes, no identity write');
      // ... a name-only edit of a member is untouched too (identityShape excludes name)
      tx = mockTx();
      await dualWriteChangedEntities(tx, mockDb, doc(bad), doc([bad[0], { ...bad[1], name: 'Renamed' }]));
      assert(idWrites(tx).length === 0, 'tolerated: a name edit inside the stored invalid group writes no projection');
      // ... but a credential change inside it aborts
      threw = '';
      try { await dualWriteChangedEntities(mockTx(), mockDb, doc(bad), doc([bad[0], { ...bad[1], password: H }])); } catch (e) { threw = e.message; }
      assert(/Identity conflict/.test(threw), `a credential change inside the invalid group must abort, got "${threw}"`);
      // repair: invalid -> valid writes the projections
      tx = mockTx();
      await dualWriteChangedEntities(tx, mockDb, doc(bad), doc([ownerX(), memberY()]));
      assert(idWrites(tx).some((x) => x.collection === 'usersByEmail' && x.data?.userId === 'x'), `repair writes the owner lookup ${J(idWrites(tx))}`);
      // a new shared email between two persons still aborts with the old message
      threw = '';
      try { await dualWriteChangedEntities(mockTx(), mockDb, doc([ownerX()]), doc([ownerX(), row('z', 'p@x.com', { agencyId: 'ag-z' })])); } catch (e) { threw = e.message; }
      assert(/Duplicate email/.test(threw), `new shared email must abort with "Duplicate email", got "${threw}"`);
      // newProjectionProblems: same problem, same shapes = tolerated
      const pb = identityProjection(bad, AG);
      const r = newProjectionProblems(pb, bad, pb, bad);
      assert(r.fresh.length === 0 && r.tolerated.length === 1, 'identical problem tolerated');
      console.log('  ✓ D dualwrite owner-derived, fail-closed, tolerant, minimal writes');
    }
    // ---- C ----
    {
      const yRow = memberY();
      const users = [ownerX(), yRow];
      const monolith = { _v: 3, venues: [venue], agencies: AG, users, tasks: [] };
      const key = emailKey('p@x.com');
      const per = {
        'venues/v1': { ...venue, _v: 1 },
        'users/x': { ...ownerX(), _v: 1 },
        'users/y': { ...yRow, _v: 1 },
        [`usersByEmail/${key}`]: { userId: 'x', email: 'p@x.com' },
        'people/x': { id: 'x', name: 'P', primaryEmail: 'p@x.com', status: 'active', _v: 1 },
        [`emails/${key}`]: { personId: 'x', status: 'active', verified: false },
      };
      const r1 = await runConsistencyCheck(createMockDb(monolith, per));
      const mm = (r1.status?.mismatches || []);
      assert(mm.length === 0, `valid 2-row person with owner-derived docs is clean: ${J(mm)}`);
      assert(r1.status.identity.multiGroups === 1 && r1.status.identity.invalidGroups === 0, `counts ${J(r1.status.identity)}`);
      const r2 = await runConsistencyCheck(createMockDb(monolith, { ...per, [`usersByEmail/${key}`]: { userId: 'y', email: 'p@x.com' } }));
      assert((r2.status?.mismatches || []).some((m) => m.reason === 'Email lookup points to wrong user'), 'lookup at the non-owner is reported');
      console.log('  ✓ C read-only check uses the same projection');
    }
  },
};
