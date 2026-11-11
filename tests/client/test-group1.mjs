import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mount } from './lib/mini-render.mjs';
import { CompanyItemsSheet, FactoriesScreen } from '../../src/components/FactoriesScreen.tsx';
import { SourceConnectForm } from '../../src/components/SourceConnectSheet.tsx';
import { previewRows } from '../../src/lib/sourcePreview.ts';
import { emptyMapping } from '../../src/lib/sources.ts';
const originalFetch = globalThis.fetch, originalDocument = globalThis.document;
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
try {
  const mapping = emptyMapping(); mapping.ingredients = { table: 'Ingredients', name: 'Name', companyLink: 'Company', certification: 'Cert', status: 'Status' }; mapping.group1Values = ['Inherently kosher'];
  const samples = { Ingredients: [{ id: 'i', fields: { Name: 'Salt', Cert: 'Group 1', Status: ' INHERENTLY KOSHER ' } }] };
  const preview = previewRows(samples, mapping, 'ingredients', 'Basic ingredients');
  assert.equal(preview.header[3], 'Basic ingredients'); assert.equal(preview.rows[0][3], 'Yes');
  const calls = [];
  let release;
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET', options.body && JSON.parse(options.body)]);
    if (url === '/api/sources/test') return Response.json({ ok: true, samples, tables: [], guess: { mapping } });
    if (options.method === 'PUT') return new Promise(resolve => { release = () => resolve(Response.json({ item: { id: 'i', name: 'Salt', agency: '', dpm: null, group1: true, group1Source: 'admin' } })); });
    return Response.json({ ingredients: [{ id: 'i', name: 'Salt', agency: '', dpm: null, group1: false, group1Source: 'source' }], products: [] });
  };
  const form = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appTest', mapping }, onClose() {}, onSaved() {} });
  await form.render(); await form.click('Test connection'); await form.type('group1Label', 'Basic ingredients');
  assert.ok(form.find(e => e.type === 'th').some(e => e.props.children === 'Basic ingredients'));
  assert.match(form.text(), /Values that mean Basic ingredients/);
  const sheet = mount(CompanyItemsSheet, { company: { id: 'c', name: 'Factory' }, group1Label: 'Group 1', onClose() {} });
  await sheet.render();
  assert.match(sheet.text(), /Factory — ingredients/);
  const button = sheet.buttons().find(b => b.label === 'Mark as Group 1').el;
  button.props.onClick(); button.props.onClick(); await sheet.render();
  assert.equal(calls.filter(c => c[1] === 'PUT').length, 1);
  assert.deepEqual(calls.at(-1), ['/api/sources/group1', 'PUT', { kind: 'ingredient', itemId: 'i', group1: true }]);
  assert.doesNotMatch(sheet.text(), /set by admin/); assert.match(sheet.text(), /Saving…/);
  release(); await sheet.render();
  assert.match(sheet.text(), /Group 1\s*: Yes \(set by admin\)/); assert.match(sheet.text(), /Remove Group 1/); assert.match(sheet.text(), /Use source value/);
  globalThis.fetch = async (url, options = {}) => {
    calls.push([url, options.method || 'GET', options.body && JSON.parse(options.body)]);
    if (options.method === 'PUT') return Response.json({ item: { id: 'i', name: 'Salt', agency: '', dpm: null, group1: false, group1Source: 'source' } });
    if (url.endsWith('/connection')) return Response.json({ sourceType: 'airtable', status: 'ok', group1Label: 'Basic ingredients' });
    return Response.json({ status: { status: 'ok' }, companies: [{ id: 'c', name: 'Factory', ingredientCount: 1, productCount: 0 }] });
  };
  await sheet.click('Use source value');
  assert.deepEqual(calls.at(-1)[2], { kind: 'ingredient', itemId: 'i', group1: null });
  assert.doesNotMatch(sheet.text(), /set by admin/);
  const factories = mount(FactoriesScreen, { isOpen: true, timeZone: 'UTC', onClose() {} });
  await factories.render(); await factories.click('Factory');
  const opened = factories.tree().props.children.find(child => child?.type === CompanyItemsSheet);
  assert.equal(opened.props.company.id, 'c'); assert.equal(opened.props.group1Label, 'Basic ingredients');
  // grep all source files, including future additions; exit 1 means no match.
  let status = 0;
  try { execFileSync('rg', ['-n', '-i', 'No symbol needed', 'src'], { stdio: 'pipe' }); } catch (e) { status = e.status; }
  assert.equal(status, 1, 'retired copy must not occur anywhere in src/');
} finally { globalThis.fetch = originalFetch; globalThis.document = originalDocument; }
console.log('Group 1 preview, confirmed single PUT, admin attribution and retired-copy guard passed');
