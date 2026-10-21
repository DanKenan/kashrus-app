/**
 * D8 client test: admin home dashboard (AgencyDashboard mounted as the admin landing page).
 *   D*  AgencyDashboard renders inline (no overlay), keeps the existing labels and numbers,
 *       one 44px "Open <venue> board" button per card -> onSelectVenue(id), tel: links never
 *       inside that button, progressbar aria, nothing under 12px, tokens only, tolerant of
 *       missing fields; loading, error + Retry (refetch), empty; stale responses ignored.
 *   H*  Header: admins get one "Agency home" button (44px, aria-current=page when home);
 *       without the new props the header is unchanged (test-9b-switcher covers main parity).
 * Run: npx tsx tests/client/test-d8-home.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { AgencyDashboard } from '../../src/components/AgencyDashboard.tsx';
import { Header } from '../../src/components/Header.tsx';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const noop = () => {};
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = globalThis.localStorage || { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
const dec = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const LONG = "The Grand Ballroom at Congregation Beth Israel's Community Center — Main Kitchen & Bakery";
const data = {
  venues: [
    { venue: { id: 'v1', name: 'Crown Market', category: 'Supermarket' }, totalTasks: 8, completedTasks: 6, completionRate: 75, overdueTasks: 2,
      overdueTaskList: [{ id: 't1', title: 'Check produce', targetTime: '8:00 AM' }],
      recentNotes: [{ id: 'n1', authorName: 'Moshe Friedman', content: 'Two cases arrived with the plumba torn; set aside for the rav.', shift: 'morning', createdAt: '2026-10-21T10:00:00Z' }],
      mashgichim: [{ email: 'y@t', name: 'Yossi Abramowitz', phone: '+18605550101', role: 'mashgiach' }, { email: 'm@t', name: 'Moshe Friedman', phone: '', role: 'mashgiach' }],
      openIncidents: [{ id: 'i1', title: 'Seal broken on the meat fridge', severity: 'critical', reporterName: 'Yossi', createdAt: '2026-10-21T09:00:00Z' }, { id: 'i2', title: 'Late delivery', severity: 'high', reporterName: 'Eli', createdAt: '2026-10-21T08:00:00Z' }, { id: 'i3', title: 'Third one', severity: 'low', reporterName: 'Eli', createdAt: '2026-10-21T07:00:00Z' }] },
    { venue: { id: 'v2', name: LONG, category: 'Catering hall' }, totalTasks: 0, completedTasks: 0, completionRate: 0, overdueTasks: 0, overdueTaskList: [], recentNotes: [], mashgichim: [], openIncidents: [] },
    { venue: { id: 'v3', name: 'מאפיית כתר — Keter Bakery' }, totalTasks: 3, completedTasks: 3, completionRate: 100 }, // missing arrays/fields (D8s tolerance)
  ],
  totals: { venueCount: 3, totalTasks: 11, completedTasks: 9, totalHandoffNotes: 4 },
};

// ---- D: dashboard ----
let calls = recordFetch({ 'GET /api/admin/dashboard': () => data, '/api/': {} });
const picks = [];
const d = mount(AgencyDashboard, { onSelectVenue: (id) => picks.push(id) });
await d.render(); await d.render();
const html = dec(d.html()).replace(/>\s+</g, '><'); const text = d.text(); // text() splits JSX text nodes, so number+label checks read html
ok('D1 fetched GET /api/admin/dashboard', calls.some(([m, p]) => m === 'GET' && p === '/api/admin/dashboard'));
ok('D2 inline page: no fixed overlay / scrim', !/fixed inset-0|bg-black\/50|bg-scrim/.test(html));
ok('D3 keeps the h2 "Agency Dashboard"', /<h2[^>]*>Agency Dashboard<\/h2>/.test(html));
for (const l of ['Venues', 'Total Tasks', 'Completed', 'Handoff Notes']) ok(`D4 totals label "${l}"`, html.includes(`>${l}<`));
ok('D5 totals numbers shown', ['>3<', '>11<', '>9<', '>4<'].every((n) => html.includes(n)));
const cardBtns = d.find((e) => e.type === 'button' && /^Open .* board$/.test(e.props['aria-label'] || ''));
ok('D6 one "Open <venue> board" button per venue', cardBtns.length === 3, String(cardBtns.length));
ok('D7 button names use the venue name', cardBtns.map((b) => b.props['aria-label']).join('|') === `Open Crown Market board|Open ${LONG} board|Open מאפיית כתר — Keter Bakery board`);
ok('D8 card buttons are >=44px', cardBtns.every((b) => /min-h-11|min-h-\[44px\]|h-11/.test(b.props.className || '')));
await d.click('Open Crown Market board');
ok('D9 tapping a card opens that venue', picks.join() === 'v1', picks.join());
const btnHtml = [...html.matchAll(/<button[^>]*aria-label="Open [^"]*board"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]).join('');
ok('D10 no tel: link or other control nested in a card button', !/<a |<button/.test(btnHtml));
ok('D11 phone person is a tel: link', /<a [^>]*href="tel:\+18605550101"/.test(html));
const tel = (html.match(/<a [^>]*href="tel:[^"]*"[^>]*>/) || [''])[0];
ok('D12 tel link is >=44px', /min-h-11|min-h-\[44px\]|h-11/.test(tel), tel);
ok('D13 person without phone is a plain chip (name shown, no tel)', html.includes('Moshe Friedman') && (html.match(/href="tel:/g) || []).length === 1);
ok('D14 progressbar with aria values', /role="progressbar"[^>]*/.test(html) && /aria-valuenow="75"/.test(html) && /aria-valuemin="0"/.test(html) && /aria-valuemax="100"/.test(html) && /aria-label="Crown Market progress"/.test(html));
ok('D15 overdue / All clear / note / incidents (max 2) shown', text.includes('2 overdue') && text.includes('All clear') && text.includes('plumba torn') && text.includes('Seal broken on the meat fridge') && text.includes('Late delivery') && !text.includes('Third one'));
ok('D16 severity word kept', /critical/.test(text) && /high/.test(text));
ok('D17 x/y done and % shown', html.includes('6/8 done') && html.includes('75%'));
ok('D18 nothing under 12px, no font-black', !/text-\[(\d|1[01])px\]|font-black|font-extrabold/.test(html));
ok('D19 tokens only (no palette classes, hex, white/black, gradients)', !/\b(bg|text|border|from|to)-(emerald|rose|zinc|slate|gray|orange|amber|red|green|blue)-\d|#[0-9a-f]{6}\b|\bbg-white\b|\bbg-black\b|dark:bg-zinc|gradient/i.test(html), (html.match(/\b(bg|text|border)-(emerald|rose|zinc|slate|gray|orange|amber|red|green|blue)-\d|bg-white|bg-black|gradient/i) || [''])[0]);
ok('D20 a venue with missing fields still renders (D8s tolerance)', html.includes('Keter Bakery') && html.includes('3/3 done'));
// loading
recordFetch({ 'GET /api/admin/dashboard': 'PENDING', '/api/': {} });
const l = mount(AgencyDashboard, { onSelectVenue: noop }); await l.render();
ok('D21 loading keeps "Loading dashboard..." inline', l.text().includes('Loading dashboard...') && !/fixed inset-0/.test(l.html()));
// error + retry
let n = 0;
globalThis.fetch = async () => { n++; if (n === 1) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: 'x' }), text: async () => '' }; return { ok: true, status: 200, headers: { get: () => null }, json: async () => data, text: async () => '' }; };
const er = mount(AgencyDashboard, { onSelectVenue: noop }); await er.render(); await er.render();
ok('D22 failed load shows the plain error line', er.text().includes("Couldn't load the dashboard."), er.text().slice(0, 120));
await er.click('Retry'); await er.render();
ok('D23 Retry fetches again and shows the data', n >= 2 && er.text().includes('Crown Market'));
// network error
globalThis.fetch = async () => { throw new Error('offline'); };
const ne = mount(AgencyDashboard, { onSelectVenue: noop }); await ne.render(); await ne.render();
ok('D24 network error also shows the error line', ne.text().includes("Couldn't load the dashboard."));
// empty
recordFetch({ 'GET /api/admin/dashboard': { venues: [], totals: { venueCount: 0, totalTasks: 0, completedTasks: 0, totalHandoffNotes: 0 } }, '/api/': {} });
const em = mount(AgencyDashboard, { onSelectVenue: noop }); await em.render(); await em.render();
ok('D25 empty keeps "No venues yet. Create your first venue to get started."', em.text().includes('No venues yet. Create your first venue to get started.'));
// reloadKey refetch + stale response ignored
let resolvers = []; let count = 0;
globalThis.fetch = async () => { count++; const k = count; return new Promise((res) => resolvers.push(() => res({ ok: true, status: 200, headers: { get: () => null }, json: async () => (k === 1 ? { venues: [{ ...data.venues[0], venue: { id: 'old', name: 'STALE VENUE' } }], totals: data.totals } : data), text: async () => '' }))); };
const rk = mount(AgencyDashboard, { onSelectVenue: noop, reloadKey: 1 }); await rk.render();
await rk.render({ reloadKey: 2 });
ok('D26 reloadKey change fetches again', count === 2, String(count));
resolvers[1](); await rk.render(); await rk.render(); resolvers[0](); await rk.render(); await rk.render();
ok('D27 an older response arriving last is ignored', rk.text().includes('Crown Market') && !rk.text().includes('STALE VENUE'), rk.text().slice(0, 160));

