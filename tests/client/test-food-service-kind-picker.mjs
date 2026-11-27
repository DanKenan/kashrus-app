import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FlexibleAirtableWizard } from '../../src/components/SourceConnectSheet.tsx';

const table = { id: 'tblCompanies', name: 'Establishments', fields: [
  { id: 'fldName', name: 'Name', type: 'singleLineText' }, { id: 'fldType', name: 'Type', type: 'singleSelect' },
] };
const company = { id: 'company', kind: 'company', tableId: table.id, fields: {
  name: { fieldId: 'fldName', expectedType: 'singleLineText', writable: false },
  type: { fieldId: 'fldType', expectedType: 'singleSelect', writable: false },
} };
const connection = { sourceType: 'airtable', baseId: 'appDemo', hasKey: true, mapping: {
  version: 2, entities: [company], relationships: [], group1Values: [], companies: {},
} };
const venues = Array.from({ length: 18 }, (_, index) => ({
  id: 'venue-' + (index + 1), name: index < 3 ? 'Mill ' + (index + 1) : 'Demo venue ' + (index + 1),
  type: index < 12 ? 'Factory' : 'Restaurant', typeMatched: index >= 12,
}));
const cases = { places: venues.slice(12).map(venue => ({ ...venue, source: 'connected' }))
  .concat({ id: 'manual', name: 'Demo manual', source: 'manual', type: '' }), candidates: venues.slice(0, 12) };
const preview = { companies: [], connected: {}, issues: [], fields: {}, relationships: {} };

async function openPicker({ failedLoads = 0, failWrite = false } = {}) {
  const calls = [];
  let saved = 0;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body && JSON.parse(options.body);
    calls.push([url, options.method ?? 'GET', body]);
    if (url === '/api/sources/test') return Response.json({ ok: true, access: 'read', tables: [table] });
    if (url.endsWith('/preview')) return Response.json(preview);
    if (url === '/api/sources/connection') return Response.json({ status: 'ok' });
    if (url === '/api/food-service' && failedLoads-- > 0) return Response.json({}, { status: 503 });
    if (url === '/api/food-service') return Response.json(cases);
    if (url === '/api/food-service/marked') return Response.json({}, { status: failWrite ? 503 : 200 });
    assert.fail('Unexpected URL: ' + url);
  };
  const wizard = mount(FlexibleAirtableWizard, { connection, onSaved() { saved++; }, onClose() {} });
  await wizard.render();
  await wizard.click('Find your Airtable tables');
  await wizard.click('Continue');
  await wizard.type('factoryValues', 'Factory');
  await wizard.type('foodServiceValues', 'Restaurant');
  await wizard.click('Continue');
  await wizard.click('Save connection');
  const writes = () => calls.filter(([url]) => url.endsWith('/marked')).map(([, , body]) => body);
  assert.deepEqual(calls.slice(-2).map(([url, method]) => [url, method]), [
    ['/api/sources/connection', 'PUT'], ['/api/food-service', 'GET'],
  ]);
  assert.deepEqual(calls.at(-2)[2].mapping.companies.foodServiceValues, ['Restaurant']);
  return { wizard, writes, saved: () => saved, calls };
}

const { wizard, writes, saved } = await openPicker();
assert.equal(wizard.find(element => element.type === 'ul').at(-1).props.children.length, 18);
assert.match(wizard.text(), /Starting choice: Factory, from the type Factory/);
assert.match(wizard.text(), /Starting choice: Food service, from the type Restaurant/);
assert.doesNotMatch(wizard.text(), /Demo manual/);
await wizard.type('Search venues by name', 'mIlL');
assert.equal(wizard.find(element => element.type === 'ul').at(-1).props.children.length, 3);
wizard.find(element => element.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
await wizard.render();
await wizard.click('Mark 3 venues as food service');
assert.equal(wizard.text().match(/You changed this venue to Food service\./g).length, 3);
await wizard.click('Mark 3 venues as a factory');
assert.doesNotMatch(wizard.text(), /You changed this venue/);
await wizard.type('Search venues by name', 'Mill 1');
await wizard.click(/^\s*Food service\s*$/);
await wizard.click('Continue');
assert.match(wizard.text(), /Review your connection/);
assert.match(wizard.text(), /11 factories and 7 food service places\. You can change any venue later from the Factories screen or the Food service screen\./);
assert.deepEqual(writes(), [{ add: ['venue-1'], remove: [], factoryAdd: [], factoryRemove: [] }]);
await wizard.click('Continue');
assert.equal(saved(), 1);

const skipped = await openPicker({ failedLoads: 1 });
assert.match(skipped.wizard.text(), /The venue list could not be loaded\. Try again, or skip this step and mark venues later from the Food service screen\./);
await skipped.wizard.click('Skip this step');
assert.match(skipped.wizard.text(), /Review your connection/);
await skipped.wizard.click('Continue');
assert.deepEqual(skipped.writes(), []);
assert.equal(skipped.saved(), 1);
assert.equal(skipped.calls.filter(([, method]) => method === 'PUT').length, 1);

const retry = await openPicker({ failedLoads: 1 });
await retry.wizard.click('Try again');
assert.match(retry.wizard.text(), /Mill 1/);
await retry.wizard.click('Continue');
assert.match(retry.wizard.text(), /12 factories and 6 food service places/);
assert.deepEqual(retry.writes(), []);

const unsaved = await openPicker({ failWrite: true });
await unsaved.wizard.type('Search venues by name', 'Demo venue 13');
await unsaved.wizard.click(/^\s*Factory\s*$/);
await unsaved.wizard.click('Continue');
assert.match(unsaved.wizard.text(), /The connection was saved, but the food service choices were not saved\. Open the Food service screen and mark the venues again\./);
assert.deepEqual(unsaved.writes(), [{ add: [], remove: [], factoryAdd: ['venue-13'], factoryRemove: [] }]);
console.log('PASS 18-venue setup, filtered bulk changes, review totals, delta-only writes, retry, skip, and save failure');
