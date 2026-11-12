import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountantPeriod, afterReportDelayMs } from '../../src/server/inspections/accountant.ts';
import { createFeesStore } from '../../src/server/inspections/fees-store.ts';
import { createReportStore } from '../../src/server/inspections/store.ts';
import { readableEmailDate } from '../../src/lib/fees.ts';
import { MockFirestore } from '../stage2/firestore-mock.mjs';

const after = { mode: 'after_report' }, zone = 'UTC', clock = s => new Date(s);
const first = '2026-11-11T15:00:00.000Z', second = '2026-11-11T15:01:00.000Z';
const last = { at: first, periodEnd: '2026-11-11', key: 'a|after_report|r1' };
assert.deepEqual(accountantPeriod(after, null, clock(first), zone, first), { from: '2026-11-01', to: '2026-11-11' });
assert.equal(accountantPeriod(after, last, clock(second), zone, second), null);
assert.equal(afterReportDelayMs(last, second, clock(second)), 540000);
assert.deepEqual(accountantPeriod(after, last, clock('2026-11-11T15:10:00.000Z'), zone, second), { from: '2026-11-01', to: '2026-11-11' });
assert.deepEqual(accountantPeriod(after, last, clock('2026-11-11T15:11:00.000Z'), zone, second), { from: '2026-11-01', to: '2026-11-11' });
assert.equal(accountantPeriod(after, last, clock('2026-11-11T15:11:00.000Z'), zone, first), null);
const midnight = { at: '2026-11-30T23:55:00.000Z', periodEnd: '2026-11-30', key: 'a|after_report|r3' };
const late = '2026-11-30T23:56:00.000Z';
assert.equal(afterReportDelayMs(midnight, late, clock('2026-12-01T00:01:00.000Z')), 240000);
assert.deepEqual(accountantPeriod(after, midnight, clock('2026-12-01T00:05:00.000Z'), zone, late), { from: '2026-11-01', to: '2026-11-30' });
assert.equal(readableEmailDate('2026-12-01'), 'Dec 1, 2026');
assert.equal(readableEmailDate(null), 'Not scheduled');

const dir = await mkdtemp(join(tmpdir(), 'fees-r2-'));
try {
  const db = new MockFirestore(), at = { value: first };
  const deps = { db: () => db, dataDir: dir, staged: () => false, now: () => clock(at.value), timeZone: () => zone };
  db._seed('inspectionFees/a', { settings: { feeEditors: 'admins' }, places: {}, accountant: null, lastSent: null, decisions: {}, updatedAt: '' });
  const a = createFeesStore(deps), b = createFeesStore(deps);
  await Promise.all([a.ensure('a'), b.ensure('a')]);
  const opts = { observedAt: null, newestReportId: 'r1' };
  const claim = await a.locked('a', () => a.claim('a', '2026-11-01', '2026-11-11', opts));
  assert.deepEqual(claim, { key: 'a|after_report|r1', previous: null });
  assert.equal(await b.locked('a', () => b.claim('a', '2026-11-01', '2026-11-11', opts)), null);
  assert.equal(await b.locked('a', () => b.claim('a', '2026-11-01', '2026-11-11', { observedAt: null, newestReportId: 'r2' })), null);
  try {
    throw Error('Simulated test transport failure');
  } catch {
    await a.locked('a', () => a.restore('a', claim));
  }
  assert.equal((await db.collection('inspectionFees').doc('a').get()).data().lastSent, null);
  const retry = await b.locked('a', () => b.claim('a', '2026-11-01', '2026-11-11', opts));
  assert.equal(retry?.key, claim.key);
  at.value = '2026-11-11T15:11:00.000Z';
  const next = await b.locked('a', () => b.claim('a', '2026-11-01', '2026-11-11', { observedAt: at.value, newestReportId: 'r2' }));
  assert.equal(next, null);
  const followUp = await b.locked('a', () => b.claim('a', '2026-11-01', '2026-11-11', { observedAt: first, newestReportId: 'r2' }));
  assert.equal(followUp?.key, 'a|after_report|r2');

  const report = (id, submittedAt) => ({ id, agencyId: 'a', companyId: 'p', companyName: 'Place', mashgiachId: 'm', mashgiachName: 'Mashgiach', submittedAt, sortKey: `${submittedAt}|${id}`, fee: { amount: 50 }, counts: {}, photoCount: 0 });
  db._seed('inspectionReportsByAgency/a/reports/one', report('one', '2026-11-30T23:59:00.000Z'));
  db._seed('inspectionReportsByAgency/a/reports/two', report('two', '2026-12-01T00:01:00.000Z'));
  const store = createReportStore(deps);
  assert.deepEqual((await store.freshReportsForRange('a', '2026-11-01', '2026-11-30')).map(r => r.id), ['one']);
  assert.deepEqual((await store.freshReportsForRange('a', '2026-12-01', '2026-12-31')).map(r => r.id), ['two']);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('R2: after-report timing, midnight, claim abort/retry, restore and fresh range passed');
