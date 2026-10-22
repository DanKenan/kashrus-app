/**
 * Edit certification from the Venues list (Don, Oct 22). Admin-only "Edit" on each venue card
 * opens the New Venue picker (the agency's choices + Other + None) and saves { certificationDetail }
 * through PUT /api/venues/:id; the card changes only from the server-confirmed venue.
 * Run: npx tsx tests/client/test-edit-cert.mjs
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { EditCertificationSheet, initialChoice } from '../../src/components/EditCertificationSheet.tsx';
import { VenuesDirectoryModal } from '../../src/components/VenuesDirectoryModal.tsx';

globalThis.document ??= { activeElement: null, addEventListener() {}, removeEventListener() {} };
let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ' :: ' + info : ''}`); } }
const A = 'Hartford Kashrut Commission (HKC)';
const OPTS = ['Glatt meat', 'Dairy', 'DE', 'Parve'];
const decode = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const V = (certification, certificationDetail, extra = {}) => ({ id: 'v1', name: "Yosi's Kitchen", agencyId: 'a', category: 'Restaurant', ...(certification !== undefined ? { certification } : {}), ...(certificationDetail !== undefined ? { certificationDetail } : {}), ...extra });

// 1. Which choice starts selected.
const IC = (venue, opts = OPTS) => JSON.stringify(initialChoice(venue, A, opts));
ok('IC no certification -> None', IC(V()) === JSON.stringify({ selected: 'none', other: '' }));
ok('IC blank certification -> None', IC(V('  ')) === JSON.stringify({ selected: 'none', other: '' }));
ok('IC agency only -> None', IC(V(A)) === JSON.stringify({ selected: 'none', other: '' }));
ok("IC Yosi's legacy 'A - A' -> None", IC(V(`${A} - ${A}`)) === JSON.stringify({ selected: 'none', other: '' }));
ok('IC today\'s form A — Dairy -> Dairy', IC(V(`${A} — Dairy`, 'Dairy')) === JSON.stringify({ selected: 1, other: '' }));
ok('IC case/spacing differences still match the option', IC(V(`${A} — parve`)) === JSON.stringify({ selected: 3, other: '' }), IC(V(`${A} — parve`)));
ok('IC legacy A - Glatt meat -> Glatt meat', IC(V(`${A} - Glatt meat`)) === JSON.stringify({ selected: 0, other: '' }));
ok('IC saved custom detail -> Other, prefilled', IC(V(`${A} — Yoshon`, 'Yoshon')) === JSON.stringify({ selected: 'other', other: 'Yoshon' }));
ok('IC agency custom choice -> that choice', IC(V(`${A} — Yoshon`, 'Yoshon'), [...OPTS, 'Yoshon']) === JSON.stringify({ selected: 4, other: '' }));
ok('IC unreadable text -> nothing selected', IC(V('OU Kosher')) === JSON.stringify({ selected: null, other: '' }));
ok('IC another agency\'s label -> nothing selected', IC(V('Star-K — Dairy', 'Dairy')) === JSON.stringify({ selected: null, other: '' }));

// 2. The card: Edit only for admins with a save path.
const venues = [V(`${A} - ${A}`), V(`${A} — Dairy`, 'Dairy', { id: 'v2', name: 'Crown Market' }), V(undefined, undefined, { id: 'v3', name: 'New Venue' })];
const base = { isOpen: true, onClose() {}, venues, currentVenue: venues[1], onSelectVenue() {}, onOpenCreateVenue() {}, agencyName: A, agencyShortCode: 'HKC', agencyLogoSrc: null };
const html = (p) => decode(renderToStaticMarkup(React.createElement(VenuesDirectoryModal, { ...base, ...p })));
const count = (h, re) => (h.match(re) || []).length;
const adminH = html({ isAdmin: true, onVenueUpdated() {} });
ok('card: admin sees one Edit per venue', count(adminH, /data-edit-certification="/g) === 3, String(count(adminH, /data-edit-certification="/g)));
{
  // Accessible name = "Edit certification for <venue name>" (aria-labelledby: the button's own words + the card heading).
  const names = [...adminH.matchAll(/aria-labelledby="([^"]+)"/g)].map(([, ids]) => ids.split(' ').map((id) => {
    const m = adminH.match(new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>(.*?)</(?:h3|span)>`));
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '?';
  }).join(' '));
  ok('card: Edit is named "Edit certification for <venue>" for screen readers', JSON.stringify(names) === JSON.stringify(["Edit certification for Yosi's Kitchen", 'Edit certification for Crown Market', 'Edit certification for New Venue']), JSON.stringify(names));
}
ok('card: Edit is a 44px target', /min-h-11 min-w-11[^"]*"[^>]*data-edit-certification|data-edit-certification[^>]*min-h-11 min-w-11/.test(adminH));
ok('card: admin sees "No certification" on a venue without one', count(adminH, />No certification</g) === 1);
ok("card: Yosi's legacy text is not printed doubled", !adminH.includes(`${A} - ${A}`));
const memberH = html({ isAdmin: false, onVenueUpdated() {} });
ok('card: non-admin sees no Edit', count(memberH, /data-edit-certification/g) === 0);
ok('card: non-admin sees no "No certification" row (unchanged)', !memberH.includes('No certification'));
ok('card: admin without a save callback sees no Edit', count(html({ isAdmin: true }), /data-edit-certification/g) === 0);
ok('card: no sheet open at first', !adminH.includes('data-edit-certification-sheet'));

// 3. Tapping Edit opens the sheet for that venue, without selecting the venue.
{
  const selected = [];
  const m = mount(VenuesDirectoryModal, { ...base, isAdmin: true, onVenueUpdated() {}, onSelectVenue: (id) => selected.push(id) });
  await m.render();
  await m.click((e) => e.props['data-edit-certification'] !== undefined, 1);
  const sheets = [...(function* walk(n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { for (const c of n) yield* walk(c); return; } if (!React.isValidElement(n)) return; yield n; yield* walk(n.props?.children); })(m.tree())].filter((e) => e.type === EditCertificationSheet);
  ok('open: one sheet, for the tapped venue', sheets.length === 1 && sheets[0].props.venue.id === 'v2', String(sheets.length));
  ok('open: the venue was not switched', selected.length === 0, JSON.stringify(selected));
}

// 4. The sheet.
const agencyRoute = (options) => ({ 'GET /api/agencies/current': { agency: { id: 'a', name: A, ...(options ? { certificationOptions: options } : {}) } } });
async function sheet(venue, routes = {}, options = [...OPTS, 'Kosher for Passover']) {
  const saved = []; const closed = [];
  const calls = recordFetch({ ...agencyRoute(options), 'PUT /api/venues/': (p, b) => ({ venue: { ...Object.fromEntries(Object.entries(venue).filter(([k]) => !['totalTasksToday', 'completedTasksToday', 'completionRate', 'workerCount', 'certificationDetail'].includes(k))), certification: b.certificationDetail ? `${A} — ${b.certificationDetail}` : A, certificationDetail: b.certificationDetail } }), ...routes });
  const m = mount(EditCertificationSheet, { venue, agencyName: A, onClose: () => closed.push(1), onSaved: (v) => saved.push(v) });
  await m.render();
  const radios = () => m.find((e) => e.type === 'input' && e.props.type === 'radio');
  const pick = async (i) => { await radios()[i].props.onChange({ target: {} }); await m.render(); };
  return { m, calls, saved, closed, radios, pick };
}
{
  const s = await sheet(V(`${A} - ${A}`));
  const labels = s.m.find((e) => e.type === 'label' && e.props.className?.includes('min-h-11')).map((e) => decode(renderToStaticMarkup(e)).replace(/<[^>]+>/g, '').trim());
  ok('sheet: the agency\'s choices, then Other, then None', JSON.stringify(labels) === JSON.stringify(['Glatt meat', 'Dairy', 'DE', 'Parve', 'Kosher for Passover', 'Other', 'None']), JSON.stringify(labels));
  ok('sheet: loads the agency\'s choices', s.calls.some(([m, p]) => m === 'GET' && p === '/api/agencies/current'));
  ok("sheet: Yosi's legacy text starts on None", s.radios()[6].props.checked === true && s.radios().filter((r) => r.props.checked).length === 1);
  ok('sheet: preview for None is the agency name', s.m.text().includes(`Venue will show: ${A}`), s.m.text());
  ok('sheet: title + venue name', s.m.text().includes('Edit certification') && s.m.text().includes("Yosi's Kitchen"));
  await s.pick(1);
  ok('sheet: picking Dairy previews the label', s.m.text().includes(`Venue will show: ${A} — Dairy`), s.m.text());
  ok('sheet: nothing saved before Save', !s.calls.some(([m]) => m === 'PUT'));
  await s.m.submit();
  const put = s.calls.filter(([m]) => m === 'PUT');
  ok('save: one PUT /api/venues/v1 with { certificationDetail: "Dairy" } only', put.length === 1 && put[0][1] === '/api/venues/v1' && JSON.stringify(Object.keys(put[0][2]).filter((k) => k !== 'expectedVersion')) === '["certificationDetail"]' && put[0][2].certificationDetail === 'Dairy', JSON.stringify(put));
  ok('save: onSaved gets the server venue', s.saved.length === 1 && s.saved[0].certificationDetail === 'Dairy' && s.saved[0].certification === `${A} — Dairy`, JSON.stringify(s.saved));
  ok('save: sheet closes', s.closed.length === 1);
}
{
  // The PUT answer has no live counts: the card keeps its shift completion and staff count.
  const s = await sheet(V(`${A} - ${A}`, undefined, { totalTasksToday: 2, completedTasksToday: 1, completionRate: 50, workerCount: 2 }));
  await s.pick(0); await s.m.submit();
  const v = s.saved[0] || {};
  ok('save: live counts kept on the card', v.totalTasksToday === 2 && v.completedTasksToday === 1 && v.completionRate === 50 && v.workerCount === 2 && v.certificationDetail === 'Glatt meat', JSON.stringify(v));
}
{
  const s = await sheet(V(`${A} — Dairy`, 'Dairy'));
  ok('sheet: today\'s Dairy starts on Dairy', s.radios()[1].props.checked === true);
  await s.pick(6); await s.m.submit();
  const put = s.calls.filter(([m]) => m === 'PUT');
  ok('save None: certificationDetail is ""', put.length === 1 && put[0][2].certificationDetail === '', JSON.stringify(put));
  ok('save None: onSaved gets agency-only venue', s.saved[0]?.certification === A);
}
{
  const s = await sheet(V(`${A} — Yoshon`, 'Yoshon'));
  ok('sheet: a saved custom detail starts on Other, prefilled', s.radios()[5].props.checked === true && s.m.find((e) => e.type === 'input' && e.props.type !== 'radio')[0]?.props.value === 'Yoshon');
  const other = () => s.m.find((e) => e.type === 'input' && e.props.type !== 'radio')[0];
  await other().props.onChange({ target: { value: '   ' } }); await s.m.render();
  await s.m.submit();
  ok('Other blank: no PUT, error shown', !s.calls.some(([m]) => m === 'PUT') && /between 1 and 60/.test(s.m.text()), s.m.text());
  await other().props.onChange({ target: { value: '  Cholov   Yisroel ' } }); await s.m.render();
  ok('Other: preview normalises spacing', s.m.text().includes(`Venue will show: ${A} — Cholov Yisroel`), s.m.text());
  await s.m.submit();
  const put = s.calls.filter(([m]) => m === 'PUT');
  ok('Other: PUT carries the normalised text', put.length === 1 && put[0][2].certificationDetail === 'Cholov Yisroel', JSON.stringify(put));
}
{
  const s = await sheet(V('OU Kosher'));
  ok('unreadable text: nothing selected, Save disabled, shows what it shows now', s.radios().every((r) => !r.props.checked) && s.m.find((e) => e.type === 'button' && e.props.type === 'submit')[0].props.disabled === true && s.m.text().includes('Now shows: OU Kosher'), s.m.text());
  await s.m.submit();
  ok('unreadable text: submit does nothing', !s.calls.some(([m]) => m === 'PUT'));
}
{
  const s = await sheet(V(A), {}, null);
  ok('agency with no saved list: the standard choices', s.radios().length === 6);
}
{
  // Server refusal: the card keeps the old value, the reason shows, the sheet stays open.
  const s = await sheet(V(`${A} - ${A}`));
  globalThis.fetch = async (url, opts = {}) => String(url).includes('/api/venues/')
    ? { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: 'Choose one of the agency\'s certification choices.' }), text: async () => '{"error":"Choose one of the agency\'s certification choices."}' }
    : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' };
  await s.pick(0); await s.m.submit();
  ok('refused: reason shown', s.m.text().includes("Choose one of the agency's certification choices."), s.m.text());
  ok('refused: no onSaved, stays open', s.saved.length === 0 && s.closed.length === 0);
}
{
  // Choices fail to load: standard choices still offered, with a note.
  globalThis.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: 'Server error' }), text: async () => '{}' });
  const m = mount(EditCertificationSheet, { venue: V(`${A} - ${A}`), agencyName: A, onClose() {}, onSaved() {} });
  await m.render();
  ok('load failed: note + standard choices', m.text().includes('Showing the standard choices') && m.find((e) => e.type === 'input' && e.props.type === 'radio').length === 6, m.text());
}

console.log(failures ? `test-edit-cert: ${passed} passed, ${failures} failed` : `test-edit-cert: ${passed}/${passed} passed`);
process.exit(failures ? 1 : 0);
