import assert from 'node:assert/strict';
import http from 'node:http';
import { shiftFixture } from './test-101-shifts-crud.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export default {
  name: 'Test 115: source server wiring',
  whatItProves: 'Encrypted keys, paginated bulk refresh, memory-only reads, unchanged backups, throttling and agency/admin isolation.',
  async run(baseUrl, ctx) {
    const { api, agencyId, tokens } = await shiftFixture(baseUrl, ctx, '115');
    const key = 'fake-source-test115-key';
    const mapping = { companies: { table: 'Companies', name: 'Name', type: 'Type', factoryValues: ['Factory'] }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, noSymbolValues: ['Group 1'] };
    const rows = {
      Companies: Array.from({ length: 7 }, (_, i) => ({ id: `rec${i}`, fields: { Name: `Company ${i}`, Type: i < 5 ? 'Factory' : 'Other' } })),
      Ingredients: Array.from({ length: 230 }, (_, i) => ({ id: `ing${i}`, fields: { Name: `Ingredient ${i}`, Company: [`rec${i % 5}`] } })),
      Products: Array.from({ length: 120 }, (_, i) => ({ id: `prod${i}`, fields: { Name: `Product ${i}`, Company: [`rec${i % 5}`] } })),
    };
    let calls = 0, socket;
    const mock = http.createServer((req, res) => {
      calls++; res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end('{}'); }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/v0/meta/whoami') return res.end(JSON.stringify({ scopes: ['data.records:read'] }));
      if (url.pathname.endsWith('/tables')) return res.end(JSON.stringify({ tables: Object.entries(rows).map(([name, records]) => ({ name, fields: Object.keys(records[0].fields).map(name => ({ name })) })) }));
      const sample = url.searchParams.get('maxRecords') === '3';
      const table = decodeURIComponent(url.pathname.split('/').pop()), start = Number(url.searchParams.get('offset') || 0), records = rows[table];
      if (!records) { res.writeHead(404); return res.end('{}'); }
      res.end(JSON.stringify({ records: records.slice(start, start + (sample ? 3 : 100)), ...(!sample && start + 100 < records.length ? { offset: String(start + 100) } : {}) }));
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
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
      calls = 0;
      assert.equal((await api('admin', 'PUT', '/api/sources/connection', body)).status, 200);
      let stored;
      for (let i = 0; i < 100; i++) { stored = await raw(); if (stored.backupIds.length === 5) break; await sleep(100); }
      assert.equal(stored.backupIds.length, 5);
      const afterFirstWrites = (await ctx.api('POST', '/api/__test__/writes', {})).json;
      assert.equal((afterFirstWrites.byCollection.sourceBackups || 0) - (firstWrites.byCollection.sourceBackups || 0), 5);
      assert.equal((afterFirstWrites.byCollection.sourceConnections || 0) - (firstWrites.byCollection.sourceConnections || 0), 2);
      assert.equal(calls, 6); // Companies: 1; ingredients: 3; products: 2.
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
      calls = 0;
      const { apiKey, ...same } = body;
      assert.equal((await api('admin', 'PUT', '/api/sources/connection', same)).status, 200);
      for (let i = 0; i < 100 && calls < 6; i++) await sleep(100);
      await sleep(200);
      assert.equal(calls, 6);
      assert.equal(((await ctx.api('POST', '/api/__test__/writes', {})).json.byCollection.sourceConnections || 0) - connectionWrites, (await raw()).connection.lastRefresh.at.slice(0, 10) === beforeRefreshDay ? 1 : 2);
      assert.equal((await ctx.api('POST', '/api/__test__/writes', {})).json.byCollection.sourceBackups || 0, beforeWrites);
      return '6 calls per refresh; 5 factories, 46 ingredients and 24 products each; 0 page reads; unchanged backups cost 0 writes';
    } finally { socket?.close(); await new Promise(r => mock.close(r)); }
  },
};
