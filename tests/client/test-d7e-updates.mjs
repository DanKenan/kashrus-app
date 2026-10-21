/**
 * D7e client test: Updates, announcements & alerts — consistency pass (no flow change).
 *   P* parity (main AND PR): every text/label/placeholder shown on main is still shown; scripted flows send
 *      the same requests/bodies and fire the same callbacks.
 *   D* design (fail on main, pass on PR).  E* empty states keep their text + data-empty-state (+ Alerts helper).
 * Run: npx tsx tests/client/test-d7e-updates.mjs   (--dump rewrites tests/client/d7e-baseline.json on main)
 */
import React from 'react';
import fs from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { UpdatesSheet } from '../../src/components/UpdatesSheet.tsx';
import { Announcements } from '../../src/components/Announcements.tsx';
import { UrgentBanner } from '../../src/components/UrgentBanner.tsx';
import { AlertsTab } from '../../src/components/AlertsTab.tsx';

const DUMP = process.argv.includes('--dump');
const BASE = new URL('./d7e-baseline.json', import.meta.url);
let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const noop = () => {};
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function inventory(html) {
  const h = decode(html);
  const texts = h.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s && !/^[\d\s%().,:/•·-]*$/.test(s) && !/\b(ago|AM|PM)\b/.test(s));
  const attrs = [...h.matchAll(/\s(placeholder|title|aria-label|alt|role)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
  return [...new Set([...texts, ...attrs])];
}
const HELPER = 'Raise one above if something needs attention.';
const now = new Date().toISOString();
const ann = [
  { id: 'n1', authorEmail: 'other@test.local', authorName: 'Rabbi Yisroel Meir Schwartzberg', title: 'Pesach kitchen kashering — Sunday 6 AM sharp, all hands', body: 'Bring gloves. בס״ד', category: 'urgent', targetRoles: [], createdAt: now, venueId: 'v1' },
  { id: 'n2', authorEmail: 'me@test.local', authorName: 'Me', title: 'Fridge 3 is fixed', body: '', category: 'update', targetRoles: ['mashgiach'], createdAt: now, venueId: 'v1' },
];
const alerts = [
  { id: 'a1', venueId: 'v1', title: 'Seal broken on the meat fridge (walk-in #2)', description: 'Found at 7am', severity: 'high', status: 'open', createdAt: now, reporterName: 'Moshe Klein' },
  { id: 'a2', venueId: 'v1', title: 'Low on gloves', description: '', severity: 'low', status: 'acknowledged', createdAt: now, reporterName: 'Sara Levi', acknowledgedAt: now, acknowledgedByName: 'Don' },
];
const draft0 = { title: '', description: '', severity: 'medium' };
function alertsProps(extra = {}) {
  return { items: alerts, loading: false, unreadIds: new Set(['a1']), role: 'admin', viewerVenueIds: ['v1'], canFillTasks: true, venueId: 'v1', active: true, highlightId: null, receipts: { a1: { id: 'a1', read: 3, total: 7 } }, mutedUntil: null, onMuteChange: noop, onMark: noop, onChanged: noop, onOpenReaders: noop, draft: draft0, media: {}, draftGen: 0, onDraftChange: noop, onMediaChange: noop, onDiscardDraft: noop, onDraftSent: noop, ...extra };
}
function annProps(extra = {}) {
  return { items: ann, loading: false, readOnly: false, canPost: true, canDelete: (i) => i.authorEmail === 'me@test.local', unreadIds: new Set(['n1']), currentUserEmail: 'me@test.local', currentUserName: 'Me', currentUserRole: 'admin', venueId: 'v1', active: true, highlightId: null, onMark: noop, onPosted: noop, onDeleted: noop, receipts: { n2: { id: 'n2', read: 2, total: 5 } }, onOpenReaders: noop, ...extra };
}
globalThis.window = globalThis.window || {}; globalThis.window.confirm = () => true;
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((f) => setTimeout(() => f(0), 0)); globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));
const fakeEl = () => ({ style: {}, focus() {}, blur() {}, scrollIntoView() {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0, width: 0 }), querySelector: () => null, querySelectorAll: () => [], contains: () => false, classList: { add() {}, remove() {} } });
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {}, body: fakeEl(), documentElement: fakeEl(), activeElement: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: fakeEl, visibilityState: 'visible' };
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {}); globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});
globalThis.IntersectionObserver = globalThis.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };

