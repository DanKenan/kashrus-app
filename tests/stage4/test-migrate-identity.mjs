/**
 * Item 8c: identity migrator planners — unit tests (no server).
 *
 * Proves: stable id order + cursor batching (≤ BATCH_MAX_USERS), agency
 * scope, batch limits; row planning conflicts (email-missing,
 * email-duplicate, person-doc-exists for ANY existing people doc incl.
 * retired, email-active-other-person; a retired mapping is fine); repair
 * planning (missing/stale only, exact 8b shapes, retired person never
 * revived, other person's active mapping never taken, reassignment keeps
 * history); and the 8c final guard in dual-write (a person new to this
 * commit may only CREATE people/{id}; updates of a bound person still work).
 */
import * as mig from '../../src/server/migrate-identity.ts';
import { emailKey } from '../../src/server/identity.ts';
import { dualWriteChangedEntities } from '../../src/server/dualwrite.ts';

function assert(c, m) { if (!c) throw new Error(m); }

function fakeDb(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const log = [];
  const ref = (path) => ({ path });
  const db = { docs, log, collection(name) { return { doc: (id) => ref(`${name}/${id}`) }; } };
  const tx = {
    async get(r) { log.push(['get', r.path]); const d = docs.get(r.path); return { exists: d !== undefined, data: () => d }; },
    set(r, data) { log.push(['set', r.path]); docs.set(r.path, JSON.parse(JSON.stringify(data))); },
    delete(r) { log.push(['delete', r.path]); docs.delete(r.path); },
  };
  return { db, tx };
}
const row = (id, email, extra = {}) => ({ id, email, name: `N ${id}`, role: 'mashgiach', agencyId: 'agency-a', venueId: 'v1', ...extra });
const pad = (n) => String(n).padStart(4, '0');

