import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { InspectionReportsInbox, InspectionReportDetail, ReportTags } from '../../src/components/InspectionReportsInbox.tsx';
import { FoodChoice } from '../../src/components/ChecklistTemplatesScreen.tsx';
function collect(node, type) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(n => collect(n, type)); return [...(node.type === type ? [node] : []), ...collect(node.props?.children, type)]; }
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const summary = { id: 'test-r', kind: 'food_service', companyName: ' Test place ', mashgiachName: 'Test visitor', submittedAt: '2026-11-11T00:00:00Z', startedAt: '2026-11-11T00:00:00Z', templateName: ' Test checklist ', counts: { checked: 1, not_used: 0, alert: 1, offList: 0 }, hasAlerts: true, photoCount: 0, status: 'new' };
const cursor = { id: 'test-cursor', submittedAt: '2026-10-01T00:00:00Z' }; const calls = [];
globalThis.fetch = async (url, opts = {}) => { calls.push([url, opts.method || 'GET', opts.body && JSON.parse(opts.body)]); return new Response(JSON.stringify(url.endsWith('/filters') ? { companies: [{ id: 'c', name: ' Test place ' }], mashgichim: [] } : url.endsWith('/follow-up') ? JSON.parse(opts.body).on ? { status: 'follow_up', followUp: { note: JSON.parse(opts.body).note || '', byName: 'Test admin', at: summary.submittedAt } } : { status: 'seen', followUp: null } : url === '/api/inspections/reports/test-r' ? { report: { ...summary, seenBy: { name: 'Test reader', at: summary.submittedAt }, note: ' Test report ', checklist: [{ itemId: 'i', label: 'Test check', type: 'yes_no', value: false, failed: true }] } } : { reports: [summary], nextCursor: cursor })); };
const inbox = mount(InspectionReportsInbox, { timeZone: 'UTC', onClose() {} }); await inbox.render();
assert.equal(calls[0][0], '/api/inspections/reports?limit=50'); assert.match(inbox.text(), /⚠ 1 problem/);
const card = inbox.find(e => e.type === 'li')[0];
assert.match(card.props.className, /rounded-xl border border-line bg-surface p-4/);
const open = card.props.children[0], seenRow = card.props.children[1];
assert.equal(open.type, 'button'); assert.match(open.props.className, /w-full/); assert.doesNotMatch(open.props.className, /border-line-control|p-4/);
assert.equal(collect(open, 'button').length, 1); assert.equal(seenRow.type, 'div'); assert.match(seenRow.props.className, /justify-end/);
assert.equal(seenRow.props.children.type, 'button'); assert.equal(seenRow.props.children.props.children, 'Mark seen');
await inbox.click('Filters');
const food = collect(inbox.tree(), FoodChoice).find(e => e.props.children === 'Food service'); food.props.onClick(); await inbox.render(); await inbox.click('Show reports');
assert.equal(calls.at(-1)[0], '/api/inspections/reports?limit=50&type=food_service');
await inbox.click('Load more'); assert.equal(calls.at(-1)[0], '/api/inspections/reports?limit=50&type=food_service&before=' + encodeURIComponent(JSON.stringify(cursor)) + '&more=1');
for (const [status, label] of [['new', 'New'], ['seen', 'Seen'], ['follow_up', 'Needs follow-up']]) { const tags = mount(ReportTags, { report: { ...summary, status } }); await tags.render(); assert.match(tags.text(), new RegExp(label)); assert.match(tags.tree().props.className, /flex .*text-xs/); assert.doesNotMatch(tags.tree().props.className, /flex-wrap/); const chips = tags.find(e => e.type === 'span'); assert.equal(chips.length, 3); for (const chip of chips) assert.match(chip.props.className, /rounded-full/); assert.equal(chips[0].props.children, 'Food service'); assert.equal(chips[1].props.children, summary.templateName); }
for (const report of [{ ...summary, templateName: '' }, { ...summary, kind: 'factory' }]) { const tags = mount(ReportTags, { report }); await tags.render(); assert.equal(tags.find(e => e.type === 'span').length, 2); }
let updated; const detail = mount(InspectionReportDetail, { id: 'test-r', timeZone: 'UTC', onClose() {}, onUpdated: r => { updated = r; } }); await detail.render(); assert.equal(updated.status, 'seen'); assert.match(detail.text(), /⚠ Problems/);
const saveButtons = () => detail.find(e => e.type === 'button' && e.props.children === 'Save');
assert.equal(saveButtons().length, 0);
const follow = detail.find(e => e.type === 'section').at(-1);
assert.equal(follow.props.children[0].props.children, 'Follow-up');
assert.equal(collect(follow, FoodChoice).length, 1);
assert.ok(detail.text().indexOf('Test report') < detail.text().indexOf('Follow-up'));
assert.match(detail.text(), /Seen by Test reader ·/);
collect(detail.tree(), FoodChoice)[0].props.onClick(); await detail.render();
assert.equal(saveButtons().length, 1); assert.doesNotMatch(saveButtons()[0].props.className, /bg-gold-deep|w-full/);
collect(detail.tree(), FoodChoice)[0].props.onClick(); await detail.render(); assert.equal(saveButtons().length, 0);
collect(detail.tree(), FoodChoice)[0].props.onClick(); await detail.render(); const note = detail.find(e => e.type === 'textarea')[0]; note.props.onChange({ target: { value: ' Test follow ' } }); await detail.render(); await detail.click(e => e.props.children === 'Save');
assert.deepEqual(calls.at(-1), ['/api/inspections/reports/test-r/follow-up', 'PUT', { on: true, note: ' Test follow ' }]); assert.equal(updated.status, 'follow_up'); assert.equal(saveButtons().length, 0); assert.match(detail.text(), /Needs follow-up · Test admin ·/);
const savedNote = detail.find(e => e.type === 'textarea')[0]; savedNote.props.onChange({ target: { value: 'Changed note' } }); await detail.render(); assert.equal(saveButtons().length, 1); detail.find(e => e.type === 'textarea')[0].props.onChange({ target: { value: ' Test follow ' } }); await detail.render(); assert.equal(saveButtons().length, 0);
collect(detail.tree(), FoodChoice)[0].props.onClick(); await detail.render(); await detail.click(e => e.props.children === 'Save'); assert.deepEqual(calls.at(-1)[2], { on: false }); assert.equal(saveButtons().length, 0); assert.equal(detail.find(e => e.type === 'textarea').length, 0); assert.equal(updated.status, 'seen');
for (const checklist of [[], [{ itemId: 'test-pass', label: ' Test passing check ', type: 'yes_no', value: true, failed: false }]]) {
  globalThis.fetch = async () => new Response(JSON.stringify({ report: { ...summary, checklist, counts: { ...summary.counts, alert: 0 }, hasAlerts: false, note: '' } }));
  const clean = mount(InspectionReportDetail, { id: 'test-clean', timeZone: 'UTC', onClose() {} }); await clean.render();
  assert.doesNotMatch(clean.text(), /⚠ Problems/); assert.match(clean.text(), /✓ No problems found/);
  assert.equal(clean.find(e => e.type === 'section' && e.props.children?.[0]?.props?.children === '⚠ Problems').length, 0);
  assert.match(clean.text(), /Other answers/);
}
console.log('food service inbox filter paging, chips, detail seen and follow-up bodies: OK');
