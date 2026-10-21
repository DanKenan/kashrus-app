/**
 * Item 8b: identity projections — unit tests (no server).
 *
 * Proves:
 *  - enforceIdentityFields: new rows born migrated (personId = id), existing
 *    rows keep personId/tokenEpoch exactly (forged values reverted and
 *    reported), legacy rows stay unmigrated, derived fields recomputed.
 *  - dualWriteChangedEntities: people/emails written exactly as specified;
 *    retire on removal (record kept); email change retires the old key;
 *    RETIRED mapping reassigned with history and verified=false; ACTIVE
 *    mapping of another person refused (throws before any write) unless that
 *    person's row is removed in the same commit; reads all precede writes.
 *  - perEntityStatus (via runConsistencyCheck): strict — a migrated row
 *    without its projections is a mismatch ("identity projection missing"),
 *    an active projection without a row is a mismatch, retired docs are
 *    fine, unmigrated rows expect nothing; counts are reported.
 */
import { enforceIdentityFields, deriveIdentityFields, stripServerOnlyUserFields, emailKey } from '../../src/server/identity.ts';
import { dualWriteChangedEntities } from '../../src/server/dualwrite.ts';
import { runConsistencyCheck } from '../../src/server/consistency.ts';
import { createMockDb, venue } from './test-consistency.mjs';

function assert(c, m) { if (!c) throw new Error(m); }

// A fake Firestore + transaction that records the order of reads and writes.
function fakeDb(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const log = [];
  const ref = (path) => ({ path });
  const db = {
    docs, log,
    collection(name) { return { doc: (id) => ref(`${name}/${id}`) }; },
  };
  const tx = {
    async get(r) { log.push(['get', r.path]); const d = docs.get(r.path); return { exists: d !== undefined, data: () => d }; },
    set(r, data) { log.push(['set', r.path]); docs.set(r.path, JSON.parse(JSON.stringify(data))); },
    delete(r) { log.push(['delete', r.path]); docs.delete(r.path); },
  };
  return { db, tx };
}
const row = (id, email, extra = {}) => ({ id, email, name: `N ${id}`, role: 'mashgiach', agencyId: 'agency-a', venueId: 'v1', avatarColor: '#fff', ...extra });
const agencies = [{ id: 'agency-a', adminEmail: 'Boss@X.com' }];

