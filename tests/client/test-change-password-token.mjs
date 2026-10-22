/**
 * QA2 #15 client prep: changing your password keeps THIS phone signed in.
 * The change-password answer carries a fresh token for the calling session (server
 * #126 bumps every session's epoch); the client must store it, or its next call is 401.
 *  K  a token in the answer is stored (Authorization of the next call uses it).
 *  N  no token in the answer (today's single-row server): the old token stays.
 *  W  wrong current password: nothing stored, the person stays signed in, plain words.
 * Run: npx tsx tests/client/test-change-password-token.mjs
 */
import React from 'react';
import { mount } from './lib/mini-render.mjs';
import { ChangePasswordModal } from '../../src/components/ChangePasswordModal.tsx';
import { setSessionToken, getSessionToken } from '../../src/lib/api.ts';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { location: { origin: 'https://app.example', pathname: '/', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const raw = String(url);
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    const h = opts.headers instanceof Headers ? Object.fromEntries(opts.headers.entries()) : Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push([method, path, body ?? null, h, raw]);
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body, h);
    if (r === 'THROW') throw new TypeError('network');
    r = r || { status: 200, body: {} };
    const hdr = r.headers || {};
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => hdr[k] ?? null }, clone() { return this; }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}

const user = { id: 'u-m', name: 'Moshe M', email: 'moshe@x.test', role: 'mashgiach', agencyId: 'ag1', venueId: 'v1' };
async function change(answer) {
  const calls = stubFetch({ 'POST /api/auth/change-password': answer });
  const m = mount(ChangePasswordModal, { isOpen: true, onClose() {}, currentUser: user });
  await m.render();
  await m.type('Enter current password', 'oldpass123');
  await m.type('Enter new password', 'newpass456');
  await m.type('Re-enter new password', 'newpass456');
  await m.submit();
  return { m, calls };
}
{
  setSessionToken('old-token');
  const { m, calls } = await change({ status: 200, body: { success: true, token: 'fresh-token' } });
  ok('K one POST, sent with the old token', calls.length === 1 && calls[0][3].authorization === 'Bearer old-token', JSON.stringify(calls[0]?.[3]));
  ok('K the fresh token from the answer is stored', getSessionToken() === 'fresh-token', String(getSessionToken()));
  ok('K success shown', decode(m.html()).includes('Password') );
}
{
  setSessionToken('old-token');
  await change({ status: 200, body: { success: true } });
  ok('N no token in the answer: the old token stays', getSessionToken() === 'old-token', String(getSessionToken()));
  setSessionToken('old-token');
  await change({ status: 200, body: { success: true, token: '' } });
  ok('N an empty token is ignored', getSessionToken() === 'old-token');
}
{
  setSessionToken('old-token');
  const { m } = await change({ status: 401, body: { code: 'CURRENT_PASSWORD_WRONG', error: 'Current password is incorrect.', token: 'should-not-store' } });
  ok('W wrong current password: nothing stored, plain words', getSessionToken() === 'old-token' && decode(m.html()).includes('Current password is wrong. Please try again.'), decode(m.html()).slice(0, 200));
}
console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
console.log('ALL PASS');
