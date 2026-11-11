import assert from 'node:assert/strict';
import { applyMapping, assign } from '../../src/server/sources/mapping.ts';
import { previewRows } from '../../src/lib/sourcePreview.ts';
import { createSourceCache } from '../../src/server/sources/cache.ts';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
const mapping = { companies: { table: 'C', name: 'Name' }, ingredients: { table: 'I', name: 'Name', companyLink: 'Company', certification: 'Cert', status: 'Status', agency: 'Agency' }, products: { table: 'P', name: 'Name', companyLink: 'Company', certification: 'Cert', status: 'Status', agency: 'Agency' }, group1Values: ['Group 1'], valueAssignments: { Cert: { 'Kof-K Parve': { dpm: 'dairy' } } } };
const fields = { Name: 'Milk', Company: 'c', Cert: 'OU-D', Status: 'Dairy Equipment', Agency: 'OU' };
const rows = { C: [{ id: 'c', fields: { Name: 'Factory' } }], I: [{ id: 'i', fields }, { id: 'override', fields: { ...fields, Cert: 'Kof-K Parve', Status: '' } }], P: [{ id: 'p', fields }] };
for (const value of ['Dairy Equipment', 'OU-D', 'OU-DE', 'CY', 'Cholov Yisroel']) assert.equal(assign(value).dpm, 'dairy');
let down = false;
const connector = { calls: () => 0, loadAll: async () => { if (down) throw Error('offline'); return applyMapping(rows, mapping); } };
const cache = createSourceCache({ connectorFor: () => connector, backups: { load: async () => [] } });
const first = await cache.refresh('a');
for (const item of [cache.data('a').ingredients[0], cache.data('a').products[0]]) {
  assert.equal(item.certificationRaw, 'OU-D'); assert.equal(item.statusRaw, 'Dairy Equipment'); assert.equal(item.agencyRaw, 'OU'); assert.equal(item.dpm, 'dairy');
}
assert.equal(cache.data('a').ingredients[1].dpm, 'dairy');
await cache.refresh('a'); assert.equal(cache.data('a').ingredients[1].dpm, 'dairy');
down = true;
const restored = createSourceCache({ connectorFor: () => connector, backups: { load: async () => JSON.parse(JSON.stringify(first.changedBackups)) } });
await restored.refresh('a');
for (const kind of ['ingredient', 'product']) {
  const item = restored.state('a').itemsFor('c', kind)[0];
  assert.equal(item.certificationRaw, 'OU-D'); assert.equal(item.statusRaw, 'Dairy Equipment');
}
assert.equal(restored.state('a').itemsFor('c', 'ingredient')[1].dpm, 'dairy');
cache.reassign('a', { ...mapping, valueAssignments: { Cert: { 'OU-D': { dpm: 'meat', group1: true } }, Status: { 'Dairy Equipment': { dpm: 'pareve' } } } });
assert.equal(cache.data('a').ingredients[0].dpm, 'pareve'); assert.equal(cache.data('a').ingredients[0].group1, true);
const preview = previewRows({ I: rows.I }, mapping, 'ingredients');
assert.ok(preview.rows[0].includes('OU-D')); assert.ok(preview.rows[0].includes('Dairy Equipment'));
assert.ok(preview.chips[0].flat().includes('Dairy')); assert.ok(preview.chips[0].flat().includes('Agency: OU'));
// The values handler must not touch storage, and must use the authenticated agency.
const handlers = new Map(); let reads = 0, admin = true;
registerSourceRoutes(Object.fromEntries(['get', 'put', 'post'].map(method => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)])), { db: () => { reads++; throw Error('storage forbidden'); }, dataDir: '/unused', staged: () => true, secret: () => '', testMode: false, requireAdmin: (_req, res) => admin ? { agencyId: 'own', id: 'admin' } : (res.status(403).json({ error: 'Forbidden' }), null), timeZone: () => 'UTC' });
let result, status;
const response = { json: value => { result = value; }, status: value => { status = value; return response; } };
await handlers.get('get /api/sources/values')({ query: { agencyId: 'other' } }, response);
assert.deepEqual(result.values, []); assert.equal(reads, 0);
admin = false; await handlers.get('get /api/sources/values')({ query: {} }, response); assert.equal(status, 403); assert.equal(reads, 0);
console.log('source values: raw text, overrides, backup, preview and memory-only authorization passed');
