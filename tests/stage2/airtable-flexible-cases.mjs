import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { shiftFixture } from './test-101-shifts-crud.mjs';

const text = (id, name) => ({ id: 'fld' + id, name, type: 'singleLineText' });
const link = (id, name, linkedTableId, inverseLinkFieldId) => ({
  id: 'fld' + id, name, type: 'multipleRecordLinks', options: { linkedTableId, inverseLinkFieldId },
});
export const pilotBase = 'appFlexiblePilot';
export const pilotKey = 'mock-flexible-pilot';
export const pilotSchema = [
  { id: 'tblFacilities', name: 'Facilities', primaryFieldId: 'fldFacility', fields: [
    text('Facility', 'Facility'), text('Address', 'Street address'), text('Brand', 'Trade name'),
    { id: 'fldPlant', name: 'Plant', type: 'multipleAttachments' },
    link('Inventory', 'Inventory', 'tblItems', 'fldOwners'),
  ] },
  { id: 'tblItems', name: 'Items', primaryFieldId: 'fldDescription', fields: [
    text('Description', 'Description'), text('Vendor', 'Vendor'), text('TextCompany', 'Referenced company'),
    link('Owners', 'Facilities', 'tblFacilities', 'fldInventory'),
    { id: 'fldCategory', name: 'Item category', type: 'singleSelect', options: { choices: [
      { id: 'selIngredient', name: 'Ingredient' }, { id: 'selProduct', name: 'Product' }, { id: 'selPackaging', name: 'Packaging' },
    ] } },
  ] },
];
const field = (fieldId, writable = true, expectedType = 'singleLineText') => ({ fieldId, expectedType, writable });
export const pilotMapping = {
  version: 2,
  entities: [
    { id: 'company', kind: 'company', tableId: 'tblFacilities', fields: {
      name: field('fldFacility', false), address: field('fldAddress'), brand: field('fldBrand'),
      plant: field('fldPlant', true, 'multipleAttachments'),
    } },
    ...['ingredient', 'product'].map(kind => ({
      id: kind, kind, tableId: 'tblItems',
      filter: { fieldId: 'fldCategory', operator: 'equals', values: [kind === 'ingredient' ? 'Ingredient' : 'Product'] },
      fields: { name: field('fldDescription'), brand: field('fldVendor') },
    })),
  ],
  relationships: ['ingredient', 'product'].map(kind => ({
    id: kind, fromEntity: kind, toEntity: 'company', kind: 'reverse-linked-record',
    ownership: 'to', cardinality: 'many-to-many', writable: true, fieldId: 'fldInventory',
  })),
  group1Values: ['Group 1'],
};
export async function mockFlexibleAirtable() {
  const rows = {
    tblFacilities: [
      { id: 'recCedar', fields: { fldFacility: 'Cedar Milling', fldAddress: '18 Mill Road', fldBrand: 'Cedar', fldInventory: ['recOats', 'recCrackers', 'recBox'] } },
      { id: 'recHarbor', fields: { fldFacility: 'Harbor Foods', fldAddress: '4 Harbor Way', fldBrand: 'Harbor', fldInventory: ['recOats', 'recOil'] } },
      { id: 'recBrook', fields: { fldFacility: 'מפעל Brook', fldAddress: '8 Brook Street', fldInventory: ['recJam'] } },
    ],
    tblItems: [
      { id: 'recOats', fields: { fldDescription: 'Rolled oats', fldCategory: 'Ingredient', fldVendor: 'Miller', fldTextCompany: 'Cedar Milling', fldOwners: ['recCedar','recHarbor'] } },
      { id: 'recCrackers', fields: { fldDescription: 'Seed crackers', fldCategory: 'Product', fldVendor: 'Cedar' } },
      { id: 'recOil', fields: { fldDescription: 'Olive oil', fldCategory: 'Ingredient' } },
      { id: 'recJam', fields: { fldDescription: 'Apricot jam', fldCategory: 'Product' } },
      { id: 'recRice', fields: { fldDescription: 'Brown rice flour', fldCategory: 'Ingredient' } },
      { id: 'recBox', fields: { fldDescription: 'Shipping carton', fldCategory: 'Packaging' } },
    ],
  };
  const schema = structuredClone(pilotSchema), patches = [];
  const state = { access: 'edit', scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'], drop: null, reject: null };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const reply = (value, status = 200) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer ' + pilotKey) return reply({}, 401);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v0/meta/whoami') return reply({ scopes: state.scopes });
    if (url.pathname === '/v0/meta/bases') return reply({ bases: [{ id: pilotBase, permissionLevel: state.access }] });
    if (url.pathname === '/v0/meta/bases/' + pilotBase + '/tables') return reply({ tables: schema });
    const [, , base, tableId, id] = url.pathname.split('/');
    const records = rows[tableId], table = schema.find(t => t.id === tableId);
    if (base !== pilotBase || !records || !table) return reply({}, 404);
    const fieldIds = url.searchParams.getAll('fields[]');
    const record = records.find(row => row.id === id);
    if (req.method === 'GET') {
      assert.equal(url.searchParams.get('returnFieldsByFieldId'), 'true');
      if (id) return record ? reply(record) : reply({}, 404);
      return reply({ records: records.map(row => ({ id: row.id, fields: Object.fromEntries(
        Object.entries(row.fields).filter(([field]) => !fieldIds.length || fieldIds.includes(field))) })) });
    }
    if (req.method !== 'PATCH' || !record) return reply({}, 405);
    let payload = '';
    for await (const chunk of req) payload += chunk;
    const { fields } = JSON.parse(payload);
    assert.ok(Object.keys(fields).every(id => table.fields.some(field => field.id === id)), 'writes use physical field IDs');
    patches.push({ table: tableId, id, fields });
    if (state.reject === id) return reply({}, 422);
    Object.assign(record.fields, fields);
    if (state.drop === id) { state.drop = null; return req.socket.destroy(); }
    return reply(record);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { schema, rows, patches, state, url: 'http://127.0.0.1:' + server.address().port, close: () => server.close() };
}

