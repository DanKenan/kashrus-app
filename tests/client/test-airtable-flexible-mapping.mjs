import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FlexibleAirtableWizard } from '../../src/components/SourceConnectSheet.tsx';
import { CompanyItemLists, RelationshipEditor } from '../../src/components/CompanyItemLists.tsx';
import { pilotMapping, pilotSchema } from '../stage2/airtable-flexible-cases.mjs';

const original = globalThis.fetch;
const calls = [];
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
const select = async (form, current, value, index = 0) => {
  const field = form.find(element => element.type === 'select' && element.props.value === current)[index];
  assert.ok(field, 'select control exists');
  field.props.onChange({ target: { value } });
  await form.render();
};
const button = (form, title) => form.buttons().find(candidate => candidate.label === title)?.el;
const connection = { sourceType: 'airtable', baseId: 'appSample', hasKey: true, mapping: pilotMapping };
const path = '/api/sources/companies/recCedar/mapping-items/ingredients';
const wrong = 'This Airtable field has the wrong type for Plant. Choose a different field.';
let blocking = true;
let stale = true;
let saved = 0;
try {
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method, options.body && JSON.parse(options.body)]);
    if (url.endsWith('/test')) return reply({ ok: true, access: 'readwrite', tables: pilotSchema });
    if (url.endsWith('/preview')) return reply({
      connected: { company: true, ingredient: true, product: true, contact: false },
      issues: [{ entity: 'company', field: 'plant', message: wrong, blocking }], fields: { company: { name: 'Read only', address: 'Ready' } },
      relationships: { ingredient: 'Ready', product: 'Read only' },
      companies: [{ id: 'recCedar', name: 'Cedar Milling', ingredients: ['Rolled oats'], products: ['Seed crackers'] }],
    });
    if (url.endsWith('/connection')) return reply({ ok: true });
    if (url.endsWith('/items')) return reply({ sourceType:'airtable', access:'readwrite', status:'ok', flexibleMapping:true,
      connectedLists:{ingredients:false,products:true,contacts:false}, mappingWrites:{products:true}, ingredients:[], products:[] });
    if (url === path) return reply({ writable:true, items:[{ id:'recRice', name:'Brown rice flour' }], companies:[] });
    if (options.method === 'POST') return stale
      ? reply({error:'This connection changed in Airtable. Reload and review before saving.'}, 409)
      : reply({saved:true});
    return reply({ companyIds:[], baseline:'fresh-baseline', baseId:'appSample', updatedAt:'now' });
  };
  const wizard = mount(FlexibleAirtableWizard, { connection, onSaved() {saved++;}, onClose() {} });
  await wizard.render();
  assert.match(wizard.text(), /Shutfey will read your table names and field types\. Nothing will be changed in Airtable\./);
  await wizard.click('Find your Airtable tables');
  assert.match(wizard.text(), /Contacts are not connected for this agency\./);
  assert.match(wizard.text(), /Ingredients and products can come from the same table if a field identifies each type\./);
  await wizard.click('Continue');
  assert.match(wizard.text(), /Which table stores the connection\?/);
  assert.match(wizard.text(), /Can one item belong to more than one company\?/);
  await wizard.click('Continue');
  assert.match(wizard.text(), /Review your connection/);
  assert.ok(wizard.text().includes(wrong));
  assert.match(wizard.text(), /Cedar Milling.*Rolled oats.*Seed crackers/);
  assert.equal(button(wizard, 'Save connection').props.disabled, true);
  blocking = false;
  await wizard.click('Test mapping');
  assert.equal(button(wizard, 'Save connection').props.disabled, false);
  await wizard.click('Save connection');
  assert.match(wizard.text(), /Airtable connection saved\./);
  assert.equal(calls.at(-1)[2].mapping.version, 2);

  for (const role of ['admin','coordinator','mashgiach']) {
    const lists = mount(CompanyItemLists, { companyId:'recCedar', role, revision:0, onSaved() {} });
    await lists.render();
    assert.match(lists.text(), /Ingredients are not connected for this agency\./);
    assert.doesNotMatch(lists.text(), /No ingredients listed/);
    assert.equal(!!button(lists, 'Assign to company'), role === 'admin');
  }
  const relationship = mount(RelationshipEditor, { path, companyId:'recCedar', operation:'assign', onSaved() {saved++;}, onClose() {} });
  await relationship.render();
  assert.equal(button(relationship, 'Assign to company').props.disabled, true);
  await select(relationship, '', 'recRice');
  assert.equal(button(relationship, 'Assign to company').props.disabled, false);
  await relationship.click('Assign to company');
  assert.equal(calls.at(-1)[2].baseline, 'fresh-baseline');
  assert.match(relationship.text(), /This connection changed in Airtable\. Reload and review before saving\./);
  assert.equal(button(relationship, 'Assign to company').props.disabled, true);
  const token = calls.at(-1)[2].operationId;
  await relationship.click('Reload and review');
  stale = false;
  await relationship.click('Assign to company');
  assert.equal(calls.at(-1)[2].operation, 'assign');
  assert.notEqual(calls.at(-1)[2].operationId, token);
  assert.equal(saved, 2);
} finally { globalThis.fetch = original; }
console.log('Flexible Airtable wizard, optional lists, role gates, stale review and assignment passed.');
