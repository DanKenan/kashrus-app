/**
 * D7b client test: Events — consistency pass + Don's two requests (5:24 AM, 5:29 AM).
 *
 * Renders EventsModal, CreateEventModal, CopyEventDialog and HistoryLogModal with a messy set
 * through tests/client/lib/mini-render.mjs, drives the same scripted interactions, and checks:
 *   P* parity (main AND PR): every text/label/placeholder/option shown on main is still shown —
 *      except the 7 "e.g." placeholders Don asked to replace (whitelisted below) and the raw
 *      reset-by codes; scripted flows send the same requests/bodies and fire the same callbacks.
 *   D* design (fail on main, pass on PR): tokens only, ≥12px, radii set, no tactile-3/5,
 *      font-black, gradients, bg-black/#hex; bg-scrim; border-line-control; 44px Close;
 *      data-empty-state on the empty event list and on an event with no tasks.
 *   E* (fail on main, pass on PR): the 7 new placeholders exist and no "e.g." is left in the 3 event files.
 *   H* (fail on main, pass on PR): History shows "Automatic (midnight)" / "Automatic" for the two
 *      codes, never the raw code; any other value is shown unchanged.
 * Run: npx tsx tests/client/test-d7b-events.mjs   (--dump rewrites tests/client/d7b-baseline.json on main)
 */
import React from 'react';
import fs from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { EventsModal } from '../../src/components/EventsModal.tsx';
import { CreateEventModal } from '../../src/components/CreateEventModal.tsx';
import { CopyEventDialog } from '../../src/components/CopyEventDialog.tsx';
import { HistoryLogModal } from '../../src/components/HistoryLogModal.tsx';

const DUMP = process.argv.includes('--dump');
const BASE = new URL('./d7b-baseline.json', import.meta.url);
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
// Don 5:24 AM — the only copy changes allowed (old placeholder -> new placeholder)
const SWAP = {
  'placeholder=e.g. Miller Wedding, Community Shabbat Dinner': 'placeholder=Event name',
  'placeholder=e.g. Beth El Synagogue Ballroom, 2626 Albany Ave': 'placeholder=Venue or address',
  'placeholder=e.g. 11:30 AM': 'placeholder=Start time',
  'placeholder=e.g. 16:30 PM': 'placeholder=End time',
  'placeholder=Add task for this event only (e.g. Verify wine bottle seals)': 'placeholder=Add a task for this event only',
  'placeholder=New default task (e.g. Check oven pilots)': 'placeholder=New default task',
  'placeholder=Add an event task (e.g. Verify sealed Cambro temperatures)...': 'placeholder=Add an event task',
  // Don 7:39 AM (D7c): the mashgiach picker shows "Name — Role"; the email handle stays only for duplicate names.
  'Moshe Klein — Mashgiach (moshe)': 'Moshe Klein — Mashgiach',
  'Sara Levi — Mashgiach (sara) · Riverside Kitchen': 'Sara Levi — Mashgiach · Riverside Kitchen',
};
const RAW_CODES = ['scheduled_midnight_cron'];

// ---------------- messy data ----------------
const venue = { id: 'v1', agencyId: 'a', name: 'Beth El Social Hall — Main Ballroom (upstairs)', category: 'Catering', createdAt: '', timeZone: 'America/New_York' };
const venue2 = { id: 'v2', agencyId: 'a', name: 'Riverside Kitchen', category: 'Restaurant', createdAt: '' };
const admin = { id: 'u1', name: 'Yossi Abramowitz-Goldberger', email: 'admin@test.local', role: 'admin', agencyId: 'a', venueId: 'v1' };
const mash = [{ id: 'm1', name: 'Moshe Klein', email: 'moshe@test.local', role: 'mashgiach', agencyId: 'a', venueId: 'v1' }, { id: 'm2', name: 'Sara Levi', email: 'sara@test.local', role: 'mashgiach', agencyId: 'a', venueId: 'v2' }];
const task = (id, title, done, extra = {}) => ({ id, title, isCompleted: done, ...extra });
const ev1 = { id: 'e1', agencyId: 'a', venueId: 'v1', venueName: venue.name, title: 'Miller–Katz wedding (300 guests, fleishig, two kitchens)', location: '2626 Albany Ave, West Hartford — Ballroom A', date: '2099-06-14', startTime: '17:30', endTime: '23:45', mashgiachType: 'assigned_user', assignedMashgiachEmail: 'moshe@test.local', assignedMashgiachName: 'Moshe Klein', status: 'confirmed', notes: 'Caterer arrives 2pm. Separate pareve dessert station. בס״ד', tasks: [task('t1', 'Kasher the ovens (libun kal) before 3pm', true, { completedByName: 'Moshe Klein', completedAt: '2099-06-14T14:10:00.000Z' }), task('t2', 'Check every case of wine for intact seals — reject anything opened', false), task('t3', 'Inspect lettuce under the light box', false)], createdByEmail: 'admin@test.local', createdByName: 'Yossi', createdAt: '2099-06-01T10:00:00.000Z' };
const ev2 = { id: 'e2', agencyId: 'a', venueId: 'v2', venueName: venue2.name, title: 'Sheva brachos', location: 'Riverside Kitchen', date: '2099-07-02', mashgiachType: 'external', externalMashgiach: { name: 'R. Dovid Weiss', phone: '860-555-0101', email: 'dw@ext.local' }, status: 'pending_review', tasks: [], createdByEmail: 'admin@test.local', createdByName: 'Yossi', createdAt: '2099-06-20T10:00:00.000Z' };

