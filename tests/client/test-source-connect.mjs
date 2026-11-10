import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { SourceConnectForm } from '../../src/components/SourceConnectSheet.tsx';
import { emptyMapping } from '../../src/lib/sources.ts';
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const mapping = { companies: { table: 'Companies', name: 'Name', factoryValues: ['Factory'] }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, noSymbolValues: ['Group 1'] };
try {
  for (const typedKey of ['', 'new-test-key']) {
    const calls = []; let saved = 0; let closed = 0;
    globalThis.fetch = async (url, options) => {
      calls.push([url, options.method, JSON.parse(options.body)]);
      return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, access: 'read', tables: ['Companies', 'Ingredients', 'Products'].map(name => ({ name, columns: ['Name', 'Company', 'Other'] })), guess: { mapping, guessed: { 'companies.table': 1, 'companies.name': 1, 'ingredients.companyLink': 0.9 } } } : { ok: true }));
    };
    const form = mount(SourceConnectForm, { connection: { sourceType: 'airtable', baseId: 'appBase', hasKey: true, keyHint: 'abcd', apiKey: 'never-render-this-key' }, onClose() { closed++; }, onSaved() { saved++; } });
    await form.render();
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
    assert.deepEqual(calls[1], ['/api/sources/connection', 'PUT', { sourceType: 'airtable', baseId: 'appBase', access: typedKey ? 'readwrite' : 'read', mapping, ...expectedKey }]);
    assert.equal(saved, 1); assert.equal(closed, 1);
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Access denied. Check the key.' }), { status: 403 });
  const form = mount(SourceConnectForm, { connection: { sourceType: null, baseId: 'appBase', mapping: emptyMapping() }, onClose() {}, onSaved() {} }); await form.render();
  await form.click('Test connection'); assert.match(form.text(), /Access denied. Check the key\./); assert.equal(form.find(e => e.props.role === 'alert').length, 1);
  console.log('source connect: OK');
} finally { globalThis.fetch = originalFetch; globalThis.document = originalDocument; }
