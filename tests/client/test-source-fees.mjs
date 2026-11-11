import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
const dir = await mkdtemp(path.join(os.tmpdir(), 'source-fees-'));
const fees = { mashgiach: { factory: { amount: 82, currency: 'USD' } } };
function fixture(testMode, db = null) {
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
  const routes = registerSourceRoutes(app, { db: () => db, dataDir: dir, staged: () => false, secret: () => 'test-only-key', testMode, requireAdmin: (req, res) => { if (req.user?.role !== 'admin') { res.status(403).json({ error: 'Forbidden' }); return null; } return req.user; }, timeZone: () => 'UTC' });
  const request = async (body, user = { id: 'u', role: 'admin', agencyId: 'agency' }) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get('post /api/__test__/source-fees')({ body, user }, res); return res;
  };
  return { handlers, routes, request };
}
try {
  assert.equal(fixture(false).handlers.has('post /api/__test__/source-fees'), false);
  const { createSourceStore } = await import('../../src/server/sources/store.ts');
  const store = createSourceStore({ db: () => null, dataDir: dir, staged: () => false });
  await store.save({ agencyId: 'agency', sourceType: 'airtable', baseId: 'test', encryptedKey: 'unreadable-test-key', keyHint: '', mapping: {}, backupHashes: {} });
  const first = fixture(true); await first.routes.boot();
  assert.equal((await first.request({ agencyId: 'other', fees })).code, 403);
  assert.equal((await first.request({ agencyId: 'agency', fees }, { role: 'worker', agencyId: 'agency' })).code, 403);
  assert.equal((await first.request({ agencyId: 'agency', fees: {} })).code, 400);
  assert.equal((await first.request({ agencyId: 'agency', fees })).code, 200);
  assert.deepEqual(first.routes.inspectionSource('agency').connection.fees, fees);
  assert.deepEqual((await store.raw('agency')).fees, fees);
  const restarted = fixture(true); await restarted.routes.boot();
  assert.deepEqual(restarted.routes.inspectionSource('agency').connection.fees, fees);
  console.log('test-only source fees: absent in production, agency/admin scoped, validated, live and durable across restart');
} finally { await rm(dir, { recursive: true, force: true }); }
