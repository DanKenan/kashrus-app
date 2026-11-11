import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { mount } from './lib/mini-render.mjs';
import { AgencyDashboard } from '../../src/components/AgencyDashboard.tsx';
import { FactoriesScreen } from '../../src/components/FactoriesScreen.tsx';
import { FactoryVisitScreen } from '../../src/components/FactoryVisitScreen.tsx';
import { InspectionOverdueBanner } from '../../src/components/InspectionOverdueBanner.tsx';
import { VisitScheduleEditor } from '../../src/components/VisitScheduleEditor.tsx';
import { calendarDate, displayDate } from '../../src/lib/visitSchedule.ts';

// Check the actual App hierarchy, including phone ordering ahead of the board.
const app = ts.createSourceFile('App.tsx', fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const elements = [];
function walk(node) { if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node); ts.forEachChild(node, walk); }
walk(app);
const tag = node => (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(app);
const main = elements.find(node => tag(node) === 'main');
const header = elements.find(node => tag(node) === 'Header');
assert.ok(header.end < main.pos);
const controls = elements.find(node => tag(node) === 'div' && node.pos > main.pos && node.end < main.end && node.getText(app).includes('max-sm:order-first'));
assert.match(controls.getText(app), /!dashboardHome && overdueCard/);
let ancestor = controls; while (ancestor && ancestor !== main) ancestor = ancestor.parent;
assert.equal(ancestor, main);
const dashboardNode = elements.find(node => tag(node) === 'AgencyDashboard');
assert.match(dashboardNode.getText(app), /overdueCard=\{overdueCard\}/);
assert.ok(controls.end < dashboardNode.pos && dashboardNode.end < main.end);
for (const label of ['Factories', 'Factory visit']) {
  const button = elements.find(node => tag(node) === 'button' && ts.isJsxElement(node) && node.children.some(child => ts.isJsxText(child) && child.text === label));
  assert.ok(button.pos > controls.pos && button.end < controls.end);
}
assert.match(main.getText(app), /\['admin', 'coordinator', 'mashgiach'\]\.includes\(currentUser.role\)/);
assert.ok(controls.end < main.getText(app).indexOf('QA2 #8') + main.getStart(app));

const OriginalDate = Date;
globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2027-01-01T02:00:00Z'])); } };
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = new EventTarget();
globalThis.localStorage = { length: 0, key() { return null; }, getItem() { return null; }, setItem() {} };
try {
  const today = calendarDate(new Date().toISOString(), 'America/Chicago');
  assert.equal(today, '2026-12-31');
  assert.equal(displayDate('2026-11-04', today), 'Nov 4');
  assert.equal(displayDate('2027-01-20', today), 'Jan 20, 2027');
  assert.equal(displayDate('2025-11-04', today), 'Nov 4, 2025');
  assert.equal(displayDate('2027-01-20', '2027-01-01'), 'Jan 20');
  const company = { id: 'c', name: 'Test Company', ingredientCount: 0, productCount: 0, schedule: { kind: 'dates', dates: ['2027-08-10'] }, nextDue: '2027-01-20', status: 'ok', overdueDays: 0, lastVisit: { at: '2025-12-31T12:00:00Z', reportId: 'r', mashgiachName: 'Test Inspector' }, mashgiachIds: [], coordinatorIds: [], mute: null };
  const data = { today, timeZone: 'America/Chicago', settings: { countFrom: 'planned', mashgichimSeeAll: true }, companies: [company], people: { mashgichim: [], coordinators: [] } };
  globalThis.fetch = async url => new Response(JSON.stringify(url === '/api/inspections/schedule' ? data : url === '/api/inspections/alerts' ? { today, alerts: [{ companyId: 'c', companyName: company.name, nextDue: '2025-11-04', muted: false }] } : { companies: [{ ...company, assigned: true }] }));
  const screen = mount(FactoriesScreen, { isOpen: true, role: 'coordinator', timeZone: data.timeZone, onClose() {} }); await screen.render();
  assert.match(screen.text(), /Last visit Dec 31, 2025 · Test Inspector Next due Jan 20, 2027/);
  const card = screen.find(e => e.type === 'li')[0].props.children;
  assert.equal(card.type, 'div'); assert.match(card.props.className, /border-line bg-surface/);
  assert.equal(card.props.children[0].type, 'button');
  assert.equal(card.props.children.at(-1).props.children, 'Visit schedule');
  assert.ok(!Array.isArray(card.props.children[0].props.children) || !card.props.children[0].props.children.some(child => child?.type === 'button'));
  await screen.click('Visit schedule');
  const editorProps = screen.tree().props.children.find(e => e?.type === VisitScheduleEditor).props;
  assert.equal(editorProps.company.id, company.id);
  const editor = mount(VisitScheduleEditor, editorProps); await editor.render();
  assert.match(editor.text(), /Next visit due: Aug 10, 2027/);
  const banner = mount(InspectionOverdueBanner, { membership: 'a:u', timeZone: data.timeZone, onOpen() {} }); await banner.render();
  assert.match(banner.text(), /due Nov 4, 2025/);
  const actions = [];
  const dashboard = mount(AgencyDashboard, { overdueCard: banner.tree(), onSelectVenue() {}, onOpenEvents: () => actions.push('events'), onOpenFactoryVisit: () => actions.push('visit'), onOpenFactories: () => actions.push('factories') }); await dashboard.render();
  const siblings = dashboard.tree().props.children;
  assert.equal(siblings[0].type, 'aside');
  assert.equal(siblings[1].type, 'h2'); assert.equal(siblings[1].props.children, 'Agency Dashboard');
  const row = siblings[2];
  assert.equal(row.type, 'div'); assert.match(row.props.className, /flex flex-wrap/);
  assert.doesNotMatch(row.props.className + ' ' + siblings[1].props.className, /(?:^|\s)(?:(?:[\w-]+):)*(?:absolute|fixed|sticky|float-\S+|(?:-?)(?:top|bottom|inset|translate-y)-\S+)/);
  assert.match(dashboard.tree().props.className, /space-y-4/);
  if (process.env.INSPECTION_LAYOUT_HTML) fs.writeFileSync(process.env.INSPECTION_LAYOUT_HTML, dashboard.html());
  assert.ok(row.props.children.every(child => child.type === 'button'));
  await dashboard.click('Events'); await dashboard.click('Factory visit'); await dashboard.click('Factories');
  assert.deepEqual(actions, ['events', 'visit', 'factories']);
  await banner.click(e => e.props['aria-label'] === 'Close'); assert.equal(banner.text(), '');
  // The visit response has no today: its fallback must use the agency zone at New Year.
  const visits = mount(FactoryVisitScreen, { userId: 'm', agencyId: 'a', timeZone: data.timeZone, onClose() {} }); await visits.render();
  assert.match(visits.text(), /Next due Jan 20, 2027/);
} finally { globalThis.Date = OriginalDate; }
console.log('inspection home/card layout and agency-year dates: OK');
