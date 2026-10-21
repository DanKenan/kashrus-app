/** Item 12: offline client contract, mini-render UI and injectable image pipeline. */
import React from 'react';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { mount } from './lib/mini-render.mjs';
import * as L from '../../src/lib/agencyLogo.ts';
import { AgencyLogoSheet } from '../../src/components/AgencyLogoSheet.tsx';
import { ShutfeyLogo } from '../../src/components/ShutfeyLogo.tsx';
import { Header } from '../../src/components/Header.tsx';
import { CertificationBadge, NO_LOGO_WORDING } from '../../src/components/CertificationBadge.tsx';
import { CreateVenueModal } from '../../src/components/CreateVenueModal.tsx';
import { observeVersion } from '../../src/lib/api.ts';
import { readFileSync } from 'node:fs';
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; }
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = {};
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const calls = [];
let handler;
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, opts });
  const r = await handler(url, opts);
  return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, headers: { get: () => String(r.version ?? 41) }, json: async () => r.body };
};
const routes = (fn) => { calls.length = 0; handler = fn; };
const dataUrl = 'data:image/png;base64,YQ==';
check('feature absent', !L.isLogoFeatureOn({}));
check('feature null', L.isLogoFeatureOn({ agencyLogoRev: null }));
check('feature string', L.isLogoFeatureOn({ agencyLogoRev: 'r' }));
check('feature own property, correct type', !L.isLogoFeatureOn(Object.create({ agencyLogoRev: null })) && !L.isLogoFeatureOn({ agencyLogoRev: 3 }) && !L.isLogoFeatureOn(null));
check('valid rev limits', !L.validRev('') && !L.validRev('x'.repeat(65)) && L.validRev('x'.repeat(64)));
const order = [];
const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL(mime, q) { order.push([mime, q]); return `data:${mime};base64,` + (order.length < 5 ? 'A'.repeat(140000) : 'YQ=='); } };
const deps = { decode: async () => ({ width: 1024, height: 512, source: {} }), createCanvas: () => canvas };
let image = await L.resizeForLogo({ type: 'image/png' }, deps);
check('encoder order and first fit', JSON.stringify(order) === JSON.stringify([['image/webp', .9], ['image/webp', .8], ['image/webp', .7], ['image/png', undefined], ['image/jpeg', .85]]) && image.mime === 'image/jpeg');
check('downscale keeps proportions', image.width === 256 && image.height === 128 && canvas.width === 256);
order.length = 0;
image = await L.resizeForLogo({ type: 'image/webp' }, { ...deps, decode: async () => ({ width: 40, height: 20, source: {} }) });
check('never upscale', image.width === 40 && image.height === 20);
await assert.rejects(() => L.resizeForLogo({ type: 'image/gif' }, deps), { message: 'Use a PNG, JPEG or WebP image.' }); passed++;
order.length = 0;
await assert.rejects(() => L.resizeForLogo({ type: 'image/jpeg' }, { ...deps, createCanvas: () => ({ ...canvas, toDataURL(m, q) { order.push([m, q]); return `data:${m};base64,` + 'A'.repeat(140000); } }) }), { message: 'That image is too large. Try a smaller or simpler image.' }); passed++;
check('all seven encodings attempted', order.length === 7 && order[6][1] === .6);
const id = { userId: 'u1', agencyId: 'a1', rev: 'r /1' };
routes(() => ({ body: { rev: id.rev, mime: 'image/png', data: 'YQ==' } }));
check('no fetch without rev', await L.loadAgencyLogo({ ...id, rev: undefined }) === null && calls.length === 0);
check('load data URL', await L.loadAgencyLogo(id) === dataUrl);
check('exact encoded rev URL', calls[0].url === '/api/agency/logo?rev=r%20%2F1');
check('cache hit same identity', await L.loadAgencyLogo(id) === dataUrl && calls.length === 1);
for (const changed of [{ userId: 'u2' }, { agencyId: 'a2' }, { rev: 'r2' }]) {
  L.writeLogoCache(id, dataUrl);
  check('cache mismatch clears entry', L.readLogoCache({ ...id, ...changed }) === null && !store.has(L.LOGO_CACHE_KEY));
}
L.writeLogoCache(id, dataUrl); L.clearLogoCache();
check('clear cache', !store.has(L.LOGO_CACHE_KEY));
check('logout clears cache in App', /const handleLogout = \(\) => \{\s*clearLogoCache\(\)/.test(readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')));
for (const changed of [{ rev: 'new' }, { userId: 'other' }]) {
  L.clearLogoCache(); let resolve; let current = id;
  routes(() => new Promise(r => { resolve = r; }));
  const pending = L.loadAgencyLogo(id, () => current === id);
  current = { ...id, ...changed };
  resolve({ body: { rev: id.rev, mime: 'image/png', data: 'YQ==' } });
  check('late identity response ignored', await pending === null && !store.has(L.LOGO_CACHE_KEY));
}
routes(() => ({ body: { rev: 'wrong', mime: 'image/png', data: 'YQ==' } }));
check('body rev mismatch', await L.loadAgencyLogo(id) === null);
for (const response of [{ status: 404, body: {} }, { body: { rev: id.rev, mime: 'image/svg+xml', data: 'YQ==' } }, { body: null }]) {
  routes(() => response); check('bad response quiet', await L.loadAgencyLogo(id) === null);
}
routes(() => { throw new Error('offline'); }); check('network failure quiet', await L.loadAgencyLogo(id) === null);
routes(() => ({ body: { rev: id.rev, mime: 'image/png', data: 'A'.repeat(140000) } }));
check('oversize image returned but not cached', (await L.loadAgencyLogo(id)).length > 140000 && !store.has(L.LOGO_CACHE_KEY));

const baselines = JSON.parse(readFileSync(new URL('./12-baseline.json', import.meta.url), 'utf8'));
const props = baselines[0].props;
const markup = p => renderToStaticMarkup(React.createElement(ShutfeyLogo, p));
for (const baseline of baselines) check('omitted logo markup byte-identical to frozen baseline', markup(baseline.props) === baseline.markup);
let logo = mount(ShutfeyLogo, { ...props, agencyLogoSrc: dataUrl }); await logo.render();
check('logo, divider, mobile fallback', logo.html().includes('h-[32px] max-w-[120px]') && logo.html().includes('w-[1px] bg-line') && logo.html().includes('max-[389px]:hidden') && logo.html().includes('min-[390px]:hidden'));
const logoWords = logo.find(e => e.type === 'span' && ['·', 'שותפי'].includes(e.props.children?.trim()));
check('sm logo secondary wordmarks wait until 2xl', logoWords.length === 2 && logoWords.every(e => e.props.className.includes('hidden 2xl:inline') && !e.props.className.includes('hidden xl:inline')));
for (const agencyLogoSrc of [undefined, null, dataUrl]) {
  const header = mount(Header, { currentUser: null, currentVenue: null, allVenues: [], agencyLogoSrc }); await header.render();
  function findLogo(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) return node.map(findLogo).find(Boolean);
    if (node.type === ShutfeyLogo) return node;
    return findLogo(node.props?.children);
  }
  check('Header lets logo wordmark shrink only with a source', findLogo(header.tree())?.props.className === (agencyLogoSrc ? 'min-w-0' : 'shrink-0'));
}

await logo.find(e => e.type === 'img' && e.props.src === dataUrl)[0].props.onError(); await logo.render();
check('error uses original shortcode at every width', logo.html() === markup(props));
logo = mount(ShutfeyLogo, { ...props, agencyLogoSrc: dataUrl }); await logo.render();
await logo.find(e => e.type === 'img' && e.props.src === dataUrl)[0].props.onLoad({ currentTarget: { naturalWidth: 1000, naturalHeight: 20 } }); await logo.render();
check('wide image falls back', logo.html() === markup(props));
const badge = p => renderToStaticMarkup(React.createElement(CertificationBadge, { certification: 'Agency — Dairy', agencyName: 'Agency', agencyShortCode: 'AG', iconClassName: 'icon', ...p }));
check('wording default shortCode', NO_LOGO_WORDING === 'shortCode');
check('logo and explicit detail', badge({ logoSrc: dataUrl, certificationDetail: 'Dairy' }).includes('<img') && !badge({ logoSrc: dataUrl }).includes('Agency — Dairy'));
const noLogoProps = { certification: 'Hartford Kashrut Commission — Glatt meat', certificationDetail: 'Glatt meat', agencyName: 'Hartford Kashrut Commission', agencyShortCode: 'HKC' };
const noLogo = badge(noLogoProps);
check('no logo consistent label uses short code without full name', noLogo.includes('HKC — Glatt meat') && !noLogo.includes('Hartford Kashrut Commission') && noLogo.includes('<svg'));
check('no logo without short code keeps stored full label', badge({ ...noLogoProps, agencyShortCode: undefined }).includes(noLogoProps.certification));
check('no logo derives detail from exact prefix', badge({ ...noLogoProps, certificationDetail: undefined }) === noLogo);
for (const certification of ['Hartford Kashrut Commission— Glatt meat', 'HKC Glatt — Meat & Pareve']) check('no logo inconsistent or historical label stays verbatim', badge({ ...noLogoProps, certification }).replace(/&amp;/g, '&').includes(certification));
check('stored detail normalised before consistency and display', badge({ logoSrc: dataUrl, certification: 'Agency — Glatt meat', certificationDetail: 'Glatt  meat ' }) === badge({ logoSrc: dataUrl, certification: 'Agency — Glatt meat', certificationDetail: 'Glatt meat' }));
check('exact prefix derives detail', badge({ logoSrc: dataUrl }).includes('<img'));
for (const p of [{ certification: 'Agency— Dairy' }, { certificationDetail: 'Meat' }, { agencyName: 'Renamed' }, { certification: 'HKC Glatt — Meat & Pareve' }]) {
  const h = badge({ logoSrc: dataUrl, ...p }); check('inconsistent historical label verbatim', !h.includes('<img') && h.replace(/&amp;/g, '&').includes(p.certification || 'Agency — Dairy'));
}

// Real browser decoder/canvas stubs exercise the sheet's file handler end to end.
URL.createObjectURL = () => 'blob:test'; URL.revokeObjectURL = () => {};
globalThis.Image = class { naturalWidth = 64; naturalHeight = 32; set src(v) { queueMicrotask(() => this.onload()); } };
globalThis.document.createElement = () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: m => `data:${m};base64,YQ==` });
let closed = 0; let changed;
const sheetProps = { isOpen: true, agencyName: 'Agency', agencyShortCode: 'AG', currentLogoSrc: dataUrl, onClose: () => closed++, onLogoChanged: r => { changed = r; } };
async function openSheet() {
  closed = 0; changed = undefined;
  routes((url, opts) => opts.method ? ({ body: { logoRev: 'saved' } }) : ({ body: { agency: {} }, version: 41 }));
  const element = AgencyLogoSheet(sheetProps);
  const m = mount(element.type, element.props); await m.render(); return m;
}
const fileInput = m => m.find(e => e.type === 'input' && e.props.type === 'file')[0];
const saveButton = m => m.find(e => e.type === 'button' && e.props.type === 'submit')[0];
async function choose(m) { await fileInput(m).props.onChange({ target: { files: [{ type: 'image/png' }] } }); await m.render(); }
let sheet = await openSheet();
check('dialog semantics labelled title', /role="dialog"/.test(sheet.html()) && /aria-modal="true"/.test(sheet.html()) && /aria-labelledby="/.test(sheet.html()) && sheet.html().includes('Agency logo'));
check('Close 44px', sheet.find(e => e.props['aria-label'] === 'Close')[0].props.className.includes('min-h-11') && sheet.find(e => e.props['aria-label'] === 'Close')[0].props.className.includes('w-11'));
check('save disabled without choice', saveButton(sheet).props.disabled);
check('preview surfaces', sheet.html().includes('>Light<') && sheet.html().includes('>Night<'));
await choose(sheet); check('choice enables save without write', !saveButton(sheet).props.disabled && calls.length === 1);
observeVersion(999);
await sheet.submit();
let put = calls.find(c => c.opts.method === 'PUT'); const body = JSON.parse(put.opts.body);
check('PUT exact application body and captured baseline', put.url === '/api/agency/logo' && body.data === 'YQ==' && body.expectedVersion === 41 && Object.keys(body).sort().join() === 'data,expectedVersion,operationId');
check('success callback and close', changed === 'saved' && closed === 1);
for (const status of [409, 400]) {
  sheet = await openSheet(); await choose(sheet);
  routes(() => ({ status, body: { error: '  Server words verbatim.  ' } })); await sheet.submit();
  check('error words and draft preserved', sheet.html().includes(status === 409 ? 'Someone else just changed the agency. Close and reopen to see the latest.' : '  Server words verbatim.  ') && !saveButton(sheet).props.disabled && closed === 0 && sheet.html().includes('data:image/webp;base64,YQ=='));
}
sheet = await openSheet(); await sheet.click('Remove logo');
const confirmation = sheet.tree().props.children.props.children.find(e => e?.props?.children?.type?.name === 'ConfirmModal').props.children;
check('remove opens existing confirmation', confirmation?.props.isOpen === true);
observeVersion(1000); routes(() => ({ body: { logoRev: null } }));
await confirmation.props.onConfirm(); await sheet.render();
check('DELETE bodyless with captured baseline', calls[0].opts.method === 'DELETE' && !calls[0].opts.body && calls[0].url.startsWith('/api/agency/logo?expectedVersion=41&operationId='));
check('remove callback and close', changed === null && closed === 1);

routes((url, opts) => opts.method === 'POST' ? { body: { venue: { id: 'v' } } } : { body: { agency: { name: 'Agency', certificationOptions: ['Dairy'] } } });
let venue = mount(CreateVenueModal, { isOpen: true, onClose() {}, onVenueCreated() {}, adminEmail: 'admin@t' }); await venue.render();
await venue.find(e => e.type === 'input' && /Establishment/.test(e.props.placeholder || ''))[0].props.onChange({ target: { value: 'Venue' } }); await venue.render();
await venue.find(e => e.type === 'input' && e.props.type === 'radio')[0].props.onChange({}); await venue.render(); await venue.submit();
check('POST certificationDetail', JSON.parse(calls.find(c => c.opts.method === 'POST').opts.body).certificationDetail === 'Dairy');
// Empty detail is omitted; Other detail is normalised independently of its label.
for (const other of [null, '  Pas   Yisroel ']) {
  routes((url, opts) => opts.method === 'POST' ? { body: { venue: { id: 'v' } } } : { body: { agency: { name: 'Agency', certificationOptions: ['Dairy'] } } });
  venue = mount(CreateVenueModal, { isOpen: true, onClose() {}, onVenueCreated() {}, adminEmail: 'admin@t' }); await venue.render();
  await venue.find(e => e.type === 'input' && /Establishment/.test(e.props.placeholder || ''))[0].props.onChange({ target: { value: 'Venue' } }); await venue.render();
  if (other) {
    await venue.find(e => e.type === 'input' && e.props.type === 'radio')[1].props.onChange({}); await venue.render();
    await venue.find(e => e.props.id === 'other-certification')[0].props.onChange({ target: { value: other } }); await venue.render();
  }
  await venue.submit();
  const body = JSON.parse(calls.find(c => c.opts.method === 'POST').opts.body);
  check('empty omitted / Other normalised', other ? body.certificationDetail === 'Pas Yisroel' : !Object.hasOwn(body, 'certificationDetail'));
}
sheet = await openSheet();
await fileInput(sheet).props.onChange({ target: { files: [{ type: 'image/svg+xml' }] } }); await sheet.render();
check('resize error shown as alert', /role="alert"/.test(sheet.html()) && sheet.html().includes('Use a PNG, JPEG or WebP image.') && saveButton(sheet).props.disabled);
// Exactly 102400 bytes is accepted on the first attempt.
const boundary = Buffer.alloc(102400).toString('base64');
let encodes = 0;
const atLimit = await L.resizeForLogo({ type: 'image/png' }, { ...deps, createCanvas: () => ({ ...canvas, toDataURL(m) { encodes++; return `data:${m};base64,${boundary}`; } }) });
check('100 KB inclusive first-fit boundary', encodes === 1 && atLimit.data === boundary);
check('closed sheet renders nothing', AgencyLogoSheet({ ...sheetProps, isOpen: false }) === null);
console.log(`${passed} passed, 0 failed.`);
