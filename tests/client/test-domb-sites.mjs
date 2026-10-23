/** Domains PR B (client): site answer parsing, refusal handling, branded sign-in, refusal screens, Agency ID, passkey labels. */
import React from 'react';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; }
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const events = [];
globalThis.window = { location: { hostname: 'app.valley.test', pathname: '/' }, dispatchEvent: (e) => { events.push(e); return true; }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: function CustomEventStub(type, init) { return { type, detail: init?.detail }; } });
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {}, cookie: '' };
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
let handler = () => ({ status: 200, body: {} });
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  const r = await handler(String(url), opts);
  if (r === 'THROW') throw new TypeError('offline');
  const body = r.body;
  return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, headers: { get: (h) => (h.toLowerCase() === 'x-data-version' ? null : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => JSON.stringify(body), clone() { return this; } };
};
const S = await import('../../src/lib/site.ts');
const api = await import('../../src/lib/api.ts');
const PK = await import('../../src/lib/passkeys.ts');
const { SiteRefusedScreen } = await import('../../src/components/SiteRefusedScreen.tsx');
const { LoginPage } = await import('../../src/components/LoginPage.tsx');
const { AgencySettingsForm } = await import('../../src/components/AgencySettingsSheet.tsx');
const SHARED_O = 'https://workers-collaborative-dashboard-1080260390009.us-east1.run.app';

// --- safeSharedOrigin: only the server's origin, https (http on loopback for local tests) ---
check('https origin kept', S.safeSharedOrigin(SHARED_O) === SHARED_O);
check('loopback http kept', S.safeSharedOrigin('http://127.0.0.1:3494') === 'http://127.0.0.1:3494');
check('path refused', S.safeSharedOrigin(SHARED_O + '/x') === null);
check('javascript: refused', S.safeSharedOrigin('javascript:alert(1)') === null);
check('plain http elsewhere refused', S.safeSharedOrigin('http://evil.test') === null);
check('non-string refused', S.safeSharedOrigin(5) === null && S.safeSharedOrigin(null) === null);

// --- parseSiteAnswer ---
check('shared', S.parseSiteAnswer({ site: 'shared' })?.site === 'shared');
const unk = S.parseSiteAnswer({ site: 'unknown', sharedOrigin: SHARED_O });
check('unknown + origin', unk.site === 'unknown' && unk.sharedOrigin === SHARED_O);
check('unknown with bad origin -> null origin', S.parseSiteAnswer({ site: 'unknown', sharedOrigin: 'javascript:x' }).sharedOrigin === null);
const ag = S.parseSiteAnswer({ site: 'agency', agency: { name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: 'r1' }, sharedOrigin: SHARED_O });
check('agency parsed', ag.site === 'agency' && ag.agency.name === 'Valley Vaad' && ag.agency.logoRev === 'r1' && ag.agency.shortCode === 'VV');
check('agency without name -> null', S.parseSiteAnswer({ site: 'agency', agency: { name: '' } }) === null);
check('garbage -> null', S.parseSiteAnswer(null) === null && S.parseSiteAnswer({ site: 'x' }) === null && S.parseSiteAnswer('shared') === null);
check('brandName wins for display', S.siteDisplayName({ name: 'Valley Vaad Inc', brandName: 'Valley Vaad', shortCode: '', logoRev: null }) === 'Valley Vaad');
check('name when no brandName', S.siteDisplayName(ag.agency) === 'Valley Vaad');

// --- siteWaitNeeded: Cloud Run and local hosts open as today ---
check('run.app no wait', !S.siteWaitNeeded('workers-collaborative-dashboard-1080260390009.us-east1.run.app'));
check('a.run.app no wait', !S.siteWaitNeeded('workers-collaborative-dashboard-je3qe44lta-ue.a.run.app'));
check('localhost no wait', !S.siteWaitNeeded('localhost') && !S.siteWaitNeeded('127.0.0.1'));
check('custom host waits', S.siteWaitNeeded('app.hartfordkashrut.org'));

// --- siteRefusalFrom ---
check('403 WRONG_SITE', S.siteRefusalFrom(403, { code: 'WRONG_SITE', sharedOrigin: SHARED_O })?.code === 'WRONG_SITE');
check('403 SITE_NOT_SET_UP', S.siteRefusalFrom(403, { code: 'SITE_NOT_SET_UP', sharedOrigin: SHARED_O })?.sharedOrigin === SHARED_O);
check('401 WRONG_SITE (recovery hint)', S.siteRefusalFrom(401, { code: 'WRONG_SITE' })?.code === 'WRONG_SITE');
check('401 SITE_NOT_SET_UP ignored', S.siteRefusalFrom(401, { code: 'SITE_NOT_SET_UP' }) === null);
check('other status ignored', S.siteRefusalFrom(400, { code: 'WRONG_SITE' }) === null && S.siteRefusalFrom(404, { code: 'WRONG_SITE' }) === null);
check('other code ignored', S.siteRefusalFrom(403, { code: 'CSRF_ORIGIN' }) === null && S.siteRefusalFrom(403, null) === null);

