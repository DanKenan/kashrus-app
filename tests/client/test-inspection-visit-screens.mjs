import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FactoryVisitScreen, SourceText, ItemSection, ItemSheet, VisitOutbox } from '../../src/components/FactoryVisitScreen.tsx';
import { InspectionReportsInbox, InspectionReportDetail } from '../../src/components/InspectionReportsInbox.tsx';
import { buildPayload, itemSnapshot, newDraft, queueReport, readOutbox, saveDraft, setMark, visitScope } from '../../src/lib/inspectionVisit.ts';
const values = new Map();
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
globalThis.window = new EventTarget();
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const item = { id: 'item-1', name: '  Original שם\nName ', brand: '  Bay Salt Co.  ', code: ' Code ', certificationRaw: '  OU-D  ', statusRaw: ' Status  RAW ', agency: 'OU', dpm: 'dairy', group1: true };
const list = { company: { id: 'factory-1', name: ' Factory שם ', brand: ' Brand ', plant: ' Plant ' }, listVersion: 'hash-1', refreshedAt: '2026-11-10T12:00:00Z', group1Label: 'Group 1', ingredients: [item], products: [{ ...item, id: 'product-1' }] };
const factory = { ...list.company, ingredientCount: 1, productCount: 1 };
const summary = { id: 'report-1', companyId: factory.id, companyName: factory.name, mashgiachId: 'user-1', mashgiachName: ' Inspector שם ', submittedAt: '2026-11-10T15:00:00Z', startedAt: '2026-11-10T12:00:00Z', counts: { checked: 1, not_used: 0, alert: 1, offList: 1 }, hasAlerts: true, listChanged: true, photoCount: 1 };
const scope = visitScope('user-1', 'agency-1');
let calls = [];
let responseStatus = 201;
let fee = null;
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  let body;
  if (url === '/api/auth/me') body = { user: { id: 'user-1', agencyId: 'agency-1' } };
  else if (url === '/api/visits/factories') body = { companies: [factory], group1Label: 'Group 1', refreshedAt: list.refreshedAt };
  else if (url === '/api/visits/factories/factory-1') body = list;
  else if (url === '/api/visits/reports') return new Response(JSON.stringify(responseStatus < 400 ? { report: summary, fee } : { error: 'Please edit this report.' }), { status: responseStatus });
  else if (url.startsWith('/api/inspections/reports?')) body = { reports: Array.from({ length: 50 }, (_, i) => ({ ...summary, id: `report-${i}` })), nextCursor: { submittedAt: summary.submittedAt, id: 'report-49' } };
  else if (url.endsWith('/photos')) body = { photos: { 'mark:1': 'data:image/jpeg;base64,YQ==' } };
  else body = { report: { ...summary, note: ' Report note ', marks: [{ kind: 'ingredient', itemId: item.id, status: 'checked', note: '', hasPhoto: false, item }, { kind: 'product', itemId: 'product-1', status: 'alert', note: ' Different panel ', hasPhoto: true, item }], offList: [{ name: ' Off list ', brand: ' Brand ', note: ' Off note ', hasPhoto: false }] } };
  return new Response(JSON.stringify(body));
};
const props = { userId: 'user-1', agencyId: 'agency-1', timeZone: 'America/Chicago', onClose() {} };
let screen = mount(FactoryVisitScreen, props); await screen.render();
assert.match(screen.text(), /Factory visit/);
assert.match(screen.text(), /1 ingredients/);
await screen.click(e => e.props.children?.some?.(child => child?.props?.children === factory.name));
assert.match(screen.text(), /List updated/);
// Interact with the actual child section's callback, then verify the parent saved its draft.
let draft = JSON.parse(localStorage.getItem(`${scope}:draft:factory-1`));
assert.match(draft.clientReportId, /^[A-Za-z0-9-]{8,64}$/);
const row = mount(ItemSection, { title: 'Ingredients', kind: 'ingredient', items: list.ingredients, draft, onMark(kind, id, status) { draft = setMark(draft, kind, id, draft.marks[0]?.status === status ? null : { status }); }, onEdit() {} });
await row.render();
assert.ok(row.html().includes(item.certificationRaw));
assert.ok(row.html().includes(item.name));
await row.click('Checked'); await row.render({ draft });
assert.match(row.text(), /✓ Checked/);
assert.equal(row.find(e => e.props['aria-pressed'] === true).length, 1);
await row.click('Checked'); await row.render({ draft });
assert.equal(draft.marks.length, 0);
await row.type('search-ingredient', 'no match'); assert.equal(row.find(e => e.type === 'li').length, 0);
// A filled selection retains its words/check and aria-pressed; alternatives stay outlined.
for (const [status, fill] of [['checked', 'bg-ok'], ['not_used', 'bg-ink-soft'], ['alert', 'bg-warn']]) {
  const marked = mount(ItemSection, { title: 'Ingredients', kind: 'ingredient', items: [item], draft: { ...draft, marks: [{ kind: 'ingredient', itemId: item.id, status }] }, onMark() {}, onEdit() {} });
  await marked.render();
  const choices = marked.find(e => e.type === 'button' && typeof e.props['aria-pressed'] === 'boolean');
  assert.equal(choices.length, 3);
  assert.equal(choices.filter(e => e.props['aria-pressed']).length, 1);
  for (const choice of choices) {
    assert.ok(choice.props.className.includes('min-h-11'));
    if (choice.props['aria-pressed']) {
      assert.ok(choice.props.className.split(' ').includes(fill));
      assert.ok(choice.props.className.split(' ').includes('text-paper'));
      assert.ok(choice.props.children.includes('✓ '));
    } else {
      assert.doesNotMatch(choice.props.className, /bg-(ok|ink-soft|warn)\b/);
      assert.ok(choice.props.className.includes('border-line-control'));
    }
  }
}
const source = mount(SourceText, { item }); await source.render();
assert.ok(source.find(e => e.type === 'p' && e.props.children === item.name)[0].props.className.includes('font-bold'));
const brandLine = source.find(e => e.type === 'p' && e.props.className.includes('text-sm'))[0];
assert.ok(brandLine.props.className.includes('text-ink-soft'));
assert.ok(brandLine.props.children.some(child => child?.props?.children === item.brand));
function assertSourceChips(html) {
  assert.ok(html.includes(item.name)); assert.ok(html.includes(item.brand));
  assert.ok(html.includes(item.certificationRaw)); // Raw OU-D spacing is retained verbatim.
  for (const chip of ['OU', 'Dairy', 'Group 1']) assert.ok(html.includes(`text-xs text-ink-soft">${chip}</span>`));
}
assertSourceChips(source.html());
const productSource = mount(SourceText, { item, kind: 'product' }); await productSource.render();
const productBrand = productSource.find(e => e.type === 'p' && e.props.className.includes('text-sm'));
assert.equal(productBrand.length, 1);
assert.ok(productBrand[0].props.children.some(child => child?.props?.children === item.code));
assert.ok(productSource.html().indexOf(item.code) < productSource.html().indexOf(item.certificationRaw));
assertSourceChips(productSource.html());
const equipment = mount(SourceText, { item: { ...item, dpm: 'dairy_equipment', group1: false } }); await equipment.render();
assert.ok(equipment.html().includes('text-xs text-ink-soft">DE</span>'));
assert.ok(equipment.html().includes(item.certificationRaw)); // Assignment never rewrites OU-D.
// Restore a changed-list draft without dropping any findings.
draft = { ...newDraft(list, 'client-report-123', '2026-11-10T12:00:00Z'), listVersion: 'older-hash', marks: [{ kind: 'ingredient', itemId: item.id, status: 'alert', note: ' Original note ' }, { kind: 'ingredient', itemId: 'removed', status: 'checked', item: { name: 'Removed source', brand: '', code: '', certificationRaw: '', statusRaw: '' } }], offList: [{ name: '  Off list  ', brand: ' Brand ' }] };
saveDraft(localStorage, scope, draft);
screen = mount(FactoryVisitScreen, props); await screen.render(); await screen.click(e => e.props.children?.some?.(child => child?.props?.children === factory.name));
assert.match(screen.text(), /Draft restored/); assert.match(screen.text(), /all findings were kept/);
await screen.click('Review and send'); assertSourceChips(screen.html()); await screen.type('report-note', '  Report note\noriginal  ');
await screen.click('Send report'); assert.match(screen.text(), /Saved on this phone — it will be sent automatically/);
assert.equal(readOutbox(localStorage, scope)[0].draft.marks.length, 2);
assert.equal(readOutbox(localStorage, scope)[0].draft.note, '  Report note\noriginal  ');
// Worker sends exactly the queued body; success clears the draft and shows confirmation without a fee.
const originalInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
// Exercise browsers without Web Locks, including recovery from a closed tab's lease.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
localStorage.setItem(`${scope}:send-lock`, JSON.stringify({ owner: 'closed-tab', expires: Date.now() - 1 }));
const queuedBody = structuredClone(readOutbox(localStorage, scope)[0].draft);
const intervals = [];
globalThis.setInterval = fn => { intervals.push(fn); return intervals.length; };
globalThis.clearInterval = () => {};
try {
  const worker = mount(VisitOutbox, { userId: 'user-1', agencyId: 'agency-1' });
  // The renderer settles React updates, not the lease's 50 ms arbitration timer.
  // Wait for the persisted outcome and finally cleanup, with a bounded failure.
  async function waitForSend(id, outcome) {
    const deadline = Date.now() + 2000;
    do {
      await worker.render();
      const entry = readOutbox(localStorage, scope).find(row => row.draft.clientReportId === id);
      if (entry && outcome(entry) && localStorage.getItem(`${scope}:send-lock`) === null) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.fail(`Outbox send did not finish for ${id}`);
  }
  await waitForSend('client-report-123', entry => !!entry.sent);
  await screen.render(); assert.match(screen.text(), /We got it/); assert.doesNotMatch(screen.text(), /fee/i);
  assert.equal(localStorage.getItem(`${scope}:draft:factory-1`), null);
  assert.equal(calls.filter(call => call.url === '/api/visits/reports').length, 1);
  assert.deepEqual(calls.find(call => call.url === '/api/visits/reports').body, queuedBody);
  assert.deepEqual(queuedBody.marks[0].item, itemSnapshot(item));
  for (const event of ['online', 'focus']) { window.dispatchEvent(new Event(event)); await worker.render(); }
  assert.equal(calls.filter(call => call.url === '/api/visits/reports').length, 1);
  // A 5xx backs off. A later retry keeps its id. A 4xx stops all automatic retries.
  const other = { ...draft, clientReportId: 'client-report-456', listVersion: list.listVersion, marks: [] };
  responseStatus = 503; queueReport(localStorage, scope, other);
  window.dispatchEvent(new Event('inspection-send'));
  await waitForSend(other.clientReportId, entry => entry.attempts === 1);
  let queued = readOutbox(localStorage, scope).find(entry => entry.draft.clientReportId === other.clientReportId);
  assert.equal(queued.attempts, 1); assert.equal(queued.stopped, false);
  const count = calls.length; window.dispatchEvent(new Event('online')); await worker.render(); assert.equal(calls.length, count);
  localStorage.setItem(`${scope}:outbox:${other.clientReportId}`, JSON.stringify({ ...queued, nextAttempt: 0 }));
  responseStatus = 400; window.dispatchEvent(new Event('focus'));
  await waitForSend(other.clientReportId, entry => entry.stopped);
  queued = readOutbox(localStorage, scope).find(entry => entry.draft.clientReportId === other.clientReportId);
  assert.equal(queued.stopped, true); assert.equal(queued.error, 'Please edit this report.');
  const sends = calls.filter(call => call.url === '/api/visits/reports');
  assert.equal(sends.at(-1).body.clientReportId, other.clientReportId);
  const stoppedCount = calls.length; intervals[0](); window.dispatchEvent(new Event('online')); await worker.render(); assert.equal(calls.length, stoppedCount);
} finally {
  globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}
// A receipt with a configured fee displays the currency amount.
localStorage.setItem(`${scope}:outbox:fee-report-123`, JSON.stringify({ draft: { ...draft, clientReportId: 'fee-report-123' }, attempts: 1, nextAttempt: 0, stopped: false, sent: { report: { ...summary, id: 'fee-report' }, fee: { amount: 125, currency: 'USD' } } }));
const feeScreen = mount(FactoryVisitScreen, props); await feeScreen.render();
await feeScreen.click(/We got it/, 1); assert.match(feeScreen.text(), /Your fee for this visit:.*125/);
// Sheet validates alerts and preserves typed source text in its callback.
let initial = { name: '', note: '' }; let saved;
const sheet = mount(ItemSheet, { initial, alert: true, onClose() {}, onChange(value) { initial = value; }, onSave(value) { saved = value; } });
await sheet.render(); await sheet.submit(); assert.match(sheet.text(), /needs a note or photo/);
await sheet.type('item-note', '  Different label  '); await sheet.render({ initial }); await sheet.submit();
assert.equal(saved.note, '  Different label  ');
// Inbox uses a timestamp cursor and fetches photos only on demand, retaining original photo indices.
calls = [];
const inbox = mount(InspectionReportsInbox, { timeZone: 'America/Chicago', onClose() {} }); await inbox.render();
assert.match(inbox.text(), /Alert/); assert.match(inbox.text(), /List changed/); assert.match(inbox.text(), /9:00 AM/);
await inbox.click('Load more'); assert.ok(calls.at(-1).url.includes(`before=${encodeURIComponent(JSON.stringify({ submittedAt: summary.submittedAt, id: 'report-49' }))}`));
const detail = mount(InspectionReportDetail, { id: 'report-1', timeZone: 'America/Chicago', onClose() {} }); await detail.render();
assert.equal(calls.some(call => call.url.endsWith('/photos')), false);
const markup = detail.html(); assertSourceChips(markup); assert.ok(markup.indexOf('Different panel') < markup.indexOf('>Checked<'));
await detail.click('Load photos'); assert.equal(calls.filter(call => call.url.endsWith('/photos')).length, 1);
assert.ok(detail.html().includes('data:image/jpeg;base64,YQ=='));
console.log('inspection visit screens and outbox: passed');
