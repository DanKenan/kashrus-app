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
    assert.match(form.text(), /Ingredients\/Schedule A/);
    assert.match(form.text(), /Products\/Schedule B/);
    assert.match(form.text(), /Companies/);
    assert.doesNotMatch(form.text(), /Look at the address bar\./);
    await form.click('How to find your Base ID');
    assert.match(form.text(), /Open your base in Airtable in a browser\./);
    assert.match(form.text(), /Look at the address bar\./);
    assert.match(form.text(), /Copy from app up to the next slash\. That is your Base ID\./);
    await form.click('Close Base ID help');
    assert.doesNotMatch(form.text(), /Look at the address bar\./);
    assert.doesNotMatch(form.text(), /tap your profile picture/);
    await form.click('How to find your access key');
    assert.match(form.text(), /In Airtable, tap your profile picture, then Builder Hub, then Personal access tokens\./);
    assert.match(form.text(), /Tap Create token and name it, for example Shutfey\./);
    assert.match(form.text(), /Tap Add a scope and add/);
    assert.match(form.text(), /Tap Add a base and pick your base\./);
    assert.match(form.text(), /airtable\.com\/create\/tokens/);
    assert.match(form.text(), /Airtable shows it only once\./);
    await form.click('Close access key help');
    assert.doesNotMatch(form.text(), /tap your profile picture/);
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
  // Add and remove mapping fields.
  const arCalls = [];
  globalThis.fetch = async (url, options) => {
    arCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping, guessed: {} } } : { ok: true }));
  };
  const ar = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', hasKey: true, keyHint: 'abcd' }, onClose() {}, onSaved() {} });
  await ar.render();
  const removes = () => ar.buttons().filter(b => b.aria.startsWith('Remove'));
  assert.equal(removes().length, 16, 'every optional row has a remove control');
  assert.ok(!removes().some(b => ['Remove Table', 'Remove Name', 'Remove Link to company'].includes(b.aria)), 'required rows cannot be removed');
  assert.equal(ar.buttons().filter(b => b.label === 'Add field').length, 3, 'one add control per section');
  await ar.click('Test connection');
  assert.match(ar.text(), /Connected · read only/);
  await ar.click('Add field', 1);
  assert.match(ar.text(), /Field label/);
  await ar.type(/extra\.1\.label$/, 'Symbol');
  await ar.type(/extra\.1$/, 'Other');
  assert.equal(ar.find(e => e.type === 'select' && e.props.name === 'ingredients.extra.1')[0].props.value, 'Other');
  await ar.click('Remove Brand (optional)', 0);
  assert.equal(removes().length, 16, 'added row plus removed row cancel out');
  await ar.submit();
  assert.deepEqual(arCalls[1][2].mapping, { ...mapping, ingredients: { ...mapping.ingredients, Symbol: 'Other' }, hidden: { companies: ['brand'], ingredients: [], products: [] } });
  await ar.click('Remove Symbol');
  assert.equal(ar.find(e => e.type === 'select' && e.props.name === 'ingredients.extra.1').length, 0, 'removed row is gone');
  await ar.submit();
  assert.deepEqual(arCalls[2][2].mapping, { ...mapping, hidden: { companies: ['brand'], ingredients: [], products: [] } }, 'removing the added row clears its mapping entry');
  // Review round 1: Test connection must not restore a removed field, a draft
  // named like a built-in must not clobber it, and Not used deletes an entry.
  const restoreMapping = { companies: { table: 'Companies', name: 'Name', brand: 'Brand', factoryValues: ['Factory'] }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: ['Group 1'] };
  const restoreCalls = [];
  globalThis.fetch = async (url, options) => {
    restoreCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping: restoreMapping, guessed: { 'companies.brand': 1 } } } : { ok: true }));
  };
  const restore = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: restoreMapping }, onClose() {}, onSaved() {} });
  await restore.render();
  await restore.click('Remove Brand (optional)', 0);
  await restore.click('Test connection');
  await restore.submit();
  const restored = restoreCalls.at(-1)[2].mapping;
  assert.equal(restored.companies.brand, undefined, 'removed brand is not restored by Test connection');
  assert.deepEqual(restored.hidden.companies, ['brand'], 'removal is saved so it persists on reopen');
  const draftCalls = [];
  globalThis.fetch = async (url, options) => {
    draftCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping: restoreMapping, guessed: {} } } : { ok: true }));
  };
  const draft = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: restoreMapping }, onClose() {}, onSaved() {} });
  await draft.render();
  await draft.click('Add field', 0);
  await draft.type(/extra\.1\.label$/, 'Symbol');
  await draft.type(/extra\.1$/, 'Other');
  await draft.type(/extra\.1\.label$/, 'name');
  await draft.submit();
  assert.deepEqual(draftCalls.at(-1)[2].mapping, restoreMapping, 'draft named name keeps the required Name mapping');
  const unusedCalls = [];
  globalThis.fetch = async (url, options) => {
    unusedCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ ok: true }));
  };
  const unused = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: restoreMapping }, onClose() {}, onSaved() {} });
  await unused.render();
  await unused.type('companies.brand', '');
  await unused.submit();
  assert.equal(unusedCalls.at(-1)[2].mapping.companies.brand, undefined, 'Not used deletes the optional mapping entry');
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
  const cells = () => preview.find(e => e.type === 'td').map(e => e.props.children[0]);
  await preview.click('Add field', 1);
  assert.match(preview.text(), /Field label/);
  await preview.type(/extra\.1\.label$/, 'Symbol');
  await preview.type(/extra\.1$/, 'Other');
  assert.ok(cells().includes('OK-M'), 'a custom field shows as an extra preview column');
  assert.ok(cells().includes('OU-D')); assert.match(preview.text(), /Agency: OU/); assert.match(preview.text(), /Dairy/); assert.ok(cells().includes('Yes'));
  const dairySelect = preview.find(e => e.type === 'select' && e.props.value === 'dairy')[0];
  dairySelect.props.onChange({ target: { value: 'meat' } });
  await preview.render();
  assert.ok(cells().includes('OU-D')); assert.match(preview.text(), /Meat/);
  assert.equal(previewCalls, 1, 'editing a value updates the preview without a request');
  preview.find(e => e.type === 'select' && e.props.value === 'meat')[0].props.onChange({ target: { value: 'dairy' } });
  await preview.render();
  assert.match(preview.text(), /No sample rows for this table\./);
  await preview.type('group1Values', 'OU-D');
  assert.ok(cells().includes('OU-D')); assert.doesNotMatch(preview.text(), /Agency: OU/);
  await preview.type('group1Values', 'Group 1');
  await preview.type('factoryValues', 'Other type');
  const companyCells = cells().slice(0, 5);
  assert.equal(companyCells[2], 'No');
  await preview.type('factoryValues', 'Factory');
  assert.equal(cells()[2], 'Yes');
  await preview.type('ingredients.certification', 'Other');
  assert.ok(cells().includes('OK-M')); assert.match(preview.text(), /Agency: OK/); assert.match(preview.text(), /Meat/); assert.ok(!cells().includes('OU-D'));
  assert.equal(preview.find(e => e.props['aria-label'] === 'Check this guess').length, 0);
  await preview.type('ingredients.table', 'Alternate');
  await preview.type('ingredients.name', 'Name');
  assert.ok(cells().includes('Alternate ingredient')); assert.ok(!cells().includes('Salt'));
  assert.equal(previewCalls, 1);
  const valueCalls = [];
  globalThis.fetch = async url => {
    valueCalls.push(url);
    const q = new URL(url, 'http://local').searchParams.get('q');
    return Response.json({ total: 301, values: q ? [{ column: 'Cert', value: 'Rare value', count: 1 }] : Array.from({ length: 300 }, (_, i) => ({ column: 'Cert', value: `Value ${i}`, count: 301 - i })) });
  };
  const valueForm = mount(SourceConnectForm, { connection: { sourceType: 'airtable', mapping }, onClose() {}, onSaved() {} });
  await valueForm.render();
  await valueForm.type('valueSearch', 'Rare');
  assert.match(valueForm.text(), /Rare value/);
  assert.ok(valueCalls.includes('/api/sources/values?q=Rare'), 'search can find values outside the first 300');
  assert.equal(valueForm.find(e => e.props.name === 'valueSearch').length, 1);
  globalThis.fetch = async url => Response.json(url.includes('/values') ? {
    total: 2, values: [{ kind: 'ingredient', column: 'Cert', value: 'Saved only', count: 12 }, { kind: 'ingredient', column: 'Cert', value: 'OU-D', count: 9 }],
  } : { ok: true, samples: { Ingredients: [{ id: 's', fields: { Cert: 'OU-D' } }, { id: 'n', fields: { Cert: 'Sample only' } }] } });
  const fullValues = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appSaved', mapping: { ...mapping, ingredients: { ...mapping.ingredients, certification: 'Cert' } } }, onClose() {}, onSaved() {} });
  await fullValues.render();
  assert.match(fullValues.text(), /Saved only/);
  await fullValues.click('Test connection');
  assert.match(fullValues.text(), /Saved only/);
  assert.match(fullValues.text(), /Sample only/);
  const valueRows = fullValues.find(e => e.type === 'div' && e.props.className === 'space-y-2 rounded-lg border border-line p-4');
  assert.equal(valueRows.length, 3, 'merge samples without duplicating saved values');
  assert.match(fullValues.text(), /9/);
  globalThis.fetch = async url => Response.json(url.includes('/values') ? { total: 2, values: [
    { kind: 'ingredient', column: 'Cert', value: 'OU-D', count: 2 },
    { kind: 'product', column: 'Cert', value: 'OU-D', count: 1 },
  ] } : { ok: true });
  const separate = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appSaved', mapping: {
    ...mapping, valueAssignments: { Cert: { 'OU-D': { dpm: 'pareve' } } },
  } }, onClose() {}, onSaved() {} });
  await separate.render();
  const controls = () => separate.find(e => e.type === 'select' && ['pareve', 'meat'].includes(e.props.value));
  assert.equal(controls().length, 2, 'legacy assignments apply to both kinds');
  controls()[0].props.onChange({ target: { value: 'meat' } }); await separate.render();
  assert.deepEqual(controls().map(e => e.props.value), ['meat', 'pareve']);
  const usageCalls = [];
  globalThis.fetch = async url => {
    usageCalls.push(url);
    return Response.json({ ok: true, samples: { Products: Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, fields: { Name: `Product ${i}`, Cert: 'OU-DE' } })), Ingredients: Array.from({ length: 14 }, (_, i) => ({ id: `u${i}`, fields: { Name: ['Sugar', 'Salt', 'Cocoa'][i] || `Item ${i}`, Brand: ['Domino', 'Morton', 'Hershey'][i] || `Brand ${i}`, Cert: 'OU-DE' } })) } });
  };
  const usageForm = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appNew' }, onClose() {}, onSaved() {} });
  await usageForm.render();
  await usageForm.click('Test connection');
  await usageForm.type('ingredients.table', 'Ingredients');
  await usageForm.type('ingredients.name', 'Name');
  await usageForm.type('ingredients.brand', 'Brand');
  await usageForm.type('ingredients.certification', 'Cert');
  assert.match(usageForm.text(), /What each value means/);
  assert.match(usageForm.text(), /Your database writes the certification in different ways. Tell the app once what each one means — it applies to every ingredient that uses it./);
  assert.match(usageForm.text(), /Used by 14 ingredients/);
  assert.match(usageForm.text(), /Sugar \(Domino\) · Salt \(Morton\) · Cocoa \(Hershey\)/);
  assert.equal(usageForm.find(e => e.type === 'select' && e.props.value === 'dairy_equipment').length, 1);
  const expand = usageForm.find(e => e.type === 'button' && e.props.children === '+11')[0];
  assert.match(expand.props.className, /min-h-11/);
  await usageForm.click('+11');
  assert.match(usageForm.text(), /Item 13 \(Brand 13\)/);
  assert.equal(usageForm.find(e => e.type === 'li').length, 14);
  await usageForm.type('products.table', 'Products');
  await usageForm.type('products.name', 'Name');
  await usageForm.type('products.certification', 'Cert');
  assert.match(usageForm.text(), /Used by 3 products/);
  assert.equal(usageCalls.length, 1, 'usage and expansion make no extra requests');
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