// --- loadSite: one call per page; failure = shared (today's page) ---
S.resetSiteForTests();
handler = () => 'THROW';
check('offline -> shared', (await S.loadSite()).site === 'shared' && S.currentSite().site === 'shared');
S.resetSiteForTests(); calls.length = 0;
handler = (u) => (u.startsWith('/api/site') ? { body: { site: 'agency', agency: { name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: null }, sharedOrigin: SHARED_O } } : { body: {} });
const a1 = S.loadSite(); const a2 = S.loadSite();
check('one request per page', (await a1) === (await a2) && calls.filter((c) => c.url === '/api/site').length === 1);
check('no-store', calls[0].opts.cache === 'no-store');
S.resetSiteForTests();
handler = () => ({ status: 500, body: {} });
check('5xx -> shared', (await S.loadSite()).site === 'shared');
S.resetSiteForTests();
handler = () => ({ body: { site: 'weird' } });
check('unreadable -> shared', (await S.loadSite()).site === 'shared');

// --- loadSiteLogo ---
handler = () => ({ body: { rev: 'r1', mime: 'image/png', data: 'YQ==' } });
check('logo data url', (await S.loadSiteLogo('r1')) === 'data:image/png;base64,YQ==');
check('logo url carries rev', calls.at(-1).url === '/api/site/logo?rev=r1');
handler = () => ({ body: { rev: 'r2', mime: 'image/png', data: 'YQ==' } });
check('wrong rev refused', (await S.loadSiteLogo('r1')) === null);
handler = () => ({ body: { rev: 'r1', mime: 'image/svg+xml', data: 'YQ==' } });
check('svg refused', (await S.loadSiteLogo('r1')) === null);
handler = () => ({ body: { rev: 'r1', mime: 'image/png', data: 'not base64!' } });
check('bad data refused', (await S.loadSiteLogo('r1')) === null);
handler = () => ({ status: 404, body: {} });
check('404 -> null', (await S.loadSiteLogo('r1')) === null);
check('no rev -> null without a call', (calls.length, await S.loadSiteLogo(null)) === null);

// --- apiFetch: a site refusal clears the sign-in it used and shows the screen; never on the shared address ---
const siteEvents = () => events.filter((e) => e.type === S.SITE_REFUSED_EVENT);
S.resetSiteForTests();
handler = (u) => (u === '/api/site' ? { body: { site: 'agency', agency: { name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: null }, sharedOrigin: SHARED_O } } : { status: 403, body: { code: 'WRONG_SITE', sharedOrigin: SHARED_O, error: 'x' } });
await S.loadSite();
api.setSessionToken('tok-1'); events.length = 0;
let r = await api.apiFetch('/api/tasks');
check('403 still returned to caller', r.status === 403);
check('token cleared', api.getSessionToken() === null);
check('event with code + origin', siteEvents().length === 1 && siteEvents()[0].detail.code === 'WRONG_SITE' && siteEvents()[0].detail.sharedOrigin === SHARED_O);
check('no session-expired event', !events.some((e) => e.type === 'shutfey:unauthorized'));
// a newer sign-in stored while the refused request was in flight is kept
api.setSessionToken('tok-old'); events.length = 0;
handler = (u, o) => { api.setSessionToken('tok-new'); return { status: 403, body: { code: 'WRONG_SITE', sharedOrigin: SHARED_O } }; };
await api.apiFetch('/api/tasks');
check('newer token kept', api.getSessionToken() === 'tok-new' && siteEvents().length === 1);
// SITE_NOT_SET_UP from a signed-out page: event, nothing to clear
api.setSessionToken(null); events.length = 0;
handler = () => ({ status: 403, body: { code: 'SITE_NOT_SET_UP', sharedOrigin: SHARED_O } });
await api.apiFetch('/api/auth/login', { method: 'POST', body: '{}' });
check('not-set-up event', siteEvents().length === 1 && siteEvents()[0].detail.code === 'SITE_NOT_SET_UP');
// other 403s: nothing
api.setSessionToken('tok-2'); events.length = 0;
handler = () => ({ status: 403, body: { code: 'FORBIDDEN', error: 'no' } });
await api.apiFetch('/api/tasks');
check('other 403 keeps token, no event', api.getSessionToken() === 'tok-2' && siteEvents().length === 0);
// on the shared address the codes are ignored entirely (today's behaviour)
S.resetSiteForTests();
handler = (u) => (u === '/api/site' ? { body: { site: 'shared' } } : { status: 403, body: { code: 'WRONG_SITE', sharedOrigin: SHARED_O } });
await S.loadSite(); events.length = 0;
await api.apiFetch('/api/tasks');
check('shared: token kept, no event', api.getSessionToken() === 'tok-2' && siteEvents().length === 0);
check('shared: noticeSiteRefusal false', S.noticeSiteRefusal(403, { code: 'WRONG_SITE' }) === false && siteEvents().length === 0);
api.setSessionToken(null);

