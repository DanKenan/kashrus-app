import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { createReportStore } from '../../src/server/inspections/store.ts';
import { installReadMeter, resetReadMeter, readMeterSnapshot } from '../../src/server/read-meter.ts';
const dir = await mkdtemp(join(tmpdir(), 'scoped-pages-'));
process.env.FIRESTORE_MOCK_FILE = join(dir, 'db.json');
const db = new MockFirestore(); installReadMeter(db);
const at = i => new Date(Date.parse('2026-11-03T12:00:00Z') - i * 1000).toISOString();
try {
  for (let i = 0; i < 1204; i++) {
    const id = `r${String(i).padStart(4, '0')}`, submittedAt = at(i);
    db._seed(`inspectionReportsByAgency/a/reports/${id}`, { id, agencyId: 'a', companyId: i === 1200 || i === 1202 ? 'assigned' : 'other', mashgiachId: i === 1200 || i === 1202 ? 'mine' : 'other', submittedAt, sortKey: `${submittedAt}|${id}` });
  }
  const store = createReportStore({ db: () => db, dataDir: dir, staged: () => false }); await store.ensure('a');
  resetReadMeter(); const sparse = await store.visiblePage('a', 50, undefined, r => r.companyId === 'assigned');
  assert.deepEqual(sparse.reports, []); assert.deepEqual(sparse.nextCursor, { submittedAt: at(1199), id: 'r1199' }); assert.equal(readMeterSnapshot().total, 1000);
  resetReadMeter(); const more = await store.visiblePage('a', 50, sparse.nextCursor, r => r.companyId === 'assigned');
  assert.deepEqual(more.reports.map(r => r.id), ['r1200', 'r1202']); assert.equal(more.nextCursor, null); assert.equal(readMeterSnapshot().total, 4);
  resetReadMeter(); const mine = await store.visiblePage('a', 50, undefined, r => r.mashgiachId === 'mine');
  assert.deepEqual(mine.reports.map(r => r.id), ['r1200', 'r1202']); assert.equal(mine.nextCursor, null); assert.equal(readMeterSnapshot().total, 0);
  const first = await store.visiblePage('a', 50), second = await store.visiblePage('a', 50, first.nextCursor);
  assert.equal(first.reports[0].id, 'r0000'); assert.equal(first.reports.at(-1).id, 'r0049'); assert.equal(second.reports[0].id, 'r0050'); assert.equal(readMeterSnapshot().total, 0);
  // The end cursor follows the scanned agency tail, even when the last visible row is newer.
  assert.equal(more.reports.at(-1).id, 'r1202'); assert.equal(store.list('a').at(-1).id, 'r1203');
  db._seed('inspectionReportsByAgency/a/reports/r0500', { ...db._docs['inspectionReportsByAgency/a/reports/r0500'], companyId: 'assigned' });
  const partialStore = createReportStore({ db: () => db, dataDir: dir, staged: () => false }); await partialStore.ensure('a');
  resetReadMeter(); const partial = await partialStore.visiblePage('a', 50, undefined, r => r.companyId === 'assigned');
  assert.deepEqual(partial.reports.map(r => r.id), ['r0500']); assert.equal(partial.nextCursor.id, 'r1199'); assert.equal(readMeterSnapshot().total, 1000);
  resetReadMeter(); const partialMore = await partialStore.visiblePage('a', 50, partial.nextCursor, r => r.companyId === 'assigned');
  assert.deepEqual(partialMore.reports.map(r => r.id), ['r1200', 'r1202']); assert.equal(partialMore.nextCursor, null); assert.equal(readMeterSnapshot().total, 4);
  // The 1000-row read budget applies to Firestore; local history can fill its visible page.
  const directory = join(dir, 'local', 'inspection-reports', 'inspectionReports');
  const files = new Map(Object.values(db._docs).map(r => [join(directory, `a__${r.id}.json`), JSON.stringify(r)]));
  const read = fs.readFile, readdir = fs.readdir;
  try {
    fs.readdir = async p => p === directory ? [...files.keys()].map(p => p.slice(directory.length + 1)) : readdir(p);
    fs.readFile = async (p, ...args) => files.has(p) ? files.get(p) : read(p, ...args);
    const local = createReportStore({ db: () => null, dataDir: join(dir, 'local'), staged: () => false });
    const localPage = await local.visiblePage('a', 50, undefined, r => r.companyId === 'assigned');
    assert.deepEqual(localPage.reports.map(r => r.id), ['r0500', 'r1200', 'r1202']); assert.equal(localPage.nextCursor, null);
  } finally { fs.readFile = read; fs.readdir = readdir; }
  console.log('scoped paging: 1000-row cap, agency cursor continuation, full coordinator/mine pages, admin order and exact 1000R/4R/0R passed');
} finally { await rm(dir, { recursive: true, force: true }); }
