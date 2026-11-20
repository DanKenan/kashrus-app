// npx tsx tests/stage2/fee-change-worker.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockFirestore } from './firestore-mock.mjs';
import { createFeesStore } from '../../src/server/inspections/fees-store.ts';
import { createFeeChangeWorker } from '../../src/server/inspections/fee-change-events.ts';
import { createFeeChangePush } from '../../src/server/inspections/fee-change-push.ts';

const minute = 60_000;
const agency = 'agency', admin = 'admin';
const input = { agency, report: 'report', companyId: 'factory', company: 'Factory', actorId: 'coordinator',
  actor: 'Coordinator', coordinator: true, newRate: 85, inherited: 80, admins: [admin, admin] };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fee-change-worker-'));
const subscriptions = ['phone', 'tablet'].map(endpoint => ({ endpoint, keys: { auth: 'auth', p256dh: 'key' } }));

try {
 for (const storage of ['local', 'firestore']) {
  const dataDir = path.join(root, storage);
  process.env.FIRESTORE_MOCK_FILE = path.join(root, 'db.json');
  let db = storage === 'firestore' ? new MockFirestore() : null;
  let now = Date.UTC(2026, 10, 20), available = [...subscriptions], failPhone = true, failAtAck = false;
  const deps = { db: () => db, now: () => new Date(now), dataDir, staged: () => false };
  let fees, worker, delayEligibility = false;
  const attempts = [], accepted = [], pruned = [];
  let send = async sub => {
    if (sub.endpoint === 'phone' && failPhone) throw Object.assign(Error('Busy'), { statusCode: 429, headers: { 'retry-after': '120' } });
    return { statusCode: 201 };
  };
  const push = createFeeChangePush({
    eligible: async (a, u) => {
      if (delayEligibility) now += 3 * minute;
      return a === agency && u === admin ? available : [];
    },
    send: async (sub, payload, topic) => {
      attempts.push(sub.endpoint);
      const response = await send(sub);
      accepted.push([sub.endpoint, JSON.parse(payload).data.eventId, topic]);
      if (failAtAck) triggerFailure();
      return response;
    },
    prune: async sub => { pruned.push(sub.endpoint); available = available.filter(s => s !== sub); },
  });
  async function boot() {
    if (db) db = new MockFirestore();
    fees = createFeesStore(deps);
    await fees.ensure(agency);
    worker = createFeeChangeWorker(deps, fees, push);
  }
  function triggerFailure() {
    if (db) {
      const orig = db.runTransaction;
      db.runTransaction = async function (action) {
        this.runTransaction = orig;
        return orig.call(this, async tx => { await action(tx); throw Error('Injected commit failure'); });
      };
    } else {
      const orig = fs.rename;
      fs.rename = async () => { fs.rename = orig; throw Error('Injected commit failure'); };
    }
  }
  await boot();
  await fees.update(agency, next => { next.settings.feeEditors = 'admins_and_coordinators'; });
  triggerFailure();
  await assert.rejects(fees.recordChange(input), /Injected commit failure/);
  await boot();
  assert.deepEqual(fees.doc(agency).places, {});
  assert.deepEqual(fees.doc(agency).decisions, {});
  const inbox = async () => (await worker.inbox(agency, admin)).events;
  const sweep = () => worker.sweep([agency]);
  assert.deepEqual(await inbox(), []);
  // Separate instances contend on the same Firestore transaction. Local requests share the agency lock.
  const other = db ? createFeesStore(deps) : fees;
  await other.ensure(agency);
  const [first, second] = await Promise.all([fees.recordChange(input), other.recordChange(input)]);
  assert.deepEqual(first, second);
  await boot();
  const [event] = await inbox();
  assert.equal(event.status, 'Pending');
  assert.equal((await inbox()).length, 1);
  assert.deepEqual((await worker.inbox('other', admin)).events, []);
  assert.deepEqual((await worker.inbox(agency, 'other')).events, []);
  assert.equal(await worker.markRead(agency, event.id, 'other'), false);
  assert.equal(await worker.markRead(agency, event.id, admin), true);
  assert.equal(await worker.markRead(agency, event.id, admin), true);
  assert.equal((await inbox())[0].status, 'Pending');
  assert.deepEqual(attempts, []);

  await Promise.all([sweep(), sweep()]);
  assert.deepEqual(attempts.sort(), ['phone', 'tablet']);
  now += minute;
  await sweep(); assert.equal(attempts.length, 2); // Retry-After takes precedence over one minute.
  now += minute; failPhone = false;
  await Promise.all([sweep(), sweep()]);
  assert.deepEqual(accepted.map(([target]) => target).sort(), ['phone', 'tablet']);
  assert.equal((await inbox())[0].status, 'Sent to push service');
  assert.equal((await inbox()).length, 1);

  // Accept, lose only the acknowledgement, restart, then reclaim the expired lease.
  now += minute;
  available = [subscriptions[0]]; failAtAck = true;
  await fees.recordChange({ ...input, report: 'ambiguous', newRate: 90 });
  await assert.rejects(sweep(), /Injected commit failure/);
  failAtAck = false;
  await boot();
  const count = accepted.length;
  await sweep(); assert.equal(accepted.length, count);
  now += 2 * minute;
  await sweep(); assert.deepEqual(accepted.at(-1), accepted.at(-2));
  assert.equal((await inbox()).length, 2);
  assert.equal((await inbox())[0].status, 'Sent to push service');

  // A slow membership refresh cannot send using an expired lease.
  now += minute; delayEligibility = true;
  await fees.recordChange({ ...input, report: 'slow-refresh', newRate: 92 });
  const beforeSlow = attempts.length;
  await sweep();
  assert.equal(attempts.length, beforeSlow);
  delayEligibility = false; now += minute;
  await sweep();
  assert.equal(attempts.length, beforeSlow + 1);

  // No eligible subscription and an expired subscription are both terminal.
  now += minute; available = [];
  await fees.recordChange({ ...input, report: 'opted-out', newRate: 95 });
  await sweep(); assert.equal((await inbox())[0].status, 'Push unavailable');
  for (const code of [404, 410]) {
    now += minute; available = [subscriptions[0]];
    send = async () => { throw Object.assign(Error('Gone'), { statusCode: code }); };
    await fees.recordChange({ ...input, report: 'gone-' + code, newRate: code });
    await sweep(); assert.equal((await inbox())[0].status, 'Push unavailable');
  }
  assert.deepEqual(pruned, ['phone', 'phone']);
  now += minute; available = [subscriptions[0]];
  send = async () => { throw Object.assign(Error('Transient'), { statusCode: 503 }); };
  await fees.recordChange({ ...input, report: 'no-access-before-retry', newRate: 99 });
  await sweep(); const beforeRemoval = attempts.length;
  now += minute; available = [];
  await sweep(); assert.equal(attempts.length, beforeRemoval);
  assert.equal((await inbox())[0].status, 'Push unavailable');

  now += minute; available = [subscriptions[0]];
  const start = now;
  await fees.recordChange({ ...input, report: 'exhausted', newRate: 100 });
  assert.equal((await sweep()).oldestPendingAt, new Date(start).toISOString());
  for (const delay of [1, 5, 15, 60, 360]) {
    const n = attempts.length;
    now += delay * minute - 1; await sweep(); assert.equal(attempts.length, n);
    now++; await sweep(); assert.equal(attempts.length, n + 1);
  }
  now = start + 24 * 60 * minute;
  const n = attempts.length, metrics = await sweep();
  assert.equal(metrics.failedDeliveries, 1); assert.equal(metrics.exhaustedDeliveries, 1); assert.equal(metrics.oldestPendingAt, null);
  assert.equal((await inbox())[0].status, 'Push failed'); assert.equal(attempts.length, n);
  // Same-timestamp changes page deterministically and older terminal failures remain accessible.
  for (let i = 0; i < 21; i++) await fees.recordChange({ ...input, report: 'history-' + i, newRate: 300 + i });
  const page1 = await worker.inbox(agency, admin);
  const page2 = await worker.inbox(agency, admin, page1.nextCursor);
  assert.equal(page1.events.length, 20);
  assert.equal(page2.nextCursor, null);
  assert.ok(page2.events.some(e => e.status === 'Push failed'));
  const ids = [...page1.events, ...page2.events].map(e => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter(id => id === event.id).length, 1);
  console.log(storage + ' atomic fee save, inbox identity, retry, restart, leases, pruning and exhaustion passed');
 }
} finally { await fs.rm(root, { recursive: true, force: true }); }
