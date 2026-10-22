// 10M part 1 client: "I already have a Shutfey account" on the agency sign-up page.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { AgencySignupForm } from '../../src/components/AgencySignupForm.tsx';
let pass = 0, fail = 0;
const ok = (l, c) => { if (c) pass++; else { fail++; console.log('FAIL ' + l); } };
const html = renderToStaticMarkup(React.createElement(AgencySignupForm, { onSuccess() {}, onSwitchToLogin() {} }));
ok('mode choice shown, new account by default', html.includes('data-signup-mode="new"') && html.includes('New Shutfey account') && html.includes('I already have a Shutfey account'));
ok('new mode keeps the name, address and create button', html.includes('Full Name *') && html.includes('Address (Optional)') && html.includes('Create Agency Account &amp; Launch Portal'));
ok('new mode has no existing-account note', !html.includes('data-existing-account-note'));
const src = fs.readFileSync(new URL('../../src/components/AgencySignupForm.tsx', import.meta.url), 'utf8');
ok('existing mode goes through registerIntoExistingAccount, not apiFetch', src.includes('await registerIntoExistingAccount({') && !src.includes("apiFetch('/api/agencies/register-existing'"));
const ex = src.slice(src.indexOf('await registerIntoExistingAccount({'), src.indexOf("await apiFetch('/api/agencies/register',"));
ok('existing body: email, password, operationId, contactPhone; no adminName / adminPassword / address', ex.includes('email: cleanAdminEmail') && ex.includes('password: cleanAdminPassword') && ex.includes('operationId: operationIdRef.current') && ex.includes('contactPhone:') && !ex.includes('adminName') && !ex.includes('adminPassword') && !ex.includes('initialVenueAddress'));
ok('one operation id per form (useRef), matches the server shape', /useRef<string>\(\s*`op-\$\{Date\.now\(\)\.toString\(36\)\}-\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 12\)\}`/.test(src));
const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
ok('generated id passes /^[A-Za-z0-9_-]{8,100}$/', /^[A-Za-z0-9_-]{8,100}$/.test(id));
ok('existing mode: plain note, labels and button', src.includes('Use the email and password you already sign in with.') && src.includes("'Your email *'") && src.includes("'Your password *'") && src.includes("'Add Agency to My Account'"));
ok('existing mode: name and address hidden', /\{!hasAccount && \(\s*<div>\s*<label[^>]*>\s*Full Name \*/.test(src) && /\{!hasAccount && \(\s*<div>\s*<label[^>]*>\s*Address \(Optional\)/.test(src));
ok('existing mode: no 6-character rule', src.includes('if (!hasAccount && cleanAdminPassword.length < 6)'));
ok('the old register call is unchanged for new accounts', src.includes('adminPassword: cleanAdminPassword,') && src.includes("await apiFetch('/api/agencies/register',"));

// RV1 B1: a wrong password must not sign out a session already on this device.
const store = new Map([['shutfey_session_token', 'tok-existing']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.sessionStorage = globalThis.localStorage;
const events = [];
globalThis.window = { dispatchEvent: (e) => { events.push(e && e.type); return true; }, localStorage: globalThis.localStorage };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
const seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url, headers: new Headers(init && init.headers), body: init && init.body });
  return new Response(JSON.stringify({ error: 'Email or password is incorrect.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
};
const { registerIntoExistingAccount } = await import('../../src/lib/registerExisting.ts');
const api = await import('../../src/lib/api.ts');
const before = api.getSessionToken();
const res = await registerIntoExistingAccount({ agencyName: 'X', initialVenueName: 'Y', initialVenueCategory: 'Restaurant', email: 'a@b.test', password: 'nope', operationId: 'op-test-123456' });
ok('wrong password: 401 with the server words', res.ok === false && res.status === 401 && res.data.error === 'Email or password is incorrect.');
ok('the request goes to register-existing with no session token and no kiosk header', seen.length === 1 && seen[0].url === '/api/agencies/register-existing' && !seen[0].headers.has('Authorization') && !seen[0].headers.has('X-Kiosk-Device'));
ok('the stored session is untouched and no sign-out event fired', before === 'tok-existing' && api.getSessionToken() === 'tok-existing' && !events.includes('shutfey:unauthorized'));
globalThis.fetch = async () => new Response('not json', { status: 502 });
const res2 = await registerIntoExistingAccount({ agencyName: 'X', initialVenueName: 'Y', initialVenueCategory: 'Restaurant', email: 'a@b.test', password: 'p', operationId: 'op-test-123456' });
ok('a non-JSON error answer does not crash (empty data)', res2.ok === false && res2.status === 502 && typeof res2.data === 'object');
console.log(`${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
