import assert from 'node:assert/strict';
import { guessMapping, splitCertification, parseDpm, applyMapping } from '../../src/server/sources/mapping.ts';
import { createConnector, NotAvailableYet } from '../../src/server/sources/stubs.ts';
const schemas = [
  [{ name: 'Companies', columns: ['Name', 'Type', 'Brand', 'Plant'] }, { name: 'Ingredients', columns: ['Company', 'Name', 'Certification', 'Certifying Agency', 'DPM', 'Expiration'] }, { name: 'Products', columns: ['Company', 'Product Name', 'UPC', 'Symbol Required'] }],
  [{ name: '  FACTORIES ', columns: [' NAME ', 'category', 'brand_name', 'SITE'] }, { name: 'Schedule_A', columns: ['establishments', 'ingredient', 'kosher-certification', 'kosher_status', 'exp.date'] }, { name: 'Product-List', columns: ['CLIENT', 'ITEM', 'code_case', 'symbol_required'] }],
];
for (const tables of schemas) {
  const { mapping, guessed } = guessMapping(tables);
  for (const kind of ['companies', 'ingredients', 'products']) {
    assert.equal(mapping[kind].table, tables[['companies', 'ingredients', 'products'].indexOf(kind)].name);
    const columns = Object.entries(mapping[kind]).filter(([k]) => k !== 'table').map(([, v]) => v);
    assert.equal(new Set(columns).size, columns.length);
    assert.ok(mapping[kind].name);
  }
  assert.ok(Object.values(guessed).every(v => v >= 0 && v <= 1));
}
assert.deepEqual(guessMapping([]).mapping.companies, {});
const single = guessMapping([{ name: 'Ingredients', columns: ['Certifying Agency'] }]).mapping.ingredients;
assert.equal(single.certification, 'Certifying Agency');
assert.equal(single.agency, undefined);
for (const value of ['OU-D', 'OU D', 'OU Dairy']) assert.deepEqual(splitCertification(value), { agency: 'OU', dpm: 'dairy', group1: false });
for (const value of ['Kof-K Parve', 'OK-P', 'Star-K Pareve']) assert.equal(splitCertification(value).dpm, 'pareve');
for (const value of ['Meat', 'Glatt', 'Demo-M']) assert.equal(splitCertification(value).dpm, 'meat');
assert.deepEqual(splitCertification('OU'), { agency: 'OU', group1: false });
assert.deepEqual(splitCertification(' gRoUp   1 '), { group1: true });
assert.equal(splitCertification('Custom', ['CUSTOM']).group1, true);
assert.equal(parseDpm('Parve | Pas Yisroel'), 'pareve');
const mapping = guessMapping(schemas[0]).mapping;
mapping.companies.factoryValues = [' factory '];
const row = (id, fields) => ({ id, fields });
const data = applyMapping({
  Companies: [row('c1', { Name: 'Demo Flour', Type: 'FACTORY', Notes: 'text', Count: 7, Files: [{ url: 'https://example.test' }] }), row('c2', { Name: 'Demo Shop', Type: 'shop' })],
  Ingredients: [row('i1', { Company: ['c1', 'c2'], Name: 'Flour', Certification: 'OU-D', 'Certifying Agency': 'Demo Seal', DPM: 'Parve | Pas Yisroel', Notes: 'dry' }), row('i2', { Company: ' demo flour , c1', Name: 'Salt', Certification: 'Group 1' })],
  Products: [row('p1', { Company: 'Demo Flour', 'Product Name': 'Bread', UPC: '001', 'Symbol Required': false })],
}, mapping);
assert.equal(data.companies.length, 1);
assert.deepEqual(data.companies[0].extra, { Notes: 'text' });
assert.deepEqual(data.ingredients.map(i => i.companyIds), [['c1'], ['c1']]);
assert.equal(data.ingredients[0].certifyingAgency, 'Demo Seal');
assert.equal(data.ingredients[0].dpm, 'pareve');
assert.deepEqual(data.ingredients[0].extra, { Notes: 'dry' });
assert.equal(data.ingredients[1].group1, true);
assert.equal(data.products[0].symbolRequired, false);
// Numeric mapped and custom fields survive as strings instead of being dropped.
const numericMapping = { companies: { table: 'Companies', name: 'Name' }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company', expiresOn: 'Expiry', Batch: 'Batch' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: ['Group 1'] };
const numeric = applyMapping({
  Companies: [row('c1', { Name: 'Acme' })],
  Ingredients: [row('i1', { Company: 'c1', Name: 'Salt', Expiry: 2027, Batch: 42, Notes: 'dry' })],
  Products: [],
}, numericMapping);
assert.equal(numeric.ingredients[0].expiresOn, '2027', 'a numeric expiry date survives');
assert.deepEqual(numeric.ingredients[0].extra, { Batch: '42', Notes: 'dry' }, 'a numeric custom field survives alongside text extras');
for (const settings of [{ kind: 'google_sheets', spreadsheetId: 'demo' }, { kind: 'excel', workbookId: 'demo' }, { kind: 'supabase', url: 'https://example.test' }]) {
  const connector = createConnector({ ...settings, mapping }, 'demo-key');
  assert.deepEqual(await connector.testConnection(), { ok: false, error: 'Not available yet' });
  await assert.rejects(connector.loadAll(), NotAvailableYet);
  await assert.rejects(connector.listCompanies(), NotAvailableYet);
  await assert.rejects(connector.listItems('c1', 'ingredient'), NotAvailableYet);
  assert.equal(connector.calls(), 0);
}
console.log('all source mapping checks passed');

const loose = guessMapping([
  { name: 'Est. 2024', columns: ['Name', 'Manufacturer', 'Supplier', 'Mfr'] },
  { name: 'Ingredient List 2024', columns: ['Ingr. name', 'Certification', 'Cert agency', 'Exp. date', 'Brand Name'] },
]);
assert.equal(loose.mapping.companies.table, 'Est. 2024');
assert.equal(loose.mapping.companies.brand, undefined);
assert.equal(loose.mapping.ingredients.table, 'Ingredient List 2024');
assert.equal(loose.guessed['ingredients.table'], 0.6);
assert.equal(loose.mapping.ingredients.name, 'Ingr. name');
assert.equal(loose.mapping.ingredients.certification, 'Certification');
assert.equal(loose.mapping.ingredients.agency, 'Cert agency');
assert.equal(loose.mapping.ingredients.expiresOn, 'Exp. date');
assert.equal(loose.mapping.ingredients.brand, 'Brand Name');
assert.equal(loose.guessed['ingredients.brand'], 0.9);

assert.deepEqual(splitCertification('OU-DE'), { agency: 'OU', dpm: 'dairy_equipment', group1: false });

const shared = {Companies:['a','b'].map(id => ({id,sourceKey:'raw-'+id,fields:{Name:'Same',Type:'Factory'}})),
  Ingredients:[row('item',{Company:' sAME '})]};
assert.throws(()=>applyMapping(shared,mapping),/Multiple companies match.*unique ID/);
shared.Ingredients[0].fields.Company = 'raw-b';
assert.deepEqual(applyMapping(shared,mapping).ingredients[0].companyIds,['b']);

const commaName = 'Golden Grain, Inc.';
const commaRows = {
  Companies: [row('short',{Name:'Golden Grain',Type:'Factory'}),row('full',{Name:commaName,Type:'Factory'})],
  Ingredients: [row('flour',{Company:commaName}),row('salt',{Company:'full, short'})],
};
assert.deepEqual(applyMapping(commaRows,mapping).ingredients.map(i => i.companyIds), [['full'],['full','short']]);
commaRows.Companies.push(row('another',{Name:commaName,Type:'Factory'}));
assert.throws(()=>applyMapping(commaRows,mapping),/Multiple companies match "Golden Grain, Inc\."/);
commaRows.Companies[0].sourceKey = commaName;
assert.deepEqual(applyMapping(commaRows,mapping).ingredients[0].companyIds,['short']);

const filteredRows = {
  Companies: [
    { id: 'c1', sourceKey: 'full', fields: { Name: 'Demo Factory', Type: 'Factory' } },
    { id: 'c2', sourceKey: 'supply', fields: { Name: 'Demo Vendor', Type: 'Vendor' } },
  ],
  Ingredients: [row('flour', { Company: 'full, supply' })],
  Products: [row('loaf', { Company: 'Demo Vendor, Demo Factory' })],
};
const filtered = applyMapping(filteredRows, mapping);
assert.deepEqual(filtered.companies.map(c => c.id), ['c1']);
assert.deepEqual(filtered.ingredients[0].companyIds, ['c1']);
assert.deepEqual(filtered.products[0].companyIds, ['c1']);
filteredRows.Ingredients[0].fields.Company = 'supply';
assert.deepEqual(applyMapping(filteredRows, mapping).ingredients[0].companyIds, []);
for (const missing of ['unknown', ['full', 'unknown']]) {
  filteredRows.Ingredients[0].fields.Company = missing;
  assert.throws(() => applyMapping(filteredRows, mapping), /Unknown company link/);
}
filteredRows.Ingredients[0].fields.Company = 'full, unknown';
assert.throws(() => applyMapping(filteredRows, mapping), /Cannot uniquely resolve/);
filteredRows.Companies[1].fields.Name = 'Demo Factory';
filteredRows.Ingredients[0].fields.Company = 'Demo Factory';
assert.throws(() => applyMapping(filteredRows, mapping), /Multiple companies match/);
