import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { createScheduleStore } from '../../src/server/inspections/schedule-store.ts';
import { createReportStore, reportId } from '../../src/server/inspections/store.ts';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
const dir = await mkdtemp(join(tmpdir(), 'schedule-store-'));
const now = () => new Date('2026-11-03T14:00:00Z');
process.env.FIRESTORE_MOCK_FILE = join(dir, 'mock.json');
let blocked = false;
try {
  for (const db of [null, new MockFirestore()]) {
    const dataDir = join(dir, db ? 'db' : 'local'), deps = { db: () => db, dataDir, staged: () => blocked, now };
    const store = createScheduleStore(deps); await store.boot(['a', 'b']);
    const s = { kind: 'every', n: 1, unit: 'month', start: '2026-01-31' };
    assert.equal(await store.update('a', { companies: { c: { schedule: s } } }), true);
    assert.equal(await store.update('a', { companies: { c: { schedule: s } } }), false);
    assert.equal(await store.update('a', { companies: { c: { schedule: { start: s.start, unit: s.unit, n: s.n, kind: s.kind } } } }), false);
    await Promise.all([store.update('a', { companies: { c: { mashgiachIds: ['u'] } } }), store.update('a', { companies: { c: { coordinatorIds: ['coord'] } } })]);
    await store.update('a', { companies: { c: { mute: { until: null, by: 'admin', at: now().toISOString() } } } });
    const reports = createReportStore({ ...deps, schedules: store });
    const report = { id: 'report', agencyId: 'a', companyId: 'c', mashgiachId: 'u', mashgiachName: 'Test inspector', companyName: ' Exact factory ', submittedAt: now().toISOString(), startedAt: now().toISOString(), counts: {}, photoCount: 0 };
    assert.equal((await reports.save(report, {})).created, true);
    assert.equal((await reports.save(report, {})).created, false);
    const detailOnly = createReportStore({ ...deps, schedules: undefined });
    assert.equal(detailOnly.latest('a', 'c'), undefined);
    await detailOnly.get('a', 'report'); assert.equal(detailOnly.latest('a', 'c').id, 'report');
    assert.equal(detailOnly.latest('b', 'c'), undefined);
    blocked = true;
    await assert.rejects(store.update('a', { companies: { c: { schedule: null } } }), /Writes blocked/);
    await assert.rejects(reports.save({ ...report, id: 'blocked' }, {}), /Writes blocked/);
    blocked = false;
    const restarted = createScheduleStore(deps); await restarted.boot(['a', 'b']);
    assert.deepEqual(restarted.company('a', 'c'), store.company('a', 'c'));
    assert.equal(restarted.company('a', 'c').lastVisit.reportId, 'report');
    assert.equal(restarted.company('a', 'c').mute.until, null);
    assert.equal(restarted.company('b', 'c').lastVisit, null);
    const dates = { kind: 'dates', dates: ['2027-01-01'] };
    await restarted.update('a', { companies: { c: { schedule: dates } } });
    const changedKind = createScheduleStore(deps); await changedKind.boot(['a']);
    assert.deepEqual(changedKind.company('a', 'c').schedule, dates);
    await restarted.update('a', { companies: { c: { schedule: null, mashgiachIds: [], mute: null } } });
    const cleared = createScheduleStore(deps); await cleared.boot(['a']);
    assert.equal(cleared.company('a', 'c').schedule, null); assert.deepEqual(cleared.company('a', 'c').mashgiachIds, []); assert.equal(cleared.company('a', 'c').mute, null);
    assert.deepEqual(cleared.company('a', 'c').coordinatorIds, ['coord']);
    assert.equal(cleared.company('a', 'c').lastVisit.reportId, 'report');
    // A failed report batch must publish neither a report nor lastVisit.
    if (db) {
      const batch = db.batch.bind(db); db.batch = () => { const b = batch(); b.commit = async () => { throw Error('Unavailable'); }; return b; };
      await assert.rejects(reports.save({ ...report, id: 'failed', submittedAt: '2026-11-04T14:00:00Z' }, {}), /Unavailable/);
      assert.equal(store.company('a', 'c').lastVisit.reportId, 'report'); db.batch = batch;
    }
  }
  const largeDir = join(dir, 'large'); await mkdir(join(largeDir, 'inspection-schedules'), { recursive: true });
  const companies = {};
  for (let i = 0; i < 1100; i++) companies['c' + i] = { schedule: null, mashgiachIds: ['x'.repeat(790)] };
  await writeFile(join(largeDir, 'inspection-schedules/a.json'), JSON.stringify({ settings: { countFrom: 'planned', mashgichimSeeAll: true }, companies, updatedAt: now().toISOString() }));
  const large = createScheduleStore({ db: () => null, dataDir: largeDir, staged: () => false, now }); await large.boot(['a']);
  await assert.rejects(large.update('a', { companies: { extra: { mashgiachIds: ['x'.repeat(60000)] } } }), e => e.status === 400);
  assert.deepEqual(large.company('a', 'extra').mashgiachIds, []);
  const handlers = new Map(), app = Object.fromEntries(['get', 'post', 'put'].map(method => [method, (p, h) => handlers.set(method + ' ' + p, h)]));
  registerInspectionRoutes(app, { db: () => null, dataDir: dir, staged: () => false, user: req => req.user, source: () => ({ state: { companies: [], itemsFor: () => [] } }), now, maxPhotoChars: 400000, photoRe: /./ });
  assert.equal(handlers.has('post /api/__test__/inspections/check'), false);
  for (const role of ['worker', 'manager', 'owner', 'unknown']) for (const kiosk of [false, true]) {
    const res = { status(code) { this.code = code; return this; }, json() {} };
    await handlers.get('get /api/visits/factories')({ user: { id: 'u', agencyId: 'a', role }, kiosk }, res); assert.equal(res.code, 403);
  }
  const pushes = [], alertHandlers = new Map();
  const alertApp = Object.fromEntries(['get', 'post', 'put'].map(method => [method, (p, h) => alertHandlers.set(method + ' ' + p, h)]));
  let instant = now();
  const admin = { id: 'admin', name: 'Test admin', role: 'admin', agencyId: 'tenant' };
  const coord = { id: 'coord', name: 'Test coordinator', role: 'coordinator', agencyId: 'tenant' };
  const mash = { id: 'mash', name: 'Test inspector', role: 'mashgiach', agencyId: 'tenant' };
  const alertRoutes = registerInspectionRoutes(alertApp, { db: () => null, dataDir: join(dir, 'alerts'), staged: () => blocked, user: req => req.user,
    agencyIds: () => ['tenant'], people: () => [admin, coord, mash, mash, { ...admin, id: 'foreign', agencyId: 'other' }], timeZone: () => 'America/New_York',
    source: () => ({ listVersion: () => 'v', items: () => [], state: { companies: [{ id: 'c', name: ' Source Exact ', brand: ' Brand Exact ', plant: ' Plant Exact ' }], itemsFor: () => [] } }),
    now: () => instant, testMode: true, push: (user, title, body) => pushes.push({ id: user.id, title, body }), maxPhotoChars: 400000, photoRe: /./ });
  await alertRoutes.boot();
  const request = async (method, route, body = {}, caller = admin) => {
    const res = { status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
    await alertHandlers.get(method + ' ' + route)({ user: caller, body, params: { id: 'c' } }, res); return res;
  };
  assert.deepEqual((await request('put', '/api/inspections/schedule/settings', {})).data.settings, { countFrom: 'last_visit', mashgichimSeeAll: true });
  await request('put', '/api/inspections/schedule/companies/:id', { schedule: { kind: 'every', n: 30, unit: 'day', start: '2026-11-03' } });
  await request('put', '/api/inspections/schedule/companies/:id/people', { mashgiachIds: ['mash'], coordinatorIds: [] });
  const exact = (await request('get', '/api/inspections/schedule')).data.companies[0];
  assert.equal(exact.name, ' Source Exact '); assert.equal(exact.brand, ' Brand Exact '); assert.equal(exact.plant, ' Plant Exact ');
  blocked = true; assert.deepEqual((await alertRoutes.check()).sent, []); assert.equal(pushes.length, 0); blocked = false;
  assert.deepEqual((await alertRoutes.check()).sent[0].userIds, ['admin', 'mash']);
  assert.deepEqual(pushes.map(p => p.body), [' Source Exact  — due Nov 3', ' Source Exact  — due Nov 3']);
  assert.ok(pushes.every(p => p.title === 'Visit overdue'));
  instant = new Date('2026-11-10T14:00:00Z'); await alertRoutes.check();
  assert.equal(pushes[2].body, 'Still no visit:  Source Exact  — due Nov 3');
  // An uncached retry cannot use a different visible company to reveal an old private report.
  await request('put', '/api/inspections/schedule/companies/:id/people', { mashgiachIds: ['mash'], coordinatorIds: ['coord'] });
  const oldReports = createReportStore({ db: () => null, dataDir: join(dir, 'alerts'), staged: () => false });
  await oldReports.save({ id: reportId('tenant', 'coord', 'private-report'), agencyId: 'tenant', companyId: 'private', companyName: 'Private test factory', mashgiachId: 'coord', mashgiachName: coord.name, submittedAt: now().toISOString(), startedAt: now().toISOString(), counts: {}, photoCount: 0 }, {});
  const privateRetry = await request('post', '/api/visits/reports', { clientReportId: 'private-report', companyId: 'c', listVersion: 'v', startedAt: now().toISOString(), marks: [], offList: [] }, coord);
  assert.equal(privateRetry.code, 404);
  // Do not expose default see-all visibility while the real document is still loading.
  let releaseDocument;
  const loading = new Promise(resolve => { releaseDocument = resolve; });
  const bootHandlers = new Map(), bootApp = Object.fromEntries(['get', 'post', 'put'].map(method => [method, (p, h) => bootHandlers.set(method + ' ' + p, h)]));
  const bootRoutes = registerInspectionRoutes(bootApp, { db: () => ({ collection: () => ({ doc: () => ({ get: async () => { await loading; return { data: () => ({ settings: { countFrom: 'planned', mashgichimSeeAll: false }, companies: {}, updatedAt: now().toISOString() }) }; } }) }) }),
    dataDir: dir, staged: () => false, user: req => req.user, scheduleAgencyIds: () => ['tenant'], agencyIds: () => [], now,
    source: () => ({ state: { companies: [{ id: 'c', name: 'Test factory' }], itemsFor: () => [] } }), maxPhotoChars: 400000, photoRe: /./ });
  let answered = false;
  const bootRes = { json(data) { this.data = data; answered = true; }, status() { return this; } };
  const waiting = bootHandlers.get('get /api/visits/factories')({ user: mash }, bootRes);
  const boot = bootRoutes.boot(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(answered, false);
  releaseDocument(); await boot; await waiting; assert.deepEqual(bootRes.data.companies, []);
  console.log('inspection schedule store: merge/no-op, concurrency, restart, local fallback, batch failure, staged block, size guard and closed roles passed');
} finally { await rm(dir, { recursive: true, force: true }); }
