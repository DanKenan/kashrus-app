/**
 * Domains PR B follow-up (client): the invite page on an agency's own address shows the
 * agency's logo (or its name in large text) and a small "Powered by Shutfey"; on the shared
 * address (no site prop / site null) the invite page is exactly as before.
 * Run: npx tsx tests/client/test-invb-site-invite.mjs
 */
import React from 'react';
import fs from 'node:fs';
import { mount } from './lib/mini-render.mjs';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { location: { hostname: 'app.valley.test', origin: 'https://app.valley.test', pathname: '/invite', hash: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { InvitePage } = await import('../../src/components/InvitePage.tsx');
const SR = await import('../../src/components/SiteRefusedScreen.tsx');

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const count = (h, s) => h.split(s).length - 1;
const TOK = 'A'.repeat(20) + 'b_c-' + '9'.repeat(19);
const LOGO_B64 = 'iVBORw0KGgo=';

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const full = String(url).replace(/^https?:\/\/[^/]+/, '');
    const path = full.split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; try { body = JSON.parse(opts.body); } catch {}
    calls.push([method, path, full, body ?? null]);
    let r = routes[`${method} ${path}`];
    if (typeof r === 'function') r = r(body, full);
    if (r === 'THROW') throw new TypeError('network');
    r = r || { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, clone() { return this; }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}
const PREVIEW = (agencyName = 'Valley Vaad') => ({ status: 200, body: { kind: 'member', agencyName, role: 'mashgiach', name: 'Yossi Katz' } });
const LOGO = (rev) => ({ status: 200, body: { rev, mime: 'image/png', data: LOGO_B64 } });
async function page(routes, site) {
  const calls = stubFetch(routes); const logins = []; const left = [];
  store.clear();
  const props = { token: TOK, onLoginSuccess: (u) => logins.push(u), onLeave: () => left.push(1), darkMode: false, onToggleDarkMode() {} };
  if (site !== undefined) props.site = site;
  const m = mount(InvitePage, props);
  await m.render();
  return { m, calls, logins, left, html: () => decode(m.html()) };
}
const VV = { name: 'Valley Vaad', brandName: null, shortCode: 'VV', logoRev: null };
const VV_LOGO = { ...VV, logoRev: 'r7' };

// ---- shared address: exactly as before (no prop, and site: null) ----
const sharedNoProp = await page({ 'GET /api/invites/preview': PREVIEW() });
const sharedNull = await page({ 'GET /api/invites/preview': PREVIEW() }, null);
{
  const h = sharedNoProp.html();
  ok('shared: identical markup with and without site: null', h === sharedNull.html());
  ok('shared: Shutfey logo in the header, no agency brand, no "Powered by"', !h.includes('data-site-brand') && !h.includes('Powered by Shutfey') && !h.includes('data-site-logo') && !h.includes('data-site-name'));
  ok('shared: header layout unchanged (justify-between)', h.includes('justify-between') && !h.includes('justify-end'));
  ok('shared: "You\'re invited to join" + agency heading as before', h.includes("You're invited to join") && /data-invite-agency[^>]*>Valley Vaad</.test(h));
  ok('shared: no site logo request', !sharedNoProp.calls.some((c) => c[1] === '/api/site/logo') && !sharedNull.calls.some((c) => c[1] === '/api/site/logo'));
  const labels = sharedNoProp.m.buttons().map((b) => b.label);
  ok('shared: the two buttons unchanged', labels.includes('New to Shutfey? Choose a password') && labels.includes('Already use Shutfey? Sign in'), JSON.stringify(labels));
}
// Source pin: the shared branch of the header is the old element, untouched.
{
  const src = fs.readFileSync(new URL('../../src/components/InvitePage.tsx', import.meta.url), 'utf8');
  ok('source: Shutfey header logo only when there is no site', src.includes('{!site && <ShutfeyLogo size="sm" showSubtitle={true} />}'));
}

// ---- site address, no logo: the name in large text, said once, + Powered by Shutfey ----
{
  const s = await page({ 'GET /api/invites/preview': PREVIEW() }, VV);
  const h = s.html();
  ok('site no logo: brand block with the name in large text', h.includes('data-site-brand') && /data-site-name[^>]*>Valley Vaad</.test(h));
  ok('site no logo: small "Powered by Shutfey"', h.includes('data-powered-by') && h.includes('Powered by Shutfey'));
  ok('site no logo: no Shutfey header logo, header right-aligned', h.includes('justify-end') && !h.includes('justify-between'));
  ok('site no logo: agency name said once', count(h, 'Valley Vaad') === 1, String(count(h, 'Valley Vaad')));
  ok('site no logo: heading "You\'re invited" with name and role', h.includes("You're invited<") && h.includes('Yossi Katz') && h.includes('Mashgiach'));
  ok('site no logo: no logo request when the agency has none', !s.calls.some((c) => c[1] === '/api/site/logo'));
  const labels = s.m.buttons().map((b) => b.label);
  ok('site no logo: same two buttons', labels.includes('New to Shutfey? Choose a password') && labels.includes('Already use Shutfey? Sign in'));
}
// brandName is what the site shows; the invite's agency name may be the legal name -> same agency, once.
{
  const s = await page({ 'GET /api/invites/preview': PREVIEW('Valley Vaad') }, { ...VV, name: 'Valley Vaad', brandName: 'VVaad' });
  const h = s.html();
  ok('site brandName: big brand name, invite agency name matches the record name -> not repeated', /data-site-name[^>]*>VVaad</.test(h) && !h.includes('data-invite-agency'));
}
// Invite agency differs from the site agency (should not happen; the server gates): both shown.
{
  const s = await page({ 'GET /api/invites/preview': PREVIEW('Lakeside Vaad') }, VV);
  const h = s.html();
  ok('site, other agency invite: both names shown, nothing hidden', /data-site-name[^>]*>Valley Vaad</.test(h) && /data-invite-agency[^>]*>Lakeside Vaad</.test(h) && h.includes("You're invited to join"));
}

// ---- site address with a logo ----
{
  const s = await page({ 'GET /api/invites/preview': PREVIEW(), 'GET /api/site/logo': (_b, full) => (full === '/api/site/logo?rev=r7' ? LOGO('r7') : { status: 404, body: {} }) }, VV_LOGO);
  const h = s.html();
  ok('site logo: the logo image from the agency settings', h.includes('data-site-logo') && h.includes(`src="data:image/png;base64,${LOGO_B64}"`) && h.includes('alt="Valley Vaad"'));
  ok('site logo: no large name, "Powered by Shutfey" under it', !h.includes('data-site-name') && h.includes('Powered by Shutfey'));
  ok('site logo: "You\'re invited to join Valley Vaad" heading kept', h.includes("You're invited to join") && /data-invite-agency[^>]*>Valley Vaad</.test(h));
  ok('site logo: logo fetched by its rev', s.calls.some((c) => c[2] === '/api/site/logo?rev=r7'));
}
// Logo fails to load -> the name in large text (never an empty brand)
{
  const s = await page({ 'GET /api/invites/preview': PREVIEW(), 'GET /api/site/logo': { status: 404, body: {} } }, VV_LOGO);
  const h = s.html();
  ok('site logo missing on the server: the name in large text instead', !h.includes('data-site-logo') && /data-site-name[^>]*>Valley Vaad</.test(h) && count(h, 'Valley Vaad') === 1);
}
// The brand stays on the other states of the page (link not valid / offline)
{
  const s = await page({ 'GET /api/invites/preview': { status: 404, body: {} } }, VV);
  const h = s.html();
  ok('site, used/expired link: brand on top, the usual words below', h.includes('data-site-brand') && h.includes('data-invite-state="invalid"'));
}
// Accept still works on a site address (same request as the shared address)
{
  const routes = { 'GET /api/invites/preview': PREVIEW(), 'POST /api/invites/accept': { status: 200, body: { success: true, user: { id: 'u9', name: 'Yossi Katz', role: 'mashgiach' }, token: 'session.jwt' } } };
  const sh = await page(routes);
  await sh.m.click('New to Shutfey? Choose a password'); await sh.m.type('invite-new-password', 'yossi-own-pass'); await sh.m.type('invite-new-confirm', 'yossi-own-pass'); await sh.m.submit();
  const st = await page(routes, VV);
  await st.m.click('New to Shutfey? Choose a password'); await st.m.type('invite-new-password', 'yossi-own-pass'); await st.m.type('invite-new-confirm', 'yossi-own-pass'); await st.m.submit();
  const acc = (s) => s.calls.filter((c) => c[0] === 'POST').map((c) => JSON.stringify([c[1], c[3]]));
  ok('accept on site: signed in', st.logins.length === 1 && st.logins[0].id === 'u9');
  ok('accept on site: same accept request as on the shared address', acc(sh).length === 1 && JSON.stringify(acc(sh)) === JSON.stringify(acc(st)), JSON.stringify([acc(sh), acc(st)]));
}

// ---- helpers ----
ok('inviteAgencyIsSite: name, brandName, case/space-insensitive', SR.inviteAgencyIsSite(' valley vaad ', VV) && SR.inviteAgencyIsSite('VVaad', { ...VV, brandName: 'VVaad' }));
ok('inviteAgencyIsSite: other/empty -> false', !SR.inviteAgencyIsSite('Lakeside Vaad', VV) && !SR.inviteAgencyIsSite('', VV) && !SR.inviteAgencyIsSite(null, VV));

// ---- App wiring (source) ----
{
  const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const inv = app.slice(app.indexOf('<InvitePage'), app.indexOf('/>', app.indexOf('<InvitePage')));
  ok('App: invite page gets the site agency', inv.includes('site={siteAgency}'));
  ok('App: on an address that needs /api/site, the invite page waits for it (signed in or not)', app.includes('if (!site && (!currentUser || (invitePage && !isKiosk))) {'));
  ok('App: the wait comes before the invite page', app.indexOf('if (!site && (!currentUser || (invitePage && !isKiosk))) {') < app.indexOf('<InvitePage'));
}

console.log(`invite site branding: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
