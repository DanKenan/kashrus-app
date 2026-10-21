/**
 * D7a client test: Factory audit / hechsher check — consistency pass.
 *
 * Renders FactoryAuditHubModal, HechsherCheckModal, AddDiscrepancyModal,
 * SubmitAuditReportModal and AirtableConfigModal with a messy set through a tiny
 * stateful renderer (tests/client/lib/mini-render.mjs), drives the same
 * scripted interactions on each, and checks:
 *   P* (parity — pass on main AND on the PR): every piece of text, every button
 *      label/title, every input placeholder shown today is still there
 *      (d7a-baseline.json, recorded on main 4057821); every scripted interaction
 *      sends the same requests with the same bodies and calls the same callbacks
 *      with the same values. Nothing about the flow changes.
 *   D* (design — fail on main, pass on the PR): spec tokens only (no raw palette
 *      classes, no #hex / bg-black backdrops, no text under 12 px, radii from the
 *      set, no retired tactile-3/5, no font-black/extrabold, no gold gradients),
 *      backdrop = bg-scrim, every input/select/textarea edge = border-line-control,
 *      44 px close buttons with aria-label="Close", a skeleton (data-skeleton)
 *      while the hub is loading instead of the empty message, and a helpful empty
 *      state (data-empty-state) for each empty list.
 *
 * Run: npx tsx tests/client/test-d7a-factory.mjs        (add --dump to rewrite the baseline)
 */
import React from 'react';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { FactoryAuditHubModal } from '../../src/components/FactoryAuditHubModal.tsx';
import { HechsherCheckModal } from '../../src/components/HechsherCheckModal.tsx';
import { AddDiscrepancyModal } from '../../src/components/AddDiscrepancyModal.tsx';
import { SubmitAuditReportModal } from '../../src/components/SubmitAuditReportModal.tsx';
import { AirtableConfigModal } from '../../src/components/AirtableConfigModal.tsx';

