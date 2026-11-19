import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { registerSourceRoutes } from '../../src/server/sources/routes.ts';
import { registerInspectionRoutes } from '../../src/server/inspections/routes.ts';
import { createScheduleStore } from '../../src/server/inspections/schedule-store.ts';
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
const taggedRow = ['sheet-permanent-target', 'Test Sheet'];
const untaggedRow = ['sheet-permanent-untagged', 'Test Untagged Sheet'];
const sheets = {
  Companies: [['ID', 'Name', 'Other Name'], taggedRow, ['sheet-permanent-other', 'Test Other Sheet'], untaggedRow, ['legacy-archive', 'Legacy Archive']],
  Ingredients: [['ID', 'Name', 'Company'], ['sheet-ing', 'Test linked', 'sheet-permanent-target']],
  Products: [['ID', 'Name', 'Company']],
};
let companyTab = 'Companies', companyTabId = 0, companyRowCount = 1000;
const tag = { metadataKey: 'recordId', metadataValue: 'sheet-permanent-target', metadataId: 42 };
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
    if (sheetsUnavailable) return Response.json({}, { status: 503 });
    const tabs = [companyTab, 'Ingredients', 'Products'];
    const sheetId = title => title === companyTab ? companyTabId : tabs.indexOf(title);
    const grid = title => sheets[title === companyTab ? 'Companies' : title];
    if (url.pathname.endsWith('/developerMetadata:search')) {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(init.body).dataFilters, [{ developerMetadataLookup: { metadataId: tag.metadataId } }]);
      return Response.json({ matchedDeveloperMetadata: sheets.Companies.includes(taggedRow) ? [{ developerMetadata: tag }] : [] });
    }
    assert.equal(method, 'GET');
    const values = url.pathname.split('/values/')[1];
    if (values) return Response.json({ values: grid(decodeURIComponent(values).slice(1, -1)) });
    const range = url.searchParams.get('ranges');
    if (!range) return Response.json({ sheets: tabs.map(title => ({ properties: { title, sheetId: sheetId(title) } })) });
    const title = range.slice(1, -1);
    if (!tabs.includes(title)) return Response.json({}, { status: 400 });
    return Response.json({ sheets: [{ properties: { title, sheetId: sheetId(title), gridProperties: { rowCount: companyRowCount } }, data: [{
      rowData: grid(title).map(row => ({ values: row.map(formattedValue => ({ formattedValue })) })),
      rowMetadata: grid(title).map(row => row === taggedRow ? { developerMetadata: [tag] } : {}),
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
    bindSheetArchives: (...args) => inspections.bindSheetArchives(...args),
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
const pay = (a, from = '2026-01-01', to = '2026-02-01') => api(a, `/api/inspections/pay?from=${from}&to=${to}`);
const list = a => api(a, '/api/factories');
const inspectDoc = async (collection, a) => db ? (await db.doc(`${collection}/${a}`).get()).data() :
  JSON.parse(await readFile(join(dir, collection === 'inspectionSchedules' ? 'inspection-schedules' : collection, a + '.json'), 'utf8'));
const sheetMapping = { ...mapping, companies: { table: 'Companies', pk: 'ID', name: 'Name' } };
const remapSheets = companies => api('sheets', '/api/sources/connection', 'PUT', {
  sourceType: 'google_sheets', baseId: 'test-sheet', access: 'readwrite', mapping: { ...sheetMapping, companies },
});

try {
  const storage = createSourceStore(deps);
  for (const agencyId of agencies) {
    const isSheets = agencyId === 'sheets';
    await storage.save({
      agencyId, sourceType: isSheets ? 'google_sheets' : 'airtable', baseId: isSheets ? 'test-sheet' : 'appFixture',
      access: 'readwrite', mapping: isSheets ? sheetMapping : mapping,
      encryptedKey: isSheets ? '' : encryptKey('test-api-key', secret(), agencyId), keyHint: '', backupHashes: {},
      updatedAt: clock.toISOString(), updatedBy: 'admin',
      ...(isSheets && { oauth: { google_sheets: { access: 'readwrite', refreshToken: encryptKey('test-refresh', secret(), agencyId),
        accountEmail: encryptKey('test@example.invalid', secret(), agencyId) } } }),
    });
  }
  await sources.boot();
  for (const a of agencies) {
    for (let i = 0; i < 100 && !(await list(a)).companies.length; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok((await list(a)).companies.length);
  }

  const sheetCompanyId = (await list('sheets')).companies.find(row => row.name === 'Test Sheet').id;
  const unmatchedLastVisit = { reportId: 'outside-this-purge', at: clock.toISOString(), mashgiachName: 'Test mashgiach' };
  const seededSchedule = createScheduleStore(deps);
  await seededSchedule.ensure('sheets');
  await seededSchedule.update('sheets', { companies: { [sheetCompanyId]: { lastVisit: unmatchedLastVisit } } });
  await inspections.boot();

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
  const feeSettings = { company: { amount: 310, per: 'month' }, mashgiach: { amount: 50 } };
  await api('airtable', '/api/inspections/fees/recTarget', 'PUT', feeSettings);
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

  for (const [from, to, revenue, visits, paid] of [
    ['2026-01-01', '2026-01-30', 300, 0, 0],
    ['2026-01-01', '2026-02-28', 310, 1, 50],
    ['2026-02-01', '2026-02-28', 0, 0, 0],
  ]) {
    const row = (await pay('airtable', from, to)).rows.find(row => row.key === 'recTarget');
    assert.equal(row?.companies ?? 0, revenue);
    assert.equal(row?.visits ?? 0, visits);
    assert.equal(row?.paid ?? 0, paid);
    const preview = await api('airtable', `/api/inspections/accountant/preview?from=${from}&to=${to}`);
    const summary = preview.text.split('\n').find(line => line.startsWith('Test Target\t'));
    assert.equal(summary, revenue ? `Test Target\t${visits}\t$50.00\t$${paid}.00\t$${revenue}.00\t$${revenue - paid}.00` : undefined);
  }

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
  await remapSheets({ ...sheetMapping.companies, name: 'Other Name' });
  await sheetAction('refresh', {}, 409);
  await remapSheets(sheetMapping.companies);
  taggedRow.splice(0, 2, 'changed-tagged-id', 'Changed tagged name');
  await sheetAction('refresh', {}, 409);
  assert.equal((await inspectDoc('inspectionCompanyRemoval', 'sheets')).companies[sheetTarget.id].deletedAt, undefined);
  taggedRow.splice(0, 2, 'sheet-permanent-target', 'Test Sheet');

  const untagged = sheetList.companies.find(row => row.name === 'Test Untagged Sheet');
  const retained = await submit('sheets', untagged.id, 'untagged');
  const untaggedPath = `/api/factories/${untagged.id}/removal`;
  const untaggedAction = (action, extra = {}, expected = 200) =>
    api('sheets', untaggedPath, 'POST', { action, source: sheetScope, ...extra }, 'admin', expected);
  assert.deepEqual(await untaggedAction('delete', { confirmation: 'DELETE', name: untagged.name }), { status: 'guided' });
  // Move the tagged row before physically deleting it, then simulate a failed read.
  sheets.Companies.push(sheets.Companies.splice(1, 1)[0]);
  sheets.Companies.pop();
  companyRowCount--;
  sheetsUnavailable = true;
  await sheetAction('refresh', {}, 503);
  assert.ok((await list('sheets')).companies.find(row => row.id === sheetTarget.id).removalPending);
  sheetsUnavailable = false;
  sheets.Products.push(['sheet-product', 'Test late link', 'sheet-permanent-target']);
  await sheetAction('refresh', {}, 409);
  assert.ok((await sheetPlan()).blockers.some(text => text.startsWith('Schedule B ·')));
  sheets.Products.length = 1;
  assert.deepEqual(await sheetAction('refresh'), { status: 'deleted' });
  untaggedRow.splice(0, 2, 'changed-untagged-id', 'Changed untagged name');
  await untaggedAction('refresh', {}, 409);
  assert.equal((await inspectDoc('inspectionCompanyRemoval', 'sheets')).companies[untagged.id].deletedAt, undefined);

  const otherSheet = sheetList.companies.find(row => row.name === 'Test Other Sheet');
  const legacy = sheetList.companies.find(row => row.name === 'Legacy Archive');
  await inspections.setRemoval('sheets', legacy.id, { source: sheetScope, archived: true, name: legacy.name });
  const otherPath = id => `/api/factories/${id}/removal`;
  assert.equal((await api('sheets', otherPath(otherSheet.id), 'POST', { action: 'archive', source: sheetScope })).status, 'archived');
  companyTab = 'Renamed Companies';
  await remapSheets({ ...sheetMapping.companies, table: companyTab });
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    assert.equal((await api('sheets', '/api/sources/refresh', 'POST')).ok, true);
  } finally {
    Date.now = realNow;
  }
  const renamedList = await list('sheets');
  assert.ok(renamedList.companies.find(row => row.name === legacy.name).archived);
  const renamed = renamedList.companies.find(row => row.name === otherSheet.name);
  assert.ok(renamed.archived);
  assert.ok(!(await schedule('sheets')).companies.some(row => row.id === renamed.id));
  // The same title and record key on a replacement tab must not inherit the archive.
  companyTabId = 21;
  await remapSheets({ ...sheetMapping.companies, table: companyTab });
  assert.equal((await list('sheets')).companies.find(row => row.id === renamed.id).archived, undefined);
  assert.equal((await api('sheets', otherPath(renamed.id), 'POST', { action: 'archive', source: renamedList.status.companySource })).status, 'archived');
  companyTabId = 0;
  await remapSheets({ ...sheetMapping.companies, table: companyTab });
  assert.ok((await list('sheets')).companies.find(row => row.id === renamed.id).archived);
  assert.equal((await api('sheets', otherPath(renamed.id), 'POST', { action: 'restore', source: renamedList.status.companySource })).status, 'restored');
  assert.ok((await schedule('sheets')).companies.some(row => row.id === renamed.id));
  companyTabId = 21;
  await remapSheets({ ...sheetMapping.companies, table: companyTab });
  assert.ok((await list('sheets')).companies.find(row => row.id === renamed.id).archived);
  companyTabId = 0;
  await remapSheets({ ...sheetMapping.companies, table: companyTab });

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
  const feesAfter = await inspectDoc('inspectionFees', 'airtable');
  assert.deepEqual(feesAfter.places.recTarget.company, feeSettings.company);
  assert.deepEqual(feesAfter.places.recTarget.mashgiach, feeSettings.mashgiach);
  assert.equal(feesAfter.decisions[kept.report.id], undefined);
  assert.equal((await inspectDoc('inspectionInbox', 'airtable')).followUp[kept.report.id], undefined);
  const targetSchedule = (await inspectDoc('inspectionSchedules', 'airtable')).companies.recTarget;
  assert.equal(targetSchedule.lastVisit, null);
  assert.deepEqual(targetSchedule.mashgiachIds, ['airtable-mashgiach']);
  assert.deepEqual(targetSchedule.coordinatorIds, ['airtable-coordinator']);
  assert.deepEqual((await inspectDoc('inspectionSchedules', 'sheets')).companies[sheetTarget.id].lastVisit, unmatchedLastVisit);
  assert.equal((await inspectDoc('inspectionCompanyRemoval', 'sheets')).companies[untagged.id].deletedAt, undefined);
  assert.equal((await reports('sheets', untagged.id)).reports[0].id, retained.report.id);
  assert.equal((await pay('airtable')).totals.paid, 80);
  assert.ok(!(await pay('airtable')).rows.some(row => row.key === 'recTarget'));
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
