import assert from 'node:assert/strict';
import http from 'node:http';
import { createAirtableConnector } from '../../src/server/sources/airtable.ts';
const mapping = { companies: { table: 'Companies', name: 'Name', type: 'Type', factoryValues: ['Factory'] }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company', certification: 'Certification' }, products: { table: 'Products', name: 'Name', companyLink: 'Company', code: 'Code' }, group1Values: ['Group 1'] };
const row = (id, fields) => ({ id, fields });
const tables = {
  Notes: [row('n', { Name: 'Notes' })],
  Contacts: [row('x', { Name: 'Contacts' })],
  Companies: Array.from({ length: 7 }, (_, i) => row(`c${i}`, { Name: `Demo ${i}`, Type: i < 5 ? 'Factory' : 'Shop' })),
  Ingredients: Array.from({ length: 230 }, (_, i) => row(`i${i}`, { Name: `Demo ingredient ${i}`, Company: [`c${i % 5}`], Certification: 'Group 1' })),
  Products: Array.from({ length: 120 }, (_, i) => row(`p${i}`, { Name: `Demo product ${i}`, Company: [`c${i % 5}`], Code: `${i}` })),
};
let mode = 'ok', writes = false, requests = [], retry = 0;
const fakeKey = 'demo-key-never-expose';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push({ path: url.pathname, at: Date.now() });
  assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, `Bearer ${fakeKey}`);
  res.setHeader('Content-Type', 'application/json');
  if (mode === '401' || mode === '403' || mode === '404') { res.statusCode = Number(mode); return res.end(JSON.stringify({ error: fakeKey })); }
  if (mode === '429' && retry++ < 1 || mode === 'always429') { res.statusCode = 429; res.setHeader('Retry-After', '0'); return res.end('{}'); }
  if (url.pathname === '/v0/meta/whoami') return res.end(JSON.stringify({ scopes: writes ? ['data.records:read', 'data.records:write'] : ['data.records:read'] }));
  if (url.pathname === '/v0/meta/bases/demo/tables') return res.end(JSON.stringify({ tables: Object.entries(tables).map(([name, rows]) => ({ name, fields: Object.keys(rows[0].fields).map(name => ({ name })) })) }));
  const name = decodeURIComponent(url.pathname.split('/').at(-1));
  if (url.searchParams.has('maxRecords')) {
    assert.equal(url.searchParams.get('maxRecords'), '3');
    assert.equal(url.searchParams.get('cellFormat'), 'string');
    assert.equal(url.searchParams.get('timeZone'), 'UTC');
    assert.equal(url.searchParams.get('userLocale'), 'en-us');
    return res.end(JSON.stringify({ records: tables[name].slice(0, 3).map(r => ({ ...r, fields: { ...r.fields, Company: ' Demo Factory ', Long: 'x'.repeat(250) } })) }));
  }
  assert.equal(url.searchParams.get('pageSize'), '100');
  const config = Object.values(mapping).find(v => v.table === name);
  const fields = Object.entries(config).filter(([k, v]) => k !== 'table' && typeof v === 'string').map(([, v]) => v);
  assert.deepEqual(url.searchParams.getAll('fields[]').sort(), fields.sort());
  const offset = Number(url.searchParams.get('offset') || 0);
  res.end(JSON.stringify({ records: tables[name].slice(offset, offset + 100), ...(offset + 100 < tables[name].length ? { offset: String(offset + 100) } : {}) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = { baseId: 'demo', apiKey: fakeKey, mapping, apiBase: `http://127.0.0.1:${server.address().port}` };
try {
  const connector = createAirtableConnector(config);
  const data = await connector.loadAll();
  assert.equal(data.companies.length, 5); assert.equal(data.ingredients.length, 230); assert.equal(data.products.length, 120);
  assert.equal(connector.calls(), 6); console.log('Mock Airtable whole-base call count: 6 (1 company page + 3 ingredient pages + 2 product pages)');
  const starts = requests.map(r => r.at);
  for (let i = 5; i < starts.length; i++) assert.ok(starts[i] - starts[i - 5] >= 1000);
  for (const c of await connector.listCompanies()) { assert.equal((await connector.listItems(c.id, 'ingredient')).length, 46); assert.equal((await connector.listItems(c.id, 'product')).length, 24); }
  assert.equal(connector.calls(), 6);
  let result = await connector.testConnection(); assert.equal(result.access, 'read'); assert.equal(result.tables.length, 5);
  const beforeSamples = connector.calls();
  const samples = await connector.samples(result.tables);
  assert.equal(connector.calls() - beforeSamples, 5);
  assert.equal(samples.Ingredients.length, 3);
  console.log('Mock Test connection on 5 tables: 7 calls (2 metadata + 5 sample requests)');
  assert.equal(samples.Ingredients[0].fields.Company, 'Demo Factory');
  assert.equal(samples.Ingredients[0].fields.Long.length, 200);
  writes = true; result = await connector.testConnection(); assert.equal(result.access, 'readwrite');
  for (const status of ['401', '403', '404']) {
    mode = status; const failed = createAirtableConnector(config);
    const result = await failed.testConnection(); assert.equal(result.ok, false); assert.ok(result.error.includes(status)); assert.ok(!result.error.includes(fakeKey)); assert.equal(failed.calls(), 1);
  }
  mode = '429'; retry = 0; const limited = createAirtableConnector(config); assert.equal((await limited.testConnection()).ok, true); assert.equal(limited.calls(), 3);
  mode = 'always429'; const failed = createAirtableConnector(config); assert.equal((await failed.testConnection()).ok, false); assert.equal(failed.calls(), 2);
  const unsafeFetch = createAirtableConnector({ ...config, fetchImpl: async () => { throw new Error(fakeKey); } });
  await assert.rejects(unsafeFetch.loadAll(), e => !e.message.includes(fakeKey));
  console.log('all source Airtable checks passed');
} finally { await new Promise(resolve => server.close(resolve)); }
