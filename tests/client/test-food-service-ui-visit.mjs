import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FoodServiceVisitScreen, FoodServiceOutbox } from '../../src/components/FoodServiceVisitScreen.tsx';
import { FoodChoice } from '../../src/components/ChecklistTemplatesScreen.tsx';
function collect(node, type) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(n => collect(n, type)); return [...(node.type === type ? [node] : []), ...collect(node.props?.children, type)]; }
const storage = new Map(); globalThis.localStorage = { get length() { return storage.size; }, key: i => [...storage.keys()][i] ?? null, getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
globalThis.window = new EventTarget(); globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name, options, fn) => fn({}) } } });
const interval = globalThis.setInterval; globalThis.setInterval = () => 0;
const place = { id: 'fs_test', name: ' Test place ', address: ' Test address ', type: ' Test type ', assigned: true };
const item = { id: 'i_0000000000', label: ' Test check ', type: 'yes_no', required: true, help: ' Test help ', problemIf: 'no', min: null, max: null };
const template = { id: 't_000000000000', name: ' Test checklist ', items: [item], version: 1, updatedAt: '2026-11-11T00:00:00Z' };
const calls = []; let attempts = 0;
globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body && JSON.parse(opts.body); calls.push([url, opts.method || 'GET', body]);
  if (url === '/api/auth/me') return new Response(JSON.stringify({ user: { id: 'test-user', agencyId: 'test-agency' } }));
  if (url === '/api/visits/food-service') return new Response(JSON.stringify({ places: [place] }));
  if (url === '/api/visits/food-service/fs_test') return new Response(JSON.stringify({ place, template, fee: null }));
  if (url === '/api/visits/reports') { attempts++; return attempts === 1 ? new Response(JSON.stringify({ error: 'This checklist changed. Check it and send again.', template: { ...template, version: 2, items: [item, { ...item, id: 'i_1111111111', required: false }] } }), { status: 409 }) : new Response(JSON.stringify({ report: { id: 'test-report', companyName: place.name, submittedAt: '2026-11-11T00:00:00Z', counts: { alert: 1 } }, fee: { amount: 45, currency: 'USD' } }), { status: 201 }); }
  throw Error(url);
};
try {
  for (const [address, type, expected] of [[' Test address ', ' Test type ', ' Test address '], ['', ' Test type ', ' Test type '], ['', '', null]]) {
    place.address = address; place.type = type; storage.clear();
    const visit = mount(FoodServiceVisitScreen, { userId: 'test-user', agencyId: 'test-agency', timeZone: 'UTC', initialPlaceId: place.id, onClose() {} }); await visit.render();
    const heading = visit.find(e => e.type === 'h3' && e.props.children === place.name)[0]; assert.ok(heading);
    const sourceLines = visit.find(e => e.type === 'p' && e.props.dir === 'auto');
    if (expected) assert.equal(sourceLines[0].props.children, expected);
    else assert.equal(sourceLines.some(e => e.props.children === ''), false);
    assert.equal(sourceLines.some(e => e.props.children === ' Test type '), expected === ' Test type ');
  }
  place.address = ' Test address '; place.type = ' Test type '; storage.clear(); calls.length = 0;
  const screen = mount(FoodServiceVisitScreen, { userId: 'test-user', agencyId: 'test-agency', timeZone: 'UTC', onClose() {} }); await screen.render();
  await screen.click(/Test place/); assert.match(screen.text(), /Answer every required item/);
  const send = () => screen.find(e => e.type === 'button' && e.props.children === 'Send report')[0]; assert.equal(send().props.disabled, true);
  collect(screen.tree(), FoodChoice).find(e => e.props.children === 'No').props.onClick(); await screen.render(); assert.equal(send().props.disabled, false); assert.match(screen.text(), /⚠ Problem/);
  const outbox = mount(FoodServiceOutbox, { userId: 'test-user', agencyId: 'test-agency' }); await outbox.render();
  await screen.click('Send report'); await new Promise(r => setTimeout(r, 30)); await screen.render();
  const first = calls.find(c => c[0] === '/api/visits/reports')[2]; assert.deepEqual(Object.keys(first).sort(), ['kind', 'clientReportId', 'companyId', 'startedAt', 'templateId', 'templateVersion', 'answers', 'note'].sort());
  assert.equal(first.kind, 'food_service'); assert.equal(first.templateVersion, 1); assert.deepEqual(first.answers, [{ itemId: item.id, value: false }]);
  assert.match(screen.text(), /This checklist changed\. Check it and send again\./);
  assert.equal(collect(screen.tree(), FoodChoice).find(e => e.props.children === 'No').props.selected, true);
  await screen.click('Send report'); await new Promise(r => setTimeout(r, 30)); await screen.render();
  assert.equal(calls.filter(c => c[0] === '/api/visits/reports').at(-1)[2].templateVersion, 2);
  assert.match(screen.text(), /We got it/); assert.match(screen.text(), /Your fee for this visit: \$45\.00/); assert.match(screen.text(), /Problems found: 1/);
} finally { globalThis.setInterval = interval; }
console.log('food service visit required answers, exact submission, 409 retention, confirmed fee: OK');