const sweep = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/^(id|operationId|createdAt|updatedAt)$/.test(k) && typeof v === 'string' && /etask-|[0-9a-f]{8}-|T\d\d:/.test(v) ? '*' : v)));

async function scenario() {
  const out = {};
  // 1. Events hub — list, active event with tasks, every action
  const cb = [];
  const evm = mount(EventsModal, { isOpen: true, onClose: () => cb.push('close'), events: [ev1, ev2], currentUser: admin, currentVenue: venue, allVenues: [venue, venue2], availableMashgichim: mash,
    onOpenCreateEvent: () => cb.push('create'), onToggleEventTask: async (e, t, c, n) => { cb.push(['toggle', e, t, c, n ?? null]); }, onUpdateEvent: async (e) => { cb.push(['update', sweep(e)]); }, onDeleteEvent: async (id) => { cb.push(['delete', id]); }, onCopyEvent: (e) => cb.push(['copy', e.id]) });
  await evm.render(); out.eventsHub = { inv: inventory(evm.html()), html: evm.html() };
  await evm.click('Inspect lettuce');
  await evm.type(/Add an event task/, 'Check the fish for scales');
  await evm.click((e) => e.props.onClick && /Add/.test(JSON.stringify(e.props.children ?? '')) && !/Event/.test(JSON.stringify(e.props.children ?? '')) && e.type === 'button').catch(async () => { await evm.click(/^\s*Add\s*$/); });
  await evm.click((e) => e.props.title === 'Copy event' || /Copy/.test(String(e.props['aria-label'] || '')) || /Copy/.test(JSON.stringify(e.props.children ?? ''))).catch(() => {});
  out.eventsActions = { calls: cb.slice() };
  await evm.click('Sheva brachos'); out.eventsNoTasks = { inv: inventory(evm.html()), html: evm.html() };
  const evEmpty = mount(EventsModal, { isOpen: true, onClose: noop, events: [], currentUser: admin, currentVenue: venue, allVenues: [venue], availableMashgichim: mash, onOpenCreateEvent: noop, onToggleEventTask: async () => {}, onUpdateEvent: async () => {} });
  await evEmpty.render(); out.eventsEmpty = { inv: inventory(evEmpty.html()), html: evEmpty.html() };
  // 2. Create event — fill and submit
  const created = [];
  const calls = recordFetch({ 'POST /api/events': (p, b) => ({ event: { ...b, id: 'new1' } }), '/api/': {} });
  const ce = mount(CreateEventModal, { isOpen: true, onClose: () => created.push('close'), onEventCreated: (e) => created.push(['created', e.id]), currentUser: admin, currentVenue: venue, allVenues: [venue, venue2], availableMashgichim: mash });
  await ce.render(); out.createForm = { inv: inventory(ce.html()), html: ce.html() };
  await ce.type(/Miller Wedding|Event name/, 'Bar mitzvah — Cohen family');
  await ce.type(/Beth El Synagogue|Venue or address/, 'Beth El, 2626 Albany Ave');
  const dateIn = ce.find((e) => e.type === 'input' && e.props.type === 'date')[0];
  if (dateIn) { await dateIn.props.onChange({ target: { value: '2099-08-01' } }); await ce.render(); }
  await ce.type(/11:30|Start time/, '18:00'); await ce.type(/16:30|End time/, '22:00');
  await ce.type(/Add task for this event only|Add a task for this event only/, 'Check the challah');
  await ce.click((e) => e.type === 'button' && typeof e.props.onClick === 'function' && /Add/.test(JSON.stringify(e.props.children ?? '')) && !/Event/.test(JSON.stringify(e.props.children ?? ''))).catch(() => {});
  const sel = ce.find((e) => e.type === 'select' && typeof e.props.onChange === 'function');
  if (sel[0]) { const opt = JSON.stringify(sel[0].props.children ?? ''); if (opt.includes('moshe@test.local')) { await sel[0].props.onChange({ target: { value: 'moshe@test.local' } }); await ce.render(); } }
  await ce.submit().catch(() => {});
  out.createSubmit = { fetch: calls.filter(([m]) => m !== 'GET').map(([m, p, b]) => [m, p, sweep(b)]), calls: created };
  // 3. Copy event
  const cp = [];
  const cpd = mount(CopyEventDialog, { isOpen: true, event: ev1, venue, currentUser: admin, onClose: () => cp.push('close'), onCopy: async (id, title, date, op) => { cp.push(['copy', id, title, /^\d{4}-\d{2}-\d{2}$/.test(date) ? 'YYYY-MM-DD' : date, typeof op]); return null; } });
  await cpd.render(); out.copyForm = { inv: inventory(cpd.html()), html: cpd.html() };
  const tIn = cpd.find((e) => e.type === 'input' && e.props.type !== 'date' && typeof e.props.onChange === 'function')[0];
  if (tIn) { await tIn.props.onChange({ target: { value: 'Miller–Katz wedding (copy)' } }); await cpd.render(); }
  await cpd.click('Create copy');
  out.copyCalls = { calls: cp };
  // 4. History reset-by
  const snap = (id, by) => ({ id, date: '2099-06-0' + id.slice(1), totalTasks: 10, completedTasks: 7, completionRate: 70, entries: [], resetAt: '2099-06-01T04:00:00.000Z', resetBy: by });
  const hl = mount(HistoryLogModal, { isOpen: true, onClose: noop, historyLogs: [snap('s1', 'scheduled_midnight_cron'), snap('s2', 'system'), snap('s3', 'rabbi.cohen@test.local')] });
  await hl.render(); const histHtml = [hl.html()];
  for (const n of [1, 2]) { await hl.click((e) => e.type === 'button' && typeof e.props.onClick === 'function' && /Jun (\d+),/.exec(JSON.stringify(e.props.children ?? ''))?.[1] === String(n + 1), 0).catch(() => {}); histHtml.push(hl.html()); }
  out.history = { html: histHtml.join('\n') };
  return out;
}

