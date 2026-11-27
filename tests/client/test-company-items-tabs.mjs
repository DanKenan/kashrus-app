import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { CompanyItemLists, itemListEditor } from '../../src/components/CompanyItemLists.tsx';
import { CompanyScreen } from '../../src/components/CompanyScreen.tsx';
import { CompanyItemsSheet, FactoriesScreen } from '../../src/components/FactoriesScreen.tsx';
import { VisitSheet } from '../../src/components/FactoryVisitScreen.tsx';
import { SheetRecordList } from '../../src/components/SheetRecordEditor.tsx';

globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = globalThis.sessionStorage = { getItem() { return null; } };

const company = { id: 'recFactory', name: 'Ahlstrom', ingredientCount: 29, productCount: 26 };
const visitItems = {
  ingredients: Array.from({ length: 29 }, (_, i) => ({ id: `recI${i}`, name: `Ingredient ${i + 1}`,
    agency: i === 0 ? 'cRc' : '', dpm: 'pareve', group1: false, group1Source: 'source' })),
  products: Array.from({ length: 26 }, (_, i) => ({ id: `recP${i}`, name: `Product ${i + 1}`,
    agency: '', statusRaw: 'Pareve | Passover', group1: false, group1Source: 'source' })),
};
const mapping = {
  companies: { table: 'Sites', name: 'Label' },
  ingredients: { table: 'Materials', name: 'Description', companyLink: 'Plant' },
  products: { table: 'Finished goods', name: 'Trade name', companyLink: 'Manufactured at' },
};
const airtable = { sourceType: 'airtable', status: 'ok', access: 'readwrite', mapping };
const sheets = { sourceType: 'google_sheets', status: 'ok', access: 'readwrite', sheetsEditSections: ['products'] };
const props = { company, group1Label: 'Group 1', onClose() {} };
const tabs = sheet => sheet.buttons().filter(({ el }) => el.props.role === 'tab');
const child = (screen, component) => screen.tree().props.children.find(el => el?.type === component);

let listReads = 0;
let confirmMark;
globalThis.fetch = async (url, options) => {
  if (options.method === 'PUT') {
    assert.equal(url, '/api/sources/group1');
    assert.deepEqual(JSON.parse(options.body), { kind: 'ingredient', itemId: 'recI0', group1: true });
    return new Promise(resolve => { confirmMark = () => resolve(Response.json({ item: {
      ...visitItems.ingredients[0], group1: true, group1Source: 'admin',
    } })); });
  }
  assert.equal(url, '/api/factories/recFactory/items');
  listReads++;
  return Response.json(visitItems);
};
const sheet = await mount(CompanyItemsSheet, props).render();
assert.match(sheet.text(), /Ahlstrom — items Factory item lists/);
assert.deepEqual(tabs(sheet).map(({ label, el }) => [label, el.props['aria-selected'], el.props.tabIndex]), [
  ['Ingredients (29)', true, 0], ['Products (26)', false, -1],
]);
assert.match(sheet.html(), /Certifying kosher agency.*cRc.*No certification on file/);
assert.doesNotMatch(sheet.text(), /Product 1/);
sheet.buttons().find(({ label }) => label === 'Mark as Group 1').el.props.onClick();
await sheet.click('Products (26)');
assert.match(sheet.text(), /Product 1 .* Pareve \| Passover/);
assert.doesNotMatch(sheet.text(), /Ingredient 1/);
assert.equal(sheet.find(el => el.props.role === 'tabpanel' && !el.props.hidden)[0].props.id, tabs(sheet)[1].el.props['aria-controls']);
confirmMark();
await sheet.click('Ingredients (29)');
assert.match(sheet.text(), /Yes \(set by admin\)/);
assert.equal(listReads, 1);
tabs(sheet)[0].el.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
await sheet.render();
assert.equal(tabs(sheet)[1].el.props['aria-selected'], true);

let failed = true;
globalThis.fetch = async () => failed
  ? Response.json({ error: 'Fixture offline' }, { status: 503 })
  : Response.json({ ingredients: [], products: [{ ...visitItems.products[0], name: 'Alternate agency item' }] });
const retry = await mount(CompanyItemsSheet, { ...props, isAdmin: false }).render();
assert.match(retry.text(), /Couldn't load the item lists\. Try again\./);
assert.doesNotMatch(retry.text(), /No ingredients listed|Alternate agency item/);
failed = false;
await retry.click('Try again');
assert.match(retry.text(), /No ingredients listed for this company\./);
await retry.click('Products (1)');
assert.match(retry.text(), /Alternate agency item/);
assert.doesNotMatch(retry.text(), /Manage products|Mark as Group 1/);

assert.equal(itemListEditor('admin', airtable, 'products'), 'company');
assert.equal(itemListEditor('admin', sheets, 'products'), 'sheet');
assert.equal(itemListEditor('admin', sheets, 'ingredients'), undefined);
for (const role of ['coordinator', 'mashgiach']) assert.equal(itemListEditor(role, airtable, 'products'), undefined);
for (const connection of [{ ...airtable, access: 'read' }, { ...airtable, status: 'stale' },
  { ...airtable, sourceType: 'excel' }, { ...airtable, sourceType: 'upload' }, { ...airtable, mapping: undefined }]) {
  assert.equal(itemListEditor('admin', connection, 'products'), undefined);
}

for (const [connection, target] of [[airtable, 'company'], [sheets, 'sheet']]) {
  globalThis.fetch = async url => {
    if (url.endsWith('/connection')) return Response.json(connection);
    if (url === '/api/factories') return Response.json({ companies: [company] });
    if (url.endsWith('/schedule')) return Response.json({ settings: {}, people: {}, companies: [], today: '2026-11-27' });
    if (url.includes('/reports?')) return Response.json({ reports: [] });
    if (url === '/api/factories/recFactory/items') return Response.json(visitItems);
    assert.equal(url, '/api/sources/companies/recFactory/items');
    return Response.json({ ...visitItems, ...connection });
  };
  const factories = await mount(FactoriesScreen, { isOpen: true, timeZone: 'UTC', onClose() {} }).render();
  await factories.click('Ahlstrom');
  const items = await mount(CompanyItemsSheet, child(factories, CompanyItemsSheet).props).render();
  assert.equal(items.buttons().some(b => b.label === 'Manage ingredients'), target === 'company');
  await items.click('Products (26)');
  await items.click('Manage products');
  await factories.render();
  const editor = child(factories, target === 'company' ? CompanyScreen : SheetRecordList);
  if (target === 'company') {
    assert.equal(editor.props.initialItemList, 'products');
    const screen = await mount(CompanyScreen, editor.props).render();
    const list = screen.tree().props.children.props.children[1].props.children.find(el => el?.type === CompanyItemLists);
    const lists = await mount(CompanyItemLists, list.props).render();
    assert.match(lists.html(), /aria-label="Products \(26\)"/);
    assert.match(lists.html(), />Add product<.*>Edit</);
    child(lists, VisitSheet).props.onClose();
  } else {
    assert.equal(editor.props.section, 'products');
    editor.props.onClose();
  }
  await factories.render();
  await items.render(child(factories, CompanyItemsSheet).props);
  assert.equal(tabs(items)[1].el.props['aria-selected'], true);
  assert.equal(child(factories, CompanyItemsSheet).props.revision, 1);
}
console.log('Company item tabs: counts, keyboard selection, marks, Retry, permissions, and both existing editor entry points passed.');
