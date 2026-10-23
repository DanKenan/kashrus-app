/**
 * 12b-c client flows ([12BC-RV1] regressions), rendered with tests/client/lib/mini-render.mjs (no DOM):
 *  V*  move-to-pool / make-main: the confirm sends the version its dry-run preview was answered at;
 *      a conflict re-runs the preview and asks again (never confirms against an old open-work list).
 *  S*  tick sheet: a venue that leaves the offered list is dropped and never sent.
 *  K*  the owner Pool reloads when the roster changes (refreshKey = USERS_UPDATED roster).
 * Run: npx tsx tests/client/test-12bc-pool-flows.mjs
 */
const store = new Map();
globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
const { mount } = await import('./lib/mini-render.mjs');
const { PoolMoveDialog, PoolTickSheet, PoolModal } = await import('../../src/components/PoolPanel.tsx');
const { observeVersion } = await import('../../src/lib/api.ts');
const { POOL_TEXT } = await import('../../src/lib/pool.ts');

let passed = 0; let failures = 0;
const ok = (label, cond, info = '') => { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } };
const calls = [];
let answer = () => ({ status: 200, data: {} });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  let body = null; try { body = JSON.parse(opts.body); } catch {}
  calls.push({ m: (opts.method || 'GET').toUpperCase(), path, body });
  const { status, data } = answer(path, body);
  return { ok: status < 300, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
};
const walk = function* (n) { if (n == null || typeof n !== 'object') return; if (Array.isArray(n)) { for (const c of n) yield* walk(c); return; } yield n; yield* walk(n.props?.children); };
const inRow = (m, id, pred) => { const row = m.find((e) => e.props['data-venue-row'] === id)[0]; return row ? [...walk(row.props.children)].filter((e) => typeof e.type === 'string' && pred(e)) : []; };
const check = async (m, id, on) => { const cb = inRow(m, id, (e) => e.type === 'input' && e.props.type === 'checkbox')[0]; await cb.props.onChange({ target: { checked: on } }); await m.render(); };
const confirm = async (m) => { const b = m.find((e) => e.props['data-confirm'] !== undefined)[0]; await b.props.onClick(); await m.render(); };
const venues = [{ id: 'v-a', name: 'Valley Deli' }, { id: 'v-b', name: 'Hill Bakery' }];
const OPEN = { dryRun: true, openWork: { tasks: [{ id: 't1', title: 'Check the eggs', venueId: 'v-a' }], events: [] } };

// V1 move: preview at version 5; later activity moves the client to 9; the confirm still sends 5
{
  calls.length = 0; observeVersion(5);
  answer = (p, b) => (b?.dryRun ? { status: 200, data: OPEN } : { status: 200, data: { success: true } });
  let done = null;
  const m = mount(PoolMoveDialog, { mode: 'move', person: { id: 'u1', name: 'Yossi Katz', venueId: 'v-a', venueRevision: 3 }, venues, onClose() {}, onDone: (x) => { done = x; } });
  await m.render();
  const dry = calls.filter((c) => c.path === '/api/users/u1/move-to-pool');
  ok('V1 dry run first, at version 5', dry.length === 1 && dry[0].body.dryRun === true && dry[0].body.expectedVersion === 5, JSON.stringify(dry));
  ok('V1 open work shown', /1 open task/.test(m.text()) && /Check the eggs/.test(m.text()));
  observeVersion(9);
  await confirm(m);
  const conf = calls.filter((c) => c.path === '/api/users/u1/move-to-pool' && c.body.dryRun === false);
  ok('V1 confirm sends the preview version (5), not the newer 9', conf.length === 1 && conf[0].body.expectedVersion === 5 && conf[0].body.expectedVenueRev === 3, JSON.stringify(conf));
  ok('V1 done', /in the Pool now/.test(String(done)));
}

// V2 move: the confirm meets a conflict -> fresh preview, a notice, and no second confirm by itself
{
  calls.length = 0; observeVersion(13);
  let confirms = 0;
  answer = (p, b) => {
    if (b?.dryRun) return { status: 200, data: { dryRun: true, openWork: confirms ? { tasks: [{ id: 't1', title: 'Check the eggs', venueId: 'v-a' }, { id: 't2', title: 'Light the ovens', venueId: 'v-a' }], events: [] } : OPEN.openWork } };
    confirms++; return { status: 409, data: { error: 'Conflict', code: 'VERSION_CONFLICT' } };
  };
  let done = null;
  const m = mount(PoolMoveDialog, { mode: 'move', person: { id: 'u1', name: 'Yossi Katz', venueId: 'v-a', venueRevision: 3 }, venues, onClose() {}, onDone: (x) => { done = x; } });
  await m.render();
  observeVersion(15);
  await confirm(m);
  const after = calls.filter((c) => c.path === '/api/users/u1/move-to-pool');
  ok('V2 conflict -> one confirm, then a fresh dry run at the newer version', after.length === 3 && after[1].body.dryRun === false && after[2].body.dryRun === true && after[1].body.expectedVersion === 13 && after[2].body.expectedVersion === 15, JSON.stringify(after.map((c) => c.body)));
  ok('V2 the fresh list and the notice are shown', /2 open tasks/.test(m.text()) && m.text().includes(POOL_TEXT.previewChanged), m.text());
  ok('V2 nothing confirmed by itself', done === null && confirms === 1);
}

