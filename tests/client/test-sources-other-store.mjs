import assert from 'node:assert/strict';
import { createSourceStore } from '../../src/server/sources/store.ts';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
import { parseUpload } from '../../src/server/sources/upload.ts';
const docs = new Map(), budget = [];
let reads = 0, writes = 0, blocked = false;
const db = { collection: collection => ({ async get() { const found = [...docs].filter(([k]) => k.startsWith(collection + '/')); reads += Math.max(1, found.length); return { docs: found.map(([, v]) => ({ data: () => structuredClone(v) })) }; }, doc: id => ({ collection, id, async get() { reads++; const v = docs.get(collection + '/' + id); return { exists: !!v, data: () => structuredClone(v) }; } }) }), batch() { const ops = []; return { set(ref, doc) { ops.push({ ref, doc }); }, delete(ref) { ops.push({ ref }); }, async commit() { writes += ops.length; for (const { ref, doc } of ops) {
            const id = ref.collection + '/' + ref.id;
            if (doc) {
                assert.ok(JSON.stringify(doc).length < 500 * 1024);
                docs.set(id, structuredClone(doc));
            }
            else
                docs.delete(id);
        } } }; } };
const store = createSourceStore({ db: () => db, dataDir: '/unused', staged: () => blocked });
const connection = { agencyId: 'demo-agency', sourceType: 'upload', baseId: 'upload', access: 'read', mapping: { companies: { table: 'Companies', name: 'Name' }, ingredients: { table: '' }, products: { table: '' }, group1Values: [] }, encryptedKey: '', keyHint: '', backupHashes: {} };
const files = [parseUpload(Buffer.from('Name\nDemo Bakery'), 'Companies.csv')];
const measure = async (action, fn, r, w) => { reads = 0; writes = 0; const result = await fn(); budget.push({ action, reads, writes }); assert.equal(reads, r, action); assert.equal(writes, w, action); return result; };
await measure('upload parts + manifest', () => store.saveUpload(connection, files), 0, 2);
files.push(parseUpload(Buffer.from('Name\nDemo Flour'), 'Ingredients.csv'));
await measure('second upload parts + manifest', () => store.saveUpload(connection, files), 0, 2);
await measure('mapping config', () => store.save(connection), 0, 1);
const handlers = new Map(), app = Object.fromEntries(['get', 'post', 'put', 'delete', 'patch'].map(m => [m, (p, h) => handlers.set(m + ' ' + p, h)]));
const routes = registerSourceRoutes(app, { db: () => db, dataDir: '/unused', staged: () => blocked, secret: () => 'demo-test-secret', testMode: false, requireAdmin: () => ({ id: 'demo-admin', agencyId: 'demo-agency' }), timeZone: () => 'UTC' });
await measure('boot connection + upload part', async () => { await routes.boot(); for (let i = 0; i < 10; i++)
    await new Promise(r => setImmediate(r)); }, 2, 0);
const request = async (path) => { let value; await handlers.get('get ' + path)({ query: {}, params: {} }, { json(v) { value = v; }, status() { return this; } }); return value; };
await measure('upload browse', async () => { assert.equal((await request('/api/factories')).companies[0].name, 'Demo Bakery'); await request('/api/sources/connection'); }, 0, 0);
assert.equal([...docs.keys()].some(k => k.startsWith('sourceBackups/')), false);
blocked = true;
await assert.rejects(() => store.saveUpload(connection, files), /blocked/);
blocked = false;
const huge = [{ ...files[0], tabs: [{ name: 'Companies', columns: ['Name'], rows: Array.from({ length: 2000 }, (_, i) => ({ id: 'r' + i, fields: { Name: 'x'.repeat(2000) } })) }] }];
await assert.rejects(() => store.saveUpload(connection, huge), /too big to copy/);
await measure('disconnect + upload parts deleted', () => store.remove(connection), 0, 2);
assert.equal(docs.size, 0);
console.table(budget);
console.log('upload boot-only reads, atomic bounded parts, no backups, writes and memory browse passed');

// Separate boot config reads from the existing asynchronous last-good refresh.
const { encryptKey } = await import('../../src/server/sources/crypto.ts');
const remote = { ...connection, sourceType: 'supabase', baseId: 'https://' + 'a'.repeat(20) + '.supabase.co', upload: undefined, encryptedKey: encryptKey('fake-demo-key', 'demo-test-secret', 'demo-agency') };
docs.set('sourceConnections/demo-agency', JSON.parse(JSON.stringify(remote)));
let release, name = 'Demo Bakery';
const gate = new Promise(r => { release = r; }), previousFetch = globalThis.fetch, previousNow = Date.now;
globalThis.fetch = async () => { await gate; return Response.json([{ id: 'r2', Name: name }]); };
try {
  const restarted = registerSourceRoutes(app, { db: () => db, dataDir: '/unused', staged: () => false, secret: () => 'demo-test-secret', testMode: false, requireAdmin: () => ({ id: 'demo-admin', agencyId: 'demo-agency' }), timeZone: () => 'UTC' });
  await measure('remote boot connection only', () => restarted.boot(), 1, 0);
  await measure('initial last-good refresh', async () => { release(); for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); }, 0, 3);
  await measure('remote browse', async () => { assert.equal((await request('/api/factories')).companies[0].name, 'Demo Bakery'); }, 0, 0);
  let instant = previousNow();
  Date.now = () => instant;
  const refresh = async () => { let status = 200; await handlers.get('post /api/sources/refresh')({ body: {} }, { status(n) { status = n; return this; }, json() {} }); assert.equal(status, 200); };
  instant += 61000;
  await measure('unchanged refresh', refresh, 0, 0);
  name = 'Changed Demo Bakery'; instant += 61000;
  await measure('changed refresh + old part cleanup', refresh, 0, 4);
  console.table(budget.slice(-5));
} finally { globalThis.fetch = previousFetch; Date.now = previousNow; }
