import assert from 'node:assert/strict';
import { guessMapping, applyMapping, parseMoney } from '../../src/server/sources/mapping.ts';
import { createUploadConnector } from '../../src/server/sources/upload.ts';
const columns = ['Name', 'Street Address', 'Yearly Fee', 'Visit Fee'];
const { mapping } = guessMapping([{ name: 'Companies', columns }]);
assert.equal(mapping.companies.address, 'Street Address');
assert.equal(mapping.companies.companyFee, 'Yearly Fee');
assert.equal(mapping.companies.mashgiachFee, 'Visit Fee');
for (const [s, n] of [['$1,200.50', 1200.5], ['1200', 1200], ['0', 0]])
    assert.equal(parseMoney(s), n);
for (const s of ['12,00', '$x', '1.234', '-5', 'Infinity', '', null])
    assert.equal(parseMoney(s), undefined);
const m = { ...mapping, ingredients: { table: '' }, products: { table: '' } };
const data = applyMapping({ Companies: [{ id: 'r2', fields: { Name: 'Golden Grain Bakery', 'Street Address': '100 Demo Street', 'Yearly Fee': '$1,200.50', 'Visit Fee': 80 } }] }, m);
assert.equal(data.companies[0].companyFee, 1200.5);
assert.equal(data.companies[0].mashgiachFee, 80);
assert.equal(data.companies[0].address, '100 Demo Street');
assert.deepEqual(data.ingredients, []);
const files = [{ id: 'main', name: 'Demo companies', tabs: [{ name: 'List', columns: ['Name'], rows: [{ id: 'r2', fields: { Name: 'Demo Bakery' } }] }] }, { id: 'separate', name: 'Demo ingredients', tabs: [{ name: 'List', columns: ['Name', 'Company'], rows: [{ id: 'r2', fields: { Name: 'Demo Flour', Company: 'Demo Bakery' } }] }] }];
const adapter = createUploadConnector({ files, mapping: { companies: { table: 'List', name: 'Name', file: { id: 'main', name: 'Demo companies' } }, ingredients: { table: 'List', name: 'Name', companyLink: 'Company', file: { id: 'separate', name: 'Demo ingredients' } }, products: { table: '' }, group1Values: [] } });
const mapped = await adapter.loadAll();
assert.equal(mapped.companies[0].name, 'Demo Bakery');
assert.equal(mapped.ingredients[0].name, 'Demo Flour');
assert.deepEqual(mapped.ingredients[0].companyIds, ['r2']);
console.log('general mapping, money, unused lists and per-list files passed');
