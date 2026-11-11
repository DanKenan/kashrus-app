import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { SourceConnectForm } from '../../src/components/SourceConnectSheet.tsx';
import { emptyMapping } from '../../src/lib/sources.ts';
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const mapping = { companies: { table: 'Companies', name: 'Name', factoryValues: ['Factory'] }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: ['Group 1'] };
try {
  for (const typedKey of ['', 'new-test-key']) {
    const calls = []; let saved = 0; let closed = 0;
    globalThis.fetch = async (url, options) => {
      calls.push([url, options.method, JSON.parse(options.body)]);
      return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping, guessed: { 'companies.table': 1, 'companies.name': 1, 'ingredients.companyLink': 0.9 } } } : { ok: true }));
    };
    const form = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', hasKey: true, keyHint: 'abcd', apiKey: 'never-render-this-key' }, onClose() { closed++; }, onSaved() { saved++; } });
    await form.render();
    for (const label of ['Brand (optional)', 'Plant / location (optional)', 'Expiration (optional)']) assert.ok(form.text().includes(label));
    assert.doesNotMatch(form.text(), /Brand optional|Plant optional|Expiration optional/);
    for (const source of ['Google Sheets', 'Excel', 'Supabase']) assert.equal(form.buttons().find(b => b.label.includes(source)).el.props.disabled, true);
    assert.equal(form.find(e => e.type === 'button' && e.props.type === 'submit')[0].props.disabled, true);
    assert.match(form.text(), /A key is saved \(…abcd\). Leave empty to keep it\./);
    assert.doesNotMatch(form.html(), /never-render-this-key/);
    assert.equal(form.find(e => e.props.name === 'apiKey')[0].props.autoComplete, 'off');
    if (typedKey) await form.type('apiKey', typedKey);
    await form.click('Test connection');
    assert.match(form.text(), /Connected · read only/);
    assert.equal(form.find(e => e.type === 'select' && e.props.name === 'companies.name')[0].props.value, 'Name');
    assert.equal(form.find(e => e.type === 'span' && e.props.children === 'Guessed').length, 3);
    assert.match(form.html(), /Other/);
    const expectedKey = typedKey ? { apiKey: typedKey } : {};
    assert.deepEqual(calls[0], ['/api/sources/test', 'POST', { sourceType: 'airtable', baseId: 'appBase', ...expectedKey }]);
    assert.equal(form.find(e => e.type === 'button' && e.props.type === 'submit')[0].props.disabled, false);
    await form.type('ingredients.companyLink', '');
    assert.equal(form.find(e => e.type === 'button' && e.props.type === 'submit')[0].props.disabled, true);
    await form.submit(); assert.equal(calls.length, 1);
    await form.type('ingredients.companyLink', 'Company');
    if (typedKey) {
      const radio = form.find(e => e.type === 'input' && e.props.type === 'radio' && e.props.value === 'readwrite')[0];
      radio.props.onChange(); await form.render();
    }
    await form.submit();
    assert.deepEqual(calls[1], ['/api/sources/connection', 'PUT', { sourceType: 'airtable', baseId: 'appBase', access: typedKey ? 'readwrite' : 'read', group1Label: 'Group 1', mapping, ...expectedKey }]);
    assert.equal(saved, 1); assert.equal(closed, 1);
  }
  const previewMapping = { ...mapping, companies: { ...mapping.companies, type: 'Type' }, ingredients: { ...mapping.ingredients, certification: 'Cert' } };
  let previewCalls = 0;
  globalThis.fetch = async () => {
    previewCalls++;
    return new Response(JSON.stringify({ ok: true, tables: [
      { name: 'Ingredients', columns: ['Name', 'Company', 'Cert', 'Other'] },
      { name: 'Alternate', columns: ['Name', 'Cert'] },
    ], samples: {
      Companies: [{ id: 'c1', fields: { Name: 'Factory company', Type: 'Factory' } }],
      Ingredients: [{ id: '1', fields: { Name: 'Salt', Cert: 'OU-D', Other: 'OK-M' } }, { id: '2', fields: { Name: 'Water', Cert: 'Group 1' } }],
      Alternate: [{ id: '3', fields: { Name: 'Alternate ingredient', Cert: 'Star-K' } }],
    }, guess: { mapping: previewMapping, guessed: { 'ingredients.certification': 0.6, 'ingredients.name': 0.9 } } }));
  };
  const preview = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appPreview' }, onClose() {}, onSaved() {} });
  await preview.render();
  assert.match(preview.text(), /Press Test connection to see a preview\./);
  await preview.click('Test connection');
  assert.equal(preview.find(e => e.props['aria-label'] === 'Check this guess').length, 1);
  assert.equal(preview.find(e => e.type === 'span' && e.props.children === 'Guessed').length, 1);
  const cells = () => preview.find(e => e.type === 'td').map(e => e.props.children);
  assert.ok(cells().includes('OU')); assert.ok(cells().includes('Dairy')); assert.ok(cells().includes('Yes'));
  assert.match(preview.text(), /No sample rows for this table\./);
  await preview.type('group1Values', 'OU-D');
  assert.ok(!cells().includes('OU')); assert.ok(!cells().includes('Dairy'));
  await preview.type('group1Values', 'Group 1');
  await preview.type('factoryValues', 'Other type');
  const companyCells = cells().slice(0, 5);
  assert.equal(companyCells[2], 'No');
  await preview.type('factoryValues', 'Factory');
  assert.equal(cells()[2], 'Yes');
  await preview.type('ingredients.certification', 'Other');
  assert.ok(cells().includes('OK')); assert.ok(cells().includes('Meat')); assert.ok(!cells().includes('OU'));
  assert.equal(preview.find(e => e.props['aria-label'] === 'Check this guess').length, 0);
  await preview.type('ingredients.table', 'Alternate');
  await preview.type('ingredients.name', 'Name');
  assert.ok(cells().includes('Alternate ingredient')); assert.ok(!cells().includes('Salt'));
  assert.equal(previewCalls, 1);
  const savedMapping = {
    companies: { table: 'Companies', name: 'Custom name', factoryValues: ['Existing factory'], brand: '' },
    ingredients: { table: 'Ingredients', name: 'Custom ingredient', companyLink: 'Existing link' },
    products: { table: 'Products', name: '', companyLink: 'Existing product link' }, group1Values: ['Existing no symbol'],
  };
  const before = structuredClone(savedMapping);
  const suggestion = { ...mapping, companies: { ...mapping.companies, brand: 'Brand' } };
  const savedCalls = [];
  globalThis.fetch = async (url, options) => {
    savedCalls.push([url, JSON.parse(options.body)]);
    return new Response(JSON.stringify(url.endsWith('/test') ? {
      ok: true, access: 'read', tables: [], guess: { mapping: suggestion, guessed: {
        'companies.table': 1, 'companies.name': 1, 'companies.brand': 1, 'ingredients.companyLink': 1, 'products.name': 1,
      } },
    } : { ok: true }));
  };
  const existing = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appSaved', mapping: savedMapping }, onClose() {}, onSaved() {} });
  await existing.render();
  assert.match(existing.text(), /Press Test connection to see a preview\./);
  await existing.type('factoryValues', 'Edited factory');
  await existing.type('group1Values', 'Edited no symbol');
  await existing.click('Test connection');
  const selected = name => existing.find(e => e.type === 'select' && e.props.name === name)[0].props.value;
  assert.equal(selected('companies.name'), 'Custom name');
  assert.equal(selected('ingredients.companyLink'), 'Existing link');
  assert.equal(selected('companies.brand'), 'Brand');
  assert.equal(selected('products.name'), 'Name');
  assert.equal(existing.find(e => e.type === 'span' && e.props.children === 'Guessed').length, 2);
  const guessedLabels = existing.find(e => e.type === 'label' && Array.isArray(e.props.children) && e.props.children.some(child => child?.props?.children === 'Guessed'));
  assert.deepEqual(guessedLabels.map(e => e.props.children[0]), ['Brand (optional)', 'Name']);
  await existing.submit();
  assert.deepEqual(savedCalls.at(-1)[1].mapping, {
    ...savedMapping, companies: { ...savedMapping.companies, brand: 'Brand', factoryValues: ['Edited factory'] },
    products: { ...savedMapping.products, name: 'Name' }, group1Values: ['Edited no symbol'],
  });
  assert.deepEqual(savedMapping, before);
  await existing.click('Test connection');
  assert.equal(existing.find(e => e.type === 'span' && e.props.children === 'Guessed').length, 0);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Access denied. Check the key.' }), { status: 403 });
  const form = mount(SourceConnectForm, { connection: { sourceType: null, baseId: 'appBase', mapping: emptyMapping() }, onClose() {}, onSaved() {} }); await form.render();
  await form.click('Test connection'); assert.match(form.text(), /Access denied. Check the key\./); assert.equal(form.find(e => e.props.role === 'alert').length, 1);
  console.log('source connect: OK');
} finally { globalThis.fetch = originalFetch; globalThis.document = originalDocument; }
