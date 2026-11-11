import assert from 'node:assert/strict';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
import { encryptKey } from '../../src/server/sources/crypto.ts';

const message = "The saved key can't be read. Enter the key again in Settings.";
const logs = [];
const warn = console.warn, info = console.info;
console.warn = (...args) => logs.push(args.join(' '));
console.info = (...args) => logs.push(args.join(' '));
function fixture(get) {
  const handlers = new Map();
  const app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
  const routes = registerSourceRoutes(app, {
    db: () => ({ collection: () => ({ get }) }), dataDir: '/unused', staged: () => true,
    secret: () => 'changed-test-secret', testMode: false,
    requireAdmin: () => ({ id: 'admin', agencyId: 'agency-test' }), timeZone: () => 'UTC',
  });
  async function request(method, path, body = {}) {
    let json, code = 200;
    await handlers.get(`${method} ${path}`)({ body }, { status(n) { code = n; return this; }, json(value) { json = value; } });
    return { code, json };
  }
  return { ...routes, request };
}
try {
  const failed = fixture(async () => { throw Error('fake-key-must-not-be-logged'); });
  await assert.doesNotReject(failed.boot());
  assert.deepEqual(logs, ['[sources] startup failed']);

  let release;
  const pending = fixture(() => new Promise(resolve => { release = resolve; }));
  const boot = pending.boot();
  assert.equal((await pending.request('get', '/api/sources/connection')).json.status, 'never');
  release({ docs: [] });
  await boot;

  const plain = 'fake-key-must-not-be-logged';
  const connection = { agencyId: 'agency-test', sourceType: 'airtable', baseId: 'appTEST', access: 'read', mapping: {}, encryptedKey: encryptKey(plain, 'old-test-secret', 'agency-test'), keyHint: '…gged', backupHashes: {} };
  const saved = fixture(async () => ({ docs: [{ data: () => connection }] }));
  await assert.doesNotReject(saved.boot());
  // boot starts the refresh in the background; wait for its cache publication.
  for (let i = 0; i < 20; i++) {
    if (logs.some(line => line.includes('ok=false'))) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  const state = (await saved.request('get', '/api/sources/connection')).json;
  assert.equal(state.status, 'error');
  assert.equal(state.error, message);
  assert.equal(state.calls, 0);
  assert.equal((await saved.request('get', '/api/factories')).json.status.status, 'error');
  const tested = await saved.request('post', '/api/sources/test', { sourceType: 'airtable', baseId: 'appTEST' });
  assert.equal(tested.json.error, message);
  assert.equal(JSON.stringify(logs).includes(plain), false);
  assert.equal(JSON.stringify(state).includes(plain), false);
  const fetchBefore = globalThis.fetch;
  const mapping = { companies: { table: 'Companies', name: 'Name' }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, noSymbolValues: [] };
  globalThis.fetch = async () => Response.json({ scopes: [], tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, fields: [{ name: 'Name' }, { name: 'Company' }] })), records: [] });
  try {
    const replacement = await saved.request('put', '/api/sources/connection', { sourceType: 'airtable', baseId: 'appTEST', access: 'read', mapping, apiKey: 'fake-replacement-key' });
    assert.equal(replacement.code, 200); assert.equal(replacement.json.status, 'never'); assert.equal(replacement.json.error, null);
    for (let i = 0; i < 30; i++) {
      if ((await saved.request('get', '/api/sources/connection')).json.status === 'ok') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await saved.request('get', '/api/sources/connection')).json.status, 'ok');
  } finally { globalThis.fetch = fetchBefore; }
} finally { console.warn = warn; console.info = info; }
console.log('source boot failures are contained; unreadable keys have a safe error status');
