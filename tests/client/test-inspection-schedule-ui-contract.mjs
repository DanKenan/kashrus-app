import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FactoriesScreen } from '../../src/components/FactoriesScreen.tsx';
import { VisitScheduleEditor } from '../../src/components/VisitScheduleEditor.tsx';
import { InspectionOverdueBanner } from '../../src/components/InspectionOverdueBanner.tsx';
const originalNow = Date.now;
let now = Date.parse('2026-11-03T15:00:00Z'); Date.now = () => now;
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
const company = { id: 'c', name: '  Test Bakery  ', schedule: null, nextDue: '2026-11-03', status: 'overdue', overdueDays: 0, lastVisit: null, mashgiachIds: [], coordinatorIds: [], mute: { until: null, by: 'u', at: '2026-11-03T00:00:00Z' } };
const data = { today: '2026-11-03', timeZone: 'America/Chicago', settings: { countFrom: 'planned', mashgichimSeeAll: true }, companies: [company, { ...company, id: 'n', name: 'Test No Schedule', nextDue: null, status: 'none', mute: null, lastVisit: { at: '2026-11-03T01:00:00Z', reportId: 'r', mashgiachName: 'Test Inspector' } }], people: { mashgichim: [], coordinators: [] } };
let calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push([url, options.body && JSON.parse(options.body)]);
  let body = url.endsWith('/schedule') ? data : url.endsWith('/connection') ? { sourceType: 'airtable', status: 'ok' } : url === '/api/visits/factories' ? { companies: data.companies.map(row => ({ ...row, ingredientCount: 1, productCount: 2 })), status: { status: 'ok' } } : url === '/api/inspections/alerts' ? { alerts: [{ companyId: 'c', companyName: company.name, nextDue: '2026-11-03', muted: false }] } : { company };
  return new Response(JSON.stringify(body));
};
const closed = mount(FactoriesScreen, { isOpen: false, role: 'coordinator', timeZone: 'UTC', onClose() {} }); await closed.render(); assert.equal(calls.length, 0);
const screen = mount(FactoriesScreen, { isOpen: true, role: 'coordinator', timeZone: 'UTC', onClose() {} }); await screen.render();
assert.match(screen.text(), /None yet/); assert.match(screen.text(), /No schedule/); assert.match(screen.text(), /Nov 2 · Test Inspector/); assert.match(screen.text(), /Yes · due today/); assert.match(screen.text(), /Alerts off/); assert.match(screen.text(), /Showing the companies assigned to you/); assert.doesNotMatch(screen.text(), /Visit schedule settings/);
const editor = mount(VisitScheduleEditor, { company, data, isAdmin: false, onSaved() {}, onClose() {} }); await editor.render(); assert.doesNotMatch(editor.text(), /Who's responsible/); assert.match(editor.text(), /Next visit due: No schedule/);
calls = []; await editor.submit(); assert.equal(calls.length, 0);
editor.find(e => e.type === 'select')[0].props.onChange({ target: { value: 'every' } }); await editor.render(); await editor.submit(); assert.deepEqual(calls, [['/api/inspections/schedule/companies/c', { schedule: { kind: 'every', n: 1, unit: 'day', start: data.today } }]]);
const banner = mount(InspectionOverdueBanner, { membership: 'a:u', onOpen() {} }); await banner.render(); assert.match(banner.text(), /1 company is overdue/); await banner.click(e => e.props['aria-label'] === 'Close'); assert.equal(banner.text(), '');
console.log('inspection schedule UI contract: OK');
// Each section uses only its own endpoint; dates are sorted and deduplicated.
for (const [kind, expected] of [['per_year', { kind: 'per_year', n: 1, start: data.today }], ['dates', { kind: 'dates', dates: [data.today] }]]) {
  calls = [];
  const edit = mount(VisitScheduleEditor, { company, data, isAdmin: true, onSaved() {}, onClose() {} }); await edit.render();
  edit.find(e => e.type === 'select')[0].props.onChange({ target: { value: kind } }); await edit.render(); await edit.submit();
  assert.deepEqual(calls, [['/api/inspections/schedule/companies/c', { schedule: expected }]]);
}
const peopleData = { ...data, people: { mashgichim: [{ id: 'm', name: 'Test Inspector' }], coordinators: [{ id: 'r', name: 'Test Coordinator' }] } };
const assigned = mount(VisitScheduleEditor, { company, data: peopleData, isAdmin: true, onSaved() {}, onClose() {} }); await assigned.render(); calls = [];
assigned.find(e => e.type === 'input' && e.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } }); await assigned.render(); await assigned.submit();
assert.deepEqual(calls, [['/api/inspections/schedule/companies/c/people', { mashgiachIds: ['m'], coordinatorIds: [] }]]);
for (const mode of ['on', 'until']) {
  const muted = mount(VisitScheduleEditor, { company, data, isAdmin: false, onSaved() {}, onClose() {} }); await muted.render(); calls = [];
  muted.find(e => e.type === 'input' && e.props.name === 'alerts')[mode === 'on' ? 0 : 2].props.onChange(); await muted.render(); await muted.submit();
  assert.deepEqual(calls, [['/api/inspections/schedule/companies/c/mute', mode === 'on' ? { muted: false } : { muted: true, until: data.today }]]);
}
for (const countFrom of ['last_visit', 'planned']) {
  const preview = mount(VisitScheduleEditor, { company: { ...company, schedule: { kind: 'every', n: 1, unit: 'month', start: '2026-01-31' }, lastVisit: { at: '2026-03-01T01:00:00Z', reportId: 'r', mashgiachName: 'Test Inspector' } }, data: { ...data, settings: { ...data.settings, countFrom } }, isAdmin: false, onSaved() {}, onClose() {} }); await preview.render();
  assert.match(preview.text(), countFrom === 'planned' ? /Next visit due: Mar 31/ : /Next visit due: Mar 28/);
}
// A new due date changes the dismissal signature on a later app load.
globalThis.fetch = async () => new Response(JSON.stringify({ alerts: [{ companyId: 'c', companyName: company.name, nextDue: '2026-11-10', muted: false }] }));
const renewed = mount(InspectionOverdueBanner, { membership: 'a:u', onOpen() {} }); await renewed.render(); assert.match(renewed.text(), /due Nov 10/);
const { FactoryVisitScreen } = await import('../../src/components/FactoryVisitScreen.tsx');
globalThis.window = new EventTarget();
globalThis.localStorage = { ...globalThis.localStorage, length: 0, key() { return null; } };
globalThis.fetch = async url => new Response(JSON.stringify({ companies: [{ id: 'other', name: 'Test Other', assigned: false, nextDue: '2026-12-01', status: 'ok', ingredientCount: 0, productCount: 0 }, { id: 'mine', name: 'Test Assigned', assigned: true, nextDue: '2026-11-03', status: 'overdue', overdueDays: 5, ingredientCount: 0, productCount: 0 }] }));
const visits = mount(FactoryVisitScreen, { userId: 'm', agencyId: 'a', timeZone: 'UTC', onClose() {} }); await visits.render();
assert.ok(visits.text().indexOf('Your companies') < visits.text().indexOf('Test Assigned'));
assert.ok(visits.text().indexOf('Test Assigned') < visits.text().indexOf('Other companies'));
assert.match(visits.text(), /⚠ Overdue · 5 days/); assert.match(visits.text(), /Next due Dec 1/);

let visibility;
globalThis.document.addEventListener = (name, callback) => { if (name === 'visibilitychange') visibility = callback; };
let alertRequests = 0;
globalThis.fetch = async () => { alertRequests++; return new Response(JSON.stringify({ alerts: [] })); };
const throttled = mount(InspectionOverdueBanner, { membership: 'a:throttle', onOpen() {} }); await throttled.render();
assert.equal(alertRequests, 1); visibility(); await throttled.render(); assert.equal(alertRequests, 1);
now += 600_000; visibility(); await throttled.render(); assert.equal(alertRequests, 2);
Date.now = originalNow;