export default {
  name: 'Item 8c: identity migrator planners (unit)',
  whatItProves: 'Bounded, ordered, agency-scoped batches; row and repair planning conflicts per the signed 8c plan v2 (no person-doc takeover, no revival, no mapping takeover); the dual-write final guard refuses creating over an existing people doc while bound-person updates still work.',
  async run() {
    // --- batching, order, scope, cursor ---
    {
      const users = [];
      for (let i = 250; i >= 1; i--) users.push(row(`u${pad(i)}`, `u${i}@x.com`));
      users.push(row('b1', 'b1@x.com', { agencyId: 'agency-b' }));
      users.push(row('hkc1', 'h1@x.com', { agencyId: undefined }));
      users.push(row('m1', 'm1@x.com', { personId: 'm1' }));
      const doc = { users };
      let c = null, sizes = [], seen = [];
      for (;;) {
        const n = mig.nextCandidates(doc, 'agency-a', 'rows', c);
        if (!n.batch.length) break;
        sizes.push(n.batch.length); seen.push(...n.batch.map((u) => u.id));
        c = n.lastId;
        if (!n.more) break;
      }
      assert(JSON.stringify(sizes) === JSON.stringify([99, 99, 52]), `batch sizes ${sizes}`);
      assert(seen.length === 250 && seen.every((id, i) => i === 0 || seen[i - 1] < id), 'stable ascending id order, no repeats');
      assert(!seen.includes('b1') && !seen.includes('hkc1') && !seen.includes('m1'), 'agency scope + only unmigrated rows');
      assert(mig.nextCandidates(doc, 'agency-hkc', 'rows', null).batch.map((u) => u.id).join() === 'hkc1', "missing agencyId = 'agency-hkc'");
      assert(mig.nextCandidates(doc, 'agency-a', 'repair', null).batch.map((u) => u.id).join() === 'm1', 'repair step = migrated rows only');
      assert(mig.rowBatchWithinLimits(99) && !mig.rowBatchWithinLimits(100) && mig.rowBatchDocCount(99) <= mig.READ_LIMIT, 'limits');
      console.log('  ✓ batching: 250 → 99/99/52, ordered, cursor, agency-scoped, limits');
    }

    // --- row planning ---
    {
      const doc = { users: [
        row('a1', 'a1@x.com'), row('a2', ''), row('a3', 'dup@x.com'), row('a4', 'DUP@x.com '),
        row('a5', 'a5@x.com'), row('a6', 'a6@x.com'), row('a7', 'a7@x.com'), row('a8', 'a8@x.com'),
      ] };
      const batch = doc.users;
      const people = new Map([['a5', { id: 'a5', status: 'retired' }], ['a8', { id: 'a8', status: 'active' }]]);
      const emails = new Map([
        [emailKey('a6@x.com'), { personId: 'someone', status: 'active' }],
        [emailKey('a7@x.com'), { personId: 'old', status: 'retired' }],
      ]);
      const p = mig.planRowBatch(doc, batch, people, emails);
      const by = Object.fromEntries(p.conflicts.map((x) => [x.userId, x.reason]));
      assert(JSON.stringify(p.migrate) === '["a1","a7"]', `migrate ${p.migrate}`);
      assert(by.a2 === 'email-missing' && by.a3 === 'email-duplicate' && by.a4 === 'email-duplicate', JSON.stringify(by));
      assert(by.a5 === 'person-doc-exists' && by.a8 === 'person-doc-exists', 'any existing people doc (retired or active) blocks migration');
      assert(by.a6 === 'email-active-other-person', 'active mapping of another person blocks');
      assert(JSON.stringify(p.conflicts).indexOf('@') === -1, 'conflicts carry ids + reason codes only');
      // a duplicate with an already-migrated row elsewhere also blocks
      const p2 = mig.planRowBatch({ users: [row('z1', 'z@x.com'), row('z2', 'z@x.com', { personId: 'z2', agencyId: 'agency-b' })] }, [row('z1', 'z@x.com')], new Map(), new Map());
      assert(p2.conflicts[0]?.reason === 'email-duplicate', 'duplicate across agencies blocks');
      console.log('  ✓ row planning: email-missing / email-duplicate / person-doc-exists (incl. retired) / email-active-other-person; retired mapping OK');
    }

    // --- repair planning ---
    {
      const now = '2026-10-21T00:00:00.000Z';
      const r1 = row('r1', 'R1@x.com', { personId: 'r1' });       // nothing exists → create both
      const r2 = row('r2', 'r2@x.com', { personId: 'r2' });       // all fine → ok
      const r3 = row('r3', 'r3@x.com', { personId: 'r3', name: 'New Name' }); // stale name
      const r4 = row('r4', 'r4@x.com', { personId: 'r4' });       // retired person → conflict
      const r5 = row('r5', 'r5@x.com', { personId: 'r5' });       // mapping active for other → conflict
      const r6 = row('r6', 'r6@x.com', { personId: 'r6' });       // mapping retired for other → reassign w/ history
      const doc = { users: [r1, r2, r3, r4, r5, r6] };
      const P = (id, e, extra = {}) => ({ id, name: `N ${id}`, primaryEmail: e, status: 'active', createdAt: 'c', _v: 1, ...extra });
      const people = new Map([
        ['r2', P('r2', 'r2@x.com')], ['r3', P('r3', 'r3@x.com')], ['r4', P('r4', 'r4@x.com', { status: 'retired' })],
        ['r5', P('r5', 'r5@x.com')], ['r6', P('r6', 'r6@x.com')],
      ]);
      const E = (pid, status = 'active', extra = {}) => ({ personId: pid, status, verified: false, source: 'admin-entered', addedAt: 'a', ...extra });
      const emails = new Map([
        [emailKey('r2@x.com'), E('r2')], [emailKey('r3@x.com'), E('r3')], [emailKey('r4@x.com'), E('r4')],
        [emailKey('r5@x.com'), E('other')], [emailKey('r6@x.com'), E('gone', 'retired', { previousPersonIds: ['older'] })],
      ]);
      const p = mig.planRepairBatch(doc, doc.users, people, emails, now);
      const by = Object.fromEntries(p.conflicts.map((x) => [x.userId, x.reason]));
      assert(by.r4 === 'person-doc-retired' && by.r5 === 'email-active-other-person', JSON.stringify(by));
      assert(p.ok === 1 && JSON.stringify(p.repaired) === '["r1","r3","r6"]', `repaired ${p.repaired} ok ${p.ok}`);
      const w = Object.fromEntries(p.writes.map((x) => [`${x.collection}/${x.id}`, x.data]));
      assert(w['people/r1'] && w['people/r1'].primaryEmail === 'r1@x.com' && w['people/r1'].status === 'active' && w['people/r1']._v === 1, 'missing people created (8b shape)');
      assert(w[`emails/${emailKey('r1@x.com')}`]?.verified === false && w[`emails/${emailKey('r1@x.com')}`]?.personId === 'r1', 'missing mapping created verified:false');
      assert(w['people/r3']?.name === 'New Name' && w['people/r3']._v === 2 && w['people/r3'].createdAt === 'c', 'stale people updated, createdAt kept');
      const m6 = w[`emails/${emailKey('r6@x.com')}`];
      assert(m6 && JSON.stringify(m6.previousPersonIds) === '["older","gone"]' && m6.reassignedAt === now && m6.verified === false, 'retired mapping reassigned with history');
      assert(!w['people/r4'] && !w['people/r5'] && !w[`emails/${emailKey('r5@x.com')}`], 'nothing written for conflicted rows');
      const again = mig.planRepairBatch(doc, [r2], people, emails, now);
      assert(again.writes.length === 0 && again.ok === 1, 'nothing missing → zero writes');
      // a people doc at people/{personId} carrying ANOTHER identity (embedded id
      // differs) or an unknown status → 'person-doc-mismatch', nothing written
      const r7 = row('r7', 'r7@x.com', { personId: 'r7' });
      const r8 = row('r8', 'r8@x.com', { personId: 'r8' });
      const peopleX = new Map([['r7', P('someone-else', 'x@else.test')], ['r8', P('r8', 'r8@x.com', { status: 'frozen' })]]);
      const mx = mig.planRepairBatch({ users: [r7, r8] }, [r7, r8], peopleX, new Map(), now);
      const byX = Object.fromEntries(mx.conflicts.map((x) => [x.userId, x.reason]));
      assert(byX.r7 === 'person-doc-mismatch' && byX.r8 === 'person-doc-mismatch' && mx.writes.length === 0 && mx.repaired.length === 0, `mismatch ${JSON.stringify(byX)} writes ${mx.writes.length}`);
      console.log('  ✓ repair planning: missing/stale only, 8b shapes, retired person never revived, foreign people doc never overwritten, no mapping takeover, history kept');
    }

    // --- dual-write final guard ---
    {
      // born-migrated (new) row over an existing RETIRED people doc → throws, nothing written
      const { db, tx } = fakeDb({ 'people/x1': { id: 'x1', name: 'Old', primaryEmail: 'old@x.com', status: 'retired', createdAt: 'c', _v: 3 } });
      let threw = false;
      try { await dualWriteChangedEntities(tx, db, { users: [] }, { users: [row('x1', 'new@x.com', { personId: 'x1' })] }); }
      catch (e) { threw = /person document already exists/.test(e.message); }
      assert(threw, 'creating over an existing people doc must throw');
      assert(!db.log.some((l) => l[0] !== 'get'), 'no write before the guard');
      assert(db.docs.get('people/x1').status === 'retired', 'retired doc untouched');
      // a legacy row the migrator migrates (before: no personId) → same guard
      const f2 = fakeDb({ 'people/x2': { id: 'x2', status: 'active', name: 'Z', primaryEmail: 'z@x.com', createdAt: 'c', _v: 1 } });
      threw = false;
      try { await dualWriteChangedEntities(f2.tx, f2.db, { users: [row('x2', 'x2@x.com')] }, { users: [row('x2', 'x2@x.com', { personId: 'x2' })] }); }
      catch (e) { threw = /person document already exists/.test(e.message); }
      assert(threw, 'migrating a row over an existing people doc must throw');
      // a bound person's ordinary rename / email change still works
      const f3 = fakeDb({ 'people/x3': { id: 'x3', name: 'N x3', primaryEmail: 'x3@x.com', status: 'active', createdAt: 'c', _v: 1 } });
      const b3 = row('x3', 'x3@x.com', { personId: 'x3' });
      await dualWriteChangedEntities(f3.tx, f3.db, { users: [b3] }, { users: [{ ...b3, name: 'Renamed', email: 'x3new@x.com' }] });
      const p3 = f3.db.docs.get('people/x3');
      assert(p3.name === 'Renamed' && p3.primaryEmail === 'x3new@x.com' && p3._v === 2, 'bound person update still works');
      console.log('  ✓ final guard: create over existing people doc (retired/active) refused, nothing written; bound-person updates unaffected');
    }
  },
};
