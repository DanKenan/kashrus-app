import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
import { createReportStore } from '../../src/server/inspections/store.ts';
import { createInboxStore } from '../../src/server/inspections/inbox-store.ts';
import { installReadMeter, resetReadMeter, readMeterSnapshot } from '../../src/server/read-meter.ts';
import { installWriteMeter, resetWriteMeter, writeMeterSnapshot } from '../../src/server/write-meter.ts';
const dir = await mkdtemp(join(tmpdir(), 'food-memory-'));
process.env.FIRESTORE_MOCK_FILE = join(dir, 'db.json');
try {
 const db = new MockFirestore(); installReadMeter(db); installWriteMeter(db);
 let clock = new Date('2026-11-11T12:00:00Z'), blocked = false;
 const deps = { db: () => db, dataDir: dir, staged: () => blocked, now: () => clock };
 const at = i => new Date(clock.getTime() - i * 1000).toISOString();
 for (let i = 0; i < 1204; i++) {
  const id = `r${String(i).padStart(4, '0')}`, submittedAt = at(i);
  db._seed(`inspectionReportsByAgency/a/reports/${id}`, { id, agencyId: 'a', companyId: i === 1200 ? 'assigned' : 'other', mashgiachId: 'u', submittedAt, kind: i === 1200 ? 'food_service' : 'factory', templateName: i === 1200 ? 'Test saved checklist' : '', sortKey: `${submittedAt}|${id}` });
 }
 const store = createReportStore(deps); await store.ensure('a');
 resetReadMeter();
 const cold = await store.visiblePage('a', 50, undefined, r => r.companyId === 'assigned', false);
 assert.deepEqual(cold.reports, []); assert.equal(cold.nextCursor.id, 'r0199'); assert.equal(readMeterSnapshot().total, 0);
 const scan = await store.visiblePage('a', 50, cold.nextCursor, r => r.companyId === 'assigned', true);
 assert.deepEqual(scan.reports, []); assert.equal(scan.nextCursor.id, 'r1199'); assert.equal(readMeterSnapshot().total, 1000);
 resetReadMeter(); const tail = await store.visiblePage('a', 50, scan.nextCursor, r => r.companyId === 'assigned', true);
 assert.equal(tail.reports[0].kind, 'food_service'); assert.equal(tail.reports[0].templateName, 'Test saved checklist'); assert.equal(tail.nextCursor, null); assert.equal(readMeterSnapshot().total, 4);
 resetReadMeter(); assert.equal((await store.visiblePage('a', 50, undefined, r => r.kind === 'food_service', false)).reports.length, 1); assert.equal(readMeterSnapshot().total, 0);
 const handlers = new Map(), app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
 const routes = registerInspectionRoutes(app, { ...deps, agencyIds: () => ['a'], user: req => req.user, source: () => ({ state: { companies: [], itemsFor: () => [] }, items: () => [], listVersion: () => '' }), maxPhotoChars: 400000, photoRe: /./ });
 await routes.boot();
 const request = async query => {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handlers.get('get /api/inspections/reports')({ user: { id: 'admin', name: 'Test admin', role: 'admin', agencyId: 'a' }, query, params: {} }, res); assert.equal(res.code, 200); return res.body;
 };
 const before = JSON.stringify({ submittedAt: at(199), id: 'r0199' });
 resetReadMeter(); assert.deepEqual((await request({ limit: '50', before })).reports, []); assert.equal(readMeterSnapshot().total, 0);
 const loaded = await request({ limit: '50', before, more: '1' }); assert.equal(loaded.reports.length, 50); assert.equal(loaded.reports.at(-1).id, 'r0249'); assert.equal(readMeterSnapshot().total, 50);
 resetReadMeter(); assert.equal((await request({ limit: '50', before })).reports.length, 50); assert.equal(readMeterSnapshot().total, 0);
 const inbox = createInboxStore({ ...deps, submittedAt: (a, id) => id === 'expired' ? '2026-07-01T00:00:00Z' : store.list(a).find(r => r.id === id)?.submittedAt });
 db._seed('inspectionInbox/a', { seen: { expired: { by: 'u', byName: 'Test admin', at: clock.toISOString() } }, followUp: { expired: { note: 'Keep follow-up', by: 'u', byName: 'Test admin', at: clock.toISOString() } }, updatedAt: clock.toISOString() });
 await inbox.ensure('a'); resetReadMeter(); resetWriteMeter();
 const u = { id: 'u', name: 'Test admin' }, report = i => ({ id: `new${i}`, submittedAt: clock.toISOString() });
 await Promise.all(Array.from({ length: 5 }, (_, i) => inbox.mark('a', report(i), u)));
 assert.equal(writeMeterSnapshot().total, 0); assert.equal(await inbox.flush(), 1); assert.equal(writeMeterSnapshot().total, 1); assert.equal(readMeterSnapshot().total, 0);
 assert.equal(Object.hasOwn(inbox.doc('a').seen, 'expired'), false); assert.ok(inbox.doc('a').followUp.expired);
 await inbox.mark('a', report(6), u); assert.equal(await inbox.flush(), 0); assert.equal(writeMeterSnapshot().total, 1);
 clock = new Date('2026-11-11T12:00:10Z'); assert.equal(await inbox.flush(), 1); assert.equal(writeMeterSnapshot().total, 2);
 await inbox.mark('a', report(7), u);
 await inbox.followUp('a', report(1), u, true, 'Test pending seen');
 assert.equal(db._docs['inspectionInbox/a'].seen.new7, undefined);
 assert.ok(inbox.doc('a').seen.new7);
 clock = new Date('2026-11-11T12:00:20Z'); await inbox.flush(); assert.ok(db._docs['inspectionInbox/a'].seen.new7);
 await inbox.mark('a', report(8), u); blocked = true; await assert.rejects(inbox.flush(true), e => e.status === 503); assert.equal(db._docs['inspectionInbox/a'].seen.new8, undefined);
 blocked = false; assert.equal(await inbox.flush(true), 1);
 const companies = [
  { id: 'alpha', name: 'Alpha Kitchen', type: 'Factory' },
  { id: 'beta', name: 'Beta Kitchen', type: 'Restaurant' },
  { id: 'factory', name: 'Factory Without Reports', type: 'Factory' }
 ];
 const template = (id, name) => ({ id, name, items: [], version: 1, updatedAt: clock.toISOString() });
 const templates = { ta: template('ta', 'Alpha Checklist'), tb: template('tb', 'Beta Checklist'), unused: template('unused', 'Unused Checklist') };
 db._seed('inspectionFoodService/b', {
  templates, templateOrder: ['ta', 'tb', 'unused'], marked: ['alpha'],
  placeTemplates: { alpha: 'ta', beta: 'tb' },
  manualPlaces: { manual1: { name: 'Manual Kitchen', address: 'Demo address', createdAt: clock.toISOString() } },
  updatedAt: clock.toISOString()
 });
 const scheduleRow = (mashgiachIds, coordinatorIds) => ({
  schedule: { every: 7, unit: 'days', startDate: '2026-11-01' },
  mashgiachIds, coordinatorIds,
  mute: { until: null, by: 'admin', at: clock.toISOString() },
  lastVisit: { at: clock.toISOString(), reportId: 'old', mashgiachName: 'Demo Mashgiach' },
  alert: { kind: 'first', at: clock.toISOString(), nextDue: '2026-11-08' }
 });
 db._seed('inspectionSchedules/b', {
  companies: {
   alpha: scheduleRow(['m1'], ['c1']),
   beta: scheduleRow(['m2'], ['c2']),
   factory: scheduleRow(['m1'], ['c1']),
   manual1: scheduleRow(['m2'], ['c1'])
  },
  updatedAt: clock.toISOString()
 });
 const users = [
  { id: 'admin', name: 'Demo Admin', role: 'admin', agencyId: 'b' },
  { id: 'c1', name: 'First Coordinator', role: 'coordinator', agencyId: 'b' },
  { id: 'c2', name: 'Second Coordinator', role: 'coordinator', agencyId: 'b' },
  { id: 'm1', name: 'First Mashgiach', role: 'mashgiach', agencyId: 'b' },
  { id: 'm2', name: 'Second Mashgiach', role: 'mashgiach', agencyId: 'b' }
 ];
 const handlersB = new Map();
 const appB = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => handlersB.set(`${method} ${path}`, handler)]));
 const routesB = registerInspectionRoutes(appB, {
  ...deps, agencyIds: () => ['b'], user: req => req.user, people: () => users,
  source: () => ({
   connection: { mapping: { companies: { foodServiceValues: ['Restaurant'] } } },
   state: { companies, itemsFor: () => [] },
   items: () => [], listVersion: () => ''
  }),
  maxPhotoChars: 400000, photoRe: /./
 });
 await routesB.boot();
 const callB = async (method, path, user, body = {}, params = {}) => {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handlersB.get(`${method} ${path}`)({ user, body, query: {}, params }, res);
  return res;
 };
 const [admin, c1, c2] = users;
 resetReadMeter();
 const first = await callB('get', '/api/food-service', c1);
 const second = await callB('get', '/api/food-service', c2);
 assert.deepEqual(first.body.templates.map(t => t.id), ['ta']);
 assert.deepEqual(second.body.templates.map(t => t.id), ['tb']);
 assert.deepEqual(first.body.places.map(p => p.id), ['alpha', 'manual1']);
 assert.deepEqual(second.body.places.map(p => p.id), ['beta']);
 assert.equal(readMeterSnapshot().total, 0);
 const all = await callB('get', '/api/food-service', admin);
 assert.deepEqual(all.body.templates.map(t => t.id), ['ta', 'tb', 'unused']);
 assert.equal(all.body.places.find(p => p.id === 'alpha').marked, true);
 assert.equal(all.body.places.find(p => p.id === 'alpha').typeMatched, false);
 assert.equal(all.body.places.find(p => p.id === 'beta').marked, false);
 assert.equal(all.body.places.find(p => p.id === 'beta').typeMatched, true);
 assert.equal(all.body.places.find(p => p.id === 'manual1').marked, false);
 assert.equal(all.body.places.find(p => p.id === 'manual1').typeMatched, false);
 companies[0].type = 'Restaurant';
 const unmarked = await callB('put', '/api/food-service/marked', admin, { remove: ['alpha'] });
 assert.equal(unmarked.code, 200);
 assert.equal(unmarked.body.places.find(p => p.id === 'alpha').marked, false);
 assert.equal(unmarked.body.places.find(p => p.id === 'alpha').typeMatched, true);
 assert.equal((await callB('put', '/api/food-service/marked', admin, { remove: ['unknown'] })).code, 400);
 const adminFilters = await callB('get', '/api/inspections/reports/filters', admin);
 const coordinatorFilters = await callB('get', '/api/inspections/reports/filters', c1);
 assert.ok(adminFilters.body.companies.some(c => c.id === 'factory'));
 assert.deepEqual(adminFilters.body.mashgichim.map(m => m.id), ['m1', 'm2']);
 assert.ok(coordinatorFilters.body.companies.some(c => c.id === 'factory'));
 assert.deepEqual(coordinatorFilters.body.mashgichim.map(m => m.id), ['m1', 'm2']);
 assert.equal(readMeterSnapshot().total, 0);
 resetReadMeter(); resetWriteMeter();
 const originalBatch = db.batch.bind(db);
 let commits = 0;
 db.batch = (...args) => {
  const batch = originalBatch(...args), commit = batch.commit.bind(batch);
  batch.commit = async (...commitArgs) => { commits++; return commit(...commitArgs); };
  return batch;
 };
 const deleted = await callB('delete', '/api/food-service/places/:id', admin, {}, { id: 'manual1' });
 assert.equal(deleted.code, 200);
 assert.equal(commits, 1);
 assert.equal(writeMeterSnapshot().total, 2);
 assert.equal(readMeterSnapshot().total, 0);
 assert.equal(Object.hasOwn(db._docs['inspectionSchedules/b'].companies, 'manual1'), false);
 assert.equal(Object.hasOwn(db._docs['inspectionFoodService/b'].manualPlaces, 'manual1'), false);
 assert.equal((await callB('get', '/api/inspections/schedule', admin)).body.companies.some(c => c.id === 'manual1'), false);
 db.batch = originalBatch;
 console.log('PASS food-service memory-only pages, bounded explicit loading, projection, concurrent seen debounce, 90-day prune, pending seen isolation and blocked flush');
} finally { await rm(dir, { recursive: true, force: true }); }
