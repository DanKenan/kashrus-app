import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { createScheduleStore } from '../../src/server/inspections/schedule-store.ts';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
const dir = await mkdtemp(join(tmpdir(), 'schedule-boot-'));
process.env.FIRESTORE_MOCK_FILE = join(dir, 'db.json');
const now = () => new Date('2026-11-04T14:00:00Z');
const agencies = ['pending', 'unavailable', 'report-failed'];
const companyId = a => `${a}-company`;
const admin = a => ({ id: `admin-${a}`, name: 'Test admin', role: 'admin', agencyId: a });
const db = new MockFirestore(), collection = db.collection.bind(db), batch = db.batch.bind(db);
let releaseReports, reportFinished = false, writes = 0;
const pendingReports = new Promise(resolve => { releaseReports = resolve; });
const scheduleReads = {}, reportReads = {};
const queryPrototype = Object.getPrototypeOf(collection('inspectionReportsByAgency/pending/reports'));
const queryGet = queryPrototype.get;
try {
  for (const a of agencies) await collection('inspectionSchedules').doc(a).set({
    settings: { countFrom: 'last_visit', mashgichimSeeAll: false }, updatedAt: now().toISOString(),
    companies: { [companyId(a)]: { schedule: { kind: 'every', n: 1, unit: 'day', start: '2026-11-01' }, mashgiachIds: [], coordinatorIds: ['saved-coordinator'],
      mute: a === 'unavailable' ? { until: null, by: 'saved-admin', at: now().toISOString() } : null,
      lastVisit: { at: '2026-11-03T14:00:00Z', reportId: 'stored-report', mashgiachName: 'Test inspector' }, alert: null } },
  });
  db.collection = path => {
    const col = collection(path);
    if (path === 'inspectionSchedules') {
      const doc = col.doc.bind(col);
      col.doc = a => {
        const ref = doc(a), get = ref.get.bind(ref);
        ref.get = async () => {
          scheduleReads[a] = (scheduleReads[a] || 0) + 1;
          if (a === 'unavailable' && scheduleReads[a] === 1) throw Error('Temporary schedule outage');
          return get();
        };
        return ref;
      };
    }
    return col;
  };
  queryPrototype.get = async function () {
    if (this.path.startsWith('inspectionReportsByAgency/')) {
      const a = this.path.split('/')[1]; reportReads[a] = (reportReads[a] || 0) + 1;
      if (a === 'pending') { await pendingReports; reportFinished = true; }
      if (a === 'report-failed') throw Error('Reports unavailable');
    }
    return queryGet.call(this);
  };
  db.batch = () => { const b = batch(), commit = b.commit.bind(b); b.commit = async () => { await commit(); writes += b._ops.length; }; return b; };
  const handlers = new Map(), app = Object.fromEntries(['get', 'post', 'put'].map(method => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
  const deps = { db: () => db, dataDir: dir, staged: () => false, now, user: req => req.user,
    agencyIds: () => agencies, scheduleAgencyIds: () => agencies, people: a => [admin(a)], timeZone: () => 'America/New_York', testMode: true,
    source: a => ({ state: { companies: [{ id: companyId(a), name: 'Test factory' }], itemsFor: () => [] }, listVersion: () => 'v', items: () => [] }),
    maxPhotoChars: 400000, photoRe: /./ };
  const routes = registerInspectionRoutes(app, deps);
  const request = async (method, path, a, body = {}, user = admin(a)) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handlers.get(`${method} ${path}`)({ user, body, query: {}, params: { id: companyId(a), companyId: companyId(a) } }, res);
    return res;
  };
  // Boot waits for schedules only. A pending report query cannot delay any visit route.
  await routes.boot(); assert.equal(reportFinished, false);
  for (const path of ['/api/visits/factories', '/api/visits/factories/:companyId']) assert.equal((await request('get', path, 'pending')).code, 200);
  const submitted = await request('post', '/api/visits/reports', 'pending', { clientReportId: 'boot-report', companyId: companyId('pending'), listVersion: 'v', startedAt: now().toISOString(), marks: [], offList: [] });
  assert.equal(submitted.code, 201); assert.equal(reportFinished, false);
  const mash = { id: 'unassigned', name: 'Test inspector', role: 'mashgiach', agencyId: 'pending' };
  assert.deepEqual((await request('get', '/api/visits/factories', 'pending', {}, mash)).body.companies, []);
  // A schedule failure is isolated, throttled, and blocks writes over the unknown document.
  for (const path of ['/api/inspections/schedule', '/api/visits/factories', '/api/visits/factories/:companyId']) assert.equal((await request('get', path, 'unavailable')).code, 503);
  const before = writes;
  assert.equal((await request('put', '/api/inspections/schedule/companies/:id', 'unavailable', { schedule: null })).code, 503);
  assert.equal((await request('put', '/api/inspections/schedule/companies/:id/people', 'unavailable', { mashgiachIds: [], coordinatorIds: [] })).code, 503);
  assert.equal((await request('post', '/api/visits/reports', 'unavailable', { clientReportId: 'blocked-report', companyId: companyId('unavailable') })).code, 503);
  assert.equal(writes, before); assert.equal(scheduleReads.unavailable, 1);
  const unknown = createScheduleStore(deps);
  await assert.rejects(unknown.update('unavailable', { settings: { mashgichimSeeAll: true } }), /Schedules unavailable/);
  assert.equal(writes, before);
  assert.equal((await request('get', '/api/inspections/schedule', 'report-failed')).body.companies[0].nextDue, '2026-11-04');
  // Checks await existing hydration, never retry its failed query or an unavailable schedule.
  const readsBeforeCheck = JSON.stringify({ scheduleReads, reportReads });
  let checked = false;
  const checking = routes.check().then(value => { checked = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(checked, false);
  releaseReports(); const result = await checking;
  assert.equal(JSON.stringify({ scheduleReads, reportReads }), readsBeforeCheck);
  assert.deepEqual(result.sent, [{ companyId: companyId('report-failed'), kind: 'first', userIds: ['admin-report-failed'] }]);
  assert.equal(result.writes, 1); assert.equal(writes, before + 1);
  const persisted = (await collection('inspectionSchedules').doc('report-failed').get()).data();
  assert.equal(persisted.companies[companyId('report-failed')].alert.dueDate, '2026-11-04');
  // The next request after backoff shares one retry and restores the saved scope and mute.
  await new Promise(resolve => setTimeout(resolve, 1050));
  const recovered = await Promise.all([request('get', '/api/inspections/schedule', 'unavailable'), request('get', '/api/visits/factories', 'unavailable')]);
  assert.ok(recovered.every(r => r.code === 200)); assert.equal(scheduleReads.unavailable, 2);
  assert.deepEqual(recovered[0].body.companies[0].coordinatorIds, ['saved-coordinator']);
  assert.equal(recovered[0].body.companies[0].mute.by, 'saved-admin');
  assert.equal(recovered[0].body.settings.mashgichimSeeAll, false);
  assert.equal((await request('put', '/api/inspections/schedule/settings', 'unavailable', { mashgichimSeeAll: true })).code, 200);
  assert.equal(scheduleReads.unavailable, 2); assert.equal(writes, before + 2);
  console.log('inspection boot: visit hydration independence, stored lastVisit after report failure, per-agency retry/backoff and unknown-document write block passed');
} finally { releaseReports(); queryPrototype.get = queryGet; await rm(dir, { recursive: true, force: true }); }
