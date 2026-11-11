import assert from 'node:assert/strict';
import { mount } from './lib/mini-render.mjs';
import { FactoryVisitScreen, ItemSheet, VisitOutbox, useVisitFocus, compressReportPhoto } from '../../src/components/FactoryVisitScreen.tsx';
import { setSessionToken } from '../../src/lib/api.ts';
import { newDraft, saveDraft, restoreDraft, setMark, buildPayload, readOutbox, queueReport, visitScope } from '../../src/lib/inspectionVisit.ts';
import { normalizeSubmit, buildReport } from '../../src/server/inspections/model.ts';
const values = new Map();
globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
globalThis.window = new EventTarget(); globalThis.document = new EventTarget(); document.activeElement = null;
const item = { id: 'i', name: ' Exact שם ', brand: ' Brand ', code: '', certificationRaw: ' Raw ', statusRaw: '', agency: '', dpm: '', group1: false };
const list = { company: { id: 'c', name: 'Factory', brand: '', plant: '' }, listVersion: 'v', refreshedAt: null, backupTakenAt: '2026-11-01T12:00:00Z', ingredients: [item], products: [] };
const scope = visitScope('u', 'a');
let draft = setMark(newDraft(list, 'report-round2', '2026-11-01T12:00:00Z'), 'ingredient', item.id, { status: 'checked' });
saveDraft(localStorage, scope, draft);
const changed = restoreDraft(localStorage, scope, { ...list, listVersion: 'v2', ingredients: [] });
assert.equal(changed.draft.marks.length, 1); assert.equal(changed.draft.marks[0].item.name, item.name);
const re = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const normalized = normalizeSubmit(buildPayload(changed.draft), 400000, re);
const context = { id: 'r', agencyId: 'a', userId: 'u', userName: 'User', companyName: 'Factory', listVersion: 'v2', items: () => [], now: '2026-11-01T13:00:00Z', fee: null };
const removed = buildReport(normalized, context); assert.equal(removed.marks[0].itemMissing, true); assert.equal(removed.counts.checked, 1);
assert.throws(() => buildReport(normalizeSubmit({ ...buildPayload(draft), marks: [{ kind: 'ingredient', itemId: 'unknown', status: 'checked' }] }, 400000, re), context), /Unknown item/);
assert.throws(() => normalizeSubmit({ ...buildPayload(draft), marks: [{ ...draft.marks[0], item: { name: 'Incomplete' } }] }, 400000, re), /snapshot/);
const photo = length => 'data:image/jpeg;base64,' + 'A'.repeat(length - 'data:image/jpeg;base64,'.length - 1) + '=';
const four = { ...draft, marks: [], offList: Array.from({ length: 4 }, () => ({ name: 'Photo', photo: photo(225000) })) };
assert.equal(four.offList.reduce((sum, row) => sum + row.photo.length, 0), 900000);
assert.equal(buildPayload(four).offList.length, 4); assert.equal(Object.keys(normalizeSubmit(four, 400000, re).photos).length, 4);
const over = { ...four, offList: four.offList.map((row, i) => i ? row : { ...row, photo: photo(225001) }) };
assert.throws(() => buildPayload(over), /photos together are too large/); assert.throws(() => normalizeSubmit(over, 400000, re), /900000/);
// Bad JSON and bad shapes retain exact bytes and cannot block valid neighbours.
queueReport(localStorage, scope, draft);
localStorage.setItem(`${scope}:outbox:bad`, '{broken bytes'); localStorage.setItem(`${scope}:outbox:shape`, '{}');
assert.equal(readOutbox(localStorage, scope).length, 1); assert.equal(localStorage.getItem(`${scope}:quarantine:bad`), '{broken bytes'); assert.equal(localStorage.getItem(`${scope}:quarantine:shape`), '{}');
values.delete(`${scope}:outbox:report-round2`);
// The same real components mounted by App: worker precedes the screen and cookie generation changes after its mount.
localStorage.setItem('shutfey_cookie_session', 'cookie-style-sign-in');
let posts = [], resolvePost, offline = false, who = 'u', status = 201, rotateDuringCheck = true, identityChecks = 0;
globalThis.fetch = async (url, options = {}) => {
  if (offline) throw Error('Offline');
  if (url === '/api/auth/me') { identityChecks++; if (rotateDuringCheck) { rotateDuringCheck = false; setSessionToken(null); } return Response.json({ user: { id: who, agencyId: 'a' } }); }
  if (url === '/api/visits/factories') return Response.json({ companies: [{ ...list.company, ingredientCount: 1, productCount: 0 }] });
  if (url === '/api/visits/factories/c') return Response.json(list);
  if (url === '/api/visits/reports') { posts.push(options.body); return new Promise(resolve => { resolvePost = () => resolve(Response.json(status < 400 ? { report: { ...removed, id: 'r' }, fee: null } : { error: 'Edit report' }, { status })); }); }
  throw Error(url);
};
const heldLocks = new Set();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name, _options, fn) => {
  if (heldLocks.has(name)) return fn(null);
  heldLocks.add(name); try { await fn({}); } finally { heldLocks.delete(name); }
} } } });
const interval = globalThis.setInterval; globalThis.setInterval = () => 0;
try {
  saveDraft(localStorage, scope, four);
  const budgetScreen = mount(FactoryVisitScreen, { userId: 'u', agencyId: 'a', timeZone: 'UTC', onClose() {} });
  await budgetScreen.render(); await budgetScreen.click('Factory'); await budgetScreen.click('Edit item');
  const findSheet = node => !node ? undefined : Array.isArray(node) ? node.map(findSheet).find(Boolean) : node.type === ItemSheet ? node : findSheet(node.props?.children);
  const failure = findSheet(budgetScreen.tree()).props.onSave({ ...four.offList[0], photo: photo(225001) });
  assert.match(failure, /photos together are too large/);
  saveDraft(localStorage, scope, draft);
  const worker = mount(VisitOutbox, { userId: 'u', agencyId: 'a' }); await worker.render();
  setSessionToken(null); // Same cookie session, new credentialGeneration.
  const screen = mount(FactoryVisitScreen, { userId: 'u', agencyId: 'a', timeZone: 'UTC', onClose() {} }); await screen.render(); await screen.click('Factory');
  assert.match(screen.text(), /Saved copy from/); assert.doesNotMatch(screen.text(), /List updated —/);
  await screen.click('Review and send'); await screen.click('Send report');
  await worker.render(); await screen.render(); assert.equal(posts.length, 1); assert.equal(identityChecks, 2); assert.match(screen.text(), /Sending…/);
  assert.equal(screen.buttons().some(b => /Edit|Remove/.test(b.label)), false);
  const otherTab = mount(VisitOutbox, { userId: 'u', agencyId: 'a' }); await otherTab.render();
  assert.equal(posts.length, 1); // A second mounted worker cannot POST the in-flight entry.
  for (const name of ['focus', 'online', 'inspection-send']) window.dispatchEvent(new Event(name));
  await worker.render(); assert.equal(posts.length, 1);
  resolvePost(); await worker.render(); await screen.render(); assert.match(screen.text(), /We got it/); assert.equal(posts.length, 1);
  // Unknown result is retried byte-for-byte, and no Edit is available until a definite 4xx.
  const next = { ...draft, clientReportId: 'report-uncertain' }; saveDraft(localStorage, scope, next); queueReport(localStorage, scope, next);
  const fetchReal = globalThis.fetch; globalThis.fetch = async (url, options) => { if (url === '/api/visits/reports') { posts.push(options.body); throw Error('Connection interrupted'); } return fetchReal(url, options); };
  window.dispatchEvent(new Event('inspection-send')); await worker.render();
  const uncertain = readOutbox(localStorage, scope).find(e => e.draft.clientReportId === next.clientReportId); assert.equal(uncertain.stopped, false); assert.equal(uncertain.sending, false);
  const waiting = mount(FactoryVisitScreen, { userId: 'u', agencyId: 'a', timeZone: 'UTC', onClose() {} }); await waiting.render(); await waiting.click('View waiting report'); assert.equal(waiting.buttons().some(b => b.label === 'Edit'), false);
  localStorage.setItem(`${scope}:outbox:${next.clientReportId}`, JSON.stringify({ ...uncertain, nextAttempt: 0 }));
  globalThis.fetch = fetchReal; status = 400; window.dispatchEvent(new Event('focus')); await worker.render(); assert.equal(posts.at(-1), posts.at(-2)); resolvePost(); await worker.render(); await waiting.render(); assert.ok(waiting.buttons().some(b => b.label === 'Edit'));
  await waiting.click('Edit'); assert.equal(readOutbox(localStorage, scope).some(e => e.draft.clientReportId === next.clientReportId), false);
  // Different signed-in user cannot send this membership's queued bytes.
  who = 'different'; queueReport(localStorage, scope, { ...draft, clientReportId: 'report-other-user' }); const n = posts.length; window.dispatchEvent(new Event('inspection-send')); await worker.render(); assert.equal(posts.length, n);
  // Saved factory list reopens without any network and retains its marks and source text.
  offline = true; saveDraft(localStorage, scope, { ...draft, clientReportId: 'report-offline-new' });
  const reopen = mount(FactoryVisitScreen, { userId: 'u', agencyId: 'a', timeZone: 'UTC', onClose() {} }); await reopen.render(); await reopen.click(e => e.props.children?.some?.(child => child?.props?.children === 'Factory')); assert.match(reopen.text(), /Draft restored/); assert.equal(JSON.parse(localStorage.getItem(`${scope}:draft:c`)).marks[0].item.name, item.name);
} finally { globalThis.setInterval = interval; }
// Compression uses bounded dimensions and report-specific JPEG quality.
globalThis.FileReader = class { readAsDataURL() { this.result = 'data:image/jpeg;base64,YQ=='; this.onload(); } };
globalThis.Image = class { width = 4000; height = 2000; set src(_) { this.onload(); } };
let canvas;
document.createElement = () => canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: (type, quality) => { assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.7); return 'data:image/jpeg;base64,YQ=='; } };
await compressReportPhoto({}); assert.equal(canvas.width, 1280); assert.equal(canvas.height, 640);
console.log('round 2 regressions: retained snapshots, photo budget, quarantine, cookie generation, one send, uncertain retry, identity isolation, offline reopen and compression passed');
// Shared focus logic contains Tab, gives Escape to the top dialog, and restores focus.
const listeners = new Map(); let restored = 0, cleanup;
globalThis.document = { activeElement: { isConnected: true, focus() { restored++; } }, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {} };
const React = (await import('react')).default;
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previousDispatcher = internals.H;
const first = { focus() { document.activeElement = first; } }, last = { focus() { document.activeElement = last; } };
const root = { querySelectorAll: () => [first, last], contains: node => node === first || node === last };
let refs = 0, closes = 0;
internals.H = { useRef: value => ({ current: refs++ === 0 ? root : value }), useEffect: fn => { cleanup = fn(); } };
try { useVisitFocus(() => { closes++; }); } finally { internals.H = previousDispatcher; }
assert.equal(document.activeElement, first);
let prevented = 0;
listeners.get('keydown')({ key: 'Tab', shiftKey: true, preventDefault() { prevented++; } }); assert.equal(document.activeElement, last);
listeners.get('keydown')({ key: 'Tab', shiftKey: false, preventDefault() { prevented++; } }); assert.equal(document.activeElement, first);
listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(closes, 1); assert.equal(prevented, 2);
cleanup(); assert.equal(restored, 1);
