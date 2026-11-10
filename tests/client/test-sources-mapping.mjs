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
for (const value of ['OU-D', 'OU D', 'OU Dairy', 'OU-DE']) assert.deepEqual(splitCertification(value), { agency: 'OU', dpm: 'dairy', noSymbolNeeded: false });
for (const value of ['Kof-K Parve', 'OK-P', 'Star-K Pareve']) assert.equal(splitCertification(value).dpm, 'pareve');
for (const value of ['Meat', 'Glatt', 'Demo-M']) assert.equal(splitCertification(value).dpm, 'meat');
assert.deepEqual(splitCertification('OU'), { agency: 'OU', noSymbolNeeded: false });
assert.deepEqual(splitCertification(' gRoUp   1 '), { noSymbolNeeded: true });
assert.equal(splitCertification('Custom', ['CUSTOM']).noSymbolNeeded, true);
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
assert.equal(data.ingredients[1].noSymbolNeeded, true);
assert.equal(data.products[0].symbolRequired, false);
for (const settings of [{ kind: 'google_sheets', spreadsheetId: 'demo' }, { kind: 'excel', workbookId: 'demo' }, { kind: 'supabase', url: 'https://example.test' }]) {
  const connector = createConnector({ ...settings, mapping }, 'demo-key');
  assert.deepEqual(await connector.testConnection(), { ok: false, error: 'Not available yet' });
  await assert.rejects(connector.loadAll(), NotAvailableYet);
  await assert.rejects(connector.listCompanies(), NotAvailableYet);
  await assert.rejects(connector.listItems('c1', 'ingredient'), NotAvailableYet);
  assert.equal(connector.calls(), 0);
}
console.log('all source mapping checks passed');
