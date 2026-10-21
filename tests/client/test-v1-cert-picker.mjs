/**
 * V1 client test: certification picker (CreateVenueModal "Certification details" + CertificationOptionsSheet).
 *   L*  certOptions: label "<agency> — <detail>" (one function), normalisation, validation mirroring
 *       src/server/cert-options.ts (control chars incl. U+2028/2029, 1..60, <=25, case-insensitive
 *       de-dupe keeps the first).
 *   S*  Sheet: dialog semantics, 44px controls, Save disabled until changed, exact PUT body (options
 *       normalised, expectedOptions = list at open, expectedVersion = version at OPEN), 409 copy with
 *       edits kept, 400 server words, client validation sends nothing, success -> onSaved + close.
 *   C*  Modal: loads the agency's choices, radio per choice + Other, preview line, POST certification
 *       label, no choice -> agency alone, Other + "Save for next time" -> one POST then PUT with the
 *       POST response's version, PUT failure -> "Venue created" (no 2nd POST), load failure shown.
 * Run: npx tsx tests/client/test-v1-cert-picker.mjs
 */
import React from 'react';
import { mount } from './lib/mini-render.mjs';
import * as CO from '../../src/lib/certOptions.ts';
import { CertificationOptionsSheet } from '../../src/components/CertificationOptionsSheet.tsx';
import { CreateVenueModal } from '../../src/components/CreateVenueModal.tsx';
import { observeVersion } from '../../src/lib/api.ts';

