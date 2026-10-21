/**
 * D7d client test: Kiosk tablets & account dialogs — consistency pass (no flow change).
 *
 * Renders KioskDevicesModal, KioskCodeDialog, ConfirmModal (3 variants), ChangePasswordModal and
 * ForgotPasswordModal through tests/client/lib/mini-render.mjs, drives scripted interactions, and checks:
 *   P* parity (main AND PR): every text/label/placeholder/option shown on main is still shown;
 *      scripted flows send the same requests/bodies and fire the same callbacks.
 *   D* design (fail on main, pass on PR): tokens only, >=12px, radii set, no tactile-3/5,
 *      font-black, gradients, bg-black/#hex; bg-scrim; border-line-control; 44px Close (aria-label^="Close").
 *   E* (fail on main, pass on PR): the kiosk tablets empty state keeps its text + data-empty-state + helper.
 * Run: npx tsx tests/client/test-d7d-dialogs.mjs   (--dump rewrites tests/client/d7d-baseline.json on main)
 */
import React from 'react';
import fs from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { KioskDevicesModal } from '../../src/components/KioskDevicesModal.tsx';
import { KioskCodeDialog } from '../../src/components/KioskCodeDialog.tsx';
import { ConfirmModal } from '../../src/components/ConfirmModal.tsx';
import { ChangePasswordModal } from '../../src/components/ChangePasswordModal.tsx';
import { ForgotPasswordModal } from '../../src/components/ForgotPasswordModal.tsx';

const DUMP = process.argv.includes('--dump');
const BASE = new URL('./d7d-baseline.json', import.meta.url);
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
const HELPER = 'Pair a tablet with the code shown on its screen.';
const admin = { id: 'u1', name: 'Yossi Abramowitz-Goldberger', email: 'admin@test.local', role: 'admin', agencyId: 'a', venueId: 'v1' };
const venues = [{ id: 'v1', name: 'Beth El Social Hall — Main Ballroom (upstairs)', createdAt: '' }, { id: 'v2', name: 'Riverside Kitchen', createdAt: '' }];
const devices = [{ id: 'd1', name: 'Kitchen tablet (back door)', venueId: 'v1', pairedAt: '2099-06-01T10:00:00.000Z', lastSeenAt: '2099-06-02T10:00:00.000Z' }];
globalThis.window = globalThis.window || {}; globalThis.window.confirm = () => true;

