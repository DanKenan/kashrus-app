import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FactoriesScreen } from '../../src/components/FactoriesScreen.tsx';
import { FoodServiceScreen } from '../../src/components/FoodServiceScreen.tsx';
import { PlaceKindFlip } from '../../src/components/PlaceKindFlip.tsx';
import { classifyPlace, typeMatched } from '../../src/server/inspections/food-service.ts';

const demo = [
  { id: 'mill', name: 'Demo Mill', type: 'Factory' },
  { id: 'sibling', name: 'Demo Mill East', type: 'Factory' },
  { id: 'bistro', name: 'Demo Bistro', type: 'Restaurant' },
  { id: 'diner', name: 'Demo Diner', type: 'Restaurant' },
];
const data = { today: '2026-11-27', timeZone: 'UTC', templates: [],
  settings: { countFrom: 'planned', mashgichimSeeAll: true }, people: { mashgichim: [], coordinators: [] } };
const scheduleRow = { schedule: { kind: 'every', n: 7, unit: 'day', start: '2026-11-25' },
  nextDue: '2026-12-02', lastVisit: null, status: 'ok', overdueDays: 0, mashgiachIds: [], coordinatorIds: [], mute: null };
const manual = { ...scheduleRow, id: 'fs_demo', name: 'Demo Manual', source: 'manual', type: '', address: '', templateId: null };
const fee = { company: { amount: 1200, per: 'year' }, mashgiach: { amount: 42 } };
const values = ['Restaurant'];
const marked = new Set(), factoryMarked = new Set(), requests = [];
const isFoodService = row => classifyPlace(row, values, [...marked], {}, [...factoryMarked]) === 'food_service';
const factoryRows = () => demo.filter(row => !isFoodService(row)).map(row => ({ ...row, ingredientCount: 2, productCount: 3 }));
let failNext = true;
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.fetch = async (url, options = {}) => {
  if (url === '/api/sources/connection') return Response.json({ sourceType: 'airtable', status: 'ok', mapping: { companies: { foodServiceValues: values } } });
  if (url.startsWith('/api/inspections/reports')) return Response.json({ reports: [] });
  if (url === '/api/factories' || url === '/api/visits/factories') return Response.json({ companies: factoryRows() });
  if (url === '/api/inspections/schedule') return Response.json({ ...data, companies: demo.map(row => ({ ...row, ...scheduleRow, kind: isFoodService(row) ? 'food_service' : 'factory' })) });
  if (url === '/api/inspections/fees/mill') return Response.json(fee);
  if (url === '/api/food-service') return Response.json({ ...data, candidates: factoryRows(), places: [
    ...demo.filter(isFoodService).map(row => ({ ...row, ...scheduleRow, source: 'connected', address: '', templateId: null, typeMatched: typeMatched(row, values) })),
    manual,
  ] });
  if (url === '/api/food-service/marked') {
    assert.equal(options.method, 'PUT');
    const body = JSON.parse(options.body);
    requests.push(body);
    if (failNext) { failNext = false; return Response.json({}, { status: 503 }); }
    for (const id of body.remove ?? []) marked.delete(id);
    for (const id of body.factoryRemove ?? []) factoryMarked.delete(id);
    for (const id of body.add ?? []) {
      if (!typeMatched(demo.find(row => row.id === id), values)) marked.add(id);
    }
    for (const id of body.factoryAdd ?? []) {
      if (typeMatched(demo.find(row => row.id === id), values)) factoryMarked.add(id);
    }
    return Response.json({ ok: true });
  }
  assert.fail('Unexpected request ' + url);
};

function* flips(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* flips(child);
  } else if (node?.type === PlaceKindFlip) {
    yield node;
  } else if (node?.props) {
    yield* flips(node.props.children);
  }
}
const controls = screen => [...flips(screen.tree())];
async function flip(screen, id, label) {
  const row = controls(screen).find(control => control.props.companyId === id);
  assert.ok(row, id + ' has a flip control on this board');
  const button = await mount(PlaceKindFlip, row.props).render();
  await button.click(label);
  await screen.render();
}
const factories = role => mount(FactoriesScreen, { role, isOpen: true, timeZone: 'UTC', onClose() {} }).render();
const food = role => mount(FoodServiceScreen, { role, userId: 'demo', agencyId: 'demo', timeZone: 'UTC', onClose() {} }).render();

let board = await factories('admin');
assert.deepEqual(controls(board).map(control => control.props.companyId), ['mill', 'sibling']);
await flip(board, 'mill', 'Mark as food service');
assert.match(board.text(), /The change was not saved\. Try again\./);
assert.ok(controls(board).some(control => control.props.companyId === 'mill'));
await flip(board, 'mill', 'Mark as food service');
assert.deepEqual(requests.at(-1), { add: ['mill'], factoryRemove: ['mill'] });
assert.deepEqual(controls(board).map(control => control.props.companyId), ['sibling']);

board = await food('admin');
assert.deepEqual(controls(board).map(control => control.props.companyId), ['mill', 'bistro', 'diner']);
const millRow = board.find(element => element.type === 'li' && element.key === 'mill')[0];
assert.ok(!controls(board).some(control => control.props.companyId === manual.id));
assert.match(JSON.stringify(millRow.props.children), /Choose checklist/);
assert.match(JSON.stringify(millRow.props.children), /Dec 2/);
await flip(board, 'mill', 'Mark as a factory');
assert.deepEqual(requests.at(-1), { factoryAdd: ['mill'], remove: ['mill'] });
assert.equal(marked.has('mill'), false);
await flip(board, 'bistro', 'Mark as a factory');
assert.ok(factoryMarked.has('bistro'));
assert.deepEqual(controls(board).map(control => control.props.companyId), ['diner']);
board = await factories('admin');
await flip(board, 'bistro', 'Mark as food service');
assert.equal(factoryMarked.has('bistro'), false);
assert.equal(marked.has('bistro'), false);
assert.deepEqual(controls(board).map(control => control.props.companyId), ['mill', 'sibling']);

for (const role of ['coordinator', 'mashgiach']) {
  assert.deepEqual(controls(await factories(role)), []);
  assert.deepEqual(controls(await food(role)), []);
}
console.log('PASS both board flips, one-venue scope, type defaults restored, inline error, checklist choice, and role gates');
