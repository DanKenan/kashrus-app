import assert from 'node:assert/strict';
import { validateFees, validateAccountant, validateSettings, computePay, monthsCovered, amount, range } from '../../src/server/inspections/fees.ts';
const fees = { settings: { feeEditors: 'admins' }, places: {}, decisions: {}, accountant: null, lastSent: null, updatedAt: '' };
for (const value of [-1, Infinity, NaN, 100001, 1.001, 0.0000000001, 0.1 + 0.2, '1', null]) assert.throws(() => amount(value));
for (const value of [0, 0.01, 100000, 12.34]) assert.equal(amount(value), value);
assert.throws(() => validateFees({ company: { amount: 1, per: 'hour' }, mashgiach: null }));
assert.throws(() => validateFees({ company: null, mashgiach: { amount: 1, per: 'month' } }));
assert.deepEqual(validateFees({ company: null, mashgiach: null }), { company: null, mashgiach: null });
assert.throws(() => validateSettings({ feeEditors: 'everyone' }));
assert.throws(() => validateAccountant({ name: 'Test', email: 'a@example.test,b@example.test', timing: { mode: 'after_report' } }));
for (const email of ['a..b@example.test', '.a@example.test', 'a@..test', 'a@-example.test', 'a@example.test,other@example.test']) assert.throws(() => validateAccountant({ name: 'Test', email, timing: { mode: 'after_report' } }));
for (const timing of [{ mode: 'dates', days: [] }, { mode: 'dates', days: [1, 1] }, { mode: 'dates', days: [29] }, { mode: 'every_days', everyDays: 91 }, { mode: 'every_days', everyDays: 0 }, { mode: 'other' }]) assert.throws(() => validateAccountant({ name: 'Test accountant', email: 'test@example.test', timing }));
for (const timing of [{ mode: 'dates', days: [1, 28, 'last'] }, { mode: 'every_days', everyDays: 90 }, { mode: 'after_report' }]) assert.deepEqual(validateAccountant({ name: 'Test accountant', email: 'test@example.test', timing }).timing, timing);
assert.throws(() => range('2026-02-30', '2026-03-01'));
assert.throws(() => range('2026-03-02', '2026-03-01'));
assert.equal(monthsCovered('2026-10-01', '2026-10-31'), 1);
assert.equal(monthsCovered('9999-12-01', '9999-12-31'), 1);
assert.equal(monthsCovered('2024-02-15', '2024-02-29'), 15 / 29);
assert.equal(monthsCovered('2026-01-16', '2026-02-14'), 16 / 31 + 14 / 28);
const places = [{ id: 'a', name: 'Main Street Cafe' }, { id: 'b', name: 'Golden Crust Bakery' }, { id: 'c', name: 'Northfield Snacks' }];
const reports = [];
for (const [id, count, company, set, name] of [['a', 9, 60, 50, 'R. Dovid Stern'], ['b', 1, 1200, 80, 'R. Moshe Klein'], ['c', 6, 200, 150, 'R. Eli Weiss']]) {
 fees.places[id] = { company: { amount: company, per: id === 'b' ? 'year' : 'visit' }, mashgiach: { amount: set } };
 for (let i = 0; i < count; i++) reports.push({ id: id + i, companyId: id, companyName: places.find(p => p.id === id).name, mashgiachId: 'm' + id, mashgiachName: name, submittedAt: '2026-10-20T14:00:00Z', fee: { amount: set }, ...(id === 'c' && i === 0 ? { dataFee: { amount: 180 }, feeMismatch: true } : {}) });
}
for (const by of ['place', 'mashgiach']) {
 const table = computePay(reports, fees, places, '2026-10-01', '2026-10-31', by, 'America/New_York');
 assert.deepEqual(table.totals, { visits: 16, paid: 1430, companies: 1840, left: 410 }); assert.equal(table.mismatches, 1);
 fees.decisions.c0 = { amount: 180 }; assert.equal(computePay(reports, fees, places, table.from, table.to, by, 'UTC').totals.paid, 1460); delete fees.decisions.c0;
}
fees.places.d = { company: { amount: 310, per: 'month' }, mashgiach: null }; places.push({ id: 'd', name: 'Test empty monthly place' });
const prorated = computePay([], fees, places, '2026-10-01', '2026-10-15', 'place', 'UTC');
assert.equal(prorated.totals.companies, 198.39); assert.equal(prorated.rows.length, 2);
assert.equal(computePay([], fees, places, '2026-10-01', '2026-10-15', 'mashgiach', 'UTC').rows[0].name, 'No visits in this period');
const split = computePay([{ ...reports[9], mashgiachId: 'first' }, { ...reports[9], id: 'other', mashgiachId: 'second', fee: null }], fees, places.slice(0, 2), '2026-10-01', '2026-10-31', 'mashgiach', 'UTC');
assert.equal(split.rows.filter(r => r.visits).every(r => r.companies === 50), true); assert.equal(split.noFee, 1);
console.log('fees model: validation, sketch totals, proration, splits, rounding and decisions passed');