let passed = 0; let failures = 0;
function ok(label, cond, info = '') { if (cond) passed++; else { failures++; console.error(`FAIL ${label}${info ? ': ' + info : ''}`); } }
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { activeElement: null, addEventListener() {}, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = globalThis.localStorage || { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
if (!globalThis.crypto?.randomUUID) globalThis.crypto = { randomUUID: () => 'op-' + Math.random() };
const dec = (s) => s.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const ev = (target = {}) => ({ preventDefault() {}, stopPropagation() {}, target: { value: '', checked: false, ...target } });

// fetch: 'METHOD /path' -> { status, body, version } or (body, calls) => that
function routes(map) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    let b = null; try { b = JSON.parse(opts.body); } catch {}
    calls.push([method, path, b]);
    let r = map[`${method} ${path}`];
    if (typeof r === 'function') r = r(b, calls);
    r = r || { status: 404, body: { error: 'no route' } };
    const st = r.status ?? 200;
    return { ok: st < 300, status: st, headers: { get: (h) => (/x-state-version/i.test(h) && r.version !== undefined ? String(r.version) : null) }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}
const noPalette = (h) => !/text-\[(\d|1[01])px\]|font-black|gradient|\b(bg|text|border)-(emerald|rose|zinc|slate|gray|red|green|blue|amber)-\d|#[0-9a-f]{6}\b|bg-white\b/.test(h);

// ---- L: helpers ----
ok('L1 label "<agency> — <detail>"', CO.certificationLabel('HKC', 'Glatt meat') === 'HKC — Glatt meat');
ok('L2 label normalises the detail', CO.certificationLabel('HKC', '  Pas   Yisroel ') === 'HKC — Pas Yisroel');
ok('L3 no detail -> agency alone', CO.certificationLabel('HKC', '') === 'HKC' && CO.certificationLabel('HKC', '   ') === 'HKC');
ok('L4 normalizeOption keeps case', CO.normalizeOption('  cholov   Yisroel ') === 'cholov Yisroel');
const V = CO.validateOptions;
ok('L5 valid list -> null', V(['Glatt meat', 'Dairy', 'DE', 'Parve']) === null);
ok('L6 empty option -> error', typeof V(['Dairy', '   ']) === 'string');
ok('L7 61 chars -> error, 60 ok', typeof V(['x'.repeat(61)]) === 'string' && V(['x'.repeat(60)]) === null);
ok('L8 C0/C1 control chars -> error', typeof V(['a\u0007b']) === 'string' && typeof V(['a\u0085b']) === 'string' && typeof V(['a\nb']) === 'string');
ok('L9 U+2028 / U+2029 -> error (server parity)', typeof V(['a\u2028b']) === 'string' && typeof V(['a\u2029b']) === 'string');
ok('L10 case-insensitive duplicate is NOT an error (server keeps the first)', V(['Dairy', 'dairy']) === null, String(V(['Dairy', 'dairy'])));
ok('L11 26 distinct -> error; 25 ok', typeof V(Array.from({ length: 26 }, (_, i) => 'c' + i)) === 'string' && V(Array.from({ length: 25 }, (_, i) => 'c' + i)) === null);
ok('L12 26 with one duplicate (25 after de-dupe) ok', V([...Array.from({ length: 25 }, (_, i) => 'c' + i), 'C0']) === null);
ok('L13 non-text -> error', typeof V([3]) === 'string');
const san = typeof CO.sanitizeOptions === 'function' ? CO.sanitizeOptions(['  Dairy ', 'DAIRY', 'Parve']) : null;
ok('L14 sanitizeOptions normalises + de-dupes keeping the first', !!san && san.ok && JSON.stringify(san.options) === JSON.stringify(['Dairy', 'Parve']), JSON.stringify(san));

// ---- S: sheet ----
const LIST = ['Glatt meat', 'Dairy', 'DE', 'Parve'];
let savedWith = null; let closed = 0;
function openSheet(version = 41) {
  savedWith = null; closed = 0;
  return mount(CertificationOptionsSheet, { options: LIST, versionAtOpen: version, onClose: () => { closed++; }, onSaved: (o) => { savedWith = o; } });
}
const choiceInputs = (m) => m.find((e) => e.type === 'input' && /^Choice \d+$/.test(e.props['aria-label'] || ''));
const addInput = (m) => m.find((e) => e.type === 'input' && !e.props['aria-label'] && e.props.id)[0];
const submitBtn = (m) => m.find((e) => e.type === 'button' && e.props.type === 'submit')[0];
let s = openSheet();
await s.render();
observeVersion(57); // a newer version heard after open must not become the baseline
let html = dec(s.html());
ok('S1 role=dialog + aria-modal + labelled "Certification choices"', /role="dialog"/.test(html) && /aria-modal="true"/.test(html) && /aria-labelledby="[^"]+"/.test(html) && html.includes('>Certification choices<'));
const closeTag = (html.match(/<button[^>]*aria-label="Close"[^>]*>/) || [''])[0];
ok('S2 44px Close', /min-h-11/.test(closeTag) && /\bw-11\b/.test(closeTag), closeTag);
ok('S3 one labelled input per choice', choiceInputs(s).length === 4 && choiceInputs(s)[0].props.value === 'Glatt meat');
const small = html.match(/<(button|input)(?![^>]*min-h-11)[^>]*>/);
ok('S4 every button and input is 44px', !small, small?.[0]);
ok('S5 nothing under 12px, no palette/hex/gradient/font-black', noPalette(html));
ok('S6 Save disabled until something changes', submitBtn(s).props.disabled === true);
let calls = routes({ 'PUT /api/agency/certification-options': { status: 200, body: { certificationOptions: [...LIST, 'Pas Yisroel'] }, version: 58 } });
await s.submit();
ok('S7 no write when unchanged', calls.length === 0);
await addInput(s).props.onChange(ev({ value: '  Pas   Yisroel ' })); await s.render();
ok('S8 Save enabled after typing a new choice', submitBtn(s).props.disabled === false);
await s.submit();
let put = calls.find((c) => c[0] === 'PUT');
ok('S9 PUT /api/agency/certification-options', !!put, JSON.stringify(calls));
ok('S10 options normalised, list order kept, new one last', JSON.stringify(put?.[2]?.options) === JSON.stringify([...LIST, 'Pas Yisroel']), JSON.stringify(put?.[2]));
ok('S11 expectedOptions = list at open', JSON.stringify(put?.[2]?.expectedOptions) === JSON.stringify(LIST));
ok('S12 expectedVersion = version at OPEN (41), not latest (57)', put?.[2]?.expectedVersion === 41, String(put?.[2]?.expectedVersion));
ok('S13 success -> onSaved(server list) + closes', JSON.stringify(savedWith) === JSON.stringify([...LIST, 'Pas Yisroel']) && closed === 1);

// rename + remove, then 409
s = openSheet(70); await s.render();
await choiceInputs(s)[2].props.onChange(ev({ value: 'Dairy Equipment' })); await s.render();
await s.click('Remove choice 4'); await s.render();
calls = routes({ 'PUT /api/agency/certification-options': { status: 409, body: { error: 'Version conflict', code: 'VERSION_CONFLICT' } } });
await s.submit();
put = calls.find((c) => c[0] === 'PUT');
ok('S14 rename + remove -> PUT body', JSON.stringify(put?.[2]?.options) === JSON.stringify(['Glatt meat', 'Dairy', 'Dairy Equipment']) && put?.[2]?.expectedVersion === 70, JSON.stringify(put?.[2]));
html = dec(s.html());
ok('S15 409 -> "Someone else just changed the choices…" alert', /role="alert"[^>]*>Someone else just changed the choices. Close and reopen to see the latest.</.test(html));
ok('S16 409 keeps the edits and the sheet open', choiceInputs(s).length === 3 && choiceInputs(s)[2].props.value === 'Dairy Equipment' && closed === 0 && savedWith === null);

// 400 server words
s = openSheet(71); await s.render();
await choiceInputs(s)[0].props.onChange(ev({ value: 'Glatt' })); await s.render();
routes({ 'PUT /api/agency/certification-options': { status: 400, body: { error: 'Each option can be at most 60 characters.' } } });
await s.submit();
ok('S17 400 -> server words shown', dec(s.html()).includes('Each option can be at most 60 characters.') && closed === 0);

// client validation -> nothing sent
s = openSheet(72); await s.render();
await choiceInputs(s)[1].props.onChange(ev({ value: '   ' })); await s.render();
calls = routes({});
await s.submit();
ok('S18 empty choice -> alert, no request', calls.length === 0 && /role="alert"/.test(dec(s.html())));

// ---- C: CreateVenueModal ----
const AG = { id: 'a1', name: 'HKC', shortCode: 'HKC', adminEmail: 'admin@t', certificationSeal: '', region: '', createdAt: '', certificationOptions: ['Glatt meat', 'Dairy', 'Kitniyot'] };
let created = []; let mclosed = 0;
function openModal() {
  created = []; mclosed = 0;
  return mount(CreateVenueModal, { isOpen: true, onClose: () => { mclosed++; }, onVenueCreated: (v) => { created.push(v); }, adminEmail: 'admin@t', agencyName: 'HKC (prop)', agencyTimeZone: 'America/New_York' });
}
const radios = (m) => m.find((e) => e.type === 'input' && e.props.type === 'radio');
const nameInput = (m) => m.find((e) => e.type === 'input' && /Establishment/i.test(e.props.placeholder || ''))[0];
const venueBody = { venue: { id: 'v9', name: 'Crown' } };

calls = routes({ 'GET /api/agencies/current': { body: { agency: AG }, version: 30 }, 'POST /api/venues': { body: venueBody, version: 31 } });
let mm = openModal(); await mm.render();
html = dec(mm.html());
ok('C1 loads the agency choices (GET /api/agencies/current)', calls.some((c) => c[0] === 'GET' && c[1] === '/api/agencies/current'));
ok('C2 one radio per saved choice + Other, in a labelled radiogroup', radios(mm).length === 4 && /role="radiogroup"[^>]*aria-labelledby="certification-details-label"/.test(html) && html.includes('Kitniyot') && />\s*Other\s*</.test(html.replace(/<input[^>]*>/g, '')));
ok('C3 choice rows are 44px labels', (html.match(/<label[^>]*min-h-11[^>]*><input type="radio"/g) || []).length === 4);
ok('C4 preview shows agency alone before a pick', html.includes('Venue will show: HKC<'));
ok('C5 Edit choices button is 44px', /<button[^>]*min-h-11[^>]*>Edit choices</.test(html));
ok('C6 no palette/hex/<12px in the new block', noPalette(html.slice(html.indexOf('Certification details') - 200, html.indexOf('Venue will show') + 200)));
await radios(mm)[2].props.onChange(ev({ checked: true })); await mm.render();
ok('C7 preview "HKC — Kitniyot" after picking', dec(mm.html()).includes('Venue will show: HKC — Kitniyot'));
await nameInput(mm).props.onChange(ev({ value: 'Crown Market' })); await mm.render();
await mm.submit();
let post = calls.filter((c) => c[0] === 'POST' && c[1] === '/api/venues');
ok('C8 POST certification = "HKC — Kitniyot"', post.length === 1 && post[0][2]?.certification === 'HKC — Kitniyot', JSON.stringify(post[0]?.[2]));
ok('C9 no options PUT without "Save for next time"', !calls.some((c) => c[0] === 'PUT'));
ok('C10 created + closed', created.length === 1 && mclosed === 1);

// no pick -> agency alone
calls = routes({ 'GET /api/agencies/current': { body: { agency: AG }, version: 30 }, 'POST /api/venues': { body: venueBody, version: 31 } });
mm = openModal(); await mm.render();
await nameInput(mm).props.onChange(ev({ value: 'Plain' })); await mm.render();
await mm.submit();
post = calls.filter((c) => c[0] === 'POST');
ok('C11 no pick -> certification = agency name alone', post[0]?.[2]?.certification === 'HKC', JSON.stringify(post[0]?.[2]));

// defaults when the agency has no saved list
calls = routes({ 'GET /api/agencies/current': { body: { agency: { ...AG, certificationOptions: undefined } }, version: 30 } });
mm = openModal(); await mm.render();
ok('C12 no saved list -> Glatt meat / Dairy / DE / Parve', radios(mm).length === 5 && ['Glatt meat', 'Dairy', 'DE', 'Parve'].every((o) => mm.html().includes(o)));

// Other + Save for next time -> POST once, then PUT with the POST response's version
let order = [];
calls = routes({
  'GET /api/agencies/current': { body: { agency: AG }, version: 30 },
  'POST /api/venues': () => { order.push('POST'); return { body: venueBody, version: 44 }; },
  'PUT /api/agency/certification-options': () => { order.push('PUT'); return { status: 200, body: { certificationOptions: [...AG.certificationOptions, 'Pas Yisroel'] }, version: 45 }; },
});
mm = openModal(); await mm.render();
await radios(mm)[3].props.onChange(ev({ checked: true })); await mm.render();
const otherIn = () => mm.find((e) => e.type === 'input' && e.props.id === 'other-certification')[0];
const saveBox = () => mm.find((e) => e.type === 'input' && e.props.type === 'checkbox')[0];
ok('C13 Other reveals a labelled text field + "Save for next time" (unchecked)', !!otherIn() && dec(mm.html()).includes('for="other-certification"') && saveBox()?.props.checked === false && dec(mm.html()).includes('Save for next time'));
await otherIn().props.onChange(ev({ value: ' Pas  Yisroel ' })); await mm.render();
await saveBox().props.onChange(ev({ checked: true })); await mm.render();
ok('C14 preview "HKC — Pas Yisroel"', dec(mm.html()).includes('Venue will show: HKC — Pas Yisroel'));
await nameInput(mm).props.onChange(ev({ value: 'Keter' })); await mm.render();
await mm.submit();
post = calls.filter((c) => c[0] === 'POST');
put = calls.find((c) => c[0] === 'PUT');
ok('C15 POST certification "HKC — Pas Yisroel"', post.length === 1 && post[0][2]?.certification === 'HKC — Pas Yisroel', JSON.stringify(post[0]?.[2]));
ok('C16 POST first, then exactly one PUT', JSON.stringify(order) === JSON.stringify(['POST', 'PUT']), JSON.stringify(order));
ok('C17 PUT options = list + new choice, expectedOptions = list', JSON.stringify(put?.[2]?.options) === JSON.stringify([...AG.certificationOptions, 'Pas Yisroel']) && JSON.stringify(put?.[2]?.expectedOptions) === JSON.stringify(AG.certificationOptions), JSON.stringify(put?.[2]));
ok('C18 PUT expectedVersion = the venue POST response version (44)', put?.[2]?.expectedVersion === 44, String(put?.[2]?.expectedVersion));
ok('C19 success -> created + closed', created.length === 1 && mclosed === 1);

// PUT failure -> "Venue created" state, no second POST
calls = routes({
  'GET /api/agencies/current': { body: { agency: AG }, version: 30 },
  'POST /api/venues': { body: venueBody, version: 50 },
  'PUT /api/agency/certification-options': { status: 409, body: { error: 'Someone changed the options.', code: 'CERT_OPTIONS_CHANGED' } },
});
mm = openModal(); await mm.render();
await radios(mm)[3].props.onChange(ev({ checked: true })); await mm.render();
await otherIn().props.onChange(ev({ value: 'Yoshon' })); await mm.render();
await saveBox().props.onChange(ev({ checked: true })); await mm.render();
await nameInput(mm).props.onChange(ev({ value: 'Bakery' })); await mm.render();
await mm.submit();
html = dec(mm.html());
ok('C20 PUT failure -> "Venue created" with the reason, modal stays', html.includes('Venue created') && /wasn't saved for next time/.test(html) && mclosed === 0, html.slice(0, 400));
ok('C21 venue still reported created; POST sent once', created.length === 1 && calls.filter((c) => c[0] === 'POST').length === 1);
await mm.click('Done');
ok('C22 Done closes', mclosed === 1);

// load failure shown
calls = routes({ 'GET /api/agencies/current': { status: 500, body: { error: 'Server down' } } });
mm = openModal(); await mm.render();
ok('C23 load failure -> alert with the reason', /role="alert"[^>]*>Server down</.test(dec(mm.html())));

console.log(`${passed} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
