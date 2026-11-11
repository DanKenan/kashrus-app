import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FactoriesScreen } from '../../src/components/FactoriesScreen.tsx';
import { InspectionReportsInbox } from '../../src/components/InspectionReportsInbox.tsx';

globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const company = { id: 'c', name: 'Test Assigned Company', ingredientCount: 2, productCount: 3 };
const row = { ...company, schedule: null, nextDue: null, status: 'none', overdueDays: 0, lastVisit: null, mashgiachIds: [], coordinatorIds: ['coordinator'], mute: null };
const calls = [];
let finishSchedule;
let recovered = false;
globalThis.fetch = async url => {
  calls.push(url);
  if (url === '/api/visits/factories') return new Response(JSON.stringify({ companies: [company], group1Label: 'Test Group' }));
  if (url === '/api/inspections/schedule') {
    if (!recovered) return new Promise(resolve => { finishSchedule = resolve; });
    return new Response(JSON.stringify({ today: '2026-11-11', timeZone: 'UTC', settings: { countFrom: 'planned', mashgichimSeeAll: true }, companies: [row], people: { mashgichim: [], coordinators: [] } }));
  }
  throw Error(`Unexpected request: ${url}`);
};
const factories = mount(FactoriesScreen, { isOpen: true, role: 'coordinator', timeZone: 'UTC', onClose() {} }); await factories.render();
const scheduleButton = () => factories.find(e => e.type === 'button' && e.props.children === 'Visit schedule')[0];
function assertUnavailable() {
  assert.match(factories.text(), /Test Assigned Company/);
  assert.match(factories.text(), /Showing the companies assigned to you\./);
  assert.equal(factories.find(e => e.type === 'dd' && e.props['aria-label'] === 'Not loaded yet' && e.props.children === '—').length, 3);
  assert.equal(scheduleButton().props.disabled, true);
  assert.doesNotMatch(factories.text(), /None yet|No schedule|Alerts off/);
}
assertUnavailable(); // The list is usable while the independent schedule request is pending.
finishSchedule(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 })); await factories.render();
assertUnavailable();
assert.match(factories.text(), /Couldn't load visit schedules\. Try again/);
assert.ok(factories.buttons().some(button => button.label === 'Reports'));
recovered = true;
await factories.click("Couldn't load visit schedules. Try again");
assert.equal(calls.filter(url => url === '/api/visits/factories').length, 1);
assert.equal(calls.filter(url => url === '/api/inspections/schedule').length, 2);
assert.equal(scheduleButton().props.disabled, false);
assert.match(factories.text(), /Last visit None yet Next due No schedule Overdue No/);
assert.doesNotMatch(factories.text(), /Couldn't load visit schedules|Not loaded yet/);
assert.ok(calls.every(url => !url.startsWith('/api/factories') && !url.startsWith('/api/sources/')));

const cursor = { submittedAt: '2026-10-01T12:00:00Z', id: 'scan-position' };
const pages = [];
globalThis.fetch = async url => { pages.push(url); return new Response(JSON.stringify({ reports: [], nextCursor: pages.length === 1 ? cursor : null })); };
const inbox = mount(InspectionReportsInbox, { timeZone: 'UTC', onClose() {} }); await inbox.render();
assert.match(inbox.text(), /No reports on this page yet\. Load more to keep looking\./);
assert.doesNotMatch(inbox.text(), /No reports yet\./);
assert.ok(inbox.buttons().some(button => button.label === 'Load more'));
await inbox.click('Load more');
assert.equal(new URL(pages[1], 'https://test.invalid').searchParams.get('before'), JSON.stringify(cursor));
assert.match(inbox.text(), /No reports yet\./);
assert.doesNotMatch(inbox.text(), /No reports on this page yet|Load more/);
console.log('coordinator schedule fallback/retry and empty report pages: OK');