const DUMP = process.argv.includes('--dump');
const BASE = new URL('./d7a-baseline.json', import.meta.url);
let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
const noop = () => {};
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// visible strings + labels/titles/placeholders/values of controls, from rendered HTML
function inventory(html) {
  const h = decode(html);
  const texts = h.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s && !/^[\d\s%().,:/•·-]*$/.test(s));
  const attrs = [...h.matchAll(/\s(placeholder|title|aria-label|alt)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
  const opts = [...h.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => `option=${m[1]}`);
  return [...new Set([...texts, ...attrs, ...opts])];
}

// ---------------- messy data ----------------
const LONG = 'Liquid whole eggs, pasteurised, refrigerated, 20 kg bag-in-box — for bakery line 2 only (not for the meat kitchen)';
const venue = { id: 'v1', name: 'Northeast Ingredients Plant', category: 'Industrial Plant', createdAt: '', address: '1 Industrial Park Rd, Windsor, CT' };
const user = { id: 'u1', name: 'Yossi Abramowitz-Goldberger', email: 'y@test.local', role: 'admin', agencyId: 'a' };
const ing = (id, name, status, appr, ver, extra = {}) => ({ id, venueId: 'v1', agencyId: 'a', name, brandOrSupplier: 'Supplier ' + id, kashrutAgency: 'OU', kosherStatus: status, approvalStatus: appr, verificationStatus: ver, lotOrBatch: 'LOT-' + id, ...extra });
const ings = [
  ing('i1', 'Sugar, granulated', 'Parve', 'approved', 'verified_present', { verifiedAt: '2026-10-21T07:00:00.000Z', verifiedByName: 'Moshe' }),
  ing('i2', LONG, 'Parve', 'approved', 'unverified'),
  ing('i3', 'Cocoa powder 22/24 alkalised', 'Dairy', 'approved', 'flagged_discrepancy'),
  ing('i4', 'קמח מלא — Whole wheat flour', 'Pas Yisroel', 'pending_approval', 'unverified'),
  ing('i5', 'Beef base', 'Meat', 'discontinued', 'unverified'),
];
const report = (id, status, disc) => ({ id, agencyId: 'a', venueId: 'v1', venueName: venue.name, auditDate: '2026-10-21', startTime: '07:30', endTime: '10:15', mashgiachName: 'Yossi Abramowitz-Goldberger', mashgiachEmail: 'y@test.local', factoryRepresentative: 'Linda Martinez-O’Connor, QA Manager', totalApprovedChecked: 5, totalPresent: 3, totalDiscrepancies: disc.length, auditedIngredients: [], discrepancies: disc, summaryNotes: 'Two issues found; line 2 paused. הכל נבדק.', status, mashgiachSigned: true, createdAt: '2026-10-21T10:20:00.000Z' });
const disc = { id: 'd1', name: 'Unmarked drum of glycerin', brandOrSupplier: 'Unknown', kashrutSymbolFound: 'None / No Symbol Visible', lotOrBatch: '???', locationInFactory: 'Receiving dock, bay 3', severity: 'critical', notes: 'Found on the receiving dock with no hechsher and no paperwork. Quarantined with red tape, waiting for the rav.', actionTaken: 'Quarantined', reportedAt: '2026-10-21T08:00:00.000Z', reportedByName: 'Yossi Abramowitz-Goldberger', reportedByEmail: 'y@test.local' };
const reports = [report('r1', 'critical_violation_found', [disc]), report('r2', 'passed', [])];
const atConfig = { venueId: 'v1', agencyId: 'a', baseId: 'appXYZ', tableName: 'Approved Ingredients', viewName: 'Grid view', isConnected: true, lastSyncedAt: '2026-10-20T12:00:00.000Z', lastSyncStatus: 'success', syncedRecordCount: 42 };

const record = {};
async function scenario() {
  const out = {};
  // 1. Hub — loaded, every tab, every row action
  let calls = recordFetch({ '/api/ingredients/': (p, b) => { const id = p.split('/')[3]; const it = ings.find((x) => x.id === id); return { ...it, verificationStatus: b.verificationStatus, verifiedByName: b.verificationStatus === 'unverified' ? null : 'Yossi Abramowitz-Goldberger', verifiedAt: b.verificationStatus === 'unverified' ? null : '2026-10-21T08:00:00.000Z' }; }, '/api/ingredients': { ingredients: ings }, '/api/airtable/config': { config: atConfig }, '/api/factory-reports': { reports }, '/api/airtable/sync': { success: true, ingredients: ings, count: 5 } });
  const hub = mount(FactoryAuditHubModal, { isOpen: true, onClose: noop, currentVenue: venue, currentUser: user, isAdmin: true });
  await hub.render();
  out.hubIngredients = { inv: inventory(hub.html()) };
  await hub.click('Verify'); await hub.click('Undo').catch(() => {}); await hub.click('Flag discrepancy');
  out.hubRowActions = { fetch: calls.slice(3) };
  await hub.click('Unapproved Materials Log'); out.hubDiscEmpty = { inv: inventory(hub.html()), html: hub.html() };
  await hub.click('Official Factory Reports'); out.hubReports = { inv: inventory(hub.html()), html: hub.html() };
  // child callbacks wired by the hub (call the props the hub passes)
  const child = (T) => hub.find(() => false) && [...(function* w(n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { for (const c of n) yield* w(c); return; } if (!React.isValidElement(n)) return; yield n; yield* w(n.props?.children); })(hub.tree())].find((e) => e.type === T);
  await child(AddDiscrepancyModal).props.onAddDiscrepancy(disc); await hub.render();
  await hub.click('Unapproved Materials Log'); out.hubDiscOne = { inv: inventory(hub.html()) };
  calls.length = 0;
  await hub.click('Official Factory Reports'); await hub.click('Approved Ingredients Matrix'); await hub.click('Check', 0);
  const hcm = child(HechsherCheckModal);
  out.hubHechsherWiring = { present: !!hcm, ingredient: hcm?.props?.ingredient?.id ?? null };
  if (hcm) { await hcm.props.onConfirm(hcm.props.ingredient.id); await hub.render(); }
  out.hubHechsherConfirm = { fetch: calls.slice() };
  calls.length = 0;
  await child(AirtableConfigModal).props.onSaveConfig({ baseId: 'appNEW', tableName: 'T', viewName: 'V' });
  await child(AirtableConfigModal).props.onSyncNow(); await hub.render();
  out.hubAirtable = { fetch: calls.map(([m, p, b]) => [m, p, b && Object.keys(b).sort()]) };
  // 2. Hub — empty venue, and still loading
  recordFetch({ '/api/ingredients': { ingredients: [] }, '/api/airtable/config': { config: null }, '/api/factory-reports': { reports: [] } });
  const empty = mount(FactoryAuditHubModal, { isOpen: true, onClose: noop, currentVenue: venue, currentUser: user, isAdmin: true });
  await empty.render(); out.hubEmpty = { inv: inventory(empty.html()), html: empty.html() };
  await empty.click('Official Factory Reports'); out.hubReportsEmpty = { inv: inventory(empty.html()), html: empty.html() };
  recordFetch({ '/api/ingredients': 'PENDING', '/api/airtable/config': 'PENDING', '/api/factory-reports': 'PENDING' });
  const loading = mount(FactoryAuditHubModal, { isOpen: true, onClose: noop, currentVenue: venue, currentUser: user, isAdmin: true });
  await loading.render(); out.hubLoading = { html: loading.html() };
  // 3. Hechsher check — capture step; compare step via file pick
  const hc = []; const hech = mount(HechsherCheckModal, { ingredient: ings[1], onClose: () => hc.push('close'), onConfirm: (id) => hc.push('confirm:' + id), onFlag: (id) => hc.push('flag:' + id) });
  await hech.render(); out.hechCapture = { inv: inventory(hech.html()), html: hech.html() };
  globalThis.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; this.onload && this.onload(); } };
  const fileInput = hech.find((e) => e.type === 'input' && e.props.type === 'file')[0];
  await fileInput.props.onChange({ target: { files: [{ name: 'label.png' }], value: 'x' } }); await hech.render();
  out.hechCompare = { inv: inventory(hech.html()), html: hech.html() };
  await hech.click(/Match/); await hech.click(/Flag mismatch/); await hech.click(/Close/);
  out.hechCallbacks = { calls: hc };
  // 4. Add discrepancy — fill + submit
  const added = []; const add = mount(AddDiscrepancyModal, { isOpen: true, onClose: () => added.push('close'), currentUser: user, onAddDiscrepancy: (d) => added.push(d) });
  await add.render(); out.addForm = { inv: inventory(add.html()), html: add.html() };
  await add.type(/Artificial Strawberry/, 'Unmarked drum of glycerin'); await add.type(/Vendor label/, 'Unknown');
  const ta = add.find((e) => e.type === 'textarea')[0]; await ta.props.onChange({ target: { value: 'No hechsher; quarantined.' } }); await add.render();
  await add.submit();
  out.addCallbacks = { calls: added.map((d) => (typeof d === 'string' ? d : { ...d, id: 'ID', reportedAt: 'T' })) };
  // 5. Submit report — fill + submit
  let rcalls = recordFetch({ 'POST /api/factory-reports': (p, b) => ({ success: true, report: { ...b, id: 'r9', createdAt: 'T' } }) });
  const done = []; const rep = mount(SubmitAuditReportModal, { isOpen: true, onClose: () => done.push('close'), venue, currentUser: user, ingredients: ings, discrepancies: [disc], onSubmitSuccess: (r) => done.push(r.id) });
  await rep.render(); out.reportForm = { inv: inventory(rep.html()), html: rep.html() };
  await rep.click(/Minor inquiry/);
  await rep.submit();
  out.reportSubmit = { fetch: rcalls.map(([m, p, b]) => [m, p, b && Object.fromEntries(Object.entries(b).filter(([k]) => !/Timestamp|createdAt|auditDate/.test(k)))]), done };
  // 6. Airtable config — admin, save + sync
  const at = []; const atm = mount(AirtableConfigModal, { isOpen: true, onClose: () => at.push('close'), config: atConfig, venueName: venue.name, venueId: 'v1', isAdmin: true, onSaveConfig: async (u) => { at.push(['save', Object.keys(u).sort()]); }, onSyncNow: async () => { at.push('sync'); } });
  await atm.render(); out.airtable = { inv: inventory(atm.html()), html: atm.html() };
  await atm.click(/Advanced|Field Mapping|Column/i).catch(() => {}); out.airtableAdvanced = { inv: inventory(atm.html()) };
  await atm.submit().catch(async () => { await atm.click(/Save/); });
  await atm.click(/Sync/).catch(() => {});
  out.airtableCallbacks = { calls: at };
  const atNon = mount(AirtableConfigModal, { isOpen: true, onClose: noop, config: atConfig, venueName: venue.name, venueId: 'v1', isAdmin: false, onSaveConfig: async () => {}, onSyncNow: async () => {} });
  await atNon.render(); out.airtableNonAdmin = { inv: inventory(atNon.html()) };
  return out;
}

