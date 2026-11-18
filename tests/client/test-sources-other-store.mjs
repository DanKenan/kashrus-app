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
await measure('one-part replacement: overwrite chunk + manifest', () => store.saveUpload(connection, files), 0, 2);
// A pre-upgrade copy already uses a hash in its chunk address. Keep that address
// through subsequent replacements, including after reading the manifest again.
const legacy = {...connection,agencyId:'old-layout',upload:{...connection.upload,versioned:true}};
const oldSlot = 'sourceUploads/old-layout__copy__'+legacy.upload.hash+'__0';
docs.set(oldSlot,{data:Buffer.from(JSON.stringify(files)).toString('base64')});
await measure('legacy slot reused',()=>store.saveUpload(legacy,files.slice(0,1)),0,2);
const restored = await store.raw(legacy.agencyId);
await measure('legacy slot reused after restart',()=>store.saveUpload(restored,files),0,2);
assert.deepEqual(await store.loadUpload(restored),files);
assert.deepEqual([...docs.keys()].filter(k=>k.startsWith('sourceUploads/old-layout')), [oldSlot]);
await store.remove(restored);
await measure('mapping config', () => store.save(connection), 0, 1);
const handlers = new Map(), app = Object.fromEntries(['get', 'post', 'put', 'delete', 'patch'].map(m => [m, (p, h) => handlers.set(m + ' ' + p, h)]));
const register = () => registerSourceRoutes(app, { db: () => db, dataDir: '/unused', staged: () => blocked, secret: () => 'demo-test-secret', testMode: false, requireAdmin: () => ({ id: 'demo-admin', agencyId: 'demo-agency' }), timeZone: () => 'UTC' });
const routes = register();
const partKey = [...docs.keys()].find(k => k.startsWith('sourceUploads/'));
const part = docs.get(partKey);
docs.delete(partKey);
const healthy = {...connection,agencyId:'healthy'};
await store.saveUpload(healthy,files);
const nativeTimeout = globalThis.setTimeout;
let retry;
globalThis.setTimeout = (fn,ms,...args) => {
  if ([5000,15000].includes(ms)) { retry = fn; return {unref(){}}; }
  return nativeTimeout(fn,ms,...args);
};
const request = async (path) => { let value; await handlers.get('get ' + path)({ query: {}, params: {} }, { json(v) { value = v; }, status() { return this; } }); return value; };
const drain = async () => {for(let i=0;i<10;i++) await new Promise(r=>setImmediate(r));};
try {
  await routes.boot();
  assert.equal(routes.inspectionSource(connection.agencyId).connection,undefined);
  assert.ok(routes.inspectionSource('healthy').connection);
  const recoveringSettings = await request('/api/sources/connection');
  assert.equal(recoveringSettings.sourceType,'upload');
  assert.equal(recoveringSettings.status,'recovering');
  assert.deepEqual((await request('/api/factories')).companies,[]);
  await measure('persistent failure: only failed manifest and part',async()=>{retry();await drain();},2,0);
  docs.set(partKey,part);
  await measure('targeted recovery',async()=>{retry();await drain();},2,0);
} finally {globalThis.setTimeout=nativeTimeout;}
assert.equal((await request('/api/sources/connection')).status,'ok');
await store.remove(healthy);

