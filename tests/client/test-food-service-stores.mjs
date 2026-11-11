import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { createFoodServiceStore } from '../../src/server/inspections/food-service-store.ts';
import { createInboxStore } from '../../src/server/inspections/inbox-store.ts';
const dir = await mkdtemp(join(tmpdir(), 'food-service-'));
process.env.FIRESTORE_MOCK_FILE = join(dir, 'db.json');
try {
 for (const remote of [false, true]) {
  let clock = new Date('2026-11-11T12:00:00Z'), blocked = false, reads = 0, writes = 0;
  const db = new MockFirestore(), original = db.collection.bind(db);
  db.collection = name => { const collection = original(name), doc = collection.doc.bind(collection); collection.doc = id => { const ref = doc(id), get = ref.get.bind(ref), set = ref.set.bind(ref); ref.get = async () => { reads++; return get(); }; ref.set = async (...args) => { writes++; return set(...args); }; return ref; }; return collection; };
  const batch = db.batch.bind(db); db.batch = () => { const b = batch(), commit = b.commit.bind(b); b.commit = async () => { await commit(); writes += b._ops.length; }; return b; };
  const deps = { db: () => remote ? db : null, dataDir: join(dir, remote ? 'remote' : 'local'), staged: () => blocked, now: () => clock };
  const food = createFoodServiceStore(deps), inbox = createInboxStore({ ...deps, submittedAt: () => clock.toISOString() });
  await food.boot(['a']); await inbox.boot(['a']); assert.equal(reads, remote ? 2 : 0);
  await food.update('a', d => { d.manualPlaces.fs_test = { name: 'Test place', address: '', createdAt: clock.toISOString() }; });
  assert.equal(writes, remote ? 1 : 0);
  await food.update('a', () => {}); assert.equal(writes, remote ? 1 : 0);
  const r = i => ({ id: `r${i}`, submittedAt: clock.toISOString() }), u = { id: 'u', name: 'Test admin' };
  for (let i = 0; i < 5; i++) await inbox.mark('a', r(i), u);
  assert.equal(writes, remote ? 1 : 0);
  assert.equal(inbox.status('a', r(1)).status, 'seen');
  assert.equal(await inbox.flush(), 1); assert.equal(writes, remote ? 2 : 0);
  assert.equal(await inbox.flush(), 0); await inbox.mark('a', r(1), u); assert.equal(await inbox.flush(), 0);
  await inbox.followUp('a', r(1), u, true, 'Test note'); assert.equal(inbox.status('a', r(1)).status, 'follow_up');
  await inbox.followUp('a', r(1), u, false, ''); assert.equal(inbox.status('a', r(1)).status, 'seen');
  const reboot = createFoodServiceStore(deps), inboxReboot = createInboxStore({ ...deps, submittedAt: () => clock.toISOString() }); await reboot.boot(['a']); await inboxReboot.boot(['a']);
  assert.deepEqual(reboot.doc('a'), food.doc('a')); assert.deepEqual(inboxReboot.doc('a'), inbox.doc('a'));
  const before = structuredClone(food.doc('a')), n = writes;
  await assert.rejects(food.update('a', d => { d.manualPlaces.huge = { name: 'x'.repeat(900000) }; }), e => e.status === 400);
  assert.deepEqual(food.doc('a'), before); assert.equal(writes, n);
  blocked = true;
  await assert.rejects(food.update('a', d => { d.marked.push('c'); }), e => e.status === 503);
  await assert.rejects(inbox.mark('a', r(99), u), e => e.status === 503);
  await assert.rejects(inbox.followUp('a', r(1), u, true, 'blocked'), e => e.status === 503);
  assert.equal(writes, n); assert.deepEqual(food.doc('a'), before);
  blocked = false;
  await food.update('a', d => { delete d.manualPlaces.fs_test; });
  const deleted = createFoodServiceStore(deps); await deleted.boot(['a']); assert.deepEqual(deleted.doc('a').manualPlaces, {});
 }
 // A failed remote write must retain pending marks, including marks made
 // after the failure. The next flush must combine them into one write.
 {
  const db = new MockFirestore();
  const clock = new Date('2026-11-11T12:00:00Z');
  let attempts = 0, successfulWrites = 0, failWrites = true;
  const collection = db.collection.bind(db);
  db.collection = name => {
    const c = collection(name), doc = c.doc.bind(c);
    c.doc = id => {
      const ref = doc(id), set = ref.set.bind(ref);
      ref.set = async (...args) => {
        attempts++;
        if (failWrites) throw new Error('Simulated Firestore failure');
        successfulWrites++;
        return set(...args);
      };
      return ref;
    };
    return c;
  };
  const batch = db.batch.bind(db);
  db.batch = () => {
    const b = batch(), commit = b.commit.bind(b);
    b.commit = async () => {
      attempts++;
      if (failWrites) throw new Error('Simulated Firestore failure');
      await commit();
      successfulWrites += b._ops.length;
    };
    return b;
  };
  const deps = { db: () => db, dataDir: join(dir, 'retry'), staged: () => false, now: () => clock, submittedAt: () => clock.toISOString() };
  const inbox = createInboxStore(deps);
  await inbox.boot(['retry']);
  const user = { id: 'u', name: 'Test admin' };
  const report = id => ({ id, submittedAt: clock.toISOString() });
  await inbox.mark('retry', report('first'), user);
  await assert.rejects(inbox.flush(), /Simulated Firestore failure/);
  assert.equal(successfulWrites, 0);
  assert.equal(inbox.status('retry', report('first')).status, 'seen');
  await inbox.mark('retry', report('second'), user);
  failWrites = false;
  assert.equal(await inbox.flush(), 1);
  assert.equal(successfulWrites, 1);
  assert.equal(await inbox.flush(), 0);
  const reboot = createInboxStore(deps);
  await reboot.boot(['retry']);
  assert.equal(reboot.status('retry', report('first')).status, 'seen');
  assert.equal(reboot.status('retry', report('second')).status, 'seen');
  assert.equal(attempts, 2);
 }
 // Shutdown retries three times, resolves, and reports unsaved marks once.
 {
  const db = new MockFirestore();
  let attempts = 0;
  const collection = db.collection.bind(db);
  db.collection = name => {
    const c = collection(name), doc = c.doc.bind(c);
    c.doc = id => {
      const ref = doc(id);
      ref.set = async () => { attempts++; throw new Error('Simulated persistent failure'); };
      return ref;
    };
    return c;
  };
  const batch = db.batch.bind(db);
  db.batch = () => {
    const b = batch();
    b.commit = async () => { attempts++; throw new Error('Simulated persistent failure'); };
    return b;
  };
  const clock = new Date('2026-11-11T12:00:00Z');
  const inbox = createInboxStore({ db: () => db, dataDir: join(dir, 'shutdown'), staged: () => false, now: () => clock, submittedAt: () => clock.toISOString() });
  await inbox.boot(['shutdown']);
  await inbox.mark('shutdown', { id: 'pending', submittedAt: clock.toISOString() }, { id: 'u', name: 'Test admin' });
  const warnings = [], originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await assert.rejects(inbox.flush(true), /Simulated persistent failure/);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(attempts, 3);
  assert.deepEqual(warnings, ['[inspections] 1 seen marks could not be saved']);
  assert.equal(inbox.status('shutdown', { id: 'pending', submittedAt: clock.toISOString() }).status, 'seen');
 }
 console.log('PASS food-service/inbox boot, debounce, merge/delete, no-op, persistence, size and maintenance guards (local and Firestore)');
} finally { await rm(dir, { recursive: true, force: true }); }
