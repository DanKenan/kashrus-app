/**
 * QA2 client fixes.
 *   Q1 phone Events sheet: list OR details below md (list scrolls; a tap opens details; "All events" goes back); md+ unchanged.
 *   Q2 Change password: a wrong CURRENT password keeps the person signed in and says so.
 * Run: npx tsx tests/client/test-qa2-client.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const store = {}; globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, clear: () => { for (const k of Object.keys(store)) delete store[k]; } };
const events = []; globalThis.window = globalThis.window || {}; globalThis.window.dispatchEvent = (e) => { events.push(e.type); return true; };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t) { this.type = t; } };
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {}); globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {}, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [] };
const api = await import('../../src/lib/api.ts');

function answer(status, body) { globalThis.fetch = async () => ({ ok: status < 400, status, headers: { get: () => null }, clone() { return this; }, json: async () => body }); }
async function call(path, status, body) {
  events.length = 0; api.setSessionToken('tok-1'); answer(status, body);
  await api.apiFetch(path, { method: 'POST' });
  return { kept: api.getSessionToken() === 'tok-1', signedOutEvent: events.includes('shutfey:unauthorized') };
}
// ---- Q2: apiFetch's 401 rule ----
let r = await call('/api/auth/change-password', 401, { error: 'Current password is incorrect.' });
ok('Q2 wrong current password (today\'s server words) -> still signed in', r.kept && !r.signedOutEvent, JSON.stringify(r));
r = await call('/api/auth/change-password', 401, { error: 'Sign in required. Please log in again.' });
ok('Q2 expired session on the same endpoint -> signed out as before', !r.kept && r.signedOutEvent, JSON.stringify(r));
r = await call('/api/tasks', 401, { error: 'Current password is incorrect.' });
ok('Q2 the words alone on another endpoint -> signed out (rule is narrow)', !r.kept && r.signedOutEvent);
r = await call('/api/anything', 401, { error: 'x', code: 'CURRENT_PASSWORD_WRONG' });
ok('Q2 code CURRENT_PASSWORD_WRONG (if the server adds it) -> still signed in', r.kept && !r.signedOutEvent);
r = await call('http://127.0.0.1:1/api/auth/change-password?x=1', 401, { error: 'Current password is incorrect.' });
ok('Q2 absolute URL / query still matched', r.kept);
r = await call('/api/auth/change-password', 401, null);
ok('Q2 401 with no body -> signed out as before', !r.kept && r.signedOutEvent);

// ---- Q2: the modal ----
const { ChangePasswordModal } = await import('../../src/components/ChangePasswordModal.tsx');
api.setSessionToken('tok-1'); events.length = 0;
answer(401, { error: 'Current password is incorrect.' });
const cp = mount(ChangePasswordModal, { isOpen: true, onClose: () => {}, currentUser: { id: 'u1', email: 'e@x', name: 'Eli', role: 'coordinator' }, onSuccessToast: () => {} });
await cp.render();
const pw = cp.find((e) => e.type === 'input');
for (const [i, v] of [[0, 'wrong-one'], [1, 'newpass123'], [2, 'newpass123']]) { await pw[i].props.onChange({ target: { value: v } }); await cp.render(); }
await cp.submit();
ok('Q2 modal says "Current password is wrong. Please try again."', cp.html().includes('Current password is wrong. Please try again.'), cp.text().slice(0, 200));
ok('Q2 ... and the session is kept', api.getSessionToken() === 'tok-1' && !events.includes('shutfey:unauthorized'));
answer(400, { error: 'New password must be at least 6 characters long.' });
await cp.submit();
ok('Q2 other errors still show the server words', cp.html().includes('New password must be at least 6 characters long.'));

// ---- Q1: phone Events sheet ----
const { EventsModal } = await import('../../src/components/EventsModal.tsx');
const today = '2026-10-22';
const evs = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, agencyId: 'a', venueId: 'v', title: `Event ${i + 1}`, location: 'Hall', date: today, mashgiachType: 'unassigned', status: 'confirmed', tasks: [], createdByEmail: 'x', createdByName: 'X', createdAt: today }));
const em = mount(EventsModal, { isOpen: true, onClose: () => {}, events: evs, currentUser: { id: 'u', email: 'c@x', name: 'C', role: 'coordinator', agencyId: 'a' }, currentVenue: null, allVenues: [], onOpenCreateEvent: () => {}, onToggleEventTask: async () => {}, onUpdateEvent: async () => {} });
await em.render();
const panels = () => {
  const divs = em.find((e) => e.type === 'div' && typeof e.props.className === 'string');
  const list = divs.find((e) => e.props.className.includes('md:w-80'));
  const det = divs.find((e) => e.props.className.includes('min-w-0 flex-1') && e.props.className.includes('overflow-y-auto'));
  return { list: list?.props.className || '', det: det?.props.className || '' };
};
let p = panels();
ok('Q1 phone: list shown, details hidden on open', !p.list.includes('max-md:hidden') && p.det.includes('max-md:hidden'), JSON.stringify(p));
ok('Q1 phone: the list panel fills the sheet and can shrink (so its list scrolls)', /\bflex-1\b/.test(p.list) && /\bmin-h-0\b/.test(p.list));
ok('Q1 md+: list keeps its column width, natural size', p.list.includes('md:w-80') && p.list.includes('lg:w-96') && p.list.includes('md:flex-initial'));
ok('Q1 details panel can shrink and scroll', /\bmin-h-0\b/.test(p.det) && p.det.includes('overflow-y-auto'));
await em.click('Event 12');
p = panels();
ok('Q1 phone: tap an event -> details shown, list hidden', p.list.includes('max-md:hidden') && !p.det.includes('max-md:hidden'), JSON.stringify(p));
ok('Q1 the tapped event is the one shown', em.text().includes('Event 12'));
const back = em.buttons().find((b) => b.label === 'All events');
ok('Q1 "All events" back button, phone only, 44px', !!back && /\bmd:hidden\b/.test(back.el.props.className) && /min-h-11/.test(back.el.props.className));
await em.click((e) => e.type === 'button' && em.buttons().some((b) => b.el === e && b.label === 'All events'));
p = panels();
ok('Q1 "All events" -> back to the list', !p.list.includes('max-md:hidden') && p.det.includes('max-md:hidden'));
await em.render({ isOpen: false }); await em.render({ isOpen: true });
p = panels();
ok('Q1 reopening starts on the list', !p.list.includes('max-md:hidden'));
await em.render({ focusEventId: 'e5' });
p = panels();
ok('Q1 a focused event (e.g. just copied) opens its details on a phone', p.list.includes('max-md:hidden') && em.text().includes('Event 6'));

const src = fs.readFileSync(new URL('../../src/components/EventsModal.tsx', import.meta.url), 'utf8');
const hookIdx = src.indexOf('const [phoneDetail'); const retIdx = src.indexOf('if (!isOpen) return null');
ok('Q1 hooks stay above the early return', hookIdx > 0 && retIdx > hookIdx && src.lastIndexOf('useEffect(', retIdx) > hookIdx);

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
