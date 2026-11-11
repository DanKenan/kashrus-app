import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
const dir = await mkdtemp(path.join(os.tmpdir(), 'inspection-routes-'));
const handlers = new Map(), app = { get: (p, h) => handlers.set(`GET ${p}`, h), post: (p, h) => handlers.set(`POST ${p}`, h) };
let blocked = false;
const connection = { fees: { mashgiach: { company: { amount: 82, currency: 'USD' } } } };
const item = { id: 'item', name: ' Name ', brand: '', code: '', certificationRaw: ' Raw ', statusRaw: '', agency: '', dpm: '', group1: false };
const deps = { db: () => null, dataDir: dir, staged: () => blocked, user: req => req.user, maxPhotoChars: 400000, photoRe: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/, source: agency => ({ connection, state: { refreshedAt: null, backupTakenAt: '2026-11-01T12:00:00Z', itemsFor: () => [item], companies: agency === 'agency' ? [{ id: 'company', name: 'Factory' }] : [] }, listVersion: () => 'version', items: () => [item] }) };
const routes = registerInspectionRoutes(app, deps);
const user = { id: 'u', name: 'Inspector', agencyId: 'agency', role: 'mashgiach' };
const body = { clientReportId: 'uuid-report-123', companyId: 'company', listVersion: 'version', startedAt: new Date().toISOString(), marks: [{ kind: 'ingredient', itemId: 'item', status: 'checked' }], offList: [] };
async function request(method, route, extra = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(json) { this.body = json; return this; } };
  await handlers.get(`${method} ${route}`)({ user, body, query: {}, params: {}, ...extra }, res); return res;
}
try {
  assert.equal((await request('POST', '/api/visits/reports')).statusCode, 503);
  await routes.boot();
  assert.equal((await request('POST', '/api/visits/reports', { kiosk: true })).statusCode, 403);
  for (const badUser of [undefined, { ...user, agencyId: '' }, { ...user, role: 'worker' }, { ...user, role: 'manager' }]) assert.equal((await request('POST', '/api/visits/reports', { user: badUser })).statusCode, 403);
  const [first, retry] = await Promise.all([request('POST', '/api/visits/reports'), request('POST', '/api/visits/reports')]);
  assert.equal(first.statusCode, 201); assert.equal(retry.statusCode, 200); assert.deepEqual(first.body, retry.body);
  assert.deepEqual(first.body.fee, { amount: 82, currency: 'USD' });
  connection.fees.mashgiach.company.amount = 100;
  assert.deepEqual((await request('POST', '/api/visits/reports')).body, first.body);
  blocked = true;
  assert.equal((await request('POST', '/api/visits/reports', { body: { ...body, clientReportId: 'blocked-uuid-123' } })).statusCode, 503);
  blocked = false;
  assert.equal((await request('GET', '/api/inspections/reports')).statusCode, 403);
  assert.equal((await request('GET', '/api/visits/reports/mine')).body.reports.length, 1);
  assert.equal((await request('GET', '/api/visits/reports/mine', { user: { ...user, id: 'other' } })).body.reports.length, 0);
  for (const route of ['/api/visits/factories', '/api/visits/factories/:companyId']) {
    const response = await request('GET', route, { params: { companyId: 'company' } });
    assert.equal(response.body.refreshedAt, null); assert.equal(response.body.backupTakenAt, '2026-11-01T12:00:00Z');
  }
  const admin = { ...user, role: 'admin' };
  const second = await request('POST', '/api/visits/reports', { body: { ...body, clientReportId: 'second-report-123' } });
  const page = await request('GET', '/api/inspections/reports', { user: admin, query: { limit: 1 } });
  const row = page.body.reports[0];
  const next = await request('GET', '/api/inspections/reports', { user: admin, query: { limit: 1, before: JSON.stringify({ submittedAt: row.submittedAt, id: row.id }) } });
  assert.equal(next.body.reports.length, 1); assert.notEqual(next.body.reports[0].id, row.id);
  assert.equal((await request('GET', '/api/inspections/reports', { user: admin, query: { before: row.submittedAt } })).statusCode, 400);
  console.log('inspection routes: fail closed, roles, kiosk, concurrency, configured fees, stable retries and write block passed');
} finally { await rm(dir, { recursive: true, force: true }); }