async function scenario() {
  const out = {};
  // 1. Updates sheet frame
  const sc = [];
  const us = mount(UpdatesSheet, { open: true, onClose: () => sc.push('close'), activeTab: 'announcements', onTabChange: (t) => sc.push(['tab', t]), unreadAnnouncements: 3, unreadNotes: 0, unreadAlerts: 2, announcements: React.createElement('div', null, 'ANN-BODY'), notes: React.createElement('div', null, 'NOTES-BODY'), alerts: React.createElement('div', null, 'ALERTS-BODY') });
  await us.render(); out.sheet = { inv: inventory(us.html()), html: us.html() };
  await us.click(/Alerts/).catch((e) => sc.push('noalerts:' + e.message)); await us.click('Close updates').catch((e) => sc.push('noclose:' + e.message));
  out.sheetCalls = { calls: sc };
  // 2. Announcements (poster): list, compose, post, delete
  const ac = []; const af = recordFetch({ 'POST /api/announcements': (p, b) => ({ announcement: { id: 'n3', ...b, authorEmail: 'me@test.local', authorName: 'Me', createdAt: now } }), 'DELETE /api/announcements/': () => ({ ok: true }), '/api/': {} });
  const an = mount(Announcements, annProps({ onPosted: (i) => ac.push(['posted', i && i.title]), onDeleted: (id) => ac.push(['deleted', id]) }));
  await an.render(); out.ann = { inv: inventory(an.html()), html: an.html() };
  await an.click('New announcement').catch((e) => ac.push('nonew:' + e.message));
  out.annCompose = { inv: inventory(an.html()), html: an.html() };
  await an.type('Headline', 'Mincha at 1:45'); await an.type('Details', 'In the back room');
  await an.click('Post announcement').catch(async () => { await an.submit().catch((e) => ac.push('nopost:' + e.message)); });
  await an.click(/Delete announcement: Fridge 3/).catch((e) => ac.push('nodelete:' + e.message));
  out.annFlow = { fetch: af.filter(([m]) => m !== 'GET').map(([m, p, b]) => [m, p.replace(/\/[^/]*\d[^/]*$/, '/:id'), b]), calls: ac };
  recordFetch({ '/api/': {} });
  const ae = mount(Announcements, annProps({ items: [] })); await ae.render(); out.annEmpty = { inv: inventory(ae.html()), html: ae.html() };
  const ar = mount(Announcements, annProps({ items: [], readOnly: true, canPost: false })); await ar.render(); out.annEmptyRO = { inv: inventory(ar.html()), html: ar.html() };
  const ao = mount(Announcements, annProps({ readOnly: true, canPost: false })); await ao.render(); out.annRO = { inv: inventory(ao.html()), html: ao.html() };
  // 3. Urgent banner
  const bc = [];
  const ub = mount(UrgentBanner, { item: { id: 'n1', title: 'Pesach kitchen kashering — Sunday 6 AM sharp', createdAt: now }, onView: (id) => bc.push(['view', id]), onDismiss: (id) => bc.push(['dismiss', id]) });
  await ub.render(); out.banner = { inv: inventory(ub.html()), html: ub.html() };
  await ub.click('Dismiss and mark read').catch((e) => bc.push('nodismiss:' + e.message));
  const ub2 = mount(UrgentBanner, { item: { id: 'a1', title: 'Seal broken', createdAt: now }, onView: noop, onDismiss: noop, kicker: 'Alert' });
  await ub2.render(); out.bannerAlert = { inv: inventory(ub2.html()), html: ub2.html() };
  out.bannerCalls = { calls: bc };
  // 4. Alerts tab: list, raise
  const lc = []; const lf = recordFetch({ 'POST /api/alerts': (p, b) => ({ alert: { id: 'a3', ...b, status: 'open', createdAt: now, reporterName: 'Me', venueId: 'v1' } }), '/api/': {} });
  let draft = { ...draft0 };
  const al = mount(AlertsTab, alertsProps({ onDraftChange: (p) => { draft = { ...draft, ...p }; lc.push(['draft', Object.keys(p).join(',')]); al.setProps && al.setProps({ draft }); }, onDraftSent: () => lc.push('sent'), onChanged: () => lc.push('changed') }));
  await al.render(); out.alerts = { inv: inventory(al.html()), html: al.html() };
  await al.click('Raise an alert').catch((e) => lc.push('noraise:' + e.message));
  out.alertsCompose = { inv: inventory(al.html()), html: al.html() };
  const sf = recordFetch({ 'POST /api/alerts': (p, b) => ({ alert: { id: 'a3', ...b, status: 'open', createdAt: now, reporterName: 'Me', venueId: 'v1' } }), '/api/': {} });
  const sc2 = [];
  const as = mount(AlertsTab, alertsProps({ draft: { title: 'Gas smell by the fryer', description: 'Strong', severity: 'critical' }, onDraftSent: () => sc2.push('sent'), onChanged: () => sc2.push('changed') }));
  await as.render(); out.alertsDraft = { inv: inventory(as.html()), html: as.html() };
  // RaiseAlertForm is a nested component: mini-render drives only the top component's own elements, so the send
  // itself is not driven here (inventory of the open composer with a draft is compared instead).
  recordFetch({ '/api/': {} });
  const le = mount(AlertsTab, alertsProps({ items: [] })); await le.render(); out.alertsEmpty = { inv: inventory(le.html()), html: le.html() };
  return out;
}