let cur;
try { cur = await scenario(); } catch (e) { ok('scenario runs', false, String(e && e.stack || e).slice(0, 600)); }
if (cur && DUMP) {
  const base = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'html'))]));
  fs.writeFileSync(BASE, JSON.stringify(base, null, 1)); console.log('baseline written'); process.exit(0);
}
if (cur) {
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  // P — parity
  for (const [k, v] of Object.entries(base)) {
    const c = cur[k];
    if (!c) { ok(`P ${k}: present`, false); continue; }
    if (v.inv) { const have = new Set(c.inv); const miss = v.inv.filter((s) => !have.has(s)); ok(`P ${k}: every text/label/placeholder kept`, miss.length === 0, `${miss.length} missing: ${JSON.stringify(miss.slice(0, 8))}`); }
    for (const f of ['fetch', 'calls', 'done', 'present']) if (f in v) ok(`P ${k}: same ${f}`, JSON.stringify(c[f]) === JSON.stringify(v[f]), `now ${JSON.stringify(c[f]).slice(0, 300)} was ${JSON.stringify(v[f]).slice(0, 300)}`);
  }
  // D — design
  const files = ['FactoryAuditHubModal', 'HechsherCheckModal', 'AddDiscrepancyModal', 'SubmitAuditReportModal', 'AirtableConfigModal'];
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
    ok(`D ${f}: no bg-black backdrop`, !/bg-black/.test(src));
  }
  const htmlOf = (k) => cur[k]?.html || '';
  const backdrop = (h) => /bg-scrim/.test(h);
  for (const k of ['hubIngredients', 'hechCapture', 'addForm', 'reportForm', 'airtable']) {
    const h = htmlOf(k) || (k === 'hubIngredients' ? htmlOf('hubDiscEmpty') : '');
    ok(`D ${k}: backdrop is bg-scrim`, backdrop(h));
    const ctrls = [...decode(h).matchAll(/<(input|select|textarea)\b([^>]*)>/g)].filter((m) => !/type="(?:hidden|file|checkbox|radio)"/.test(m[2]) && !/class="[^"]*\bhidden\b/.test(m[2]));
    const bad = ctrls.filter((m) => !/border-line-control/.test(m[2]));
    ok(`D ${k}: every input/select/textarea edge is border-line-control`, ctrls.length === 0 || bad.length === 0, `${bad.length}/${ctrls.length}`);
    const closes = [...decode(h).matchAll(/<button\b([^>]*aria-label="Close"[^>]*)>/g)];
    ok(`D ${k}: a 44 px close button with aria-label="Close"`, closes.length >= 1 && closes.every((m) => /\b(?:w-11|min-w-11|size-11)\b/.test(m[1]) && /\b(?:h-11|min-h-11|size-11)\b/.test(m[1])), `${closes.length} close buttons`);
  }
  ok('D hub loading: skeleton, not the empty message', /data-skeleton/.test(htmlOf('hubLoading')) && !/No matching approved raw materials found/.test(htmlOf('hubLoading')));
  for (const k of ['hubEmpty', 'hubDiscEmpty', 'hubReportsEmpty']) ok(`D ${k}: helpful empty state (data-empty-state)`, /data-empty-state/.test(htmlOf(k)));
  ok('D hubEmpty: helper says what to do', decode(htmlOf('hubEmpty')).includes('Connect the Airtable database to load the approved list.'));
  ok('D hubDiscEmpty: helper says what to do', decode(htmlOf('hubDiscEmpty')).includes('If something on the floor has no approval, flag it here.'));
}
console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
