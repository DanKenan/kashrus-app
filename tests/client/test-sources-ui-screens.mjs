import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { SourcesForm } from '../../src/components/SourcesSheet.tsx';
import { MappingStep } from '../../src/components/MappingStep.tsx';
import { emptyMapping } from '../../src/lib/sources.ts';
globalThis.window = { location: { search: '', assign() {} } }; globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const routes = { '/api/sources/providers': { airtable: { setUp: true }, google_sheets: { setUp: false }, excel: { setUp: false }, supabase: { setUp: true }, upload: { setUp: true } }, '/api/sources/oauth/': { signedIn: false } };
recordFetch(routes);
const props = { connection: { sourceType: null }, timeZone: 'America/Chicago', onClose() {}, onSaved() {} };
const sheet = mount(SourcesForm, props); await sheet.render();
for (const text of ['Connect database · Step 1 of 3', 'Choose where your data lives', 'Where do you keep your list of companies, ingredients, and products?', 'Continue →', 'You can change your source later.']) assert.ok(sheet.text().includes(text), text);
await sheet.click('Google Sheets'); assert.ok(sheet.find(e => e.type === 'button' && String(e.props.children).includes('Continue'))[0].props.disabled); assert.match(sheet.html(), /aria-checked="true"/); assert.match(sheet.html(), /bg-gold-deep text-paper/); assert.match(sheet.html(), /lucide-check/);
await sheet.click('Upload a file'); await sheet.click('Continue'); assert.match(sheet.html(), /accept=".csv,.xlsx"/); assert.doesNotMatch(sheet.html(), /\bXLS\b|placeholder=/); assert.match(sheet.html(), /One-time copy — not kept up to date/);
const summary = mount(SourcesForm, { ...props, connection: { sourceType: 'google_sheets', fileName: 'List', access: 'read', counts: { companies: 214, ingredients: 1380, products: 2 } } }); await summary.render(); for (const text of ['Your connected sources', 'Everything is working', '214 companies · 1,380 ingredients', 'Change access', 'Change matching', 'Change source', 'Disconnect']) assert.ok(summary.text().includes(text), text); await summary.click('Disconnect'); assert.match(summary.html(), /Disconnecting stops reading. Your reports stay in the app./);
const mapping = mount(MappingStep, { initial: emptyMapping(), guessed: [], tables: [], samples: {}, busy: false, onBack() {}, onSave() {} }); await mapping.render(); for (const text of ['Match your columns', 'Company information', 'Company name', 'Company pays (yearly) (optional)', 'Mashgiach supervision fee (per visit) (optional)', 'What the company pays the agency each year.', 'What the mashgiach is paid for each visit.', 'Save matching →']) assert.ok(mapping.text().includes(text), text);
for (const path of fs.readdirSync('src/components').filter(n => /mashgiach/i.test(n))) assert.doesNotMatch(fs.readFileSync(`src/components/${path}`, 'utf8'), /SourcesSheet|MappingStep|sourcesSetup|SourceCompanyEditor/);
for (const directory of ['src/components', 'src/lib']) { const scan = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const path = `${dir}/${entry.name}`; if (entry.isDirectory()) scan(path); else if (/\.[jt]sx?$/.test(path)) assert.doesNotMatch(fs.readFileSync(path, 'utf8'), /(?:\.\s*(?:apiKey|refreshToken|clientSecret)\b|\[\s*['"](?:apiKey|refreshToken|clientSecret)['"]\s*\])/, path); } }; scan(directory); }
console.log('sources required copy, selected fill/check, unavailable continue, upload formats, role isolation and private responses: OK');
if (process.env.SOURCES_DESIGN_DIR) {
  fs.mkdirSync(process.env.SOURCES_DESIGN_DIR, { recursive: true });
  const css = fs.readdirSync('dist/assets').find(n => /^index-.*\.css$/.test(n));
  const styles = fs.readFileSync(`dist/assets/${css}`, 'utf8');
  const html = sheet.html();
  const choose = mount(SourcesForm, props); await choose.render(); await choose.click('Google Sheets');
  for (const [name, markup] of [['choose', choose.html()], ['upload', html], ['mapping', mapping.html()], ['summary', summary.html()]]) for (const theme of ['', 'dark']) fs.writeFileSync(`${process.env.SOURCES_DESIGN_DIR}/${name}-${theme || 'day'}.html`, `<!doctype html><html class="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body>${markup}<script>requestAnimationFrame(()=>{const body=document.scrollingElement; const targets=[...document.querySelectorAll('[aria-label="Close"]')]; document.body.dataset.result=JSON.stringify({width:innerWidth,scrollWidth:body.scrollWidth,close:targets.map(e=>[e.getBoundingClientRect().width,e.getBoundingClientRect().height])});});</script></body></html>`);
}
const calls = recordFetch({
  '/api/sources/providers': { ...routes['/api/sources/providers'], google_sheets: { setUp: true }, excel: { setUp: true } },
  '/api/sources/oauth/': { signedIn: true, accountEmail: 'admin@agency.test' },
  '/api/sources/files': { files: [{ id: 'company-file', name: 'Agency list' }] },
  '/api/sources/tabs': { tables: [{ name: 'Companies', columns: ['Name', 'Address', 'Company fee', 'Supervision fee'] }], samples: { Companies: [{ id: 'company', fields: { Name: 'Company', Address: '', 'Company fee': '1200', 'Supervision fee': '80' } }] } },
  'PUT /api/sources/connection': { ok: true },
  'GET /api/sources/connection': { sourceType: 'google_sheets', access: 'read', fileName: 'Agency list' },
});
const connected = mount(SourcesForm, props); await connected.render(); await connected.click('Google Sheets'); await connected.click('Continue'); assert.match(connected.html(), /Google account connected/); assert.match(connected.html(), /admin@agency.test/); assert.ok(!connected.text().includes('Start a new file'));
await connected.click('Agency list'); assert.match(connected.html(), /role="checkbox" aria-checked="true"/); await connected.click('Next: match columns');
const matching = connected.tree().props.children.props.children.flat(Infinity).find(e => e?.type === MappingStep);
assert.ok(matching); assert.equal(matching.props.initial.companies.companyFee, 'Company fee'); await matching.props.onSave(matching.props.initial); await connected.render(); assert.match(connected.html(), /Step 3 of 3/); assert.match(connected.html(), />Done</);
const saved = calls.find(([method, path]) => method === 'PUT' && path === '/api/sources/connection'); assert.equal(saved[2].sourceType, 'google_sheets'); assert.equal(saved[2].baseId, 'company-file'); assert.equal(saved[2].access, 'read'); assert.equal(saved[2].mapping.companies.mashgiachFee, 'Supervision fee');
console.log('sources signed-in file selection, filled tabs, matching fee guesses and confirmed done flow: OK');
