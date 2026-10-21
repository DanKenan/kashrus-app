/**
 * 9b client test: venue switcher for people who work at more than one venue.
 *   H*  Header: single-venue non-admin pill and admin button render EXACTLY as on main
 *       (markup baseline recorded on main b771a08); with 2+ eligible venues the
 *       non-admin pill becomes a 44px button that opens the switcher.
 *   S*  VenueSwitcherSheet: dialog semantics, one row per venue, Home tag, current
 *       marked with aria-current, tap = select + close; tokens only, nothing < 12px.
 *   U*  src/lib/venueSelection.ts pure rules: per-user storage key, eligibility
 *       (venues ∩ myVenueIds), fail-closed resolve (saved → home → first → null),
 *       venue filter for snapshots.
 * Run: npx tsx tests/client/test-9b-switcher.mjs   (--dump on main re-records the baseline)
 */
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import { Header } from '../../src/components/Header.tsx';

const DUMP = process.argv.includes('--dump');
const BASE = new URL('./9b-baseline.json', import.meta.url);
let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const noop = () => {};
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };

const A = { id: 'vA', name: 'Beth El Social Hall — Main Ballroom (upstairs)', createdAt: '' };
const B = { id: 'vB', name: 'Riverside Kitchen', createdAt: '' };
const C = { id: 'vC', name: 'Crown Market', createdAt: '' };
const staff1 = { id: 'u1', name: 'Moshe Klein', email: 'moshe@test.local', role: 'mashgiach', agencyId: 'a', venueId: 'vA', agencyName: 'Hartford Kashrut Commission', agencyShortCode: 'HKC' };
const admin = { id: 'u9', name: 'Yossi A', email: 'admin@test.local', role: 'admin', agencyId: 'a', venueId: 'vA', agencyName: 'Hartford Kashrut Commission', agencyShortCode: 'HKC' };
const baseProps = {
  allVenues: [A], onOpenCreateVenue: noop, onSelectVenue: noop, onLogout: noop, onOpenTaskModal: noop, onOpenHistoryModal: noop,
  onOpenEventsModal: noop, onOpenCreateEvent: noop, onOpenTeamModal: noop, onResetDailyBoard: noop, isRealtimeConnected: true,
  activeWorkersCount: 1, totalWorkersCount: 3, darkMode: false, onToggleDarkMode: noop, completionRate: 50,
};
const headerHtml = (p) => renderToStaticMarkup(React.createElement(Header, { ...baseProps, ...p }));
// the header date line carries the live clock and today's dates; normalise them
const strip = (h) => h.replace(/:r[0-9a-z]+:/g, ':r:').replace(/\d{1,2}:\d{2}\s?[AP]M( [A-Z]{2,5})?/g, 'TIME').replace(/(<span dir="rtl"[^>]*>)[^<]*/g, '$1HEB').replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? [A-Z][a-z]+ \d{1,2}(, \d{4})?/g, 'DATE');

// ---- baseline (main) ----
const cur = {
  staffSingle: strip(headerHtml({ currentUser: staff1, currentVenue: A, allVenues: [A] })),
  adminTwo: strip(headerHtml({ currentUser: admin, currentVenue: A, allVenues: [A, B] })),
  staffNoVenue: strip(headerHtml({ currentUser: staff1, currentVenue: null, allVenues: [] })),
};
if (DUMP) { fs.writeFileSync(BASE, JSON.stringify(cur, null, 1)); console.log('baseline written'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));

// H1-H3: parity with main when the switcher must not show (no new props, and with them)
ok('H1 single-venue staff header = main', cur.staffSingle === base.staffSingle);
ok('H2 admin header = main', cur.adminTwo === base.adminTwo);
ok('H3 staff with no venue = main', cur.staffNoVenue === base.staffNoVenue);
let opened = 0;
const withProps = (p) => strip(headerHtml({ switchableVenues: p.sw, onOpenVenueSwitcher: () => { opened++; }, ...p }));
ok('H4 single eligible venue + new props = main', withProps({ currentUser: staff1, currentVenue: A, allVenues: [A], sw: [A] }) === base.staffSingle);
ok('H5 admin + new props (2 switchable) = main', withProps({ currentUser: admin, currentVenue: A, allVenues: [A, B], sw: [A, B] }) === base.adminTwo);

