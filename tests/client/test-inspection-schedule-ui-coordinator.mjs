import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FactoriesScreen, CompanyItemsSheet } from '../../src/components/FactoriesScreen.tsx';
import { FactoryVisitScreen } from '../../src/components/FactoryVisitScreen.tsx';
import { VisitScheduleEditor } from '../../src/components/VisitScheduleEditor.tsx';
import { InspectionReportsInbox } from '../../src/components/InspectionReportsInbox.tsx';
import { overdueDaysText } from '../../src/lib/visitSchedule.ts';

globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = new EventTarget();
globalThis.localStorage = { length: 0, key() { return null; }, getItem() { return null; } };
const company = { id: 'company/a', name: '  Test Company שם  ', brand: ' Test Brand ', plant: ' Test Plant ', ingredientCount: 1, productCount: 1 };
const row = { ...company, schedule: { kind: 'every', n: 1, unit: 'week', start: '2026-11-01' }, nextDue: '2026-11-10', status: 'overdue', overdueDays: 1, lastVisit: null, mashgiachIds: [], coordinatorIds: ['coordinator'], mute: null };
const item = { id: 'i', name: ' Test Ingredient ', agency: '', dpm: null, group1: true, group1Source: 'admin' };
const calls = [];
let days = 1;
globalThis.fetch = async (url, options = {}) => {
  calls.push([url, options.method || 'GET']);
  assert.ok(!url.startsWith('/api/factories') && !url.startsWith('/api/sources/'), `Coordinator called an admin endpoint: ${url}`);
  if (url === '/api/inspections/schedule') return new Response(JSON.stringify({ today: '2026-11-11', timeZone: 'UTC', settings: { countFrom: 'planned', mashgichimSeeAll: true }, companies: [{ ...row, overdueDays: days }, { ...row, id: 'not-in-list', name: 'Test Excluded Company' }], people: { mashgichim: [], coordinators: [] } }));
  if (url === '/api/visits/factories') return new Response(JSON.stringify({ companies: [{ ...company, assigned: true, nextDue: row.nextDue, status: row.status, overdueDays: days }] }));
  if (url === '/api/visits/factories/company%2Fa') return new Response(JSON.stringify({ company, ingredients: [item], products: [{ ...item, id: 'p', name: ' Test Product ' }] }));
  throw new Error(`Unexpected request: ${url}`);
};
const props = { isOpen: true, role: 'coordinator', timeZone: 'UTC', onClose() {} };
const screen = mount(FactoriesScreen, props); await screen.render();
assert.deepEqual(calls, [['/api/inspections/schedule', 'GET'], ['/api/visits/factories', 'GET']]);
assert.equal(screen.find(e => e.type === 'h3')[0].props.children, company.name);
assert.equal(screen.find(e => e.type === 'p' && e.props.dir === 'auto')[0].props.children, `${company.brand} / ${company.plant}`);
assert.doesNotMatch(screen.text(), /Test Excluded Company|Connect|Refresh now|Settings|Visit schedule settings/);
assert.match(screen.text(), /Showing the companies assigned to you\./);
assert.match(screen.text(), /Last visit None yet Next due Nov 10 Overdue ⚠ Yes · 1 day\b/);
await screen.click(/Test Company/);
const sheetProps = screen.tree().props.children.find(e => e?.type === CompanyItemsSheet).props;
assert.equal(sheetProps.isAdmin, false);
const sheet = mount(CompanyItemsSheet, sheetProps); await sheet.render();
assert.deepEqual(calls.at(-1), ['/api/visits/factories/company%2Fa', 'GET']);
assert.equal(sheet.find(e => e.type === 'p' && e.props.children === item.name).length, 1); assert.match(sheet.text(), /Test Product/);
assert.doesNotMatch(sheet.text(), /Remove Group 1|Mark as Group 1|Use source value/);
assert.deepEqual(sheet.find(e => e.type === 'button').map(e => e.props['aria-label']), ['Close']);
await screen.click('Visit schedule');
const editorProps = screen.tree().props.children.find(e => e?.type === VisitScheduleEditor).props;
assert.equal(editorProps.isAdmin, false);
const editor = mount(VisitScheduleEditor, editorProps); await editor.render();
assert.doesNotMatch(editor.text(), /Who's responsible/); assert.match(editor.text(), /How often/); assert.match(editor.text(), /Overdue alerts/);
await screen.click('Reports'); assert.equal(screen.tree().props.children.filter(e => e?.type === InspectionReportsInbox).length, 1);
assert.ok(calls.every(([, method]) => method === 'GET'));

for (const [count, text] of [[0, 'due today'], [1, '1 day'], [5, '5 days']]) {
  assert.equal(overdueDaysText(count), text);
  days = count;
  const factories = mount(FactoriesScreen, props); await factories.render();
  assert.ok(factories.text().includes(`⚠ Yes · ${text}`));
  const visits = mount(FactoryVisitScreen, { userId: 'm', agencyId: 'a', timeZone: 'UTC', onClose() {} }); await visits.render();
  assert.ok(visits.text().includes(`⚠ Overdue · ${text}`));
  assert.doesNotMatch(factories.text() + visits.text(), /1 days/);
}
console.log('coordinator factory endpoints and overdue wording: OK');
