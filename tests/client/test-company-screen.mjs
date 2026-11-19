import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { CompanyScreen } from '../../src/components/CompanyScreen.tsx';
import { SheetRecordEditor } from '../../src/components/SheetRecordEditor.tsx';

globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.sessionStorage = { getItem() { return null; } };
globalThis.localStorage = { getItem() { return null; } };

const calls = [];
let contactFailure = true;
let info = { address: '1 Test Street', phone: '555-0100', contacts: [{ id: 'owner', name: 'Test Owner', role: 'Owner', email: '', phone: '' }] };
let rate = 45;
let sheetName = 'Test Bakery';
let sheetRevision = 'revision-1';
const path = {
  details: '/api/sources/rows/companies/test',
  sheet: '/api/sources/sheet-editor/companies/test',
  fees: '/api/inspections/fees',
  contact: '/api/inspections/company-info/test',
  visit: '/api/visits/factories/test',
  location: '/api/visits/places/test/info',
};
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  if (body) delete body.operationId;
  calls.push([method, url, body]);
  if (url === path.sheet) return Response.json({ companies: [], fields: [
    { field: 'name', rule: 'text', value: sheetName, revision: sheetRevision },
    { field: 'companyFee', rule: 'money', value: 1200, revision: 'fee-revision' },
    { field: 'mashgiachFee', rule: 'money', value: 45, revision: 'visit-fee-revision' },
  ] });
  if (url === path.details && method === 'PATCH') {
    sheetName = body.fields.name;
    sheetRevision = 'revision-2';
    return Response.json({ saved: true });
  }
  if (url === path.fees) return Response.json({ canEdit: true, places: [{
    id: 'test', company: null, importedCompany: { amount: 1200, per: 'year' }, mashgiach: { amount: rate }, mashgiachNames: [],
  }] });
  if (url === path.fees + '/test' && method === 'PUT') {
    rate = body.mashgiach.amount;
    return Response.json(body);
  }
  if (url === path.contact && method === 'PUT') {
    if (contactFailure) return Response.json({ error: 'Contacts unavailable. Try again.' }, { status: 503 });
    info = { ...info, ...body };
    return Response.json(info);
  }
  if (url === path.contact) return Response.json(info);
  if (url === path.location) return Response.json({ address: info.address, phone: info.phone });
  if (url === path.visit) return Response.json({ fee: { amount: rate, currency: 'USD' } });
  throw Error('Unexpected request ' + url);
};

function panelProps(screen, heading) {
  const workspace = screen.tree().props.children.props.children[1];
  const section = workspace.props.children.find(node => node?.props?.children?.[0]?.props.children === heading);
  assert.ok(section, 'Missing ' + heading);
  return section.props.children[1];
}
async function panel(screen, heading) {
  const element = panelProps(screen, heading);
  return mount(element.type, element.props).render();
}
async function fill(screen, type, oldValue, value) {
  const field = screen.find(node => node.type === type && node.props.value === oldValue)[0];
  assert.ok(field, 'Missing field with value ' + oldValue);
  field.props.onChange({ target: { value } });
  await screen.render();
}

const company = { id: 'test', name: 'Test Bakery', address: info.address, type: 'Factory', companyFee: 1200 };
let sourceSaves = 0;
let removal;
const props = {
  company, yearlyCount: 12, onClose() {}, onSourceSaved() { sourceSaves++; },
  onRemove(name) { removal = name; },
};
const admin = await mount(CompanyScreen, { ...props, role: 'admin',
  connection: { sourceType: 'google_sheets', sheetsEditSections: ['companies'] },
}).render();
assert.match(admin.text(), /Test Bakery Company screen/);
assert.equal(admin.find(node => node.props.role === 'dialog').length, 1);
assert.equal(admin.find(node => node.props['aria-label'] === 'Close').length, 1);
const details = await panel(admin, 'Company details');
assert.equal(panelProps(admin, 'Company details').type, SheetRecordEditor);
const fees = await panel(admin, 'Fees');
const location = await panel(admin, 'Location & contacts');
assert.match(location.html(), /maps\/search.*tel:555-0100/);
assert.deepEqual([details, fees, location].map(form => form.buttons().find(b => /Save/.test(b.label)).label),
  ['Save company details', 'Save fees', 'Save contacts']);