// H6-H10: two eligible venues -> a button
const two = headerHtml({ currentUser: staff1, currentVenue: A, allVenues: [A, B], switchableVenues: [A, B], onOpenVenueSwitcher: () => { opened++; } });
const btnRe = /<button[^>]*aria-label="Switch venue, current: Beth El Social Hall — Main Ballroom \(upstairs\)"[^>]*>/;
const btn = (two.replace(/&quot;/g, '"').match(btnRe) || [''])[0];
ok('H6 two venues: pill is a button with the agreed name', !!btn, two.slice(0, 300));
ok('H7 button has aria-haspopup=dialog', /aria-haspopup="dialog"/.test(btn));
ok('H8 button is >=44px (min-w-11 min-h-11 or 44px)', /min-h-11|min-h-\[44px\]/.test(btn) && /min-w-11|min-w-\[44px\]/.test(btn));
ok('H9 button uses tokens only (no palette classes / hex)', !/(emerald|zinc|slate|gray|rose|amber)-\d|#[0-9a-f]{3,6}/i.test(btn));
ok('H10 venue name shown once (in the button, no static pill beside it)', (two.match(/Beth El Social Hall — Main Ballroom \(upstairs\)<\/span>/g) || []).length === 1);
const hm = mount(Header, { ...baseProps, currentUser: staff1, currentVenue: A, allVenues: [A, B], switchableVenues: [A, B], onOpenVenueSwitcher: () => { opened++; } });
await hm.render();
const before = opened;
await hm.click(/Switch venue, current:/);
ok('H11 tapping the pill opens the switcher', opened === before + 1);
ok('H12 admin still has the Venues hub button (id admin-venue-switcher-btn)', /id="admin-venue-switcher-btn"/.test(headerHtml({ currentUser: admin, currentVenue: A, allVenues: [A, B], switchableVenues: [], onOpenVenueSwitcher: noop })));
ok('H13 admin never gets the staff switcher', !/Switch venue, current:/.test(headerHtml({ currentUser: admin, currentVenue: A, allVenues: [A, B], switchableVenues: [A, B], onOpenVenueSwitcher: noop })));

// ---- Sheet ----
const { VenueSwitcherSheet } = await import('../../src/components/VenueSwitcherSheet.tsx');
const picks = []; let closes = 0;
const sp = { isOpen: true, onClose: () => { closes++; }, venues: [A, B, C], currentVenueId: 'vB', homeVenueId: 'vA', onSelectVenue: (id) => picks.push(id) };
const sm = mount(VenueSwitcherSheet, sp); await sm.render();
const sh = sm.html().replace(/&quot;/g, '"');
ok('S1 role=dialog aria-modal', /role="dialog"/.test(sh) && /aria-modal="true"/.test(sh));
ok('S2 labelled by the title "Switch venue"', /aria-labelledby="([^"]+)"/.test(sh) && new RegExp(`id="${(sh.match(/aria-labelledby="([^"]+)"/) || [])[1]}"[^>]*>Switch venue<`).test(sh));
ok('S3 44px Close with aria-label Close', /<button[^>]*aria-label="Close"[^>]*class="[^"]*(w-11 h-11|min-h-11)/.test(sh) || /<button[^>]*class="[^"]*w-11 h-11[^"]*"[^>]*aria-label="Close"/.test(sh));
const rows = sm.find((e) => e.type === 'button' && e.props['aria-label'] !== 'Close');
ok('S4 one row per venue', rows.length === 3, String(rows.length));
ok('S5 rows are >=44px', rows.every((r) => /min-h-11|h-11|min-h-\[44px\]/.test(r.props.className || '')));
ok('S6 Home tag only on the home venue', (sh.match(/>Home</g) || []).length === 1 && /Beth El Social Hall[^<]*<\/span><span[^>]*>Home</.test(sh));
ok('S7 current venue has aria-current=true, others none', rows.filter((r) => r.props['aria-current'] === 'true').length === 1 && rows.find((r) => r.props['aria-current'] === 'true') === rows[1]);
ok('S8 nothing under 12px / no palette classes / no font-black', !/text-\[(\d|1[01])px\]|text-\[0?\.\d+rem\]|font-black|font-extrabold|(emerald|zinc|slate|gray)-\d|#[0-9a-f]{6}/i.test(sh));
await sm.click('Crown Market');
ok('S9 tapping a row selects it and closes', picks.join() === 'vC' && closes === 1, picks.join() + '/' + closes);
const closed = mount(VenueSwitcherSheet, { ...sp, isOpen: false }); await closed.render();
ok('S10 closed sheet renders nothing', closed.html() === '');

// ---- pure rules ----
let VS = null;
try { VS = await import('../../src/lib/venueSelection.ts'); } catch (e) { ok('U0 src/lib/venueSelection.ts exists', false, e.message); }
if (VS) {
  const { venueStorageKey, eligibleVenuesFor, resolveVenue, filterToVenue } = VS;
  ok('U1 admin storage key unchanged', venueStorageKey(admin) === 'selected_venue_id');
  ok('U2 staff key is per user', venueStorageKey(staff1) === 'selected_venue_id:u1');
  ok('U3 admin has no eligible list (agency-wide)', eligibleVenuesFor(admin, [A, B]).length === 0);
  ok('U4 no user -> none', eligibleVenuesFor(null, [A, B]).length === 0);
  ok('U5 venues ∩ myVenueIds', eligibleVenuesFor({ ...staff1, myVenueIds: ['vA', 'vB'] }, [A, B, C]).map((v) => v.id).join() === 'vA,vB');
  ok('U6 myVenueIds absent -> server list as is', eligibleVenuesFor(staff1, [A]).map((v) => v.id).join() === 'vA');
  ok('U7 foreign grant never adds a venue the server did not send', eligibleVenuesFor({ ...staff1, myVenueIds: ['vA', 'vZ'] }, [A]).map((v) => v.id).join() === 'vA');
  const el = [A, B];
  ok('U8 saved pick in scope wins', resolveVenue(staff1, el, 'vB')?.id === 'vB');
  ok('U9 saved pick out of scope -> home', resolveVenue(staff1, el, 'vC')?.id === 'vA');
  ok('U10 home not eligible -> first eligible', resolveVenue({ ...staff1, venueId: 'vZ' }, el, null)?.id === 'vA' && resolveVenue({ ...staff1, venueId: 'vZ' }, [B, C], 'vX')?.id === 'vB');
  ok('U11 nothing eligible -> null', resolveVenue(staff1, [], 'vA') === null);
  ok('U12 two users on one device: user 2 never inherits user 1 pick', (() => { store.clear(); store.set(venueStorageKey(staff1), 'vB'); const u2 = { ...staff1, id: 'u2', venueId: 'vC' }; return resolveVenue(u2, [B, C], store.get(venueStorageKey(u2)) ?? null)?.id === 'vC'; })());
  ok('U13 filterToVenue keeps only that venue', filterToVenue([{ id: 1, venueId: 'vA' }, { id: 2, venueId: 'vB' }, { id: 3 }], 'vA').map((x) => x.id).join() === '1');
}

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
