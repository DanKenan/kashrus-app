import assert from 'node:assert/strict';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let clock = originalNow();
Date.now = () => clock;
let calls = 0, failBackup = true, gate = Promise.resolve(), startupFails = true, connectionLoads = 0;
const docs = new Map(), writes = [];
const rows = { Companies: [{ id: 'c', fields: { Name: 'Old Company' } }], Ingredients: [{ id: 'i', fields: { Name: 'Salt', Company: ['c'] } }], Products: [] };
const tables = [...Array.from({ length: 17 }, (_, i) => ({ name: `Other ${i}`, fields: [{ name: 'Description' }] })), ...Object.keys(rows).map(name => ({ name, fields: [{ name: 'Name' }, { name: 'Company' }] }))];
globalThis.fetch = async url => {
  calls++; const u = new URL(url);
  if (u.pathname.endsWith('/whoami')) return Response.json({ scopes: [] });
  if (u.pathname.endsWith('/tables')) return Response.json({ tables });
  await gate;
  return Response.json({ records: rows[decodeURIComponent(u.pathname.split('/').at(-1))] || [] });
};
const db = {
  collection: collection => ({ async get() { connectionLoads++; if (startupFails) throw Error('load failed'); return { docs: [] }; }, doc: id => ({ collection, id }) }),
  batch() { const ops = []; return {
    set(ref, doc) { ops.push({ ref, doc }); }, delete(ref) { ops.push({ ref }); },
    async commit() { if (failBackup && ops.some(o => o.ref.collection === 'sourceBackupParts')) throw Error('backup failed'); for (const op of ops) { writes.push(op); docs.set(`${op.ref.collection}/${op.ref.id}`, structuredClone(op.doc)); } },
  }; },
};
const handlers = new Map(), app = Object.fromEntries(['get', 'post', 'put'].map(method => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
const routes = registerSourceRoutes(app, { db: () => db, dataDir: '/unused', staged: () => false, secret: () => 'test-secret', testMode: false, requireAdmin: () => ({ agencyId: 'a', id: 'u' }), timeZone: () => 'UTC' });
async function request(method, path, body = {}) {
  let json, status = 200;
  await handlers.get(`${method} ${path}`)({ body }, { status(n) { status = n; return this; }, json(v) { json = structuredClone(v); } });
  return { json, status };
}
const state = async () => (await request('get', '/api/sources/connection')).json;
const mapping = { companies: { table: 'Companies', name: 'Name' }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: [] };
const body = { sourceType: 'airtable', baseId: 'appTEST', apiKey: 'fake-key', access: 'read', mapping };
const until = async check => { for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); } assert.fail('timed out'); };
try {
  assert.equal((await request('put', '/api/sources/connection', { ...body, sourceType: 'excel' })).status, 400);
  assert.equal((await request('put', '/api/sources/connection', { ...body, mapping: { ...mapping, companies: { table: '', name: '' } } })).status, 400);
  assert.equal((await request('put', '/api/sources/connection', { ...body, mapping: { ...mapping, companies: { table: 'Missing', name: 'Name' } } })).status, 400);
  let result = await request('post', '/api/sources/test', body);
  assert.equal(result.json.calls, 17);
  assert.equal(Object.keys(result.json.samples).length, 15);
  assert.deepEqual(Object.keys(result.json.samples).slice(0, 3), ['Companies', 'Ingredients', 'Products']); assert.equal(result.json.samples.Ingredients[0].fields.Name, 'Salt');
  assert.equal((await request('put', '/api/sources/connection', { ...body, mapping: { ...mapping, products: { ...mapping.products, code: 'Missing' } } })).status, 400);
  const before = calls;
  assert.equal((await request('put', '/api/sources/connection', body)).status, 200);
  await until(async () => (await state()).backupSaveError);
  assert.equal(calls - before, 3); // PUT reuses the test schema.
  assert.equal((await request('get', '/api/factories')).json.status.backupSaveError, true);
  assert.deepEqual(docs.get('sourceConnections/a').backupHashes, {});
  clock += 61000;
  assert.equal((await request('post', '/api/sources/refresh')).json.ok, true);
  assert.equal((await state()).backupSaveError, true, 'unchanged refresh must not clear failed persistence');
  assert.deepEqual(docs.get('sourceConnections/a').backupHashes, {});
  failBackup = false;
  clock += 61000;
  assert.equal((await request('post', '/api/sources/refresh')).json.ok, true);
  assert.ok(writes.some(w => w.ref.collection === 'sourceBackupParts'), 'unchanged refresh writes the unconfirmed backup');
  const fetched = calls;
  await until(async () => !(await state()).backupSaveError);
  assert.equal(calls, fetched); // Timer persists from memory without a source fetch.
  assert.ok(docs.get('sourceConnections/a').backupHashes.c);
  assert.equal((await request('get', '/api/factories')).json.companies.length, 1);
  // A pending version may be superseded even when the source returns to its confirmed hash.
  failBackup = true; rows.Ingredients[0].fields.Name = 'Sea Salt'; clock += 61000;
  await request('post', '/api/sources/refresh');
  assert.equal((await state()).backupSaveError, true);
  rows.Ingredients[0].fields.Name = 'Salt'; failBackup = false; clock += 61000;
  await request('post', '/api/sources/refresh');
  assert.equal((await state()).backupSaveError, false);
  const manifest = docs.get('sourceBackups/a__c');
  const latest = JSON.parse(Buffer.from(docs.get(`sourceBackupParts/a__c__${manifest.hash}__0`).data, 'base64').toString());
  assert.equal(latest.ingredients[0].name, 'Salt', 'save the newest version, even with zero changedBackups');
  failBackup = true; rows.Companies[0].fields.Name = 'Newest Company'; clock += 61000;
  await request('post', '/api/sources/refresh');
  assert.equal((await state()).backupSaveError, true);
  failBackup = false;
  const beforeRetry = calls;
  await until(async () => !(await state()).backupSaveError);
  assert.equal(calls, beforeRetry, 'retry persists from memory without fetching the source');
  let release; gate = new Promise(r => { release = r; });
  const changed = await request('put', '/api/sources/connection', { ...body, mapping: { ...mapping, companies: { ...mapping.companies, brand: 'Company' } } });
  assert.equal(changed.json.status, 'never');
  assert.deepEqual((await request('get', '/api/factories')).json.companies, []);
  release(); await until(async () => (await state()).status === 'ok');
  await routes.boot(); const failedLoads = connectionLoads; startupFails = false;
  await until(() => connectionLoads > failedLoads);
  console.log('source PUT validation, schema reuse, cache reset and memory-only backup retry passed');
} finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