const sheetNameInput = details.find(node => node.type === 'div' && node.props.children?.props.field?.field === 'name')[0];
sheetNameInput.props.children.props.onChange('New Bakery');
await details.render();
await fill(fees, 'input', '45', '55');
await fill(location, 'input', '555-0100', '555-0101');
await location.submit();
assert.match(location.text(), /Contacts unavailable/);
assert.deepEqual(calls.at(-1), ['PUT', path.contact, { phone: '555-0101' }]);
await details.submit();
assert.equal(sourceSaves, 1);
assert.deepEqual(calls.find(([method]) => method === 'PATCH'), ['PATCH', path.details,
  { fields: { name: 'New Bakery' }, expected: { name: 'revision-1' } }]);
assert.match(details.text(), /Company details saved/);
await admin.render();
assert.match(admin.text(), /New Bakery Company screen/);
await admin.click('Remove company');
assert.equal(removal, 'New Bakery');

await fees.render(panelProps(admin, 'Fees').props);
await location.render(panelProps(admin, 'Location & contacts').props);
assert.ok(fees.find(node => node.type === 'input' && node.props.value === '55').length);
assert.ok(location.find(node => node.type === 'input' && node.props.value === '555-0101').length);
await fees.submit();
assert.deepEqual(calls.at(-1), ['PUT', path.fees + '/test', { company: null, mashgiach: { amount: 55 } }]);
assert.match(fees.text(), /Fees saved/);
assert.match(location.text(), /Contacts unavailable/);
contactFailure = false;
await location.submit();
assert.match(location.text(), /Contacts saved/);
await location.click('Add contact');
const newContactName = location.find(node => node.type === 'label' && node.props.children[0] === 'Name')[1];
newContactName.props.children[1].props.onChange({ target: { value: 'Test Manager' } });
await location.render();
const rolePicker = location.find(node => node.type === 'select' && node.props.value === 'Other')[0];
rolePicker.props.onChange({ target: { value: 'Manager' } });
await location.render();
await location.submit();
assert.deepEqual(calls.at(-1)[2], { contacts: [info.contacts[0], { name: 'Test Manager', role: 'Manager', email: '', phone: '' }] });
await location.click('Delete contact', 1);
await location.submit();
assert.deepEqual(calls.at(-1)[2], { contacts: [info.contacts[0]] });

for (const role of ['coordinator', 'mashgiach']) {
  const start = calls.length;
  const screen = await mount(CompanyScreen, { ...props, role, connection: null }).render();
  assert.doesNotMatch(screen.text(), /Company details|Danger zone|Remove company/);
  const fees = await panel(screen, 'Fees');
  const location = await panel(screen, role === 'coordinator' ? 'Location & contacts' : 'Location');
  assert.match(fees.text(), /\$55.00 per visit/);
  assert.doesNotMatch(fees.text(), /What the company pays|1200|Save/);
  assert.match(location.text(), /1 Test Street.*555-0101/);
  assert.doesNotMatch(location.text(), /Add contact|Save/);
  assert.equal(location.text().includes('Test Owner'), role === 'coordinator');
  assert.deepEqual(calls.slice(start).map(([method, url]) => [method, url]),
    [['GET', path.visit], ['GET', role === 'coordinator' ? path.contact : path.location]]);
}

const sourceMapping = { companies: { name: 'Name', address: 'Address', type: 'Type' } };
const direct = await mount(CompanyScreen, { ...props, role: 'admin',
  connection: { sourceType: 'supabase', access: 'readwrite', canWrite: true, mapping: sourceMapping },
}).render();
const directDetails = await panel(direct, 'Company details');
await fill(directDetails, 'input', '1 Test Street', '2 Test Street');
await directDetails.submit();
assert.deepEqual(calls.at(-1), ['PATCH', path.details, { fields: { address: '2 Test Street' } }]);
assert.match(directDetails.text(), /Company details saved/);

const readOnly = await mount(CompanyScreen, { ...props, role: 'admin',
  connection: { sourceType: 'airtable', access: 'readwrite', mapping: sourceMapping },
}).render();
const readOnlyDetails = await panel(readOnly, 'Company details');
assert.match(readOnlyDetails.text(), /Name Test Bakery Address 1 Test Street Type Factory Fee \$1,200/);
assert.doesNotMatch(readOnlyDetails.text(), /Save company details/);

const archive = await mount(CompanyScreen, { ...props, company: { ...company, archived: true }, role: 'admin', connection: null }).render();
assert.doesNotMatch(archive.text(), /Fees/);
assert.match(archive.text(), /Remove company/);
const archiveLocation = await panel(archive, 'Location & contacts');
assert.doesNotMatch(archiveLocation.text(), /Save contacts/);
console.log('Company screen roles, source revisions, independent saves, failure recovery, and removal handoff passed.');