// ---- H: header ----
const A = { id: 'v1', name: 'Crown Market', createdAt: '' };
const admin = { id: 'u9', name: 'Yossi A', email: 'admin@test.local', role: 'admin', agencyId: 'a', agencyName: 'Hartford Kashrut Commission', agencyShortCode: 'HKC' };
const staff = { ...admin, id: 'u1', role: 'mashgiach', venueId: 'v1' };
const hp = { currentVenue: A, allVenues: [A], onOpenCreateVenue: noop, onSelectVenue: noop, onLogout: noop, onOpenTaskModal: noop, onOpenHistoryModal: noop, onOpenEventsModal: noop, onOpenCreateEvent: noop, onOpenTeamModal: noop, onResetDailyBoard: noop, isRealtimeConnected: true, activeWorkersCount: 1, totalWorkersCount: 3, darkMode: false, onToggleDarkMode: noop, completionRate: 50 };
const H = (p) => dec(renderToStaticMarkup(React.createElement(Header, { ...hp, ...p })));
const hh = H({ currentUser: admin, isAgencyHome: true, onOpenAgencyHome: noop });
const hb = (hh.match(/<button[^>]*aria-label="Agency home"[^>]*>/g) || []);
ok('H1 admin gets exactly one visible "Agency home" button in the bar', hb.length === 1, String(hb.length));
ok('H2 it is >=44px', /min-h-11|min-h-\[44px\]|h-11/.test(hb[0] || '') && /min-w-11|min-w-\[44px\]|w-11|px-/.test(hb[0] || ''));
ok('H3 aria-current=page while home', /aria-current="page"/.test(hb[0] || ''));
ok('H4 no aria-current when on a board', !/aria-current="page"/.test((H({ currentUser: admin, isAgencyHome: false, onOpenAgencyHome: noop }).match(/<button[^>]*aria-label="Agency home"[^>]*>/) || [''])[0]));
ok('H5 non-admin never gets it', !/Agency home/.test(H({ currentUser: staff, isAgencyHome: false, onOpenAgencyHome: noop })));
ok('H6 without the new props the admin header has no Agency home button', !/Agency home/.test(H({ currentUser: admin })));
let opened = 0;
const hm = mount(Header, { ...hp, currentUser: admin, isAgencyHome: false, onOpenAgencyHome: () => { opened++; } });
await hm.render(); await hm.click('Agency home');
ok('H7 tapping it opens home', opened === 1);

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
