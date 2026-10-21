/**
 * D7c client test: Team & venues — consistency pass (no flow change).
 *
 * Renders TeamModal, VenuesDirectoryModal and CreateVenueModal with messy data through
 * tests/client/lib/mini-render.mjs, drives scripted interactions, and checks:
 *   P* parity (main AND PR): every text/label/placeholder/option shown on main is still shown
 *      (the 2 new empty-state lines are additions, never removals); scripted flows send the same
 *      requests/bodies and fire the same callbacks with the same arguments.
 *   D* design (fail on main, pass on PR): tokens only, >=12px, radii set, no tactile-3/5,
 *      font-black, gradients, bg-black/#hex; bg-scrim; border-line-control; 44px Close;
 *      role chips neutral (no purple/emerald); data-empty-state on the two no-match searches.
 *   E* (fail on main, pass on PR): the helpful empty states exist with the kept text.
 *   A* avatar: saved colours untouched; no-colour fallback is the defined token var(--gold-deep).
 *   L* Create Event picker (Don 7:39 AM): "Name — Role" only; the email handle only when two people share a display name.
 *   K* the TeamModal email "e.g." placeholder is kept verbatim; the name one becomes "Full name" (Don 7:36 AM).
 * Run: npx tsx tests/client/test-d7c-team-venues.mjs   (--dump rewrites tests/client/d7c-baseline.json on main)
 */
import React from 'react';
import fs from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { TeamModal } from '../../src/components/TeamModal.tsx';
import { VenuesDirectoryModal } from '../../src/components/VenuesDirectoryModal.tsx';
import { CreateVenueModal } from '../../src/components/CreateVenueModal.tsx';
import { CreateEventModal } from '../../src/components/CreateEventModal.tsx';

