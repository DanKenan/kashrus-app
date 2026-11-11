import assert from 'node:assert/strict';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
import { encryptKey } from '../../src/server/sources/crypto.ts';
import { normalizeConnection } from '../../src/server/sources/store.ts';
import { applyMapping } from '../../src/server/sources/mapping.ts';
const originalFetch = globalThis.fetch, originalNow = Date.now;
let reads = 0, writes = 0, sourceCalls = 0, offline = false, failWrite = false;
const docs = new Map();
const mapping = { companies: { table: 'Companies', name: 'Name' }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company', certification: 'Cert', status: 'Status' }, products: { table: 'Products', name: 'Name', companyLink: 'Company', status: 'Status' }, group1Values: ['Group 1', 'Inherently kosher'] };
const rows = { Companies: [{ id: 'c', fields: { Name: 'Factory' } }], Ingredients: [{ id: 'i', fields: { Name: 'Salt', Company: ['c'], Cert: 'Group 1' } }, { id: 'i2', fields: { Name: 'Water', Company: ['c'], Cert: 'Inherently kosher' } }], Products: [{ id: 'p', fields: { Name: 'Product', Company: ['c'], Status: ' inherently KOSHER ' } }] };
const legacy = { ...mapping, noSymbolValues: mapping.group1Values }; delete legacy.group1Values;
docs.set('sourceConnections/a', { agencyId: 'a', sourceType: 'airtable', baseId: 'appTEST', access: 'readwrite', mapping: legacy, group1Label: 'Basic ingredients', encryptedKey: encryptKey('fake-key', 'test-secret', 'a'), keyHint: '…key', backupHashes: {} });
assert.deepEqual(normalizeConnection(docs.get('sourceConnections/a')).mapping, mapping);
assert.equal(applyMapping(rows, mapping).ingredients[1].group1, true);
assert.equal(applyMapping(rows, mapping).products[0].group1, true);
const db = {
  collection: collection => ({ async get() { reads++; return { docs: [...docs].filter(([key]) => key.startsWith(collection + '/')).map(([, doc]) => ({ data: () => structuredClone(doc) })) }; }, doc: id => ({ collection, id, async get() { reads++; const doc = docs.get(`${collection}/${id}`); return { exists: !!doc, data: () => structuredClone(doc) }; } }) }),
  batch() { const ops = []; return { set(ref, doc) { ops.push([ref, doc]); }, delete(ref) { ops.push([ref]); }, async commit() { if (failWrite) throw Error('write failed'); for (const [ref, doc] of ops) { writes++; if (doc) docs.set(`${ref.collection}/${ref.id}`, structuredClone(doc)); else docs.delete(`${ref.collection}/${ref.id}`); } } }; },
};
globalThis.fetch = async url => { sourceCalls++; if (offline) throw Error('offline'); const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1)); if (name === 'tables') return Response.json({ tables: Object.keys(rows).map(name => ({ name, fields: ['Name', 'Company', 'Cert', 'Status'].map(name => ({ name })) })) }); if (name === 'whoami') return Response.json({ scopes: [] }); return Response.json({ records: rows[name] || [] }); };
function fixture() {
  const handlers = new Map(), app = Object.fromEntries(['get', 'post', 'put'].map(method => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
  const routes = registerSourceRoutes(app, { db: () => db, dataDir: '/unused', staged: () => false, secret: () => 'test-secret', testMode: false, requireAdmin(req, res) { if (req.admin === false) { res.status(403).json({ error: 'Forbidden' }); return null; } return { id: 'admin', agencyId: req.agency }; }, timeZone: () => 'UTC' });
  async function request(method, path, body = {}, extra = {}) { let json, status = 200; await handlers.get(`${method} ${path}`)({ body, params: { companyId: 'c' }, agency: 'a', ...extra }, { status(n) { status = n; return this; }, json(v) { json = structuredClone(v); } }); return { status, json }; }
  return { ...routes, request };
}
const until = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Timed out'); };
try {
  let routes = fixture(); await routes.boot();
  const getItems = () => routes.request('get', '/api/factories/:companyId/items');
  const put = body => routes.request('put', '/api/sources/group1', body);
  await until(() => docs.get('sourceConnections/a').backupHashes.c);
  assert.equal((await routes.request('get', '/api/sources/connection')).json.group1Label, 'Basic ingredients');
  assert.deepEqual((await routes.request('get', '/api/sources/connection')).json.mapping, mapping);
  assert.equal((await routes.request('get', '/api/factories')).json.status.group1Label, 'Basic ingredients');
  for (const group1Label of ['', '   ', 'a'.repeat(31), null, 42]) {
    assert.equal((await routes.request('put', '/api/sources/connection', { sourceType: 'airtable', baseId: 'appTEST', access: 'readwrite', mapping, group1Label })).status, 400);
  }
  assert.equal((await routes.request('put', '/api/sources/connection', { sourceType: 'airtable', baseId: 'appTEST', access: 'readwrite', mapping, group1Label: ' Basic ingredients ' })).status, 200);
  assert.equal((await routes.request('get', '/api/sources/connection')).json.group1Label, 'Basic ingredients');
  const readBefore = reads;
  for (let i = 0; i < 5; i++) assert.equal((await getItems()).json.ingredients[0].group1, true);
  assert.equal(reads, readBefore, 'items route performs zero Firestore reads');
  assert.equal((await getItems()).json.products[0].group1, true);
  for (const body of [{ kind: 'bad', itemId: 'i', group1: true }, { kind: 'ingredient', itemId: '', group1: true }, { kind: 'ingredient', itemId: 4, group1: true }, { kind: 'ingredient', itemId: 'i', group1: 'true' }, { kind: 'ingredient', itemId: 'i' }]) assert.equal((await put(body)).status, 400);
  assert.equal((await put({ kind: 'ingredient', itemId: 'unknown', group1: true })).status, 404);
  const before = [writes, sourceCalls];
  assert.equal((await put({ kind: 'ingredient', itemId: 'i', group1: false })).status, 200);
  assert.equal(writes - before[0], 1); assert.equal(sourceCalls, before[1]);
  assert.deepEqual((await getItems()).json.ingredients[0], { id: 'i', name: 'Salt', agency: '', dpm: null, group1: false, group1Source: 'admin' });
  assert.equal((await routes.request('put', '/api/sources/group1', { kind: 'ingredient', itemId: 'i', group1: true }, { agency: 'b' })).status, 404);
  assert.equal((await routes.request('get', '/api/factories/:companyId/items', {}, { agency: 'b' })).status, 404);
  assert.equal((await routes.request('put', '/api/sources/group1', { kind: 'ingredient', itemId: 'i', group1: true }, { admin: false })).status, 403);
  assert.equal((await routes.request('get', '/api/factories/:companyId/items', {}, { admin: false })).status, 403);
  rows.Ingredients[1].fields.Cert = 'OU';
  await put({ kind: 'ingredient', itemId: 'i2', group1: true });
  Date.now = () => originalNow() + 61000;
  await routes.request('post', '/api/sources/refresh');
  assert.equal((await getItems()).json.ingredients[0].group1, false);
  assert.equal((await getItems()).json.ingredients[1].group1, true);
  assert.equal((await getItems()).json.ingredients[1].group1Source, 'admin');
  const manifest = docs.get('sourceBackups/a__c');
  const backup = JSON.parse(Buffer.from(Array.from({ length: manifest.parts }, (_, i) => docs.get(`sourceBackupParts/a__c__${manifest.hash}__${i}`).data).join(''), 'base64').toString());
  assert.equal(backup.group1Overrides.ingredient.i, false); assert.equal(backup.group1Label, 'Basic ingredients'); assert.equal(backup.ingredients[0].certificationRaw, 'Group 1');
  offline = true; routes = fixture(); await routes.boot();
  await until(async () => (await routes.request('get', '/api/factories')).json.status.status === 'backup');
  assert.equal((await getItems()).json.ingredients[0].group1, false);
  assert.equal((await getItems()).json.ingredients[0].group1Source, 'admin');
  await put({ kind: 'ingredient', itemId: 'i', group1: null });
  assert.equal((await getItems()).json.ingredients[0].group1, true); assert.equal((await getItems()).json.ingredients[0].group1Source, 'source');
  assert.equal(Object.hasOwn(docs.get('sourceConnections/a').group1Overrides.ingredient, 'i'), false);
  await put({ kind: 'product', itemId: 'p', group1: false });
  assert.equal((await getItems()).json.products[0].group1, false);
  await Promise.all([put({ kind: 'ingredient', itemId: 'i', group1: false }), put({ kind: 'ingredient', itemId: 'i2', group1: false })]);
  assert.equal((await getItems()).json.ingredients.every(item => !item.group1), true);
  await put({ kind: 'ingredient', itemId: 'i', group1: null });
  failWrite = true;
  assert.equal((await put({ kind: 'ingredient', itemId: 'i', group1: false })).status, 503);
  assert.equal((await getItems()).json.ingredients[0].group1Source, 'source');
} finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
console.log('Group 1 server: custom mapping, legacy settings, one-write overlay, refresh, backup restore, clear, own agency and zero-read items passed');
