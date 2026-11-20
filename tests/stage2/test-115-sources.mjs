import assert from 'node:assert/strict';
import http from 'node:http';
import { shiftFixture } from './test-101-shifts-crud.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function mockAirtable() {
  const key = 'fake-source-test115-key';
  const mapping = { companies: { table: 'Companies', name: 'Name', type: 'Type', address: 'Address', factoryValues: ['Factory'] }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company', certification: 'Cert', status: 'Status', agency: 'Agency' }, products: { table: 'Products', name: 'Name', companyLink: 'Company', certification: 'Cert', status: 'Status', agency: 'Agency' }, group1Values: ['Group 1'] };
  const rows = {
    Companies: Array.from({ length: 7 }, (_, i) => ({ id: `rec${i}`, fields: { Name: `Company ${i}`, Address: 'Main Street', Type: i < 5 ? 'Factory' : 'Other' } })),
    Ingredients: Array.from({ length: 230 }, (_, i) => ({ id: `ing${i}`, fields: { Name: `Ingredient ${i}`, Company: [`rec${i % 5}`], Cert: 'OU-D', Status: 'Dairy Equipment', Agency: 'OU' } })),
    Products: Array.from({ length: 120 }, (_, i) => ({ id: `prod${i}`, fields: { Name: `Product ${i}`, Company: [`rec${i % 5}`], Cert: 'OU-D', Status: 'Dairy Equipment', Agency: 'OU' } })),
  };
  const state = { calls: 0, writable: false, denyConfirm: false, permission: false, scopeChecks: 0 };
  const schema = Object.entries(rows).map(([name, records]) => ({ name, fields: Object.keys(records[0].fields).map(name =>
    name === 'Type' ? { name, type: 'singleSelect', options: { choices: ['Factory', 'Other'].map(name => ({ name })) } } : { name }) }));
  schema.find(table => table.name === 'Companies').fields.push({ name: 'Brand' }, { name: 'Plant' }, { name: 'Supervision' });
  const recordCalls = [], patches = [];
  const mock = http.createServer(async (req, res) => {
    state.calls++; res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end('{}'); }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v0/meta/whoami') {
      state.scopeChecks++;
      if (state.scopeOffline) return req.socket.destroy();
      return res.end(JSON.stringify({ scopes: state.writable ? ['data.records:write'] : [] }));
    }
    if (url.pathname.endsWith('/tables')) return res.end(JSON.stringify({ tables: schema }));
    if (url.pathname.endsWith('/Companies/rec0')) {
      recordCalls.push(req.method);
      if (state.permission || state.denyPatch && req.method === 'PATCH' || state.denyConfirm && recordCalls.at(-2) === 'PATCH') { res.writeHead(403); return res.end('{}'); }
      if (req.method === 'PATCH') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { fields } = JSON.parse(body);
        state.beforePatch?.();
        patches.push(fields);
        for (const [key, value] of Object.entries(fields))
          if (value === null) delete rows.Companies[0].fields[key]; else rows.Companies[0].fields[key] = value;
      }
      return res.end(JSON.stringify({ ...rows.Companies[0], id: state.recordId ?? rows.Companies[0].id }));
    }
    if (state.failList) { res.writeHead(503); return res.end('{}'); }
    const sample = url.searchParams.get('maxRecords') === '3';
    const table = decodeURIComponent(url.pathname.split('/').pop()), start = Number(url.searchParams.get('offset') || 0), records = rows[table];
    if (!records) { res.writeHead(404); return res.end('{}'); }
    res.end(JSON.stringify({ records: records.slice(start, start + (sample ? 3 : 100)), ...(!sample && start + 100 < records.length ? { offset: String(start + 100) } : {}) }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  return { key, mapping, rows, state, recordCalls, patches, mock };
}
export default {
  name: 'Test 115: source server wiring',
  whatItProves: 'Encrypted keys, paginated bulk refresh, memory-only reads, unchanged backups, throttling and agency/admin isolation.',
  async run(baseUrl, ctx) {
    const { api, agencyId, tokens } = await shiftFixture(baseUrl, ctx, '115');
    const { key, mapping, rows, state, recordCalls, patches, mock } = await mockAirtable();
    let socket;
    try {
      assert.equal((await api('admin', 'POST', '/api/__test__/sources-api-base', { url: `http://127.0.0.1:${mock.address().port}` })).status, 200);
      const body = { sourceType: 'airtable', baseId: 'appTEST115', access: 'read', mapping, apiKey: key };
      const raw = async () => (await api('admin', 'POST', '/api/__test__/source-raw', { agencyId })).json;
      const bad = await api('admin', 'POST', '/api/sources/test', { ...body, apiKey: 'wrong' });
      assert.deepEqual(bad.json, { ok: false, error: 'Airtable 401: authentication failed', calls: 1 });
      assert.equal((await raw()).connection, null);
      const tested = await api('admin', 'POST', '/api/sources/test', body);
      assert.equal(tested.json.ok, true); assert.ok(tested.json.guess.mapping.companies);
      assert.equal(tested.json.calls, 5); assert.equal(tested.json.samples.Ingredients.length, 3);
      const firstWrites = (await ctx.api('POST', '/api/__test__/writes', {})).json;
      state.calls = 0;
      assert.equal((await api('admin', 'PUT', '/api/sources/connection', body)).status, 200);
      let stored;
      for (let i = 0; i < 100; i++) { stored = await raw(); if (stored.backupIds.length === 5) break; await sleep(100); }
      assert.equal(stored.backupIds.length, 5);
      const afterFirstWrites = (await ctx.api('POST', '/api/__test__/writes', {})).json;
      assert.equal((afterFirstWrites.byCollection.sourceBackups || 0) - (firstWrites.byCollection.sourceBackups || 0), 5);
      assert.equal((afterFirstWrites.byCollection.sourceConnections || 0) - (firstWrites.byCollection.sourceConnections || 0), 2);
      assert.equal(state.calls, 8); // Two metadata calls, then six paginated list reads.
      assert.match(stored.connection.encryptedKey, /^v1:/);
      assert.equal('apiKey' in stored.connection, false);
      assert.equal(JSON.stringify(stored).includes(key), false);
      for (const path of ['/api/sources/connection', '/api/factories', '/api/airtable/config']) assert.equal(JSON.stringify((await api('admin', 'GET', path)).json).includes(key), false);
      await new Promise((resolve, reject) => {
        socket = new WebSocket(baseUrl.replace(/^http/, 'ws') + `/ws?token=${tokens.admin}`);
        const timer = setTimeout(() => reject(Error('socket timeout')), 10000);
        socket.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.type === 'INITIAL_STATE') { clearTimeout(timer); try { assert.equal(JSON.stringify(m).includes(key), false); assert.ok(m); resolve(); } catch (e) { reject(e); } } };
        socket.onerror = () => { clearTimeout(timer); reject(Error('socket failed')); };
      });
      await ctx.api('POST', '/api/__test__/reads', { reset: true });
      const factories = (await api('admin', 'GET', '/api/factories')).json;
      assert.equal((await ctx.api('POST', '/api/__test__/reads', {})).json.total, 0);
      await ctx.api('POST', '/api/__test__/reads', { reset: true });
      const values = await api('admin', 'GET', '/api/sources/values?agencyId=other');
      assert.equal(values.status, 200); assert.ok(values.json.values.length > 0);
      assert.ok(values.json.values.length <= 300);
      const usage = values.json.values.find(v => v.kind === 'ingredient' && v.column === 'Cert' && v.value === 'OU-D').usage;
      assert.equal(usage.ingredient.count, 230); assert.equal(usage.product.count, 120);
      assert.equal(usage.ingredient.items.length, 50); assert.equal(usage.product.items.length, 50);
      const items = (await api('admin', 'GET', '/api/factories/rec0/items')).json;
      for (const item of [items.ingredients[0], items.products[0]]) {
        assert.equal(item.certificationRaw, 'OU-D'); assert.equal(item.statusRaw, 'Dairy Equipment'); assert.equal(item.dpm, 'dairy_equipment');
      }
      assert.equal((await ctx.api('POST', '/api/__test__/reads', {})).json.total, 0);
      assert.deepEqual((await api('foreign', 'GET', '/api/sources/values')).json.values, []);
      assert.equal((await api('mash', 'GET', '/api/sources/values')).status, 403);
      assert.equal(factories.companies.length, 5);
      for (const c of factories.companies) { assert.equal(c.ingredientCount, 46); assert.equal(c.productCount, 24); }
      assert.equal((await api('admin', 'POST', '/api/sources/refresh', {})).status, 429);
      for (const path of ['/api/factories', '/api/sources/connection']) assert.equal((await api('mash', 'GET', path)).status, 403);
      for (const path of ['/api/sources/test', '/api/sources/refresh']) assert.equal((await api('mash', 'POST', path, body)).status, 403);
      assert.equal((await api('mash', 'PUT', '/api/sources/connection', body)).status, 403);
      assert.equal((await api('foreign', 'GET', '/api/factories')).json.companies.length, 0);
      assert.equal((await api('foreign', 'GET', '/api/sources/connection')).json.hasKey, false);
      const beforeWrong = await raw();
      await api('admin', 'POST', '/api/sources/test', { ...body, apiKey: 'wrong' });
      assert.deepEqual(await raw(), beforeWrong);
      // A settings save also triggers a second real refresh, without waiting a minute.
      const beforeWrites = (await ctx.api('POST', '/api/__test__/writes', {})).json.byCollection.sourceBackups || 0;
      const beforeRefreshDay = (await raw()).connection.lastRefresh.at.slice(0, 10);
      const connectionWrites = (await ctx.api('POST', '/api/__test__/writes', {})).json.byCollection.sourceConnections || 0;
      state.calls = 0;
      const { apiKey, ...same } = body;
      assert.equal((await api('admin', 'PUT', '/api/sources/connection', same)).status, 200);
      for (let i = 0; i < 100 && state.calls < 8; i++) await sleep(100);
      await sleep(200);
      assert.equal(state.calls, 8);
      assert.equal(((await ctx.api('POST', '/api/__test__/writes', {})).json.byCollection.sourceConnections || 0) - connectionWrites, (await raw()).connection.lastRefresh.at.slice(0, 10) === beforeRefreshDay ? 1 : 2);
      assert.equal((await ctx.api('POST', '/api/__test__/writes', {})).json.byCollection.sourceBackups || 0, beforeWrites);
      const endpoint = '/api/sources/rows/companies/rec0';
      const readCalls = state.calls;
      assert.equal((await api('admin', 'GET', endpoint + '/edit')).status, 403);
      assert.equal((await api('admin', 'PATCH', endpoint, { fields: { name: 'Changed' } })).status, 403);
      assert.equal(state.calls, readCalls);
      state.writable = true;
      assert.equal((await api('admin', 'PUT', '/api/sources/connection', { ...same, access: 'readwrite' })).status, 200);
      const editor = await api('admin', 'GET', endpoint + '/edit');
      assert.equal(editor.status, 200);
      const { baseId, updatedAt } = editor.json;
      assert.deepEqual(editor.json.typeOptions, ['Factory', 'Other']);
      const patch = (fields, originals, extra = {}, path = endpoint) =>
        api('admin', 'PATCH', path, { baseId, updatedAt, fields, originals, ...extra });
      const count = state.calls, checks = state.scopeChecks;
      assert.equal((await api('mash', 'GET', endpoint + '/edit')).status, 403);
      assert.equal((await api('admin', 'POST', '/api/sources/rows/companies', { fields: { name: 'Add' } })).status, 409);
      assert.equal((await patch({ name: 'x' }, {}, {}, '/api/sources/rows/companies')).status, 400);
      for (const list of ['ingredients', 'products'])
        assert.equal((await patch({ name: 'x' }, {}, {}, endpoint.replace('companies', list))).status, 409);
      for (const binding of [{ baseId: 'appOTHER' }, { updatedAt: 'stale' }])
        assert.equal((await patch({ name: 'x' }, {}, binding)).status, 409);
      assert.equal((await patch({ name: 'x' }, {}, {}, endpoint.replace('rec0', 'rec999'))).status, 409);
      for (const fields of [{ address: 'x' }, { name: 'x', brand: 'x' }, { companyFee: '42' }, { unknown: 'x' }])
        assert.equal((await patch(fields, {})).status, 400);
      assert.equal((await patch({ type: 'Invalid' }, { type: 'Factory' })).status, 400);
      assert.equal(state.calls, count);
      rows.Ingredients[0].fields.Company = 'Company 0';
      assert.equal((await patch({ name: 'Renamed' }, { name: 'Company 0' })).status, 409);
      rows.Ingredients[0].fields.Company = ['rec0'];
      rows.Products[0].fields.Company = 'Dropped';
      assert.equal((await patch({ type: 'Factory', address: 'x' }, { type: null, address: 'stale' })).status, 409);
      assert.equal(patches.length, 0);
      const change = { name: 'Renamed', address: '', type: 'Factory' };
      const originals = { name: 'Company 0', address: 'Main Street', type: null };
      state.denyConfirm = true;
      const unclear = await patch(change, originals);
      assert.equal(unclear.json.outcome, 'unconfirmed');
      assert.deepEqual(recordCalls.slice(-3), ['GET', 'PATCH', 'GET']);
      assert.deepEqual(patches, [{ Name: 'Renamed', Address: null }]);
      assert.equal(state.scopeChecks, checks + 1);
      assert.equal((await api('admin', 'GET', '/api/factories')).json.companies.some(c => c.name === 'Renamed'), false);
      state.denyConfirm = false;
      assert.equal((await patch(change, originals)).json.saved, true);
      assert.equal(patches.length, 1);
      assert.equal((await api('admin', 'GET', '/api/factories')).json.companies.some(c => c.name === 'Renamed'), true);
      state.permission = true;
      assert.equal((await patch({ address: 'new' }, { address: null })).status, 403);
      assert.equal((await raw()).connection.access, 'readwrite');
      state.writable = false;
      assert.equal((await patch({ address: 'new' }, { address: null })).status, 403);
      assert.equal((await raw()).connection.access, 'read');
      state.writable = true; state.permission = false;
      await api('admin', 'PUT', '/api/sources/connection', { ...same, access: 'readwrite' });
      const fresh = (await api('admin', 'GET', endpoint + '/edit')).json;
      const final = await patch({ name: 'Final', address: 'New Street', type: 'Other' }, fresh.fields, { updatedAt: fresh.updatedAt });
      assert.equal(final.json.saved, true);
      assert.deepEqual(recordCalls.slice(-3), ['GET', 'PATCH', 'GET']);
      assert.deepEqual(rows.Companies[0].fields, { Name: 'Final', Address: 'New Street', Type: 'Other' });
      assert.equal((await api('admin', 'GET', '/api/factories')).json.companies.some(c => c.id === 'rec0'), false);
      return '6 calls per refresh; 5 factories, 46 ingredients and 24 products each; 0 page reads; unchanged backups cost 0 writes';
    } finally { socket?.close(); await new Promise(r => mock.close(r)); }
  },
};
