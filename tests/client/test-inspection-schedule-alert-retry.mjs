import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
import { installReadMeter, resetReadMeter, readMeterSnapshot } from '../../src/server/read-meter.ts';
import { installWriteMeter, resetWriteMeter, writeMeterSnapshot } from '../../src/server/write-meter.ts';
const dir = await mkdtemp(join(tmpdir(), 'alert-retry-'));
process.env.FIRESTORE_MOCK_FILE = join(dir, 'db.json');
const db = new MockFirestore(); installReadMeter(db); installWriteMeter(db);
let now = new Date('2026-11-03T09:00:00Z'), failCommit = true, failUser = '', commits = 0, settled = 0;
const attempts = [], delivered = [], people = ['admin', 'mashgiach', 'coordinator'].map((role, i) => ({ id: `u${i}`, name: `Test person ${i}`, role, agencyId: 'a' }));
const reset = () => { resetReadMeter(); resetWriteMeter(); };
const budget = (r, w) => { assert.equal(readMeterSnapshot().total, r); assert.equal(writeMeterSnapshot().total, w); };
try {
  await db.collection('inspectionSchedules').doc('a').set({ settings: { countFrom: 'planned', mashgichimSeeAll: true }, companies: { c: { schedule: { kind: 'dates', dates: ['2026-11-03'] }, mashgiachIds: ['u1'], coordinatorIds: ['u2'], mute: null, lastVisit: null, alert: null } }, updatedAt: now.toISOString() });
  const batch = db.batch.bind(db);
  db.batch = () => {
    const b = batch(), commit = b.commit.bind(b);
    b.commit = async () => {
      commits++;
      assert.equal(settled, attempts.length, 'Delivery promises must settle before committing');
      assert.equal(attempts.length % 3, 0, 'Every recipient must be attempted before commit');
      assert.ok(attempts.length >= 3, 'Push must precede the state commit');
      if (failCommit) { failCommit = false; throw Error('Commit unavailable'); }
      return commit();
    };
    return b;
  };
  const app = Object.fromEntries(['get', 'post', 'put'].map(method => [method, () => {}]));
  const routes = registerInspectionRoutes(app, { db: () => db, dataDir: dir, staged: () => false, now: () => now, user: () => people[0],
    agencyIds: () => ['a'], scheduleAgencyIds: () => ['a'], timeZone: () => 'UTC', people: () => [...people, { ...people[0], id: 'foreign', agencyId: 'other' }],
    source: () => ({ state: { companies: [{ id: 'c', name: 'Test factory' }], itemsFor: () => [] } }), maxPhotoChars: 400000, photoRe: /./,
    push: async user => { attempts.push(user.id); await new Promise(resolve => queueMicrotask(resolve)); settled++; if (user.id === failUser) throw Error('Push unavailable'); delivered.push(user.id); },
  });
  await routes.boot(); reset();
  await assert.rejects(routes.check(), /Commit unavailable/); budget(0, 0);
  assert.deepEqual(delivered, ['u0', 'u1', 'u2']); assert.equal(db._docs['inspectionSchedules/a'].companies.c.alert, null);
  reset(); const retry = await routes.check(); budget(0, 1);
  assert.deepEqual(retry, { sent: [], writes: 1 }); assert.equal(attempts.length, 3); assert.equal(commits, 2);
  assert.equal(db._docs['inspectionSchedules/a'].companies.c.alert.count, 1);
  reset(); assert.deepEqual(await routes.check(), { sent: [], writes: 0 }); budget(0, 0);
  now = new Date('2026-11-10T09:00:00Z'); failUser = 'u1'; reset();
  const reminder = await routes.check(); budget(0, 1);
  assert.equal(reminder.sent[0].kind, 'reminder'); assert.deepEqual(attempts.slice(3), ['u0', 'u1', 'u2']);
  assert.deepEqual(delivered.slice(3), ['u0', 'u2']); assert.equal(db._docs['inspectionSchedules/a'].companies.c.alert.count, 2);
  reset(); assert.deepEqual(await routes.check(), { sent: [], writes: 0 }); budget(0, 0); assert.equal(attempts.length, 6);
  console.log('alert delivery: push before commit, failed write retries without another push, per-user failure isolation, exact 0R/0W or 0R/1W passed');
} finally { await rm(dir, { recursive: true, force: true }); }
