import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
import { createSourceStore } from '../../src/server/sources/store.ts';
import { encryptKey } from '../../src/server/sources/crypto.ts';
import { MockFirestore } from '../stage2/firestore-mock.mjs';

const dir = await mkdtemp(join(tmpdir(), 'factory-removal-'));
const savedEnv = { ...process.env };
process.env.FIRESTORE_MOCK_FILE = join(dir, 'firestore.json');
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
const db = process.argv.includes('--firestore') ? new MockFirestore() : null;
const secret = () => 'test-source-secret';
let clock = new Date('2026-01-31T12:00:00.000Z');
const deps = { db: () => db, dataDir: dir, staged: () => false, now: () => clock, timeZone: () => 'UTC', testMode: true };
const agencies = ['airtable', 'sheets', 'second'];
const mapping = { companies: { table: 'Companies', name: 'Name', companyFee: 'Fee', mashgiachFee: 'Visit Fee' },
  ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: [] };
const company = (id, name) => ({ id, fields: { Name: name, Fee: '1200', 'Visit Fee': '40' } });
const airtable = {
  Companies: [company('recTarget', 'Test Target'), company('recArchive', 'Test Archived'), company('recAbsent', 'Test Unrequested')],
  Ingredients: [{ id: 'recIngredient', fields: { Name: 'Test ingredient', Company: ['recTarget'] } }],
  Products: [],
};
const tables = Object.keys(airtable).map((name, index) => ({ id: 'tbl' + index, name,
  fields: name === 'Companies' ? ['Name', 'Fee', 'Visit Fee'].map(name => ({ name })) :
    [{ name: 'Name' }, { name: 'Company', type: 'multipleRecordLinks', options: { linkedTableId: 'tbl0' } }],
}));
const sheets = {
  Companies: [['ID', 'Name'], ['sheet-permanent-target', 'Test Sheet'], ['sheet-permanent-other', 'Test Other Sheet']],
  Ingredients: [['ID', 'Name', 'Company'], ['sheet-ing', 'Test linked', 'sheet-permanent-target']],
  Products: [['ID', 'Name', 'Company']],
};
const sourceRequests = [];
const realFetch = globalThis.fetch;
let sheetsUnavailable = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(input), method = init?.method ?? 'GET';
  if (url.hostname === 'api.airtable.com') {
    sourceRequests.push([method, url.pathname]);
    if (url.pathname.endsWith('/tables')) return Response.json({ tables });
    const [, , , table, id] = url.pathname.split('/');
    const rows = airtable[tables.find(t => t.id === table)?.name ?? table];
    if (!id) return Response.json({ records: rows });
    const row = rows?.find(row => row.id === id);
    if (!row) return Response.json({}, { status: 404 });
    if (method === 'DELETE') {
      rows.splice(rows.indexOf(row), 1);
      return Response.json({ id, deleted: true });
    }
    return Response.json(row);
  }
  if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture', expires_in: 3600 });
  if (url.hostname === 'sheets.googleapis.com') {
    sourceRequests.push([method, url.pathname]);
    assert.equal(method, 'GET');
    if (sheetsUnavailable) return Response.json({}, { status: 503 });
    const title = url.searchParams.get('ranges').slice(1, -1);
    return Response.json({ sheets: [{ properties: { title }, data: [{
      rowData: sheets[title].map(row => ({ values: row.map(formattedValue => ({ formattedValue })) })),
    }] }] });
  }
  return realFetch(input, init);
};

const app = express();
app.use(express.json());
const person = (a, role) => ({ id: `${a}-${role}`, agencyId: a, role, name: `Test ${role}` });
const user = req => person(req.get('test-agency'), req.get('test-role'));
const sources = registerSourceRoutes(app, { ...deps, secret,
  requireAdmin(req, res) { if (user(req).role === 'admin') return user(req); res.sendStatus(403); },
  foodServiceCompanyIds: a => inspections.foodServiceCompanyIds(a),
  companyRemoval: {
    withRemoval: (...args) => inspections.withRemoval(...args),
    removal: (...args) => inspections.removal(...args),
    setRemoval: (...args) => inspections.setRemoval(...args),
    pendingRemovals: (...args) => inspections.pendingRemovals(...args),
  },
});
const inspections = registerInspectionRoutes(app, { ...deps, user, source: sources.inspectionSource, agencyIds: () => agencies,
  people: a => ['admin', 'mashgiach', 'coordinator'].map(role => person(a, role)), maxPhotoChars: 100, photoRe: /^data:image\/png;base64,YQ==$/ });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
