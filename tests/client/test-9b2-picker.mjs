/**
 * 9b2 client test: admin venue picker (Team -> "Venues: <main> +N" -> VenueAccessSheet).
 *   T*  TeamModal entry: admin viewer only, non-admin target with venueIds only; label.
 *   V*  Sheet: dialog semantics, 44px rows/Close, Main locked + tagged, tokens, >=12px,
 *       Save disabled until changed, exact PUT body (main first, venue-list order,
 *       expectedVenueIds, expectedVersion = baseline at OPEN), the three error lines,
 *       picks kept on error, success -> onSaved, no write when unchanged.
 * Run: npx tsx tests/client/test-9b2-picker.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import { VenueAccessSheet } from '../../src/components/VenueAccessSheet.tsx';
import { TeamModal } from '../../src/components/TeamModal.tsx';
import { observeVersion } from '../../src/lib/api.ts';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const noop = () => {};
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = globalThis.localStorage || { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
if (!globalThis.crypto?.randomUUID) globalThis.crypto = { randomUUID: () => 'op-' + Math.random() };
const dec = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const V = [
  { id: 'vA', name: 'Crown Market', createdAt: '' },
  { id: 'vB', name: 'Grand Ballroom', createdAt: '' },
  { id: 'vC', name: 'Keter Bakery', createdAt: '' },
];
const admin = { id: 'u9', name: 'Admin', email: 'admin@t', role: 'admin', agencyId: 'a', venueId: 'vA' };
const coord = { ...admin, id: 'u8', role: 'coordinator' };
const yossi = { id: 'u1', name: 'Yossi Abramowitz', email: 'y@t', role: 'mashgiach', agencyId: 'a', venueId: 'vA', venueIds: ['vA', 'vC'] };
const moshe = { id: 'u2', name: 'Moshe', email: 'm@t', role: 'mashgiach', agencyId: 'a', venueId: 'vB', venueIds: ['vB'] };
const noIds = { id: 'u3', name: 'Eli', email: 'e@t', role: 'mashgiach', agencyId: 'a', venueId: 'vA' };
const otherAdmin = { id: 'u4', name: 'Second Admin', email: 'a2@t', role: 'admin', agencyId: 'a', venueId: 'vA', venueIds: ['vA'] };

// ---- T: TeamModal entry ----
const tm = (viewer) => dec(renderToStaticMarkup(React.createElement(TeamModal, { isOpen: true, onClose: noop, users: [admin, yossi, moshe, noIds, otherAdmin], tasks: [], currentUser: viewer, currentVenue: V[0], venues: V, onAddUser: async () => {}, onUpdateUser: async () => {}, onDeleteUser: async () => {} })));
const hA = tm(admin);
const entries = (hA.match(/>Venues: [^<]*</g) || []).map((s) => s.slice(1, -1));
ok('T1 admin sees one entry per non-admin with venueIds (2)', entries.length === 2, JSON.stringify(entries));
ok('T2 label "Venues: Crown Market +1" for a 2-venue person', entries.includes('Venues: Crown Market +1'), JSON.stringify(entries));
ok('T3 label "Venues: Grand Ballroom" (no +0) for a 1-venue person', entries.includes('Venues: Grand Ballroom'), JSON.stringify(entries));
ok('T4 no entry for an admin target or a record without venueIds', !hA.includes('Venues: Crown Market<') || entries.length === 2);
ok('T5 coordinator viewer gets no entry', !/>Venues: /.test(tm(coord)));
const btn = (hA.match(/<button[^>]*>Venues: Crown Market \+1<\/button>/) || [''])[0];
ok('T6 entry is a 44px button', /min-h-11|min-h-\[44px\]|h-11/.test(btn), btn.slice(0, 160));

// ---- V: sheet ----
function fetchAnswer(status, body) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => { let b = null; try { b = JSON.parse(opts.body); } catch {} calls.push([(opts.method || 'GET').toUpperCase(), String(url), b]); return { ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) }; };
  return calls;
}
observeVersion(41);
let saved = 0;
const s = mount(VenueAccessSheet, { record: yossi, venues: V, onClose: noop, onSaved: () => { saved++; } });
await s.render();
observeVersion(57); // a newer version heard AFTER the sheet opened must not become the baseline
let html = dec(s.html());
ok('V1 role=dialog + aria-modal + labelled title "Venues for <name>"', /role="dialog"/.test(html) && /aria-modal="true"/.test(html) && /aria-labelledby="([^"]+)"/.test(html) && html.includes('>Venues for Yossi Abramowitz<'));
ok('V2 44px Close', /<button[^>]*aria-label="Close"[^>]*class="[^"]*(w-11|min-w-11)[^"]*(h-11|min-h-11)/.test(html) || /<button[^>]*class="[^"]*(w-11 h-11|min-h-11 min-w-11)[^"]*"[^>]*aria-label="Close"/.test(html));
const boxes = s.find((e) => e.type === 'input' && e.props.type === 'checkbox');
ok('V3 one checkbox per agency venue', boxes.length === 3, String(boxes.length));
ok('V4 Main venue checked + disabled, with "Main" tag', boxes[0].props.checked === true && boxes[0].props.disabled === true && /Crown Market<\/span><span[^>]*>Main</.test(html));
ok('V5 others reflect the record (Ballroom off, Keter on)', boxes[1].props.checked === false && boxes[2].props.checked === true);
ok('V6 rows are 44px labels', (html.match(/<label[^>]*min-h-11/g) || []).length === 3);
ok('V7 nothing under 12px, no palette/hex/gradient/font-black', !/text-\[(\d|1[01])px\]|font-black|gradient|\b(bg|text|border)-(emerald|rose|zinc|slate|gray|red|green|blue|amber)-\d|#[0-9a-f]{6}\b|bg-white\b/.test(html));
const saveBtn = () => s.find((e) => e.type === 'button' && /Save/.test(String(e.props.children)))[0];
ok('V8 Save disabled until something changes', saveBtn().props.disabled === true);
let calls = fetchAnswer(200, { success: true });
await saveBtn().props.onClick({ preventDefault() {} }); await s.render();
ok('V9 no write when unchanged', calls.length === 0);
// toggle Ballroom on
await boxes[1].props.onChange({ target: { checked: true } }); await s.render();
ok('V10 Save enabled after a change', saveBtn().props.disabled === false);
await s.click('Save');
const put = calls.find((c) => c[0] === 'PUT');
ok('V11 PUT /api/users/u1/venues', !!put && /\/api\/users\/u1\/venues$/.test(put[1].split('?')[0]), JSON.stringify(calls));
ok('V12 body venueIds = main first, then venue-list order', JSON.stringify(put?.[2]?.venueIds) === JSON.stringify(['vA', 'vB', 'vC']), JSON.stringify(put?.[2]));
ok('V13 expectedVenueIds = the record', JSON.stringify(put?.[2]?.expectedVenueIds) === JSON.stringify(['vA', 'vC']));
ok('V14 expectedVersion = baseline captured at OPEN (41), not the latest (57)', put?.[2]?.expectedVersion === 41, String(put?.[2]?.expectedVersion));
ok('V15 success -> onSaved', saved === 1);
// errors
async function errCase(status, body, expectLine, label) {
  observeVersion(60);
  const e = mount(VenueAccessSheet, { record: yossi, venues: V, onClose: noop, onSaved: () => { saved += 100; } });
  await e.render();
  const bx = e.find((x) => x.type === 'input' && x.props.type === 'checkbox');
  await bx[2].props.onChange({ target: { checked: false } }); await e.render();
  fetchAnswer(status, body);
  await e.click('Save');
  const h = dec(e.html());
  ok(`${label} shows "${expectLine}"`, h.includes(expectLine), h.slice(h.indexOf('role="alert"') - 20, h.indexOf('role="alert"') + 200));
  const bx2 = e.find((x) => x.type === 'input' && x.props.type === 'checkbox');
  ok(`${label} sheet stays open with the picks kept`, /role="dialog"/.test(h) && bx2[2].props.checked === false && saved < 100);
}
await errCase(409, { error: 'This account has not been upgraded yet; try again shortly.', code: 'NOT_MIGRATED' }, "This person's account needs a one-time upgrade first.", 'V16 NOT_MIGRATED');
await errCase(409, { error: 'Conflict', code: 'VENUES_CHANGED' }, "Someone else just changed this person's venues. Close and reopen to see the latest.", 'V17 VENUES_CHANGED');
await errCase(409, { error: 'Version conflict', code: 'VERSION_CONFLICT' }, "Someone else just changed this person's venues. Close and reopen to see the latest.", 'V18 VERSION_CONFLICT');
await errCase(400, { error: 'Every venue must be a venue of your agency.', code: 'VENUE_NOT_IN_AGENCY' }, 'Every venue must be a venue of your agency.', 'V19 other error');

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