let cur;
try { cur = await scenario(); } catch (e) { ok('scenario runs', false, String(e && e.stack || e).slice(0, 700)); }
if (cur && DUMP) {
  const base = Object.fromEntries(Object.entries(cur).filter(([k]) => k !== 'history').map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'html'))]));
  fs.writeFileSync(BASE, JSON.stringify(base, null, 1)); console.log('baseline written'); process.exit(0);
}
if (cur) {
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  for (const [k, v] of Object.entries(base)) {
    const c = cur[k];
    if (!c) { ok(`P ${k}: present`, false); continue; }
    if (v.inv) { const have = new Set(c.inv); const miss = v.inv.filter((s) => !have.has(s) && !(SWAP[s] && have.has(SWAP[s]))); ok(`P ${k}: every text/label/placeholder kept (7 Don swaps allowed)`, miss.length === 0, `${miss.length} missing: ${JSON.stringify(miss.slice(0, 8))}`); }
    for (const f of ['fetch', 'calls']) if (f in v) ok(`P ${k}: same ${f}`, JSON.stringify(c[f]) === JSON.stringify(v[f]), `now ${JSON.stringify(c[f]).slice(0, 300)} was ${JSON.stringify(v[f]).slice(0, 300)}`);
  }
  const files = ['EventsModal', 'CreateEventModal', 'CopyEventDialog'];
  const PAL = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|accent|shadow)-(?:emerald|rose|amber|red|green|blue|slate|gray|zinc|white|black|yellow|orange|indigo|purple|sky|teal|lime|pink|violet|cyan|stone|neutral)(?:-\d{2,3})?(?:\/\d+)?\b/g;
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../../src/components/${f}.tsx`, import.meta.url), 'utf8');
    const pal = src.match(PAL) || [];
    ok(`D ${f}: no raw palette colours`, pal.length === 0, `${pal.length}: ${[...new Set(pal)].slice(0, 8).join(' ')}`);
    const hex = (src.match(/(?:className|style)=[^>]*#[0-9a-fA-F]{3,8}\b/g) || []).concat(src.match(/\[#[0-9a-fA-F]{3,8}\]/g) || []);
    ok(`D ${f}: no raw hex in classes/styles`, hex.length === 0, hex.slice(0, 3).join(' | '));
    const small = [...src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].filter((m) => parseFloat(m[1]) < 12);
    ok(`D ${f}: no text under 12 px`, small.length === 0, `${small.length}`);
    const rad = src.match(/rounded-\[(?!(?:6|8|12|16|24)px\])[^\]]+\]|rounded-3xl|rounded-t-3xl|rounded-b-3xl/g) || [];
    ok(`D ${f}: radii from the set`, rad.length === 0, rad.slice(0, 4).join(' '));
    ok(`D ${f}: no retired tactile-3/5`, !/tactile-[35]\b/.test(src));
    ok(`D ${f}: no font-black/extrabold`, !/font-(?:black|extrabold)\b/.test(src));
    ok(`D ${f}: no gold gradients`, !/from-gold|to-gold-deep|bg-gradient/.test(src));
    ok(`D ${f}: no bg-black`, !/bg-black/.test(src));
    ok(`E ${f}: no "e.g." left in placeholders or copy`, !/placeholder="[^"]*e\.g\./.test(src) && !/>[^<{]*e\.g\.[^<]*</.test(src));
  }
  const htmlOf = (k) => cur[k]?.html || '';
  for (const k of ['eventsHub', 'createForm', 'copyForm']) {
    const h = decode(htmlOf(k));
    ok(`D ${k}: backdrop is bg-scrim`, /bg-scrim/.test(h));
    const ctrls = [...h.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].filter((m) => !/type="(?:hidden|file|checkbox|radio)"/.test(m[2]) && !/class="[^"]*\bhidden\b/.test(m[2]));
    const bad = ctrls.filter((m) => !/border-line-control/.test(m[2]));
    ok(`D ${k}: every input/select/textarea edge is border-line-control`, ctrls.length === 0 || bad.length === 0, `${bad.length}/${ctrls.length}`);
    const closes = [...h.matchAll(/<button\b([^>]*aria-label="Close"[^>]*)>/g)];
    ok(`D ${k}: a 44 px close button with aria-label="Close"`, closes.length >= 1 && closes.every((m) => /\b(?:w-11|min-w-11|size-11)\b/.test(m[1]) && /\b(?:h-11|min-h-11|size-11)\b/.test(m[1])), `${closes.length} close buttons`);
  }
  ok('D eventsEmpty: helpful empty state (data-empty-state)', /data-empty-state/.test(htmlOf('eventsEmpty')) && decode(htmlOf('eventsEmpty')).includes('Create an event to plan its tasks and team.'));
  ok('D eventsNoTasks: helpful empty state (data-empty-state)', /data-empty-state/.test(htmlOf('eventsNoTasks')) && decode(htmlOf('eventsNoTasks')).includes('Add the first task below.'));
  const allNew = Object.values(SWAP);
  const seen = new Set([...(cur.createForm?.inv || []), ...(cur.eventsHub?.inv || [])]);
  const evSrc = ['EventsModal', 'CreateEventModal'].map((f) => fs.readFileSync(new URL(`../../src/components/${f}.tsx`, import.meta.url), 'utf8')).join('\n');
  // shown in the scripted renders, or (for inputs behind a sub-panel, e.g. the default-task editor) present in the source
  for (const p of allNew) ok(`E new placeholder in place: ${p}`, seen.has(p) || evSrc.includes(`placeholder="${p.slice('placeholder='.length)}"`));
  const hist = decode(htmlOf('history'));
  ok('H scheduled_midnight_cron shows "Automatic (midnight)"', hist.includes('Automatic (midnight)'));
  ok('H system shows "Automatic"', /Reset by Automatic\)/.test(hist.replace(/\s+/g, ' ')));
  ok('H raw codes never shown', !RAW_CODES.some((c) => hist.includes(c)) && !/Reset by system\)/.test(hist.replace(/\s+/g, ' ')));
  ok('H other values unchanged', hist.includes('rabbi.cohen@test.local'));
}
console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
