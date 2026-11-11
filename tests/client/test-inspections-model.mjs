import assert from 'node:assert/strict';
import { normalizeSubmit, buildReport, summary } from '../../src/server/inspections/model.ts';
const photo = 'data:image/png;base64,YQ==', re = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const body = { clientReportId: 'test-uuid-123', companyId: 'factory', listVersion: 'v1', startedAt: '2026-11-01T00:00:00Z', note: ' note ', marks: [{ kind: 'ingredient', itemId: 'i', status: 'alert', note: ' Label ' }], offList: [{ name: ' Name ', brand: ' Brand ', photo }] };
const normalize = b => normalizeSubmit(b, 400000, re);
const input = normalize(body);
assert.equal(normalize({ ...body, listVersion: '' }).listVersion, '');
assert.throws(() => normalize({ ...body, listVersion: undefined }));
const item = { id: 'i', name: ' Raw Name ', brand: 'Raw Brand', code: ' X ', certificationRaw: ' Exact Certification ', statusRaw: ' Exact Status ', agency: '', dpm: '', group1: false };
const context = { id: 'report', agencyId: 'agency', userId: 'user', userName: ' Inspector ', companyName: ' Factory ', listVersion: 'v2', items: () => [item], now: '2026-11-01T01:00:00Z', fee: null };
const report = buildReport(input, context);
assert.deepEqual(report.marks[0].item, Object.fromEntries(['name', 'brand', 'code', 'certificationRaw', 'statusRaw'].map(k => [k, item[k]])));
assert.equal(report.listChanged, true); assert.equal(report.note, body.note); assert.equal(report.offList[0].name, ' Name ');
assert.deepEqual(summary(report).counts, { checked: 0, not_used: 0, alert: 1, offList: 1 });
assert.equal(JSON.stringify(report).includes('data:image'), false);
assert.throws(() => buildReport(input, { ...context, items: () => [] }));
for (const change of [
  { marks: [{ kind: 'ingredient', itemId: 'i', status: 'alert' }] },
  { marks: [body.marks[0], body.marks[0]] },
  { marks: [{ ...body.marks[0], status: 'not_checked' }] },
  { offList: Array.from({ length: 5 }, () => ({ name: 'x', photo })) },
  { offList: [{ name: 'x', photo: 'data:image/gif;base64,YQ==' }] },
  { offList: [{ name: 'x', photo: 'data:image/png;base64,' + 'A'.repeat(400000) }] },
  { note: 'x'.repeat(4001) }, { startedAt: 'yesterday' }, { clientReportId: '../bad-id' },
  { marks: Array(2001).fill(body.marks[0]) }, { offList: Array(51).fill({ name: 'x' }) },
]) assert.throws(() => normalize({ ...body, ...change }));
assert.equal(buildReport(input, { ...context, listVersion: 'v1', fee: { amount: 75, currency: 'USD' } }).fee.amount, 75);
console.log('inspection model: validation, snapshots, exact text, counts and fees passed');