await measure('upload browse', async () => { assert.equal((await request('/api/factories')).companies[0].name, 'Demo Bakery'); await request('/api/sources/connection'); }, 0, 0);
assert.equal([...docs.keys()].some(k => k.startsWith('sourceBackups/')), false);
blocked = true;
await assert.rejects(() => store.saveUpload(connection, files), /blocked/);
blocked = false;
const huge = [{ ...files[0], tabs: [{ name: 'Companies', columns: ['Name'], rows: Array.from({ length: 2000 }, (_, i) => ({ id: 'r' + i, fields: { Name: 'x'.repeat(2000) } })) }] }];
await assert.rejects(() => store.saveUpload(connection, huge), /too big to copy/);
const switched = {...connection,sourceType:'excel'};
delete switched.upload;
const originalBatch = db.batch;
db.batch = () => {
    const batch = originalBatch();
    batch.commit = async () => {throw Error('Activation failed');};
    return batch;
};
await assert.rejects(store.save(switched,[],connection.upload),/Activation failed/);
db.batch = originalBatch;
assert.deepEqual(await store.loadUpload(await store.raw(connection.agencyId)),files);
await measure('provider switch plus old chunk deletion', () => store.save(switched,[],connection.upload), 0, 2);
assert.ok(![...docs.keys()].some(k=>k.startsWith('sourceUploads/')));
await store.remove(switched);
assert.equal(docs.size, 0);
// A broken upload is durable but absent from memory. A failed DELETE must
// remain retryable; a successful DELETE invalidates even an already-fired timer.
await store.saveUpload(connection,files);
docs.delete(partKey);
const recovering = register();
globalThis.setTimeout = (fn,ms,...args) => {
  if (ms === 5000) { retry = fn; return {unref(){}}; }
  return nativeTimeout(fn,ms,...args);
};
try { await recovering.boot(); } finally { globalThis.setTimeout = nativeTimeout; }
assert.equal(recovering.inspectionSource(connection.agencyId).connection,undefined);
const disconnect = async () => {
  let status = 200, body;
  await handlers.get('delete /api/sources/connection')({}, {status(n){status=n;return this;},json(v){body=v;}});
  return {status,body};
};
db.batch = () => {throw Error('Offline');};
try { assert.equal((await disconnect()).status,503); } finally { db.batch=originalBatch; }
assert.ok(await store.raw(connection.agencyId));
assert.equal(docs.has(partKey),false);
assert.deepEqual(await disconnect(),{status:200,body:{ok:true}});
assert.equal(await store.raw(connection.agencyId),null);
assert.equal((await request('/api/sources/connection')).sourceType,null);
// Make the formerly missing chunk readable, then fire the captured callback.
docs.set(partKey,part);
await measure('cancelled startup retry',async()=>{retry();await drain();},0,0);
assert.equal(recovering.inspectionSource(connection.agencyId).connection,undefined);
docs.delete(partKey);

console.table(budget);
console.log('upload boot-only reads, atomic bounded parts, no backups, writes and memory browse passed');

// Separate boot config reads from the existing asynchronous last-good refresh.
const { encryptKey } = await import('../../src/server/sources/crypto.ts');
const remote = { ...connection, sourceType: 'supabase', baseId: 'https://' + 'a'.repeat(20) + '.supabase.co', upload: undefined, encryptedKey: encryptKey('fake-demo-key', 'demo-test-secret', 'demo-agency') };
docs.set('sourceConnections/demo-agency', JSON.parse(JSON.stringify(remote)));
let release, name = 'Demo Bakery';
const gate = new Promise(r => { release = r; }), previousFetch = globalThis.fetch, previousNow = Date.now;
globalThis.fetch = async url => { await gate; return url.endsWith('/rest/v1/')
  ? Response.json({definitions:{Companies:{properties:{id:{description:'<pk/>'},Name:{}}}}})
  : Response.json([{ id: 'r2', Name: name }],{headers:{'Content-Range':'0-0/1'}}); };
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
  // Fail a refresh write, change access, and explicitly fire its queued retry.
  const setTimer = globalThis.setTimeout;
  let retry;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 5000) { retry = fn; return {unref(){}}; }
    return setTimer(fn, ms, ...args);
  };
  const batch = db.batch;
  try {
    db.batch = () => { throw Error('Offline'); };
    name = 'Queued refresh'; instant += 61000;
    await refresh();
    assert.equal(typeof retry,'function');
    db.batch = batch;
    const res = {status(n){throw Error('Unexpected HTTP '+n)},json(){}};
    await handlers.get('put /api/sources/access')({body:{access:'readwrite'}},res);
    await measure('stale retry discarded',async () => {
      retry(); for(let i=0;i<5;i++) await new Promise(r=>setImmediate(r));
    },0,0);
    assert.equal(restarted.inspectionSource('demo-agency').connection.access,'readwrite');
    assert.equal((await store.raw('demo-agency')).access,'readwrite');
  } finally {db.batch=batch;globalThis.setTimeout=setTimer;}
  console.table(budget.slice(-6));
} finally { globalThis.fetch = previousFetch; Date.now = previousNow; }


const fs = await import('node:fs/promises');
const {tmpdir} = await import('node:os');
const {join} = await import('node:path');
const directory = await fs.mkdtemp(join(tmpdir(),'source-chunk-recovery-'));
try {
  const local = createSourceStore({db:()=>null,dataDir:directory,staged:()=>false});
  const active = {...connection};
  await local.saveUpload(active,files);
  const orphan = join(directory,'source-connections','sourceUploads','obsolete__copy__0.json');
  await fs.writeFile(orphan,'{}');
  await local.reclaimLocalUploads();
  await assert.rejects(fs.stat(orphan), {code:'ENOENT'});
  assert.deepEqual(await local.loadUpload(active),files);
} finally { await fs.rm(directory,{force:true,recursive:true}); }