export default {
  name: 'Item 8b: identity projections (unit)',
  whatItProves: 'One enforcement point for server-only identity fields; projections written/retired/reassigned exactly per the 8b contract and fail closed on an active mapping; the consistency check is strict about missing and orphan projections.',
  async run() {
    // --- enforceIdentityFields ---
    {
      const before = [row('legacy', 'l@x.com'), row('m1', 'm1@x.com', { personId: 'm1', tokenEpoch: 3, venueAccess: ['v1'], isPrimaryAdmin: false })];
      const violations = [];
      const after = enforceIdentityFields(
        before,
        [
          { ...before[0], personId: 'forged', isPrimaryAdmin: true },                         // legacy row: forged personId
          { ...before[1], personId: 'other', tokenEpoch: 99, venueId: 'v2' },                 // migrated: forged + moved
          { ...row('n1', 'boss@x.com'), role: 'admin', venueId: undefined, personId: 'zzz', tokenEpoch: 5, venueAccess: ['v9'] }, // new row
        ],
        agencies,
        { onViolation: (id, f) => violations.push(`${id}:${f}`) }
      );
      assert(after[0].personId === undefined && after[0].isPrimaryAdmin === undefined && after[0].venueAccess === undefined, 'legacy row must stay unmigrated');
      assert(after[1].personId === 'm1' && after[1].tokenEpoch === 3, 'existing personId/tokenEpoch must be kept exactly');
      assert(JSON.stringify(after[1].venueAccess) === '["v2"]', 'venueAccess must follow venueId');
      assert(after[2].personId === 'n1' && after[2].tokenEpoch === undefined, 'new row born migrated, no tokenEpoch');
      assert(after[2].isPrimaryAdmin === true && JSON.stringify(after[2].venueAccess) === '[]', 'primary admin derived case-insensitively');
      for (const v of ['legacy:personId', 'm1:personId', 'm1:tokenEpoch', 'n1:personId', 'n1:tokenEpoch']) assert(violations.includes(v), `violation not reported: ${v} (${violations})`);
      const removed = enforceIdentityFields(before, [{ ...before[1], personId: undefined, tokenEpoch: undefined }], agencies, { onViolation: (id, f) => violations.push(`rm-${id}:${f}`) });
      assert(removed[0].personId === 'm1' && removed[0].tokenEpoch === 3, 'a mutator cannot remove personId/tokenEpoch');
      assert(violations.includes('rm-m1:personId') && violations.includes('rm-m1:tokenEpoch'), 'removal attempt reported');
      assert(deriveIdentityFields({ role: 'admin', email: 'boss@x.com', agencyId: 'agency-b' }, agencies).isPrimaryAdmin === false, 'other agency is never primary admin');
      const stripped = stripServerOnlyUserFields({ a: 1, personId: 'x', venueAccess: [], isPrimaryAdmin: true, tokenEpoch: 1 });
      assert(JSON.stringify(stripped) === '{"a":1}', 'strip removes all four fields');
      console.log('  ✓ enforcement: born migrated, immutable personId/tokenEpoch (reported), legacy untouched, derived fields');
    }

    // --- dualWrite: create, then retire on removal ---
    const A = row('u1', 'A@x.com', { personId: 'u1' });
    {
      const { db, tx } = fakeDb();
      await dualWriteChangedEntities(tx, db, { users: [] }, { users: [A] });
      const p = db.docs.get('people/u1');
      const e = db.docs.get(`emails/${emailKey('a@x.com')}`);
      assert(p && p.id === 'u1' && p.name === 'N u1' && p.primaryEmail === 'a@x.com' && p.status === 'active' && p.createdAt && p._v === 1, `people doc wrong: ${JSON.stringify(p)}`);
      assert(e && e.personId === 'u1' && e.status === 'active' && e.verified === false && e.source === 'admin-entered' && e.addedAt && !('previousPersonIds' in e), `emails doc wrong: ${JSON.stringify(e)}`);
      const firstSet = db.log.findIndex((l) => l[0] !== 'get');
      assert(db.log.slice(firstSet).every((l) => l[0] !== 'get'), 'a read happened after a write');
      for (const [k, v] of db.docs) assert(!JSON.stringify(v).match(/password|kioskPin|phone|token/i), `secret-like field in ${k}`);
      const createdAt = p.createdAt;
      // unchanged row → no identity writes
      db.log.length = 0;
      await dualWriteChangedEntities(tx, db, { users: [A] }, { users: [{ ...A, role: 'coordinator' }] });
      assert(!db.log.some((l) => l[1].startsWith('people/') || l[1].startsWith('emails/')), 'projection rewritten without a name/email change');
      // removal → retired, record kept
      await dualWriteChangedEntities(tx, db, { users: [A] }, { users: [] });
      const p2 = db.docs.get('people/u1'); const e2 = db.docs.get(`emails/${emailKey('a@x.com')}`);
      assert(p2.status === 'retired' && p2.retiredAt && p2.name === 'N u1' && p2.primaryEmail === 'a@x.com' && p2.createdAt === createdAt, `people not retired as specified: ${JSON.stringify(p2)}`);
      assert(e2.status === 'retired' && e2.retiredAt && e2.personId === 'u1', `emails not retired: ${JSON.stringify(e2)}`);
      // RETIRED mapping reassigned to a NEW person: history kept, verified false
      const B = row('u2', 'a@X.com ', { personId: 'u2' });
      await dualWriteChangedEntities(tx, db, { users: [] }, { users: [B] });
      const e3 = db.docs.get(`emails/${emailKey('a@x.com')}`);
      assert(e3.personId === 'u2' && e3.status === 'active' && e3.verified === false && e3.source === 'admin-entered' && JSON.stringify(e3.previousPersonIds) === '["u1"]' && e3.reassignedAt && !('retiredAt' in e3), `reassignment wrong: ${JSON.stringify(e3)}`);
      assert(db.docs.get('people/u1').status === 'retired', 'old person must stay retired');
      console.log('  ✓ dual-write: projections created, unchanged rows untouched, removal retires (record kept), retired mapping reassigned with history');
    }

    // --- ACTIVE mapping of another person: fail closed (throws before any write) ---
    {
      const key = emailKey('c@x.com');
      const { db, tx } = fakeDb({ [`emails/${key}`]: { personId: 'ghost', status: 'active', verified: false, source: 'admin-entered', addedAt: 'x' } });
      let threw = false;
      try { await dualWriteChangedEntities(tx, db, { users: [] }, { users: [row('u3', 'c@x.com', { personId: 'u3' })] }); }
      catch (e) { threw = /active for another person/.test(e.message); }
      assert(threw, 'active mapping for another person must throw');
      assert(!db.log.some((l) => l[0] === 'set' || l[0] === 'delete'), 'nothing may be written when the mapping is owned');
      assert(db.docs.get(`emails/${key}`).personId === 'ghost', 'owned mapping unchanged');
      console.log('  ✓ dual-write: an active mapping owned by another person is refused, nothing written');
    }

    // --- same commit: remove X and create Y with X's email → retired+reassigned in one step ---
    {
      const X = row('x1', 'd@x.com', { personId: 'x1' });
      const { db, tx } = fakeDb();
      await dualWriteChangedEntities(tx, db, { users: [] }, { users: [X] });
      const Y = row('y1', 'd@x.com', { personId: 'y1' });
      await dualWriteChangedEntities(tx, db, { users: [X] }, { users: [Y] });
      const e = db.docs.get(`emails/${emailKey('d@x.com')}`);
      assert(e.personId === 'y1' && e.status === 'active' && e.verified === false && JSON.stringify(e.previousPersonIds) === '["x1"]' && e.reassignedAt, `one-step reassignment wrong: ${JSON.stringify(e)}`);
      assert(db.docs.get('people/x1').status === 'retired' && db.docs.get('people/y1').status === 'active', 'people states after swap');
      // but a still-present owner blocks it: X keeps d@, Z (new) wants it → dualwrite sees Z and X → monolith dup check throws first
      let threw = false;
      try { await dualWriteChangedEntities(tx, db, { users: [Y] }, { users: [Y, row('z1', 'd@x.com', { personId: 'z1' })] }); } catch { threw = true; }
      assert(threw, 'two live rows with one email must throw');
      console.log('  ✓ dual-write: remove-and-create in one commit reassigns in one step; a live owner still blocks');
    }

    // --- email change on a migrated row: old key retired, new key active ---
    {
      const M = row('m2', 'old@x.com', { personId: 'm2' });
      const { db, tx } = fakeDb();
      await dualWriteChangedEntities(tx, db, { users: [] }, { users: [M] });
      await dualWriteChangedEntities(tx, db, { users: [M] }, { users: [{ ...M, email: 'new@x.com' }] });
      const eo = db.docs.get(`emails/${emailKey('old@x.com')}`); const en = db.docs.get(`emails/${emailKey('new@x.com')}`);
      assert(eo.status === 'retired' && eo.personId === 'm2', 'old key retired');
      assert(en.status === 'active' && en.personId === 'm2' && en.verified === false, 'new key active');
      assert(db.docs.get('people/m2').primaryEmail === 'new@x.com' && db.docs.get('people/m2')._v === 2, 'people primaryEmail updated');
      console.log('  ✓ dual-write: email change retires the old key and activates the new one');
    }

    // --- legacy rows produce no projections ---
    {
      const { db, tx } = fakeDb();
      await dualWriteChangedEntities(tx, db, { users: [] }, { users: [row('lg', 'lg@x.com')] });
      assert(![...db.docs.keys()].some((k) => k.startsWith('people/') || k.startsWith('emails/')), 'legacy row must not get projections');
      console.log('  ✓ dual-write: unmigrated rows get no projections');
    }

    // --- consistency: strict ---
    {
      const u = { id: 'u1', agencyId: 'agency-hkc', email: 'a@x.com', name: 'U', role: 'mashgiach', avatarColor: '#fff', personId: 'u1', venueAccess: [], isPrimaryAdmin: false };
      const legacy = { id: 'u9', agencyId: 'agency-hkc', email: 'z@x.com', name: 'L', role: 'mashgiach', avatarColor: '#fff' };
      const base = {
        'venues/v1': { ...venue, _v: 1 },
        'users/u1': { ...u, _v: 1 },
        'users/u9': { ...legacy, _v: 1 },
        [`usersByEmail/${emailKey('a@x.com')}`]: { userId: 'u1', email: 'a@x.com' },
        [`usersByEmail/${emailKey('z@x.com')}`]: { userId: 'u9', email: 'z@x.com' },
      };
      const proj = {
        'people/u1': { id: 'u1', name: 'U', primaryEmail: 'a@x.com', status: 'active', createdAt: 'x', _v: 1 },
        [`emails/${emailKey('a@x.com')}`]: { personId: 'u1', status: 'active', verified: false, source: 'admin-entered', addedAt: 'x' },
        'people/old': { id: 'old', name: 'Gone', primaryEmail: 'g@x.com', status: 'retired', createdAt: 'x', retiredAt: 'y', _v: 2 },
        [`emails/${emailKey('g@x.com')}`]: { personId: 'old', status: 'retired', verified: false, source: 'admin-entered', addedAt: 'x', retiredAt: 'y' },
      };
      const monolith = { _v: 5, venues: [venue], users: [u, legacy], tasks: [] };
      let r = await runConsistencyCheck(createMockDb(monolith, { ...base, ...proj }));
      assert(r.status && r.status.match, `healthy state should match: ${JSON.stringify(r.status?.mismatches)}`);
      assert(r.status.identity && r.status.identity.migratedRows === 1 && r.status.identity.unmigratedRows === 1 && r.status.identity.peopleRetired === 1 && r.status.identity.emailsActive === 1, `counts: ${JSON.stringify(r.status.identity)}`);
      // migrated row restored without projections (e.g. a legacy 5-set restore) → not healthy
      r = await runConsistencyCheck(createMockDb(monolith, base));
      const missing = (r.status?.mismatches || []).filter((m) => m.reason === 'identity projection missing');
      assert(!r.status.match && missing.some((m) => m.collection === 'people' && m.id === 'u1') && missing.some((m) => m.collection === 'emails' && m.id === 'u1'), `missing projections not flagged: ${JSON.stringify(r.status?.mismatches)}`);
      // active orphan projections → flagged, never repaired
      r = await runConsistencyCheck(createMockDb(monolith, {
        ...base, ...proj,
        'people/ghost': { id: 'ghost', name: 'G', primaryEmail: 'h@x.com', status: 'active', createdAt: 'x', _v: 1 },
        [`emails/${emailKey('h@x.com')}`]: { personId: 'ghost', status: 'active', verified: false, source: 'admin-entered', addedAt: 'x' },
      }));
      const orph = (r.status?.mismatches || []).filter((m) => m.reason === 'active projection without row');
      assert(!r.status.match && orph.some((m) => m.collection === 'people' && m.id === 'ghost') && orph.some((m) => m.collection === 'emails' && m.id === 'ghost'), `orphans not flagged: ${JSON.stringify(r.status?.mismatches)}`);
      // out-of-date people doc
      r = await runConsistencyCheck(createMockDb(monolith, { ...base, ...proj, 'people/u1': { ...proj['people/u1'], name: 'Stale' } }));
      assert((r.status?.mismatches || []).some((m) => m.reason === 'identity projection out of date' && m.id === 'u1'), 'stale people doc not flagged');
      console.log('  ✓ consistency: strict on missing/orphan/stale projections; retired and unmigrated fine; counts reported');
    }
  },
};
