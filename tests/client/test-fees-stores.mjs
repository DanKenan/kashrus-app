import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { createReportStore } from '../../src/server/inspections/store.ts';
import { createFeesStore } from '../../src/server/inspections/fees-store.ts';
import { createCompanyInfoStore, validateCompanyInfo, emptyInfo } from '../../src/server/inspections/company-info-store.ts';
import { createEmailTransport } from '../../src/server/inspections/email.ts';
import { installReadMeter, resetReadMeter, readMeterSnapshot } from '../../src/server/read-meter.ts';
import { installWriteMeter, resetWriteMeter, writeMeterSnapshot } from '../../src/server/write-meter.ts';
const dir = await mkdtemp(join(tmpdir(), 'fees-store-'));
process.env.FIRESTORE_MOCK_FILE = join(dir, 'mock.json');
try {
 for (const db of [new MockFirestore(), null]) {
  if (db) { installReadMeter(db); installWriteMeter(db); }
  let staged = false; const deps = { db: () => db, dataDir: join(dir, db ? 'remote' : 'local'), staged: () => staged, now: () => new Date('2026-10-01T12:00:00Z') };
  const fees = createFeesStore(deps), info = createCompanyInfoStore(deps);
  resetReadMeter(); resetWriteMeter(); await Promise.all([fees.boot(['a', 'a']), info.boot(['a'])]);
  if (db) { assert.equal(readMeterSnapshot().total, 2); assert.equal(writeMeterSnapshot().total, 0); }
  resetReadMeter(); resetWriteMeter();
  await fees.update('a', n => { n.places.first = { company: { amount: 10, per: 'visit' }, mashgiach: { amount: 5 }, updatedAt: '', updatedBy: 'test' }; n.places.other = { company: null, mashgiach: null, updatedAt: '', updatedBy: 'test' }; });
  if (db) { assert.equal(writeMeterSnapshot().total, 1); assert.equal(readMeterSnapshot().total, 0); }
  resetWriteMeter(); assert.equal(await fees.update('a', () => {}), false); if (db) assert.equal(writeMeterSnapshot().total, 0);
  await fees.update('a', n => { delete n.places.first.mashgiach; n.accountant = { name: 'Test', email: 'accountant@example.test', timing: { mode: 'dates', days: [1] } }; });
  await fees.update('a', n => { n.accountant.timing = { mode: 'every_days', everyDays: 5 }; });
  const second = createFeesStore(deps); await second.boot(['a']); assert.equal('mashgiach' in second.doc('a').places.first, false); assert.deepEqual(second.doc('a').accountant.timing, { mode: 'every_days', everyDays: 5 }); assert.ok(second.doc('a').places.other);
  const value = validateCompanyInfo({ address: 'Test address', phone: '', contacts: [{ name: 'Test contact', role: 'Test role', email: '', phone: '' }] }, emptyInfo());
  assert.match(value.contacts[0].id, /^c_[a-z0-9]{10}$/); await info.update('a', n => { n.places.first = value; });
  await info.update('a', n => { n.places.first.contacts = []; });
  const info2 = createCompanyInfoStore(deps); await info2.boot(['a']); assert.deepEqual(info2.doc('a').places.first.contacts, []);
  const before = structuredClone(fees.doc('a')); resetReadMeter(); resetWriteMeter();
  await assert.rejects(fees.update('a', n => { n.places.huge = 'א'.repeat(450000); }), e => e.status === 400); assert.deepEqual(fees.doc('a'), before);
  staged = true; await assert.rejects(fees.update('a', n => { n.accountant = null; }), e => e.status === 503); await assert.rejects(info.update('a', () => {}), e => e.status === 503);
  if (db) { assert.equal(readMeterSnapshot().total, 0); assert.equal(writeMeterSnapshot().total, 0); }
  staged = false;
  await Promise.all(Array.from({ length: 10 }, (_, i) => fees.update('a', n => { n.decisions['r' + i] = { amount: i, by: 'test', byName: 'Test admin', at: '' }; })));
  assert.equal(Object.keys(fees.doc('a').decisions).length, 10);
 }
 const none = createEmailTransport(dir, true, 'none'); assert.equal(none.transport, null);
 const test = createEmailTransport(dir, true, 'test'); await test.transport.send({ to: 'test@example.test', subject: 'Test', html: '', text: '', attachments: [] }); assert.equal(test.outbox.length, 1); assert.equal((await readdir(join(dir, 'outbox'))).length, 1);
 assert.throws(() => validateCompanyInfo({ address: '', phone: '', contacts: Array(21).fill({}) }, emptyInfo()));
 console.log('fees stores: boot reads, merge/deletes, no-op, byte cap, staged block, local fallback, locks and transport passed');
} finally { await rm(dir, { recursive: true, force: true }); }