async function api(a, endpoint, method = 'GET', body, role = 'admin', expected = 200) {
  const reply = await realFetch(base + endpoint, { method, headers: { 'test-agency': a, 'test-role': role, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await reply.text();
  assert.equal(reply.status, expected, `${method} ${endpoint}: ${text}`);
  return reply.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}
const submit = (a, id, label, offList = [], role = 'admin', expected = 201) =>
  api(a, '/api/visits/reports', 'POST', { companyId: id, clientReportId: `phase-d-${label}`, listVersion: '',
    startedAt: clock.toISOString(), marks: [], offList }, role, expected);
const reports = (a, id) => api(a, `/api/inspections/reports?companyId=${id}&limit=3&more=1`);
const schedule = a => api(a, '/api/inspections/schedule');
const pay = a => api(a, '/api/inspections/pay?from=2026-01-01&to=2026-02-01');
const list = a => api(a, '/api/factories');

try {
  const storage = createSourceStore(deps);
  for (const agencyId of agencies) {
    const isSheets = agencyId === 'sheets';
    await storage.save({
      agencyId, sourceType: isSheets ? 'google_sheets' : 'airtable', baseId: isSheets ? 'test-sheet' : 'appFixture',
      access: 'readwrite', mapping: isSheets ? { ...mapping, companies: { table: 'Companies', pk: 'ID', name: 'Name' } } : mapping,
      encryptedKey: isSheets ? '' : encryptKey('test-api-key', secret(), agencyId), keyHint: '', backupHashes: {},
      updatedAt: clock.toISOString(), updatedBy: 'admin',
      ...(isSheets && { oauth: { google_sheets: { access: 'readwrite', refreshToken: encryptKey('test-refresh', secret(), agencyId),
        accountEmail: encryptKey('test@example.invalid', secret(), agencyId) } } }),
    });
  }
  await sources.boot();
  await inspections.boot();
  for (const a of agencies) {
    for (let i = 0; i < 100 && !(await list(a)).companies.length; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok((await list(a)).companies.length);
  }

  const initial = await list('airtable');
  const removePath = '/api/factories/recTarget/removal';
  const scope = initial.status.companySource;
  const mutation = (action, extra = {}, expected = 200) => api('airtable', removePath, 'POST', { action, source: scope, ...extra }, 'admin', expected);
  const preview = () => api('airtable', removePath + '?source=' + scope);
  assert.equal((await schedule('airtable')).settings.mashgichimSeeAll, false);
  assert.deepEqual((await api('airtable', '/api/visits/factories', 'GET', undefined, 'mashgiach')).companies, []);
  await submit('airtable', 'recTarget', 'unassigned', [], 'mashgiach', 404);
  await api('airtable', '/api/inspections/schedule/companies/recTarget/people', 'PUT', {
    mashgiachIds: ['airtable-mashgiach'], coordinatorIds: ['airtable-coordinator'],
  });
  assert.deepEqual((await api('airtable', '/api/visits/factories', 'GET', undefined, 'mashgiach')).companies.map(row => row.id), ['recTarget']);
  await api('second', '/api/inspections/schedule/settings', 'PUT', { mashgichimSeeAll: true });
  assert.equal((await schedule('second')).settings.mashgichimSeeAll, true);

  const attachment = 'data:image/png;base64,YQ==';
  await api('airtable', '/api/inspections/fees/recTarget', 'PUT', { company: null, mashgiach: { amount: 50 } });
  const kept = await submit('airtable', 'recTarget', 'target', [{ name: 'Test photo', photo: attachment }], 'mashgiach');
  const detail = `/api/inspections/reports/${kept.report.id}`;
  await api('airtable', detail + '/fee-decision', 'POST', { amount: 50 });
  await api('airtable', detail + '/follow-up', 'PUT', { on: true, note: 'Test follow-up' });
  const archived = await submit('airtable', 'recArchive', 'archived');
  const absent = await submit('airtable', 'recAbsent', 'unrequested');
  const otherAgency = await submit('second', 'recTarget', 'second');
  const recent = await api('airtable', '/api/inspections/reports?limit=3&more=1', 'GET', undefined, 'coordinator');
  assert.deepEqual(recent.reports.map(row => row.id), [kept.report.id]);
  assert.equal((await pay('airtable')).totals.paid, 130);

  await api('airtable', removePath, 'POST', { action: 'archive', source: scope }, 'coordinator', 403);
  await mutation('archive', { source: 'stale' }, 409);
  assert.deepEqual(await mutation('archive'), { status: 'archived' });
  assert.ok((await list('airtable')).companies.find(row => row.id === 'recTarget').archived);
  assert.ok(!(await schedule('airtable')).companies.some(row => row.id === 'recTarget'));
  await submit('airtable', 'recTarget', 'archived-denied', [], 'mashgiach', 404);
  assert.equal((await reports('airtable', 'recTarget')).reports[0].id, kept.report.id);
  assert.deepEqual(await mutation('restore'), { status: 'restored' });
  assert.equal((await schedule('airtable')).companies.find(row => row.id === 'recTarget').lastVisit.reportId, kept.report.id);
  await api('airtable', '/api/factories/recArchive/removal', 'POST', { action: 'archive', source: scope });

  assert.ok((await preview()).blockers.some(text => text.startsWith('Schedule A ·')));
  await mutation('delete', { confirmation: 'delete', name: 'Test Target' }, 400);
  await mutation('delete', { confirmation: 'DELETE', name: 'Test Target' }, 409);
  assert.equal(sourceRequests.filter(([method]) => method === 'DELETE').length, 0);
  airtable.Ingredients.length = 0;
  assert.deepEqual((await preview()).blockers, []);
  await mutation('delete', { confirmation: 'DELETE', name: 'Changed name' }, 409);
  const removal = await mutation('delete', { confirmation: 'DELETE', name: 'Test Target' });
  assert.deepEqual(removal, { status: 'deleted' });
  assert.deepEqual(sourceRequests.filter(([method]) => method === 'DELETE'), [['DELETE', '/v0/appFixture/tbl0/recTarget']]);
  assert.ok(!(await list('airtable')).companies.some(row => row.id === 'recTarget'));
  assert.equal((await reports('airtable', 'recTarget')).reports[0].id, kept.report.id);
  assert.equal((await pay('airtable')).totals.paid, 130);
  assert.deepEqual((await api('airtable', detail + '/photos')).photos, { 'off:0': attachment });

  const sheetList = await list('sheets');
  const sheetTarget = sheetList.companies.find(row => row.name === 'Test Sheet');
  const sheetPath = `/api/factories/${sheetTarget.id}/removal`;
  const sheetScope = sheetList.status.companySource;
  const sheetPlan = () => api('sheets', sheetPath + '?source=' + sheetScope);
  const sheetAction = (action, extra = {}, expected = 200) =>
    api('sheets', sheetPath, 'POST', { action, source: sheetScope, ...extra }, 'admin', expected);
  assert.ok((await sheetPlan()).blockers.some(text => text.startsWith('Schedule A ·')));
  sheets.Ingredients.length = 1;
  assert.equal((await sheetPlan()).recordKey, 'sheet-permanent-target');
  await sheetAction('refresh', {}, 409);
  assert.deepEqual(await sheetAction('delete', { confirmation: 'DELETE', name: 'Test Sheet' }), { status: 'guided' });
  assert.deepEqual(await sheetAction('refresh'), { status: 'present' });
  // Move the row before removing it in the source, then simulate a failed read.
  sheets.Companies.push(sheets.Companies.splice(1, 1)[0]);
  sheets.Companies.pop();
  sheetsUnavailable = true;
  await sheetAction('refresh', {}, 503);
  assert.ok((await list('sheets')).companies.find(row => row.id === sheetTarget.id).removalPending);
  sheetsUnavailable = false;
  sheets.Products.push(['sheet-product', 'Test late link', 'sheet-permanent-target']);
  await sheetAction('refresh', {}, 409);
  assert.ok((await sheetPlan()).blockers.some(text => text.startsWith('Schedule B ·')));
  sheets.Products.length = 1;
  assert.deepEqual(await sheetAction('refresh'), { status: 'deleted' });
  assert.deepEqual((await list('sheets')).companies.map(row => row.name), ['Test Other Sheet']);

  airtable.Companies.splice(airtable.Companies.findIndex(row => row.id === 'recAbsent'), 1);
  clock = new Date('2026-04-30T11:59:59.999Z');
  await inspections.check();
  assert.equal((await reports('airtable', 'recTarget')).reports.length, 1);
  clock = new Date('2026-04-30T12:00:00.000Z');
  await inspections.check();
  assert.equal((await reports('airtable', 'recTarget')).reports.length, 1);
  clock = new Date('2026-04-30T12:00:00.001Z');
  await inspections.check();
  await inspections.check();
  assert.equal((await reports('airtable', 'recTarget')).reports.length, 0);
  await api('airtable', detail, 'GET', undefined, 'admin', 404);
  await api('airtable', detail + '/photos', 'GET', undefined, 'admin', 404);
  if (db) {
    assert.equal((await db.doc(`inspectionReportPhotos/airtable__${kept.report.id}`).get()).exists, false);
    assert.equal((await db.doc('inspectionFees/airtable').get()).data().decisions[kept.report.id], undefined);
    assert.equal((await db.doc('inspectionInbox/airtable').get()).data().followUp[kept.report.id], undefined);
  }
  assert.equal((await pay('airtable')).totals.paid, 80);
  assert.equal((await reports('airtable', 'recArchive')).reports[0].id, archived.report.id);
  assert.equal((await reports('airtable', 'recAbsent')).reports[0].id, absent.report.id);
  assert.equal((await reports('second', 'recTarget')).reports[0].id, otherAgency.report.id);
  console.log(`Factories removal HTTP flows passed (${db ? 'Firestore mock' : 'local storage'}).`);
} finally {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
