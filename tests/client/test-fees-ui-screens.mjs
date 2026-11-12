import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mount, recordFetch } from './lib/mini-render.mjs';
import { FeesSheet, FeeChoice } from '../../src/components/FeesSheet.tsx';
import { FeesAccountantSettings } from '../../src/components/FeesAccountantSettings.tsx';
import { CompanyInfoSheet } from '../../src/components/CompanyInfoSheet.tsx';
import { PayScreen } from '../../src/components/PayScreen.tsx';
import { ReportFeeCheck } from '../../src/components/ReportFeeCheck.tsx';
import { PlaceInfoCard } from '../../src/components/PlaceInfoCard.tsx';
const fees = { settings: { feeEditors: 'admins' }, canEdit: true, places: [{ id: 'test-place', name: 'Test place', kind: 'factory', company: null, mashgiach: null, mashgiachNames: ['Test mashgiach'] }], accountant: null, email: { setUp: false }, nextEmail: null };
const calls = recordFetch({ '/api/inspections/fees': fees, '/api/inspections/fee-settings': {}, '/api/inspections/accountant': {}, '/api/inspections/company-info': { address: '', phone: '', contacts: [] }, '/api/inspections/pay': { rows: [], totals: { visits: 0, paid: 0, companies: 0, left: 0 }, mismatches: 1, noFee: 2 } });
const sheet = mount(FeesSheet, { placeId: 'test-place', onClose() {} }); await sheet.render();
assert.match(sheet.text(), /What the company pays/); assert.match(sheet.text(), /What the mashgiach is paid/); assert.match(sheet.text(), /Mashgichim never see/);
assert.deepEqual(sheet.find(e => e.type === 'input').map(e => e.props.value), ['', '']);
const inputs = sheet.find(e => e.type === 'input'); inputs[0].props.onChange({ target: { value: '160' } }); inputs[1].props.onChange({ target: { value: '150' } }); await sheet.render();
assert.match(sheet.text(), /Left for the agency: \$10.00 a visit/); await sheet.submit(); assert.deepEqual(calls.at(-1)[2], { company: { amount: 160, per: 'visit' }, mashgiach: { amount: 150 } });
fees.canEdit = false; const readonly = mount(FeesSheet, { placeId: 'test-place', onClose() {} }); await readonly.render(); assert.match(readonly.text(), /Only admins can change fees/); assert.equal(readonly.find(e => e.type === 'fieldset')[0].props.disabled, true); const before = calls.length; await readonly.submit(); assert.equal(calls.length, before);
const settings = mount(FeesAccountantSettings, { role: 'admin', onClose() {} }); await settings.render();
for (const text of ['Who can change fees', 'Your accountant', "Only this agency's pay summary is sent to this person.", 'When to send', 'No email is sent in a period with no visits.', 'Next email:', 'Email not set up yet', 'Send a test email']) assert.ok(settings.text().includes(text), text);
assert.deepEqual(settings.find(e => e.type === 'input').map(e => e.props.value), ['', '']); assert.equal(settings.buttons().find(b => b.label === 'Send a test email').el.props.disabled, true);
for (const Component of [FeesAccountantSettings, PayScreen]) for (const role of ['coordinator', 'mashgiach']) { const n = calls.length; const hidden = mount(Component, { role, timeZone: 'UTC', onClose() {} }); await hidden.render(); assert.equal(hidden.tree(), null); assert.equal(calls.length, n); }
const info = mount(CompanyInfoSheet, { placeId: 'test-place', isAdmin: true, onClose() {} }); await info.render(); await info.click('Add contact');
assert.match(info.text(), /Who sees this: admins edit/); assert.equal(info.find(e => e.type === 'input').every(e => e.props.value === ''), true);
function collect(node, type) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(n => collect(n, type)); return [...(node.type === type ? [node] : []), ...collect(node.props?.children, type)]; }
assert.equal(collect(info.tree(), FeeChoice).some(c => c.props.selected), false);
const coordinator = mount(CompanyInfoSheet, { placeId: 'test-place', isAdmin: false, onClose() {} }); await coordinator.render(); assert.doesNotMatch(coordinator.text(), /Add contact|Delete|Save/); assert.equal(coordinator.find(e => e.type === 'fieldset')[0].props.disabled, true);
const pay = mount(PayScreen, { role: 'admin', timeZone: 'UTC', onClose() {} }); await pay.render();
for (const text of ['Paid to mashgichim', 'Companies pay', 'Left for the agency', '1 report has a different amount — tap to review', '2 visits have no fee', 'Download CSV', 'Download Excel', 'Email to accountant now', "Preview the accountant's email", 'Only admins see this screen. Mashgichim never see company amounts.']) assert.ok(pay.text().includes(text), text);
assert.equal(pay.buttons().find(b => b.label === 'Email to accountant now').el.props.disabled, true);
let updated = 0; const check = mount(ReportFeeCheck, { reportId: 'test-report', placeId: 'test-place', placeName: 'Test place', timeZone: 'UTC', check: { reportAmount: 180, setAmount: 150, decided: null }, async onUpdated() { updated++; } }); await check.render(); assert.match(check.text(), /The amount doesn't match/); assert.match(check.text(), /The pay table uses \$150.00/); assert.match(check.text(), /The mashgiach doesn't see this/); await check.click('Keep'); assert.equal(updated, 1); assert.deepEqual(calls.at(-1), ['POST', '/api/inspections/reports/test-report/fee-decision', {}]);
recordFetch({ '/api/visits/places': { address: 'Test address', phone: '000', contacts: [{ name: 'Test hidden' }], company: { amount: 999 } } }); const card = mount(PlaceInfoCard, { placeId: 'test-place' }); await card.render(); assert.match(card.text(), /Test address/); assert.doesNotMatch(card.text(), /Test hidden|999/); assert.match(card.html(), /maps\/search/); assert.match(card.html(), /tel:000/);
for (const file of ['FactoryVisitScreen', 'FoodServiceVisitScreen', 'PlaceInfoCard']) { const source = fs.readFileSync(`src/components/${file}.tsx`, 'utf8'); assert.doesNotMatch(source, /company\.amount|Companies pay|feeMismatch|dataFee|feeCheck|decisions|accountant|contacts|Left for the agency/); assert.match(source, /PlaceInfoCard/); }
for (const file of ['FactoriesScreen', 'FoodServiceScreen']) { const source = fs.readFileSync(`src/components/${file}.tsx`, 'utf8'); assert.match(source, /canSeeFees\(role\)/); assert.match(source, /FeesSheet/); assert.match(source, /CompanyInfoSheet/); assert.match(source, /PayScreen/); }
console.log('fees sheets, role restrictions, empty forms, disabled email, mismatch decision and mashgiach privacy: OK');
