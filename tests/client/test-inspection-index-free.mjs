import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockFirestore } from '../stage2/firestore-mock.mjs';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
import { withOutboxLock } from '../../src/lib/inspectionVisit.ts';
// Scan complete statement chains, including multiline chains and argument callbacks.
const serverFiles = await readdir('src/server/inspections');
for (const required of ['schedule.ts', 'schedule-store.ts', 'food-service.ts', 'food-service-store.ts', 'inbox-store.ts']) assert.ok(serverFiles.includes(required), `${required}: missing index guard coverage`);
for (const file of serverFiles) {
  if (!file.endsWith('.ts')) continue;
  const source = await readFile(`src/server/inspections/${file}`, 'utf8');
  for (const chain of source.split(';')) {
    const orders = chain.match(/\.orderBy\s*\(/g) || [];
    assert.ok(orders.length < 2 && !(orders.length && /\.where\s*\(/.test(chain)), `${file}: composite query`);
  }
}
const dir = await mkdtemp(join(tmpdir(), 'inspection-index-'));
process.env.FIRESTORE_MOCK_FILE = join(dir, 'db.json');
try {
  const db = new MockFirestore(), path = 'inspectionReportsByAgency/a/reports';
  for (const q of [db.collection(path).where('id', '==', 'x'), db.collection('inspectionFoodService').where('x', '==', 'y').orderBy('updatedAt'), db.collection('inspectionInbox').orderBy('updatedAt').orderBy('id'), db.collection(path).where('agencyId', '==', 'a').orderBy('sortKey'), db.collection(path).orderBy('sortKey').orderBy('id'), db.collection(path).where('id', '>=', 'x').orderBy('sortKey'), db.collection('inspectionSchedules').where('x', '==', 'y').orderBy('updatedAt'), db.collection('inspectionSchedules').orderBy('updatedAt').orderBy('id')]) await assert.rejects(q.get(), /composite index required/);
  await db.collection(path).orderBy('sortKey').limit(200).get();
  await db.collection('other').where('id', '==', 'x').orderBy('sortKey').orderBy('id').get();
  const handlers = new Map(), app = { get: (p, h) => handlers.set(`GET ${p}`, h), post: (p, h) => handlers.set(`POST ${p}`, h), put: (p, h) => handlers.set(`PUT ${p}`, h) };
  let attempts = 0, fail = true, releaseHydration;
  const hydration = new Promise(resolve => { releaseHydration = resolve; });
  const original = db.collection.bind(db);
  // Fail terminal hydration queries without altering submit's batch path.
  const proto = Object.getPrototypeOf(original(path)), get = proto.get;
  proto.get = async function () { if (this.path === 'inspectionReportsByAgency/pending/reports') await hydration; if (this.path === path) { attempts++; if (fail) throw Error('Unavailable'); } return get.call(this); };
  const routes = registerInspectionRoutes(app, { agencyIds: () => ['a', 'pending'], db: () => db, dataDir: dir, staged: () => false, user: req => req.user, maxPhotoChars: 400000, photoRe: /./, source: () => ({ state: { companies: [{ id: 'c', name: 'Factory' }], itemsFor: () => [] }, listVersion: () => 'v', items: () => [] }) });
  const request = async (method, path, agencyId = 'a') => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get(`${method} ${path}`)({ user: { id: 'u', name: 'User', agencyId, role: 'admin' }, params: { companyId: 'c' }, query: {}, body: { clientReportId: 'index-free-report', companyId: 'c', listVersion: 'v', startedAt: new Date().toISOString(), marks: [], offList: [] } }, res); return res;
  };
  const boot = routes.boot(); await new Promise(r => setTimeout(r, 0));
  for (const p of ['/api/visits/factories', '/api/visits/factories/:companyId']) assert.equal((await request('GET', p)).code, 200);
  assert.equal((await request('POST', '/api/visits/reports')).code, 201);
  assert.equal((await request('GET', '/api/visits/factories', 'pending')).code, 200);
  assert.equal((await request('POST', '/api/visits/reports', 'pending')).code, 201);
  releaseHydration(); await boot;
  const n = attempts;
  assert.equal((await request('GET', '/api/inspections/reports')).code, 503); assert.equal(attempts, n);
  assert.equal((await request('GET', '/api/inspections/reports', 'b')).code, 200);
  fail = false;
  await new Promise(r => setTimeout(r, 1050));
  assert.equal((await request('GET', '/api/inspections/reports')).code, 200); assert.ok(attempts > n);
  proto.get = get;
  const values = new Map(), storage = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  let posts = 0, release;
  const sending = withOutboxLock(storage, 'scope', async () => { posts++; await new Promise(r => { release = r; }); });
  await new Promise(r => setTimeout(r, 70));
  await withOutboxLock(storage, 'scope', async () => { posts++; }); assert.equal(posts, 1);
  release(); await sending;
  storage.setItem('scope:send-lock', JSON.stringify({ owner: 'closed', expires: Date.now() - 1 }));
  await withOutboxLock(storage, 'scope', async () => { posts++; }); assert.equal(posts, 2);
  let held = false;
  navigator.locks = { request: async (_name, _options, fn) => { if (held) return fn(null); held = true; try { await fn({}); } finally { held = false; } } };
  await Promise.all([withOutboxLock(storage, 'scope', async () => { posts++; await new Promise(r => setTimeout(r, 10)); }), withOutboxLock(storage, 'scope', async () => { posts++; })]); assert.equal(posts, 3);
  assert.match(await readFile('src/components/FactoryVisitScreen.tsx', 'utf8'), /pb-\[max\(16px,env\(safe-area-inset-bottom\)\)\]/);
  console.log('index-free queries, mock guard, hydration isolation/backoff, cross-tab locks/lease recovery and footer passed');
} finally { await rm(dir, { recursive: true, force: true }); }