// V3 make-main: a changed choice needs its own preview; the confirm sends that preview's version
{
  calls.length = 0; observeVersion(21);
  answer = (p, b) => (b?.dryRun ? { status: 200, data: { dryRun: true, openWork: { tasks: [], events: [] } } } : { status: 200, data: { success: true } });
  const m = mount(PoolMoveDialog, { mode: 'make-main', person: { id: 'u2', name: 'Leah Gold', venueId: '', venueRevision: 4 }, venues, onClose() {}, onDone() {} });
  await m.render();
  ok('V3 no request before a venue is chosen', calls.length === 0);
  const sel = m.find((e) => e.type === 'select')[0];
  await sel.props.onChange({ target: { value: 'v-b' } }); await m.render();
  observeVersion(22);
  await confirm(m);
  const c = calls.filter((x) => x.path === '/api/users/u2/make-main');
  ok('V3 preview then confirm, both at version 21, same venue', c.length === 2 && c[0].body.dryRun === true && c[1].body.dryRun === false && c[1].body.expectedVersion === 21 && c[1].body.venueId === 'v-b', JSON.stringify(c.map((x) => x.body)));
}

// V4 make-main: going back to "Choose a venue" drops the preview and disables the confirm ([12BC-RV2] nit)
{
  calls.length = 0; observeVersion(25);
  answer = (p, b) => (b?.dryRun ? { status: 200, data: { dryRun: true, openWork: { tasks: [], events: [] } } } : { status: 200, data: { success: true } });
  const m = mount(PoolMoveDialog, { mode: 'make-main', person: { id: 'u2', name: 'Leah Gold', venueId: '', venueRevision: 4 }, venues, onClose() {}, onDone() {} });
  await m.render();
  const pick = async (v) => { const sel = m.find((e) => e.type === 'select')[0]; await sel.props.onChange({ target: { value: v } }); await m.render(); };
  const confirmBtn = () => m.find((e) => e.props['data-confirm'] !== undefined)[0];
  await pick('v-b');
  ok('V4 a preview enables the confirm', confirmBtn().props.disabled === false);
  await pick('');
  ok('V4 back to "Choose a venue": confirm disabled, preview gone', confirmBtn().props.disabled === true && !/No open tasks/.test(m.text()));
  await confirmBtn().props.onClick(); await m.render();
  ok('V4 and nothing is confirmed', calls.filter((c) => c.path === '/api/users/u2/make-main' && c.body.dryRun === false).length === 0);
}

// S1 tick sheet: a venue that leaves the offered list is dropped and never sent
{
  calls.length = 0; observeVersion(30);
  answer = () => ({ status: 200, data: { success: true } });
  const m = mount(PoolTickSheet, { person: { id: 'u3', name: 'Moshe Adler', venueRevision: 2 }, borrowFrom: 'River Cafe', venues, onClose() {}, onDone() {} });
  await m.render();
  await check(m, 'v-a', true); await check(m, 'v-b', true);
  ok('S1 both picked with a last day (borrow)', inRow(m, 'v-a', (e) => e.props.type === 'date').length === 1 && inRow(m, 'v-b', (e) => e.props.type === 'date').length === 1);
  await m.render({ venues: [venues[1]] }); // Valley Deli left the caller's scope
  await m.click(POOL_TEXT.save);
  const vo = calls.filter((c) => c.path === '/api/users/u3/venue-ops');
  ok('S1 only the still-offered venue is sent', vo.length === 1 && JSON.stringify(vo[0].body.ops.map((o) => o.venueId)) === '["v-b"]' && vo[0].body.ops.every((o) => o.op === 'add' && o.until), JSON.stringify(vo.map((c) => c.body)));
}
{
  calls.length = 0;
  const m = mount(PoolTickSheet, { person: { id: 'u3', name: 'Moshe Adler', venueRevision: 2 }, borrowFrom: 'River Cafe', venues, onClose() {}, onDone() {} });
  await m.render(); await check(m, 'v-a', true);
  await m.render({ venues: [venues[1]] });
  const save = m.buttons().find((b) => b.label === POOL_TEXT.save);
  ok('S2 nothing left picked -> Save disabled', save && save.el.props.disabled === true);
  await save.el.props.onClick(); await m.render();
  ok('S2 and nothing is sent', calls.filter((c) => c.path.endsWith('/venue-ops')).length === 0);
}

// K1 owner Pool: a roster change (USERS_UPDATED) reloads the Pool and the borrow list
{
  calls.length = 0;
  answer = (p) => (p === '/api/pool' ? { status: 200, data: { members: [] } } : p === '/api/pool/borrow' ? { status: 200, data: { people: [] } } : { status: 200, data: {} });
  const owner = { id: 'o1', name: 'Ari Cohen', role: 'owner', venueId: 'v-b', email: 'o@x.test' };
  const m = mount(PoolModal, { isOpen: true, onClose() {}, currentUser: owner, venues, refreshKey: [1] });
  await m.render();
  const n0 = calls.filter((c) => c.path === '/api/pool').length;
  const roster = [1, 2];
  await m.render({ refreshKey: roster });
  const n1 = calls.filter((c) => c.path === '/api/pool').length;
  ok('K1 loads on open', n0 === 1 && calls.some((c) => c.path === '/api/pool/borrow'), String(n0));
  ok('K1 reloads on a roster change', n1 === 2, String(n1));
  await m.render({ refreshKey: roster });
  ok('K1 same roster -> no extra load', calls.filter((c) => c.path === '/api/pool').length === 2);
}

console.log(`12b-c pool flows: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