let cur;
try { cur = await scenario(); } catch (e) { ok('scenario runs', false, String(e && e.stack || e).slice(0, 700)); }
if (cur && DUMP) {
  const base = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'html'))]));
  fs.writeFileSync(BASE, JSON.stringify(base, null, 1)); console.log('baseline written'); process.exit(0);
}
if (cur) {
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  for (const [k, v] of Object.entries(base)) {
    const c = cur[k];
    if (!c) { ok(`P ${k}: present`, false); continue; }
    if (v.inv) { const have = new Set(c.inv); const miss = v.inv.filter((s) => !have.has(s)); ok(`P ${k}: every text/label/placeholder kept`, miss.length === 0, `${miss.length} missing: ${JSON.stringify(miss.slice(0, 8))}`); }
    for (const f of ['fetch', 'calls']) if (f in v) ok(`P ${k}: same ${f}`, JSON.stringify(c[f]) === JSON.stringify(v[f]), `now ${JSON.stringify(c[f]).slice(0, 300)} was ${JSON.stringify(v[f]).slice(0, 300)}`);
  }
  const files = ['UpdatesSheet', 'Announcements', 'UrgentBanner', 'PushNotificationToggle', 'AlertsTab'];
  const PAL = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|accent|shadow)-(?:emerald|rose|amber|red|green|blue|slate|gray|zinc|white|black|yellow|orange|indigo|purple|sky|teal|lime|pink|violet|cyan|stone|neutral)(?:-\d{2,3})?(?:\/\d+)?\b/g;
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../../src/components/${f}.tsx`, import.meta.url), 'utf8');
    const pal = src.match(PAL) || [];
    ok(`D ${f}: no raw palette colours`, pal.length === 0, `${pal.length}: ${[...new Set(pal)].slice(0, 8).join(' ')}`);
    const hex = (src.match(/\[#[0-9a-fA-F]{3,8}\]/g) || []);
    ok(`D ${f}: no raw hex in classes`, hex.length === 0, hex.slice(0, 3).join(' | '));
    const small = [...src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].filter((m) => parseFloat(m[1]) < 12);
    ok(`D ${f}: no text under 12 px`, small.length === 0, `${small.length}`);
    const rad = src.match(/rounded-\[(?!(?:6|8|12|16|24)px\])[^\]]+\]|rounded-3xl|rounded-t-3xl|rounded-b-3xl/g) || [];
    ok(`D ${f}: radii from the set`, rad.length === 0, rad.slice(0, 4).join(' '));
    ok(`D ${f}: no retired tactile-3/5`, !/tactile-[35]\b/.test(src));
    ok(`D ${f}: no font-black/extrabold`, !/font-(?:black|extrabold)\b/.test(src));
    ok(`D ${f}: no gold gradients`, !/from-gold|to-gold-deep|bg-gradient/.test(src));
    ok(`D ${f}: no bg-black`, !/bg-black/.test(src));
    ok(`D ${f}: no bg-gold + text-white primary`, !/bg-gold\b[^'"`]*text-white|text-white[^'"`]*bg-gold\b/.test(src));
  }
  const htmlOf = (k) => decode(cur[k]?.html || '');
  ok('D sheet: backdrop is bg-scrim', /bg-scrim/.test(htmlOf('sheet')));
  const closes = [...htmlOf('sheet').matchAll(/<button\b([^>]*aria-label="Close updates"[^>]*)>/g)];
  ok('D sheet: Close updates is 44 px', closes.length === 1 && /\b(?:w-11|min-w-11|size-11)\b/.test(closes[0][1]) && /\b(?:h-11|min-h-11|size-11)\b/.test(closes[0][1]));
  for (const k of ['annCompose', 'alertsCompose']) {
    const ctrls = [...htmlOf(k).matchAll(/<(input|select|textarea)\b([^>]*)>/g)].filter((m) => !/type="(?:hidden|file|checkbox|radio)"/.test(m[2]) && !/class="[^"]*\bhidden\b/.test(m[2]));
    const bad = ctrls.filter((m) => !/border-line-control/.test(m[2]));
    ok(`D ${k}: every input/select/textarea edge is border-line-control`, bad.length === 0, `${bad.length}/${ctrls.length}`);
  }
  const primaries = (h) => [...h.matchAll(/<button\b[^>]*class="([^"]*)"/g)].filter((m) => /\bbg-gold-deep\b/.test(m[1]) && /\btext-paper\b/.test(m[1])).length;
  ok('D ann: exactly one primary (New announcement) before composing', primaries(htmlOf('ann')) === 1, `${primaries(htmlOf('ann'))}`);
  ok('D annCompose: exactly one primary (Post announcement) while composing', primaries(htmlOf('annCompose')) === 1 && /Post announcement/.test(htmlOf('annCompose')), `${primaries(htmlOf('annCompose'))}`);
  ok('D alerts: exactly one primary (Raise an alert) before composing', primaries(htmlOf('alerts')) === 1, `${primaries(htmlOf('alerts'))}`);
  ok('D alertsCompose: exactly one primary (Send alert now) while composing', primaries(htmlOf('alertsCompose')) === 1, `${primaries(htmlOf('alertsCompose'))}`);
  const tabs = [...htmlOf('sheet').matchAll(/<button\b[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)];
  const alertTab = tabs.find((m) => /Alerts/.test(m[1]));
  ok('D sheet: the Alerts unread badge keeps its alarm look (bg-bad / var(--bad))', !!alertTab && /bg-bad\b|var\(--bad\)/.test(alertTab[1]), alertTab ? alertTab[1].slice(0, 200) : 'no alerts tab');
  const chips = [...htmlOf('annCompose').matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]).filter((a) => /rounded-full/.test(a) && /\bh-11\b/.test(a));
  const sel = chips.filter((a) => /aria-pressed="true"/.test(a));
  ok('D annCompose: selected Kind/Send-to chips are aria-pressed and gold-wash (clearly visible)', sel.length >= 2 && sel.every((a) => /bg-gold-wash|var\(--bad-bg\)/.test(a)), `${sel.length} pressed of ${chips.length}`);
  const ae = htmlOf('annEmpty');
  ok('E annEmpty: keeps both lines + data-empty-state, no new copy', /data-empty-state/.test(ae) && ae.includes('No announcements yet.') && ae.includes('Updates for the whole team will show up here.'));
  const le = htmlOf('alertsEmpty');
  ok('E alertsEmpty: keeps its text + data-empty-state + helper (raise control shown)', /data-empty-state/.test(le) && le.includes('No open alerts at this venue.') && le.includes(HELPER));
}
console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
