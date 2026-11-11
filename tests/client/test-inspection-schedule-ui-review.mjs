import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { InspectionReportsInbox } from '../../src/components/InspectionReportsInbox.tsx';
import { InspectionOverdueBanner } from '../../src/components/InspectionOverdueBanner.tsx';
import { VisitScheduleEditor } from '../../src/components/VisitScheduleEditor.tsx';
import { nextVisitDue } from '../../src/lib/visitSchedule.ts';

globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const summary = { id: 'r1', companyName: 'Test Company', mashgiachName: 'Test Inspector', submittedAt: '2026-11-10T15:00:00Z', counts: { checked: 0, not_used: 0, alert: 0, offList: 0 } };
const cursor = { submittedAt: '2026-11-01T15:00:00Z', id: 'unseen-position' };
const secondCursor = { submittedAt: '2026-10-01T15:00:00Z', id: 'another-unseen-position' };
const requests = [];
let page = 0;
globalThis.fetch = async url => {
  requests.push(url);
  return new Response(JSON.stringify([
    { reports: [summary, { ...summary, id: 'r2' }], nextCursor: cursor },
    { reports: [], nextCursor: secondCursor },
    { reports: Array.from({ length: 50 }, (_, i) => ({ ...summary, id: `older-${i}` })), nextCursor: null },
  ][page++]));
};
const inbox = mount(InspectionReportsInbox, { timeZone: 'UTC', onClose() {} }); await inbox.render();
assert.equal(inbox.find(e => e.type === 'li').length, 2); assert.match(inbox.text(), /Load more/);
await inbox.click('Load more');
assert.equal(new URL(requests[1], 'https://test.invalid').searchParams.get('before'), JSON.stringify(cursor));
assert.equal(inbox.find(e => e.type === 'li').length, 2); assert.match(inbox.text(), /Load more/);
await inbox.click('Load more');
assert.equal(new URL(requests[2], 'https://test.invalid').searchParams.get('before'), JSON.stringify(secondCursor));
assert.equal(inbox.find(e => e.type === 'li').length, 52); assert.doesNotMatch(inbox.text(), /Load more/);

const annual = { kind: 'per_year', n: 5, start: '2027-01-01' };
const expected = ['2027-01-01', '2027-03-15', '2027-05-27', '2027-08-08', '2027-10-20', '2028-01-01', '2028-03-14', '2028-05-26', '2028-08-08', '2028-10-20'];
const dates = []; let last = null;
for (let i = 0; i < 10; i++) { last = nextVisitDue(annual, 'planned', last); dates.push(last); }
assert.deepEqual(dates, expected);
for (const year of ['2027', '2028']) assert.equal(dates.filter(date => date.startsWith(year)).length, 5);
assert.equal(nextVisitDue(annual, 'planned', last), '2029-01-01');
assert.equal(nextVisitDue(annual, 'last_visit', '2028-01-02'), '2028-03-15');
assert.equal(nextVisitDue({ ...annual, start: '2024-02-29' }, 'planned', '2025-02-27'), '2025-02-28');
assert.equal(nextVisitDue({ ...annual, start: '2024-02-29' }, 'planned', '2027-12-31'), '2028-02-29');
const company = { id: 'c', name: 'Test Company', schedule: annual, lastVisit: { at: '2028-01-02T12:00:00Z', reportId: 'r', mashgiachName: 'Test Inspector' }, mashgiachIds: [], coordinatorIds: [], mute: null };
const data = { today: '2028-01-02', timeZone: 'UTC', settings: { countFrom: 'planned', mashgichimSeeAll: true }, people: { mashgichim: [], coordinators: [] } };
for (const [countFrom, due] of [['planned', 'Mar 14'], ['last_visit', 'Mar 15']]) {
  const editor = mount(VisitScheduleEditor, { company, data: { ...data, settings: { ...data.settings, countFrom } }, isAdmin: false, onSaved() {}, onClose() {} }); await editor.render();
  assert.ok(editor.text().includes(`Next visit due: ${due}`));
  assert.deepEqual(editor.find(e => e.type === 'option').map(e => e.props.children), ['No schedule', 'Every few days, weeks or months', 'A number of times a year', 'On set dates']);
  assert.doesNotMatch(editor.text(), /…|\|/);
  assert.equal(editor.find(e => e.type === 'input' && e.props.type === 'number')[0].props.value, 5);
  assert.match(editor.text(), /times a year/);
}
const every = mount(VisitScheduleEditor, { company: { ...company, schedule: { kind: 'every', n: 3, unit: 'week', start: data.today } }, data, isAdmin: false, onSaved() {}, onClose() {} }); await every.render();
assert.match(every.text(), /Every/); assert.doesNotMatch(every.text(), /…|\|/);
assert.equal(every.find(e => e.type === 'input' && e.props.type === 'number')[0].props.value, 3);
assert.equal(every.find(e => e.type === 'select' && e.props['aria-label'] === 'Time unit')[0].props.value, 'week');

const originalNow = Date.now;
let now = Date.parse('2026-11-11T15:00:00Z'); Date.now = () => now;
let onVisibility;
globalThis.document.addEventListener = (name, fn) => { if (name === 'visibilitychange') onVisibility = fn; };
const storage = new Map(); globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
const alert = { companyId: 'a', companyName: 'Test A', nextDue: '2026-11-03', overdueDays: 8, muted: false };
let muted = true;
globalThis.fetch = async () => new Response(JSON.stringify({ alerts: [alert, { ...alert, companyId: 'b', companyName: 'Test B', muted }] }));
try {
  const banner = mount(InspectionOverdueBanner, { membership: 'a:u', onOpen() {} }); await banner.render();
  assert.match(banner.text(), /1 company is overdue/); assert.doesNotMatch(banner.text(), /Test B/);
  await banner.click(e => e.props['aria-label'] === 'Close'); assert.equal(banner.text(), '');
  assert.equal(storage.get('inspection-overdue:a:u'), JSON.stringify(['a:2026-11-03']));
  now += 600_000; onVisibility(); await banner.render(); assert.equal(banner.text(), '');
  muted = false; now += 600_000; onVisibility(); await banner.render();
  assert.match(banner.text(), /2 companies are overdue/); assert.match(banner.text(), /Test B/);
} finally { Date.now = originalNow; }
console.log('inspection review fixes: paging, annual dates, wording and unmuting: OK');
