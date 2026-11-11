import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReportStore } from '../../src/server/inspections/store.ts';
import { normalizeSubmit, buildReport } from '../../src/server/inspections/model.ts';
const dir = await mkdtemp(path.join(os.tmpdir(), 'inspection-store-'));
const docs = new Map(); let reads = 0, writes = 0, batches = 0, blocked = false;
const db = { collection: c => ({ doc: id => ({ key: `${c}/${id}`, get: async () => { reads++; return { data: () => docs.get(`${c}/${id}`) }; } }), where: () => ({ get: async () => ({ docs: [...docs.entries()].filter(([k]) => k.startsWith('inspectionReports/')).map(([, v]) => ({ data: () => v })) }) }) }), batch: () => { const pending = []; return { set: (ref, doc) => pending.push([ref.key, doc]), commit: async () => { batches++; for (const [k, v] of pending) { docs.set(k, v); writes++; } } }; } };
const deps = { db: () => db, dataDir: dir, staged: () => blocked };
const input = normalizeSubmit({ clientReportId: 'test-12345', companyId: 'c', listVersion: 'v', startedAt: new Date().toISOString(), marks: [], offList: [{ name: 'item', photo: 'data:image/png;base64,YQ==' }] }, 400000, /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
const report = buildReport(input, { id: 'r', agencyId: 'a', userId: 'u', userName: 'User', companyName: 'Factory', listVersion: 'v', items: () => [], now: new Date().toISOString(), fee: null });
try {
  const store = createReportStore(deps); await store.save(report, input.photos);
  assert.equal(writes, 2); assert.equal(batches, 1); assert.equal(reads, 0);
  docs.set('inspectionReports/a__old', { ...report, id: 'old', clientReportId: 'old-client', submittedAt: '2000-01-01T00:00:00Z' });
  const restarted = createReportStore(deps); await restarted.boot(); assert.equal(reads, 0);
  assert.equal(restarted.list('a').length, 1); assert.equal(restarted.get('a', 'old'), undefined);
  const failed = createReportStore({ ...deps, db: () => ({ ...db, batch: () => ({ set() {}, commit: async () => { throw Error('Storage unavailable'); } }) }) });
  await assert.rejects(failed.save(report, input.photos)); assert.equal(failed.get('a', 'r'), undefined);
  assert.equal(restarted.duplicate('a', 'u', input.clientReportId), 'r');
  assert.equal(restarted.get('other', 'r'), undefined);
  await Promise.all([restarted.readPhotos(report), restarted.readPhotos(report)]); assert.equal(reads, 1);
  await restarted.readPhotos(report); assert.equal(reads, 1);
  await restarted.readPhotos({ ...report, photoCount: 0 }); assert.equal(reads, 1);
  for (let i = 0; i < 9; i++) { const r = { ...report, id: `r${i}` }; await restarted.save(r, input.photos); await restarted.readPhotos(r); }
  const before = reads; await restarted.readPhotos(report); assert.equal(reads, before + 1);
  blocked = true; const w = writes; await assert.rejects(store.save({ ...report, id: 'blocked' }, input.photos)); assert.equal(writes, w); assert.equal(store.get('a', 'blocked'), undefined);
  blocked = false;
  const localDeps = { ...deps, db: () => null }, local = createReportStore(localDeps);
  await local.save(report, input.photos); const localBoot = createReportStore(localDeps); await localBoot.boot();
  assert.equal(localBoot.list('a').length, 1); assert.deepEqual(await localBoot.readPhotos(report), input.photos);
  console.log('inspection store: atomic batch budgets, boot, idempotency, LRU, write block and local restart passed');
} finally { await rm(dir, { recursive: true, force: true }); }