// --- passkey address labels ---
check('label shared', PK.passkeyAddressLabel(PK.passkeyAddressFrom({ kind: 'shared' })) === 'Shutfey address');
check('label site', PK.passkeyAddressLabel(PK.passkeyAddressFrom({ kind: 'site', agencyName: 'Valley Vaad' })) === 'Valley Vaad address');
check('label earlier', PK.passkeyAddressLabel(PK.passkeyAddressFrom({ kind: 'earlier' })) === 'Earlier Shutfey address');
check('label other', PK.passkeyAddressLabel(PK.passkeyAddressFrom({ kind: 'other' })) === 'Another address');
check('site without name -> other', PK.passkeyAddressFrom({ kind: 'site' }).kind === 'other');
check('absent (older server) -> no label', PK.passkeyAddressLabel(PK.passkeyAddressFrom(undefined)) === null && PK.passkeyAddressFrom({ kind: 'zzz' }) === undefined);
handler = () => ({ body: { passkeys: [{ id: 'a', name: 'iPhone', createdAt: '', lastUsedAt: null, address: { kind: 'site', agencyName: 'Valley Vaad' } }, { id: 'b', name: 'Old', createdAt: '' }], canAdd: true } });
const list = await PK.listPasskeys();
check('list carries address', list.passkeys[0].address.kind === 'site' && list.passkeys[1].address === undefined);

// --- refusal screens ---
const agency = { name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: null };
let html = renderToStaticMarkup(React.createElement(SiteRefusedScreen, { code: 'WRONG_SITE', agency, sharedOrigin: SHARED_O, onBack: () => {} }));
check('wrong-site words', html.includes('This address is for Valley Vaad only.') && html.includes('Your agency signs in at the Shutfey address.'));
check('button to the server-named address', html.includes(`href="${SHARED_O}/"`) && html.includes('Go to the Shutfey address'));
check('back to sign-in offered', html.includes('Back to sign-in'));
check('agency name shown large (no logo)', html.includes('data-site-name') && html.includes('Powered by Shutfey'));
html = renderToStaticMarkup(React.createElement(SiteRefusedScreen, { code: 'SITE_NOT_SET_UP', agency: null, sharedOrigin: SHARED_O }));
check('not-set-up words', html.includes("This address isn&#x27;t set up yet.") && html.includes('Please use the Shutfey address.') && !html.includes('Back to sign-in'));
html = renderToStaticMarkup(React.createElement(SiteRefusedScreen, { code: 'WRONG_SITE', agency: null, sharedOrigin: null }));
check('no origin -> no link, plain words', !html.includes('data-go-shared') && html.includes('This address is for another agency.'));

// --- LoginPage: branded on an agency address, unchanged otherwise ---
const base = { onLoginSuccess() {}, darkMode: false, onToggleDarkMode() {} };
html = renderToStaticMarkup(React.createElement(LoginPage, { ...base, site: agency, initialMode: 'signup' }));
check('branded (no logo): name once, large, then "Sign in"', html.includes('data-site-name') && html.split('Valley Vaad').length - 1 === 1 && html.includes('>Sign in<') && html.includes('Powered by Shutfey'));
check('branded: no registration', !html.includes('Register Agency') && !html.includes('Sign Up Kosher Agency') && !html.includes('Kosher Agency Registration'));
check('branded: sign-in form even when asked for signup', html.includes('type="password"'));
check('branded: name in large text without logo', html.includes('data-site-name'));
const plain = renderToStaticMarkup(React.createElement(LoginPage, { ...base, onBack() {} }));
check('shared page unchanged: registration + Shutfey copy', plain.includes('Register Agency') && plain.includes('Sign Up Kosher Agency') && plain.includes('Kosher Shift &amp; Daily Board') && !plain.includes('Powered by Shutfey'));
const plainNoProp = renderToStaticMarkup(React.createElement(LoginPage, { ...base, onBack() {}, site: null }));
check('site=null identical to no prop', plainNoProp === plain);

// --- Agency settings: read-only Agency ID line ---
handler = (u) => (u.startsWith('/api/agencies/current') ? { body: { agency: { id: 'agency-vv-demo', name: 'Valley Vaad', contactPhone: '', timeZone: 'America/New_York' } } } : { body: {} });
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { const res = await origFetch(url, opts); res.headers = { get: (h) => (h.toLowerCase() === 'x-state-version' ? '7' : null) }; return res; };
const sheet = mount(AgencySettingsForm, { isOpen: true, onClose() {}, onSaved() {} });
await sheet.render();
const sheetHtml = sheet.html();
check('Agency ID line', sheetHtml.includes('data-agency-id') && sheetHtml.includes('Agency ID') && sheetHtml.includes('agency-vv-demo'));
check('Agency ID is not an input', !/<input[^>]*agency-vv-demo/.test(sheetHtml));
globalThis.fetch = origFetch;

console.log(`DOMB CLIENT: ${passed}/${passed} checks passed`);