export async function flexibleMappingCases(baseUrl, ctx) {
  const { api, agencyId } = await shiftFixture(baseUrl, ctx, 'flexible');
  const mock = await mockFlexibleAirtable();
  const makeRequest = async (method, path, body, role = 'admin', expected = 200) => {
    const result = await api(role, method, path, body);
    assert.equal(result.status, expected, JSON.stringify(result.json));
    return result.json;
  };
  const call = (method, path, body, expected = 200) => makeRequest(method, path, body, 'admin', expected);
  const config = { sourceType: 'airtable', baseId: pilotBase, access: 'readwrite', apiKey: pilotKey };
  const pilot = (company, row, list = 'ingredients') => `/api/sources/companies/${company}/mapping-items/${list}${row ? '/' + row : ''}`;
  const editor = '/api/sources/rows/companies/recCedar';
  const next = async (path, body) => {
    const { baseId, updatedAt, baseline } = await call('GET', path);
    return { operationId: randomUUID(), baseId, updatedAt, baseline, ...body };
  };
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      const connection = await call('GET', '/api/sources/connection');
      if (connection.status === 'ok') return connection;
      await sleep(80);
    }
    assert.fail('Source never became ready');
  };
  const save = async mapping => { await call('PUT', '/api/sources/connection', { ...config, mapping }); return wait(); };
  try {
    await call('POST', '/api/__test__/sources-api-base', { url: mock.url });
    const discovery = await call('POST', '/api/sources/test', { ...config, discovery: true });
    assert.deepEqual(discovery.tables.map(t => [t.id, t.primaryFieldId]), mock.schema.map(t => [t.id, t.primaryFieldId]));
    assert.deepEqual(discovery.tables.flatMap(t => t.fields), mock.schema.flatMap(t => t.fields));
    const preview = await call('POST', '/api/sources/airtable-mapping/preview', { ...config, mapping: pilotMapping });
    assert.deepEqual(preview.companies[0], { id: 'recCedar', name: 'Cedar Milling', ingredients: ['Rolled oats'], products: ['Seed crackers'] });
    assert.equal(preview.connected.contact, false);
    assert.equal(preview.fields.company.name, 'Read only');
    assert.equal(preview.fields.company.address, 'Ready');
    const plantWarning = preview.issues.find(i => i.entity === 'company' && i.field === 'plant');
    assert.match(plantWarning.message, /wrong type for Plant/);
    assert.equal(plantWarning.blocking, false);
    const overlapping = structuredClone(pilotMapping);
    overlapping.entities[2].filter.values = ['Ingredient'];
    await call('PUT', '/api/sources/connection', { ...config, mapping: overlapping }, 400);
    const wrongTarget = structuredClone(pilotMapping);
    wrongTarget.relationships[0] = { ...wrongTarget.relationships[0], kind: 'linked-record', ownership: 'from', fieldId: 'fldOwners' };
    mock.schema[1].fields.find(f => f.id === 'fldOwners').options.linkedTableId = 'tblItems';
    const mismatch = await call('POST', '/api/sources/airtable-mapping/preview', { ...config, mapping: wrongTarget });
    assert.equal(mismatch.connected.ingredient, false);
    assert.match(mismatch.issues.find(i => i.entity === 'ingredient').message, /points to a different Airtable table/);
    const rejected = await call('PUT', '/api/sources/connection', { ...config, mapping: wrongTarget }, 400);
    assert.match(rejected.error, /points to a different Airtable table/);
    assert.equal(rejected.issues.find(i => i.entity === 'ingredient' && i.field === 'relationship').blocking, true);
    mock.schema[1].fields.find(f => f.id === 'fldOwners').options.linkedTableId = 'tblFacilities';
    const wrongType = structuredClone(wrongTarget);
    wrongType.relationships[0].fieldId = 'fldTextCompany';
    const rejectedType = await call('PUT', '/api/sources/connection', { ...config, mapping: wrongType }, 400);
    assert.equal(rejectedType.issues.find(i => i.entity === 'ingredient' && i.field === 'relationship').blocking, true);
    mock.state.scopes = ['data.records:read', 'schema.bases:read'];
    const readOnly = await call('POST', '/api/sources/airtable-mapping/preview', { ...config, mapping: pilotMapping });
    assert.equal(readOnly.relationships.ingredient, 'Read only');
    mock.state.scopes.push('data.records:write');
    const withoutProductRelationship = { ...pilotMapping, relationships: pilotMapping.relationships.filter(r => r.fromEntity !== 'product') };
    await save(withoutProductRelationship);
    for (const path of ['/api/sources/companies/recCedar/items', '/api/factories/recCedar/items', '/api/visits/factories/recCedar']) {
      const items = await call('GET', path);
      assert.deepEqual(items.connectedLists, { ingredients: true, products: false, contacts: false });
      assert.deepEqual(items.ingredients.map(row => row.name), ['Rolled oats']);
      assert.deepEqual(items.products, []);
    }
    const saved = await save(pilotMapping);
    assert.deepEqual(saved.counts, { companies: 3, ingredients: 3, products: 2 });
    const list = await call('GET', '/api/sources/companies/recCedar/items');
    assert.deepEqual(list.connectedLists, { ingredients: true, products: true, contacts: false });
    assert.deepEqual([list.ingredients.length, list.products.length], [1, 1]);
    const raw = await call('POST', '/api/__test__/source-raw', { agencyId });
    assert.equal(raw.connection.mapping.version, 2);
    assert.equal(raw.connection.mapping.entities[0].tableName, 'Facilities');
    assert.equal(raw.connection.mapping.relationships[0].fieldName, 'Inventory');
    const company = await call('GET', editor + '/edit');
    assert.deepEqual(company.fields, { name: 'Cedar Milling', address: '18 Mill Road', brand: 'Cedar' });
    assert.match(company.warnings[0], /wrong type for Plant/);
    await call('PATCH', editor, { baseId: company.baseId, updatedAt: company.updatedAt, fields: { plant: 'blocked' }, originals: { plant: null } }, 400);
    assert.equal(mock.patches.length, 0);
    await call('PATCH', editor, { baseId: company.baseId, updatedAt: company.updatedAt, fields: { address: '20 Mill Road' }, originals: { address: '18 Mill Road' } });
    assert.deepEqual(mock.patches.at(-1), { table: 'tblFacilities', id: 'recCedar', fields: { fldAddress: '20 Mill Road' } });
    const driftedField = mock.schema[0].fields.find(field => field.id === 'fldBrand');
    driftedField.type = 'multipleAttachments';
    const drifted = await call('GET', editor + '/edit');
    assert.deepEqual(drifted.fields, { name: 'Cedar Milling', address: '20 Mill Road' });
    assert.match(drifted.warnings.join(' '), /wrong type for Brand/);
    await call('PATCH', editor, { baseId: company.baseId, updatedAt: company.updatedAt,
      fields: { brand: 'blocked' }, originals: { brand: 'Cedar' } }, 400);
    assert.equal(mock.patches.length, 1);
    driftedField.type = 'singleLineText';
    const assign = pilot('recCedar', 'recRice') + '/relationship';
    const request = await next(assign, { operation: 'assign' });
    for (const role of ['coord', 'mash', 'foreign']) {
      await makeRequest('POST', assign, request, role, role === 'foreign' ? 409 : 403);
    }
    assert.equal(mock.patches.length, 1);
    const unrelated = mock.rows.tblFacilities[0].fields.fldInventory;
    mock.rows.tblFacilities[0].fields.fldInventory = [...unrelated, 'recOil'];
    assert.match((await call('POST', assign, request, 409)).error, /connection changed in Airtable/);
    assert.equal(mock.patches.length, 1);
    mock.rows.tblFacilities[0].fields.fldInventory = unrelated;
    const fresh = await next(assign, { operation: 'assign' });
    await call('POST', assign, fresh);
    assert.deepEqual(mock.patches.at(-1), { table: 'tblFacilities', id: 'recCedar', fields: { fldInventory: [...unrelated, 'recRice'] } });
    const beforeReplay = mock.patches.length;
    await call('POST', assign, fresh);
    assert.equal(mock.patches.length, beforeReplay);
    const item = pilot('recCedar', 'recOats');
    const details = await call('GET', item + '/edit');
    assert.deepEqual(details.companyIds.sort(), ['recCedar','recHarbor']);
    await call('PATCH', item, { baseId: details.baseId, updatedAt: details.updatedAt, operationId: randomUUID(),
      fields: { brand: 'North Miller' }, originals: { brand: 'Miller' } });
    assert.deepEqual(mock.patches.at(-1), { table: 'tblItems', id: 'recOats', fields: { fldVendor: 'North Miller' } });
    const move = await next(assign, { operation: 'move', destination: 'recHarbor' });
    await call('POST', assign, move);
    assert.deepEqual(mock.rows.tblFacilities[0].fields.fldInventory, unrelated);
    assert.deepEqual(mock.rows.tblFacilities[1].fields.fldInventory, ['recOats', 'recOil', 'recRice']);
    const unlink = pilot('recHarbor', 'recRice') + '/relationship';
    await call('POST', unlink, await next(unlink, { operation: 'unlink' }));
    assert.deepEqual(mock.rows.tblFacilities[1].fields.fldInventory, ['recOats', 'recOil']);
    assert.ok(mock.rows.tblItems.some(item => item.id === 'recRice'));
    mock.state.drop = 'recCedar';
    const lost = await next(assign, { operation: 'assign' });
    assert.match((await call('POST', assign, lost, 409)).error, /may have changed this connection/);
    const afterLoss = mock.patches.length;
    await call('POST', assign, lost, 409);
    assert.equal(mock.patches.length, afterLoss);
    mock.state.reject = 'recHarbor';
    const partial = await next(assign, { operation: 'move', destination: 'recHarbor' });
    assert.match((await call('POST', assign, partial, 409)).error, /only partly completed/);
    const afterPartial = mock.patches.length;
    await call('POST', assign, partial, 409);
    assert.equal(mock.patches.length, afterPartial);
    mock.state.reject = null;
    assert.deepEqual(mock.rows.tblFacilities[0].fields.fldInventory, unrelated);
    const direct = structuredClone(pilotMapping);
    direct.relationships[0] = { ...direct.relationships[0], kind: 'linked-record', ownership: 'from', fieldId: 'fldOwners' };
    await save(direct);
    const forward = pilot('recBrook', 'recOats') + '/relationship';
    await call('POST', forward, await next(forward, { operation: 'assign' }));
    assert.deepEqual(mock.patches.at(-1), { table: 'tblItems', id: 'recOats', fields: { fldOwners: ['recCedar','recHarbor','recBrook'] } });
    const ambiguous = structuredClone(pilotMapping);
    ambiguous.relationships[0] = { ...ambiguous.relationships[0], kind: 'text-reference', ownership: 'from', fieldId: 'fldTextCompany', writable: false };
    mock.rows.tblFacilities[2].fields.fldFacility = 'Cedar Milling';
    const check = await call('POST', '/api/sources/airtable-mapping/preview', { ...config, mapping: ambiguous });
    assert.match(check.issues.find(i => i.entity === 'ingredient').message, /More than one company matches/);
    await save(ambiguous);
    const count = mock.patches.length;
    assert.match((await call('GET', item + '/edit', undefined, 409)).error, /More than one company matches/);
    await call('POST', item + '/relationship', { ...lost, operation: 'assign' }, 409);
    assert.equal(mock.patches.length, count);
    return 'Flexible pilot verified with ID-keyed mock records, forward and reverse links, authorization, and uncertain-write reconciliation';
  } finally { mock.close(); }
}