async function scenario() {
  const out = {};
  // 1. Kiosk tablets: list, pair, unpair
  let list = devices.slice();
  const kc = recordFetch({ 'POST /api/kiosk/devices/pair': (p, b) => { list = [...list, { id: 'd2', name: b.name || 'Tablet', venueId: b.venueId }]; return { device: { id: 'd2', name: b.name || 'Tablet' } }; }, 'DELETE /api/kiosk/devices/': () => { list = list.filter((d) => d.id !== 'd1'); return { ok: true }; }, 'GET /api/kiosk/devices': () => ({ devices: list }), '/api/': {} });
  const kd = mount(KioskDevicesModal, { isOpen: true, onClose: noop, currentUser: admin, venues });
  await kd.render(); await kd.render(); out.kiosk = { inv: inventory(kd.html()), html: kd.html() };
  await kd.type(/ABC234/, 'xyz789'); await kd.type(/Kitchen tablet/, 'Bakery tablet');
  const vsel = kd.find((e) => e.type === 'select' && typeof e.props.onChange === 'function');
  if (vsel[0]) { await vsel[0].props.onChange({ target: { value: 'v2' } }); await kd.render(); }
  await kd.submit().catch(async () => { await kd.click(/^\s*Pair/).catch(() => {}); });
  await kd.click(/Unpair/).catch(() => {});
  out.kioskFlow = { fetch: kc.filter(([m]) => m !== 'GET').map(([m, p, b]) => [m, p, b]) };
  recordFetch({ 'GET /api/kiosk/devices': () => ({ devices: [] }), '/api/': {} });
  const ke = mount(KioskDevicesModal, { isOpen: true, onClose: noop, currentUser: admin, venues });
  await ke.render(); await ke.render(); out.kioskEmpty = { inv: inventory(ke.html()), html: ke.html() };
  // 2. Kiosk code dialog: entry step then saved
  const cc = [];
  const kcd = mount(KioskCodeDialog, { isOpen: true, personName: 'Moshe Klein', hasCode: false, phoneNumber: '+18605550101', canEditPhone: true, onClose: () => cc.push('close'), onSaveCode: async (c) => { cc.push(['save', c.length]); }, onRemoveCode: async () => { cc.push('remove'); }, onSavePhone: async (p) => { cc.push(['phone', p]); } });
  await kcd.render(); out.code = { inv: inventory(kcd.html()), html: kcd.html() };
  await kcd.type('••••', '4821'); await kcd.submit().catch((e) => cc.push('nosave:' + e.message));
  out.codeShown = { inv: inventory(kcd.html()), html: kcd.html() };
  await kcd.click('Done').catch(() => {});
  const kcd2 = mount(KioskCodeDialog, { isOpen: true, personName: 'Moshe Klein', hasCode: true, canEditPhone: false, onClose: () => cc.push('close2'), onSaveCode: async (c) => { cc.push(['save2', c.length]); }, onRemoveCode: async () => { cc.push('remove2'); }, onSavePhone: async () => {} });
  await kcd2.render(); out.codeHas = { inv: inventory(kcd2.html()), html: kcd2.html() };
  await kcd2.click('Remove code').catch((e) => cc.push('noremove:' + e.message));
  out.codeRemoveAsk = { inv: inventory(kcd2.html()), html: kcd2.html() };
  await kcd2.click(/^\s*Remove\s*$/).catch((e) => cc.push('noremove2:' + e.message));
  const kcd3 = mount(KioskCodeDialog, { isOpen: true, personName: 'Moshe Klein', hasCode: false, phoneNumber: '', canEditPhone: true, onClose: noop, onSaveCode: async () => {}, onRemoveCode: async () => {}, onSavePhone: async (p) => { cc.push(['phone', p]); } });
  await kcd3.render(); await kcd3.type('(860) 555-0123', '(860) 555-0199'); await kcd3.click('Save phone').catch((e) => cc.push('nophone:' + e.message));
  out.codeCalls = { calls: cc.slice() };
  // 3. Confirm modal, every variant
  for (const variant of ['danger', 'warning', 'primary']) {
    const c = [];
    const cm = mount(ConfirmModal, { isOpen: true, onClose: () => c.push('cancel'), onConfirm: () => c.push('confirm'), title: `Delete "Kiddush (past)"?`, message: 'This cannot be undone. בס״ד', confirmText: 'Yes, delete', cancelText: 'Keep it', variant, icon: variant === 'danger' ? 'trash' : 'alert' });
    await cm.render(); out[`confirm_${variant}`] = { inv: inventory(cm.html()), html: cm.html() };
    await cm.click('Yes, delete').catch(() => {}); await cm.click('Keep it').catch(() => {});
    out[`confirm_${variant}_calls`] = { calls: c };
  }
  // 4. Change password
  const cp = recordFetch({ 'POST /api/auth/change-password': () => ({ success: true }), '/api/': {} });
  const toasts = [];
  const chp = mount(ChangePasswordModal, { isOpen: true, onClose: noop, currentUser: admin, onSuccessToast: (m) => toasts.push(m) });
  await chp.render(); out.changePw = { inv: inventory(chp.html()), html: chp.html() };
  await chp.type(/current password/i, 'oldpass1'); await chp.type(/Enter new password/, 'newpass12'); await chp.type(/Re-enter/, 'newpass12');
  await chp.submit().catch(() => {});
  out.changePwFlow = { fetch: cp.filter(([m]) => m !== 'GET').map(([m, p, b]) => [m, p, b]), calls: toasts };
  out.changePwDone = { inv: inventory(chp.html()), html: chp.html() };
  // 5. Forgot password, 3 steps
  const fp = recordFetch({ 'POST /api/auth/forgot-password': () => ({ success: true }), 'POST /api/auth/verify-reset-code': () => ({ success: true, resetToken: 'rt' }), 'POST /api/auth/reset-password': () => ({ user: { id: 'u1' }, token: 'tok' }), '/api/': {} });
  const fs2 = [];
  const fpm = mount(ForgotPasswordModal, { onClose: () => fs2.push('close'), onSuccess: (u, t) => fs2.push(['success', u && u.id, t]) });
  await fpm.render(); out.forgot1 = { inv: inventory(fpm.html()), html: fpm.html() };
  await fpm.type(/you@example.com/, 'admin@test.local'); await fpm.submit().catch(async () => { await fpm.click(/Send|code/i).catch(() => {}); });
  out.forgot2 = { inv: inventory(fpm.html()), html: fpm.html() };
  await fpm.type(/123456/, '654321'); await fpm.submit().catch(async () => { await fpm.click(/Verify/i).catch(() => {}); });
  out.forgot3 = { inv: inventory(fpm.html()), html: fpm.html() };
  await fpm.type(/New password/, 'brandnew99'); await fpm.type(/Confirm new password/, 'brandnew99'); await fpm.submit().catch(async () => { await fpm.click(/Reset|Save|Set/i).catch(() => {}); });
  out.forgotFlow = { fetch: fp.filter(([m]) => m !== 'GET').map(([m, p, b]) => [m, p, b]), calls: fs2 };
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
  const files = ['KioskDevicesModal', 'KioskCodeDialog', 'ConfirmModal', 'ChangePasswordModal', 'ForgotPasswordModal'];
  const PAL = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|accent|shadow)-(?:emerald|rose|amber|red|green|blue|slate|gray|zinc|white|black|yellow|orange|indigo|purple|sky|teal|lime|pink|violet|cyan|stone|neutral)(?:-\d{2,3})?(?:\/\d+)?\b/g;
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../../src/components/${f}.tsx`, import.meta.url), 'utf8');
    const pal = src.match(PAL) || [];
    ok(`D ${f}: no raw palette colours`, pal.length === 0, `${pal.length}: ${[...new Set(pal)].slice(0, 8).join(' ')}`);
    const hex = (src.match(/className=[^>]*#[0-9a-fA-F]{3,8}\b/g) || []).concat(src.match(/\[#[0-9a-fA-F]{3,8}\]/g) || []);
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
  const htmlOf = (k) => cur[k]?.html || '';
  for (const k of ['kiosk', 'code', 'confirm_danger', 'changePw', 'forgot1']) {
    const h = decode(htmlOf(k));
    ok(`D ${k}: backdrop is bg-scrim`, /bg-scrim/.test(h));
    const ctrls = [...h.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].filter((m) => !/type="(?:hidden|file|checkbox|radio)"/.test(m[2]) && !/class="[^"]*\bhidden\b/.test(m[2]));
    const bad = ctrls.filter((m) => !/border-line-control/.test(m[2]));
    ok(`D ${k}: every input/select/textarea edge is border-line-control`, ctrls.length === 0 || bad.length === 0, `${bad.length}/${ctrls.length}`);
    const closes = [...h.matchAll(/<button\b([^>]*aria-label="Close[^"]*"[^>]*)>/g)];
    if (k !== 'confirm_danger' && k !== 'forgot1') ok(`D ${k}: a 44 px close button with aria-label^="Close"`, closes.length >= 1 && closes.every((m) => /\b(?:w-11|min-w-11|size-11)\b/.test(m[1]) && /\b(?:h-11|min-h-11|size-11)\b/.test(m[1])), `${closes.length} close buttons`);
    else ok(`D ${k}: any close button present is 44 px`, closes.every((m) => /\b(?:w-11|min-w-11|size-11)\b/.test(m[1]) && /\b(?:h-11|min-h-11|size-11)\b/.test(m[1])), `${closes.length}`);
  }
  const ke = decode(htmlOf('kioskEmpty'));
  ok('E kioskEmpty: helpful empty state keeps its text (data-empty-state + helper)', /data-empty-state/.test(ke) && ke.includes('No tablets are paired yet.') && ke.includes(HELPER));
}
console.log(`${passed} passed, ${failures} failed.`);
if (failures) process.exit(1);
