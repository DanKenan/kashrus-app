import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { SourceConnectForm } from '../../src/components/SourceConnectSheet.tsx';
import { applyMapping } from '../../src/server/sources/mapping.ts';
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
  // named like a built-in cannot save until it is renamed, and Not used deletes an entry.
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
  assert.equal(draftCalls.length, 0, 'a mapped draft named like a built-in cannot save');
  assert.match(draft.text(), /A field name that is already used cannot hold a column: name \(Companies\)\./);
  await draft.type(/extra\.1\.label$/, 'Symbol');
  await draft.submit();
  assert.deepEqual(draftCalls.at(-1)[2].mapping, { ...restoreMapping, companies: { ...restoreMapping.companies, Symbol: 'Other' } }, 'renaming the draft back to a valid label saves it with its column');
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
  // Review round 2: Test connection on a fresh draft must not restore a removed field.
  const freshCalls = [];
  globalThis.fetch = async (url, options) => {
    freshCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping: restoreMapping, guessed: { 'companies.brand': 1 } } } : { ok: true }));
  };
  const fresh = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', hasKey: true }, onClose() {}, onSaved() {} });
  await fresh.render();
  await fresh.click('Test connection');
  await fresh.click('Remove Brand (optional)', 0);
  await fresh.click('Test connection');
  await fresh.submit();
  const freshSaved = freshCalls.at(-1)[2].mapping;
  assert.equal(freshSaved.companies.brand, undefined, 'a second Test connection on a fresh draft does not restore a removed field');
  assert.deepEqual(freshSaved.hidden.companies, ['brand'], 'the removal is saved so it persists on reopen');
  // Review round 2: two draft rows with the same custom label are rejected, not saved.
  const dupeCalls = [];
  globalThis.fetch = async (url, options) => {
    dupeCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ ok: true }));
  };
  const dupe = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: restoreMapping }, onClose() {}, onSaved() {} });
  await dupe.render();
  await dupe.click('Add field', 0);
  await dupe.click('Add field', 0);
  await dupe.type(/extra\.1\.label$/, 'Symbol');
  await dupe.type(/extra\.1$/, 'Other');
  await dupe.type(/extra\.2\.label$/, 'Symbol');
  await dupe.type(/extra\.2$/, 'Company');
  await dupe.submit();
  assert.equal(dupeCalls.length, 0, 'duplicate custom labels are rejected before saving');
  assert.match(dupe.text(), /Each field name must be used once in a section: Symbol \(Companies\)\./);
  // Review round 3: clearing the duplicate row's column resolves it.
  assert.equal(dupe.find(e => e.type === 'select' && e.props.name === 'companies.extra.2')[0].props.disabled, false, 'a duplicate row column can be cleared');
  await dupe.type(/extra\.2$/, '');
  await dupe.submit();
  assert.equal(dupeCalls.length, 1, 'clearing the duplicate column lets the save through');
  assert.equal(dupeCalls[0][2].mapping.companies.Symbol, 'Other', 'the mapped row is saved once');
  // Review round 2: saved custom fields live in the drafts alone, so removing or
  // renaming one sticks, and changing tables clears their column selections.
  const savedCustom = { ...restoreMapping, companies: { ...restoreMapping.companies, Symbol: 'Other' }, ingredients: { ...restoreMapping.ingredients, Mark: 'Other' } };
  const customFetch = async (url, options) => new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products', 'Alternate'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping: savedCustom, guessed: {} } } : { ok: true }));
  const customCalls = [];
  globalThis.fetch = async (url, options) => { customCalls.push([url, options.method, JSON.parse(options.body)]); return customFetch(url, options); };
  const custom = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: savedCustom }, onClose() {}, onSaved() {} });
  await custom.render();
  await custom.click('Remove Symbol');
  await custom.type(/extra\.1\.label$/, 'Renamed');
  await custom.submit();
  const customSaved = customCalls.at(-1)[2].mapping;
  assert.equal(customSaved.companies.Symbol, undefined, 'removing a saved custom row sticks');
  assert.equal(customSaved.ingredients.Mark, undefined, 'renaming a saved custom row drops the old label');
  assert.equal(customSaved.ingredients.Renamed, 'Other', 'the renamed row keeps its column');
  const tableCalls = [];
  globalThis.fetch = async (url, options) => { tableCalls.push([url, options.method, JSON.parse(options.body)]); return customFetch(url, options); };
  const tableForm = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: savedCustom }, onClose() {}, onSaved() {} });
  await tableForm.render();
  await tableForm.click('Test connection');
  await tableForm.type('ingredients.table', 'Alternate');
  await tableForm.type('ingredients.name', 'Name');
  await tableForm.type('ingredients.companyLink', 'Company');
  await tableForm.submit();
  assert.equal(tableCalls.at(-1)[2].mapping.ingredients.Mark, undefined, 'changing tables clears a custom draft column');
  // Review round 2: hidden is built from current state alone, and a hidden
  // built-in can be restored without changing tables.
  const hiddenMapping = { ...restoreMapping, companies: { table: 'Companies', name: 'Name', factoryValues: ['Factory'] }, hidden: { companies: ['brand'], ingredients: [], products: [] } };
  const hiddenFetch = async (url, options) => new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products', 'Alternate'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping: hiddenMapping, guessed: {} } } : { ok: true }));
  const hiddenCalls = [];
  globalThis.fetch = async (url, options) => { hiddenCalls.push([url, options.method, JSON.parse(options.body)]); return hiddenFetch(url, options); };
  const hiddenForm = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: hiddenMapping }, onClose() {}, onSaved() {} });
  await hiddenForm.render();
  assert.ok(hiddenForm.buttons().some(b => b.aria === 'Restore Brand (optional) in Companies'), 'a hidden built-in offers a restore control');
  await hiddenForm.click('Restore Brand (optional)');
  assert.equal(hiddenForm.find(e => e.type === 'select' && e.props.name === 'companies.brand').length, 1, 'the restored row is back');
  await hiddenForm.submit();
  const hiddenSaved = hiddenCalls.at(-1)[2].mapping;
  assert.equal(hiddenSaved.hidden, undefined, 'restoring the last hidden row leaves no hidden record');
  assert.equal(hiddenSaved.companies.brand, undefined, 'a restored row is unmapped until a column is picked');
  const staleCalls = [];
  globalThis.fetch = async (url, options) => { staleCalls.push([url, options.method, JSON.parse(options.body)]); return hiddenFetch(url, options); };
  const staleForm = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: hiddenMapping }, onClose() {}, onSaved() {} });
  await staleForm.render();
  await staleForm.click('Test connection');
  await staleForm.type('companies.table', 'Alternate');
  await staleForm.type('companies.name', 'Name');
  await staleForm.submit();
  assert.equal(staleCalls.at(-1)[2].mapping.hidden, undefined, 'changing the table clears the hidden record instead of resending it');
  // Review round 3: a duplicate label only blocks saving when both rows
  // would actually be saved; a row with no column picked does not count.
  const clearCalls = [];
  globalThis.fetch = async (url, options) => {
    clearCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ ok: true }));
  };
  const clear = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: restoreMapping }, onClose() {}, onSaved() {} });
  await clear.render();
  await clear.click('Add field', 0);
  await clear.click('Add field', 0);
  await clear.type(/extra\.1\.label$/, 'Symbol');
  await clear.type(/extra\.1$/, 'Other');
  await clear.type(/extra\.2\.label$/, 'Symbol');
  await clear.submit();
  assert.equal(clearCalls.length, 1, 'a duplicate label with only one column mapped saves');
  assert.equal(clearCalls[0][2].mapping.companies.Symbol, 'Other', 'the mapped row is saved once');
  // Review round 3: a Companies custom field named like another section's
  // built-in (code) must reach the payload, the preview, and the server extra.
  const codeMapping = { ...mapping, companies: { ...mapping.companies, type: 'Type' } };
  const codeCalls = [];
  globalThis.fetch = async (url, options) => {
    codeCalls.push([url, options.method, options.body ? JSON.parse(options.body) : undefined]);
    return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read',
      tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, columns: ['Name', 'Company', 'Code', 'Other'] })),
      samples: { Companies: [{ id: 'c1', fields: { Name: 'Factory company', Type: 'Factory', Code: 'C-1' } }] },
      guess: { mapping: codeMapping, guessed: {} } } : { ok: true }));
  };
  const codeForm = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: codeMapping }, onClose() {}, onSaved() {} });
  await codeForm.render();
  await codeForm.click('Test connection');
  await codeForm.click('Add field', 0);
  await codeForm.type(/extra\.1\.label$/, 'code');
  await codeForm.type(/extra\.1$/, 'Code');
  const codeCells = () => codeForm.find(e => e.type === 'td').map(e => e.props.children[0]);
  assert.ok(codeCells().includes('C-1'), 'a Companies custom field named code shows in the preview');
  await codeForm.submit();
  const codeSaved = codeCalls.at(-1)[2].mapping;
  assert.equal(codeSaved.companies.code, 'Code', 'a Companies custom field named code reaches the save payload');
  const codeData = applyMapping({ Companies: [{ id: 'c1', fields: { Name: 'Factory company', Type: 'Factory', Code: 'C-1' } }] }, codeSaved);
  assert.equal(codeData.companies[0].extra.code, 'C-1', 'the live mapper keeps a Companies custom field named code');
  // Review round 3: a saved mapping where Brand is both hidden and mapped is
  // normalized on load, and Restore brings it back unmapped.
  const staleHiddenMapping = { ...restoreMapping, companies: { ...restoreMapping.companies, brand: 'Brand' }, hidden: { companies: ['brand'], ingredients: [], products: [] } };
  const staleHiddenCalls = [];
  globalThis.fetch = async (url, options) => {
    staleHiddenCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ ok: true }));
  };
  const staleHidden = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: staleHiddenMapping }, onClose() {}, onSaved() {} });
  await staleHidden.render();
  await staleHidden.submit();
  assert.equal(staleHiddenCalls.at(-1)[2].mapping.companies.brand, undefined, 'a hidden field keeps no column mapping on load');
  assert.deepEqual(staleHiddenCalls.at(-1)[2].mapping.hidden.companies, ['brand'], 'the hidden record is kept');
  const staleRestoreCalls = [];
  globalThis.fetch = async (url, options) => {
    staleRestoreCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ ok: true }));
  };
  const staleRestore = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: staleHiddenMapping }, onClose() {}, onSaved() {} });
  await staleRestore.render();
  assert.ok(staleRestore.buttons().some(b => b.aria === 'Restore Brand (optional) in Companies'), 'a stale hidden built-in offers a restore control');
  await staleRestore.click('Restore Brand (optional)');
  assert.equal(staleRestore.find(e => e.type === 'select' && e.props.name === 'companies.brand')[0].props.value, '', 'a restored row from a stale mapping is unmapped');
  await staleRestore.submit();
  const staleRestored = staleRestoreCalls.at(-1)[2].mapping;
  assert.equal(staleRestored.companies.brand, undefined, 'the stale brand mapping is not resent');
  assert.equal(staleRestored.hidden, undefined, 'restoring the last hidden row leaves no hidden record');
  // Review round 4: a label that matches a built-in cannot take a new column,
  // so a mapped row can never vanish silently from the Save payload.
  const reservedCalls = [];
  globalThis.fetch = async (url, options) => {
    reservedCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping: restoreMapping, guessed: {} } } : { ok: true }));
  };
  const reserved = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: restoreMapping }, onClose() {}, onSaved() {} });
  await reserved.render();
  await reserved.click('Test connection');
  await reserved.click('Add field', 0);
  await reserved.type(/extra\.1\.label$/, 'Name');
  assert.match(reserved.text(), /That name is already used in this section\./);
  assert.equal(reserved.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.disabled, true, 'a reserved label cannot take a column');
  await reserved.submit();
  assert.deepEqual(reservedCalls.at(-1)[2].mapping, restoreMapping, 'the reserved draft is not saved and nothing else is lost');
  // Review round 5: renaming a mapped row to a reserved label keeps its
  // column in draft state, and Save is blocked while the label is reserved.
  const renameCalls = [];
  globalThis.fetch = async (url, options) => {
    renameCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping: restoreMapping, guessed: {} } } : { ok: true }));
  };
  const rename = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: restoreMapping }, onClose() {}, onSaved() {} });
  await rename.render();
  await rename.click('Test connection');
  await rename.click('Add field', 0);
  await rename.type(/extra\.1\.label$/, 'Symbol');
  await rename.type(/extra\.1$/, 'Other');
  assert.equal(rename.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.value, 'Other');
  await rename.type(/extra\.1\.label$/, 'Name');
  assert.equal(rename.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.value, 'Other', 'renaming to a reserved label keeps the column');
  assert.equal(rename.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.disabled, true, 'the renamed row cannot take a column back');
  await rename.submit();
  assert.equal(renameCalls.length, 1, 'saving with a reserved mapped row is blocked');
  assert.match(rename.text(), /A field name that is already used cannot hold a column: Name \(Companies\)\./);
  // Review round 5: renaming a saved custom field through a reserved label
  // keeps its column, and once the label is valid again the mapping saves
  // under the new label.
  const renameThroughCalls = [];
  globalThis.fetch = async (url, options) => {
    renameThroughCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ ok: true }));
  };
  const renameThrough = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: savedCustom }, onClose() {}, onSaved() {} });
  await renameThrough.render();
  assert.equal(renameThrough.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.value, 'Other', 'the saved custom field opens mapped');
  await renameThrough.type(/extra\.1\.label$/, 'Name');
  assert.equal(renameThrough.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.value, 'Other', 'the column survives passing through a reserved label');
  assert.equal(renameThrough.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.disabled, true, 'the selector is disabled while the label is reserved');
  await renameThrough.submit();
  assert.equal(renameThroughCalls.length, 0, 'saving while the label is reserved is blocked');
  await renameThrough.type(/extra\.1\.label$/, 'Name on invoice');
  assert.equal(renameThrough.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.value, 'Other', 'the column is still there once the label is valid again');
  assert.equal(renameThrough.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.disabled, false, 'the selector is enabled again once the label is valid');
  await renameThrough.submit();
  assert.equal(renameThroughCalls.length, 1, 'the save goes through once the label is valid');
  assert.equal(renameThroughCalls.at(-1)[2].mapping.companies['Name on invoice'], 'Other', 'the renamed field saves under its new label with its column');
  assert.equal(renameThroughCalls.at(-1)[2].mapping.companies.Symbol, undefined, 'the old label is gone');
  // Review round 4: a saved custom field named like a built-in opens as an
  // unmapped draft, never as a mapped row that Save would drop.
  const storedReservedMapping = { ...restoreMapping, companies: { ...restoreMapping.companies, Name: 'Other' } };
  const storedReservedCalls = [];
  globalThis.fetch = async (url, options) => {
    storedReservedCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ ok: true }));
  };
  const storedReserved = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: storedReservedMapping }, onClose() {}, onSaved() {} });
  await storedReserved.render();
  assert.match(storedReserved.text(), /That name is already used in this section\./);
  assert.equal(storedReserved.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.value, '', 'a stored reserved-label field opens unmapped');
  assert.equal(storedReserved.find(e => e.type === 'select' && e.props.name === 'companies.extra.1')[0].props.disabled, true, 'a stored reserved-label field cannot take a column');
  await storedReserved.submit();
  assert.equal(storedReservedCalls.at(-1)[2].mapping.companies.Name, undefined, 'the stored reserved-label field is not saved as a custom field');
  // Review round 4: a saved hidden section that is not an array must not stop
  // the sheet from opening; it is treated as empty.
  const malformedHiddenMapping = { ...restoreMapping, hidden: { companies: 'brand', ingredients: [], products: [] } };
  const malformedCalls = [];
  globalThis.fetch = async (url, options) => {
    malformedCalls.push([url, options.method, JSON.parse(options.body)]);
    return new Response(JSON.stringify({ ok: true }));
  };
  const malformed = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', mapping: malformedHiddenMapping }, onClose() {}, onSaved() {} });
  await malformed.render();
  assert.match(malformed.text(), /Connect database/);
  assert.ok(!malformed.buttons().some(b => b.aria === 'Restore Brand (optional) in Companies'), 'a malformed hidden section is treated as empty');
  await malformed.submit();
  assert.equal(malformedCalls.at(-1)[2].mapping.hidden, undefined, 'the malformed hidden record is not resent');
  const previewMapping = { ...mapping, companies: { ...mapping.companies, type: 'Type' }, ingredients: { ...mapping.ingredients, certification: 'Cert' } };
  let previewCalls = 0;
  globalThis.fetch = async () => {
    previewCalls++;
    return new Response(JSON.stringify({ ok: true, tables: [
      { name: 'Ingredients', columns: ['Name', 'Company', 'Cert', 'Other'] },
      { name: 'Alternate', columns: ['Name', 'Cert'] },
    ], samples: {
      Companies: [{ id: 'c1', fields: { Name: 'Factory company', Type: 'Factory' } }],
      Ingredients: [{ id: '1', fields: { Name: 'Salt', Cert: 'OU-D', Other: 'OK-M' } }, { id: '2', fields: { Name: 'Water', Cert: 'Group 1' } }, { id: '3', fields: { Name: 'Yeast', Cert: 'Star-K', Other: 2027 } }],
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
  assert.ok(cells().includes('2027'), 'a numeric custom field shows in the preview');
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