const DUMP = process.argv.includes('--dump');
const BASE = new URL('./d7c-baseline.json', import.meta.url);
let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const noop = () => {};
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function inventory(html) {
  const h = decode(html);
  const texts = h.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s && !/^[\d\s%().,:/•·-]*$/.test(s));
  const attrs = [...h.matchAll(/\s(placeholder|title|aria-label|alt)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
  const opts = [...h.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => `option=${m[1]}`);
  return [...new Set([...texts, ...attrs, ...opts])];
}
const NEW_EMPTY = { team: ['No team members match your search.', 'Try a different name, email or role.'], venues: ['Try a different name, address or hashgacha.'] };
const KEEP_EG = ['e.g. dcohen@hartfordkashrut.org'];
// Don 7:36 AM: the Team NAME placeholder loses its example (the only allowed copy swap); the email one stays.
const SWAP = { 'placeholder=e.g. Rabbi David Cohen': 'placeholder=Full name' };

// ---------------- messy data ----------------
const venue = { id: 'v1', name: 'Beth El Social Hall — Main Ballroom (upstairs)', category: 'Catering', address: '2626 Albany Ave, West Hartford', hashgacha: 'HKC', createdAt: '', timeZone: 'America/New_York' };
const venue2 = { id: 'v2', name: 'Riverside Kitchen', category: 'Restaurant', address: '1 River Rd', createdAt: '' };
const venue3 = { id: 'v3', name: 'מטבח הקהילה — Community Kitchen', category: 'Bakery', createdAt: '', timeZone: 'Asia/Jerusalem' };
const admin = { id: 'u1', name: 'Yossi Abramowitz-Goldberger', email: 'admin@test.local', role: 'admin', agencyId: 'a', venueId: 'v1', avatarColor: '#8a5a2b', permissions: { canFillTasks: true, canAssignTasks: true } };
const users = [admin,
  { id: 'u2', name: 'Moshe Klein', email: 'moshe@test.local', role: 'mashgiach', agencyId: 'a', venueId: 'v1', phoneNumber: '+18605550101', hasKioskPin: true, permissions: { canFillTasks: true, canAssignTasks: false } },
  { id: 'u3', name: 'Sara Levi-Rosenblatt (nights)', email: 'sara.levi.rosenblatt@verylongdomain.example.org', role: 'coordinator', agencyId: 'a', venueId: 'v2', permissions: { canFillTasks: false, canAssignTasks: true } },
  { id: 'u4', name: 'Dov Owner', email: 'owner@test.local', role: 'owner', agencyId: 'a', venueId: 'v1' }];
const tasks = [{ id: 't1', title: 'Check ovens', assignedTo: 'moshe@test.local', venueId: 'v1' }, { id: 't2', title: 'Lettuce', assignedTo: 'moshe@test.local', venueId: 'v1' }];

async function scenario() {
  const out = {};
  // 1. Team (admin view): list, add member, change role, toggle permissions, search no-match
  const cb = [];
  const tm = mount(TeamModal, { isOpen: true, onClose: () => cb.push('close'), users, tasks, currentUser: admin, currentVenue: venue,
    onAddUser: async (u) => { cb.push(['add', u]); }, onUpdateUser: async (id, up) => { cb.push(['update', id, up]); }, onDeleteUser: async (id) => { cb.push(['delete', id]); } });
  await tm.render(); out.team = { inv: inventory(tm.html()), html: tm.html() };
  await tm.type(/Rabbi David Cohen|Full name/, 'Chaya Mushka Weiss');
  await tm.type(/dcohen@/, 'Chaya@Test.Local ');
  await tm.type(/Min 6 characters/, 'secret123');
  await tm.submit().catch(() => {});
  const roleSel = tm.find((e) => e.type === 'select' && e.props.value === 'mashgiach' && typeof e.props.onChange === 'function');
  if (roleSel.length) { await roleSel[roleSel.length - 1].props.onChange({ target: { value: 'coordinator' } }); await tm.render(); }
  await tm.click(/Fill Tasks: Allowed/, 1).catch(() => {});
  await tm.click(/Assign Tasks: Disabled/).catch(() => {});
  out.teamActions = { calls: JSON.parse(JSON.stringify(cb)) };
  await tm.type(/Search by name, email, or role/, 'zzz-nobody');
  out.teamEmpty = { html: tm.html() };
  const tn = mount(TeamModal, { isOpen: true, onClose: noop, users: [], tasks: [], currentUser: admin, currentVenue: venue, onAddUser: async () => {}, onUpdateUser: async () => {}, onDeleteUser: async () => {} });
  await tn.render(); out.teamNoRosterEmpty = { html: tn.html() };
  // 2. Team (coordinator view) — read-only list
  const tc = mount(TeamModal, { isOpen: true, onClose: noop, users, tasks, currentUser: users[2], currentVenue: venue2, onAddUser: async () => {}, onUpdateUser: async () => {}, onDeleteUser: async () => {} });
  await tc.render(); out.teamCoord = { inv: inventory(tc.html()), html: tc.html() };
  // 3. Venues directory
  const vc = [];
  const vd = mount(VenuesDirectoryModal, { isOpen: true, onClose: () => vc.push('close'), venues: [venue, venue2, venue3], currentVenue: venue, onSelectVenue: (id) => vc.push(['select', id]), onOpenCreateVenue: () => vc.push('create'), onDeleteVenue: async (id) => { vc.push(['delete', id]); }, isAdmin: true, agencyTimeZone: 'America/New_York', onVenueUpdated: (v) => vc.push(['updated', v.id]) });
  await vd.render(); out.venues = { inv: inventory(vd.html()), html: vd.html() };
  await vd.click('Riverside Kitchen').catch(() => {});
  out.venuesActions = { calls: vc.slice() };
  await vd.type(/Search by venue, address, or hashgacha/, 'zzz-nowhere');
  out.venuesEmpty = { inv: inventory(vd.html()), html: vd.html() };
  // 4. Create venue — fill and submit
  const created = [];
  const calls = recordFetch({ 'GET /api/agencies/current': { agency: { id: 'a', name: 'Hartford Kashrus Council' } }, 'POST /api/venues': (p, b) => ({ venue: { ...b, id: 'nv1' } }), '/api/': {} }); // V1: the modal loads the agency's certification choices
  const cv = mount(CreateVenueModal, { isOpen: true, onClose: () => created.push('close'), onVenueCreated: (v) => created.push(['created', v && v.id]), adminEmail: 'admin@test.local', agencyName: 'Hartford Kashrus Council', agencyTimeZone: 'America/New_York' });
  await cv.render(); out.createVenue = { inv: inventory(cv.html()), html: cv.html() };
  await cv.type(/Establishment Name/, 'Crown Market — Deli Counter');
  await cv.type(/^Address$|Address/, '2471 Albany Ave');
  await cv.type(/Full Name/, 'Moshe Klein'); await cv.type(/^Email$|Email/, 'moshe2@test.local'); await cv.type(/^Password$|Password/, 'pw123456');
  await cv.submit().catch(() => {});
  out.createVenueSubmit = { fetch: calls.filter(([m]) => m !== 'GET').map(([m, p, b]) => [m, p, b]), calls: created };
  // 5. Create Event mashgiach picker (Don 7:39 AM): "Name — Role"; email handle only for duplicate names
  const pm = [
    { id: 'p1', name: 'David Yosef Aguirre', email: 'davidyosef5780@test.local', role: 'mashgiach', agencyId: 'a', venueId: 'v1' },
    { id: 'p2', name: 'Moshe Klein', email: 'moshe.k@test.local', role: 'mashgiach', agencyId: 'a', venueId: 'v1' },
    { id: 'p3', name: ' moshe klein ', email: 'mklein2@test.local', role: 'coordinator', agencyId: 'a', venueId: 'v2' },
    { id: 'p4', name: 'Sara Levi', email: 'sara@test.local', role: 'mashgiach', agencyId: 'a' },
  ];
  recordFetch({ '/api/': {} });
  const pe = mount(CreateEventModal, { isOpen: true, onClose: noop, onEventCreated: noop, currentUser: admin, currentVenue: venue, allVenues: [venue, venue2], availableMashgichim: pm });
  await pe.render();
  out.pickerEmpty = { html: pe.html() };
  return out;
}

let cur;
try { cur = await scenario(); } catch (e) { ok('scenario runs', false, String(e && e.stack || e).slice(0, 700)); }
if (cur && DUMP) {
  const base = Object.fromEntries(Object.entries(cur).filter(([k]) => !/Empty$/.test(k)).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'html'))]));
  fs.writeFileSync(BASE, JSON.stringify(base, null, 1)); console.log('baseline written'); process.exit(0);
}
// Item V1 (Don, Oct 21): the free-text "Certification" field became the "Certification details" picker.
// Its label/placeholder are gone on purpose, and with no detail picked the venue's certification is the agency name alone.
const V1_GONE = new Set(['Certification', 'placeholder=Certification Standard']);
const v1Fetch = (f) => f.map(([m, p, b]) => [m, p, m === 'POST' && p === '/api/venues' && b ? { ...b, certification: 'Hartford Kashrus Council' } : b]);
if (cur) {
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  for (const [k, v] of Object.entries(base)) {
    const c = cur[k];
    if (!c) { ok(`P ${k}: present`, false); continue; }
    if (v.inv) { const have = new Set(c.inv); const miss = v.inv.filter((s) => !have.has(s) && !(SWAP[s] && have.has(SWAP[s])) && !(k === 'createVenue' && V1_GONE.has(s))); ok(`P ${k}: every text/label/placeholder kept (1 Don swap allowed)`, miss.length === 0, `${miss.length} missing: ${JSON.stringify(miss.slice(0, 8))}`); }
    for (const f of ['fetch', 'calls']) if (f in v) ok(`P ${k}: same ${f}`, JSON.stringify(c[f]) === JSON.stringify(k === 'createVenueSubmit' && f === 'fetch' ? v1Fetch(v[f]) : v[f]), `now ${JSON.stringify(c[f]).slice(0, 300)} was ${JSON.stringify(v[f]).slice(0, 300)}`);
  }
  const files = ['TeamModal', 'VenuesDirectoryModal', 'CreateVenueModal'];
  const PAL = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|accent|shadow)-(?:emerald|rose|amber|red|green|blue|slate|gray|zinc|white|black|yellow|orange|indigo|purple|sky|teal|lime|pink|violet|cyan|stone|neutral)(?:-\d{2,3})?(?:\/\d+)?\b/g;
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../../src/components/${f}.tsx`, import.meta.url), 'utf8');
    const pal = src.match(PAL) || [];
    ok(`D ${f}: no raw palette colours`, pal.length === 0, `${pal.length}: ${[...new Set(pal)].slice(0, 8).join(' ')}`);
    const hex = (src.match(/className=[^>]*#[0-9a-fA-F]{3,8}\b/g) || []).concat(src.match(/\[#[0-9a-fA-F]{3,8}\]/g) || []).concat(src.match(/\|\|\s*'#[0-9a-fA-F]{3,8}'/g) || []);
    ok(`D ${f}: no raw hex in classes / fallbacks`, hex.length === 0, hex.slice(0, 3).join(' | '));
    const small = [...src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].filter((m) => parseFloat(m[1]) < 12);
    ok(`D ${f}: no text under 12 px`, small.length === 0, `${small.length}`);
    const rad = src.match(/rounded-\[(?!(?:6|8|12|16|24)px\])[^\]]+\]|rounded-3xl|rounded-t-3xl|rounded-b-3xl/g) || [];
    ok(`D ${f}: radii from the set`, rad.length === 0, rad.slice(0, 4).join(' '));
    ok(`D ${f}: no retired tactile-3/5`, !/tactile-[35]\b/.test(src));
    ok(`D ${f}: no font-black/extrabold`, !/font-(?:black|extrabold)\b/.test(src));
    ok(`D ${f}: no gold gradients`, !/from-gold|to-gold-deep|bg-gradient/.test(src));
    ok(`D ${f}: no bg-black`, !/bg-black/.test(src));
  }
  const htmlOf = (k) => cur[k]?.html || '';
  for (const k of ['team', 'venues', 'createVenue']) {
    const h = decode(htmlOf(k));
    ok(`D ${k}: backdrop is bg-scrim`, /bg-scrim/.test(h));
    const ctrls = [...h.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].filter((m) => !/type="(?:hidden|file|checkbox|radio)"/.test(m[2]) && !/class="[^"]*\bhidden\b/.test(m[2]));
    const bad = ctrls.filter((m) => !/border-line-control/.test(m[2]));
    ok(`D ${k}: every input/select/textarea edge is border-line-control`, ctrls.length === 0 || bad.length === 0, `${bad.length}/${ctrls.length}`);
    const closes = [...h.matchAll(/<button\b([^>]*aria-label="Close"[^>]*)>/g)];
    ok(`D ${k}: a 44 px close button with aria-label="Close"`, closes.length >= 1 && closes.every((m) => /\b(?:w-11|min-w-11|size-11)\b/.test(m[1]) && /\b(?:h-11|min-h-11|size-11)\b/.test(m[1])), `${closes.length} close buttons`);
  }
  const team = decode(htmlOf('team'));
  ok('D team: role chips carry no purple/emerald', !/(purple|emerald)-/.test(team));
  const te = decode(htmlOf('teamEmpty')); const ve = decode(htmlOf('venuesEmpty'));
  ok('E teamEmpty: helpful empty state (data-empty-state + both lines)', /data-empty-state/.test(te) && NEW_EMPTY.team.every((s) => te.includes(s)));
  ok('E venuesEmpty: helpful empty state keeps its text (data-empty-state + helper)', /data-empty-state/.test(ve) && ve.includes('No venues match your search criteria.') && NEW_EMPTY.venues.every((s) => ve.includes(s)));
  const tnr = decode(htmlOf('teamNoRosterEmpty'));
  ok('E teamNoRoster: an empty roster with no search shows no new no-match message', !NEW_EMPTY.team.some((s) => tnr.includes(s)));
  ok('A avatar: a saved colour is used exactly as supplied', /background-color:\s*#8a5a2b/i.test(team));
  ok('A avatar: no colour -> existing token var(--gold-deep)', /background-color:\s*var\(--gold-deep\)/.test(team) && !/#3b82f6/i.test(team));
  ok('E TeamModal name placeholder is "Full name" (Don 7:36 AM)', team.includes('placeholder="Full name"') && !team.includes('Rabbi David Cohen'));
  const opts = [...decode(htmlOf('pickerEmpty')).matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()]);
  const lab = (email) => (opts.find(([v]) => v === email) || [, ''])[1];
  ok('L picker: unique name shows "Name — Role" with no email handle', /^David Yosef Aguirre — Mashgiach\b/.test(lab('davidyosef5780@test.local')) && !lab('davidyosef5780@test.local').includes('('), JSON.stringify(lab('davidyosef5780@test.local')));
  ok('L picker: another unique name has no "(" either', lab('sara@test.local').startsWith('Sara Levi — ') && !lab('sara@test.local').includes('('), JSON.stringify(lab('sara@test.local')));
  ok('L picker: duplicate display names keep their email handle', lab('moshe.k@test.local').includes('(moshe.k)') && lab('mklein2@test.local').includes('(mklein2)'), JSON.stringify([lab('moshe.k@test.local'), lab('mklein2@test.local')]));
  for (const p of KEEP_EG) ok(`K TeamModal keeps placeholder "${p}"`, team.includes(`placeholder="${p}"`));
}
console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
