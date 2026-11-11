import assert from 'node:assert/strict';
import { assign, parseDpm, splitCertification, previewRows } from '../../src/lib/sourcePreview.ts';
import { assign as serverAssign, parseDpm as serverDpm, splitCertification as serverSplit, applyMapping } from '../../src/server/sources/mapping.ts';
const values = ['OU-D', 'OU-P', 'OK-M', 'Star-K', 'cRc Dairy', 'OU DE', 'Group 1', 'group1', '', ' ', 'OU', 'Dairy', 'pareve', 'parve', 'meat', 'glatt', 'M', 'D', 'P', 'OU - Dairy', 'OK parve', 'STAR-K Meat', 'unknown', 'Group 2', 'ou-d', 'Dairy Equipment', 'OU-DE', 'Kof-K Parve', 'DE', 'Cholov Yisroel', 'CY', 'Inherently kosher', ' dairy_equipment ', 'O.U.-D', 'Cholov.Yisroel', 'D.E.', 'Dairy Eq', 'Dairy Eq.'];
for (const value of values) {
  assert.deepEqual(assign(value), serverAssign(value), value);
  assert.deepEqual(parseDpm(value), serverDpm(value), value);
  for (const list of [undefined, [], ['Group 1', 'Group 2']]) assert.deepEqual(splitCertification(value, list), serverSplit(value, list), value);
}
console.log('source preview parity: OK');

for (const value of ['Group 1', 'Inherently kosher', '  INHERENTLY  KOSHER  ', 'OU-D', '']) {
  const mapping = { companies: { table: 'C', name: 'Name' }, ingredients: { table: 'I', name: 'Name', companyLink: 'Company', certification: 'Cert', status: 'Status' }, products: { table: 'P', name: 'Name', companyLink: 'Company', status: 'Status' }, group1Values: ['Inherently kosher'] };
  for (const field of ['Cert', 'Status']) {
    const fields = { Name: 'Salt', Company: 'c', [field]: value };
    const data = applyMapping({ C: [{ id: 'c', fields: { Name: 'Factory' } }], I: [{ id: 'i', fields }], P: [{ id: 'p', fields }] }, mapping);
    assert.equal(previewRows({ I: [{ id: 'i', fields }] }, mapping, 'ingredients', 'Custom').rows[0][4], data.ingredients[0].group1 ? 'Yes' : '—');
    assert.equal(previewRows({ P: [{ id: 'p', fields }] }, mapping, 'products', 'Custom').rows[0][6], data.products[0].group1 ? 'Yes' : '—');
  }
}

for (const value of ['Dairy Equipment', 'DE', 'D.E.', 'Dairy Eq', 'Dairy Eq.', 'OU-DE']) {
  assert.equal(assign(value).dpm, 'dairy_equipment', value);
  assert.equal(serverAssign(value).dpm, 'dairy_equipment', value);
}
for (const value of ['Dairy', 'D', 'OU-D']) assert.equal(assign(value).dpm, 'dairy', value);
assert.equal(assign('OU-DE').agency, 'OU');
