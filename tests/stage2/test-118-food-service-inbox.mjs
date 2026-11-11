import assert from 'node:assert/strict';
import http from 'node:http';
import { shiftFixture } from './test-101-shifts-crud.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export default {
 name: 'Test 118: food-service checklists, inbox and problem notifications',
 whatItProves: 'Agency-neutral food-service classification, snapshots, scope, memory filters, debounced seen, follow-up, exact Firestore budgets, problem break-through and durable documents.',
 async run(baseUrl, ctx) {
  const { api, agencyId, people, venueId } = await shiftFixture(baseUrl, ctx, '118');
  const rows = { Companies: [
   { id: 'factory118a', fields: { Name: 'Test factory A', Type: 'Factory' } }, { id: 'factory118b', fields: { Name: 'Test factory B', Type: 'Factory' } },
   { id: 'place118a', fields: { Name: '  מקום 🥯 ', Type: ' Bakery ' } }, { id: 'place118b', fields: { Name: 'Test marked place', Type: 'Factory' } },
  ], Ingredients: [{ id: 'ingredient118', fields: { Name: 'Test ingredient', Company: ['factory118a'] } }], Products: [{ id: 'product118', fields: { Name: 'Test product', Company: ['factory118a'] } }] };
  const mock = http.createServer((req, res) => {
   res.setHeader('Content-Type', 'application/json'); const url = new URL(req.url, 'http://localhost');
   if (url.pathname.endsWith('/whoami')) return res.end(JSON.stringify({ scopes: ['data.records:read'] }));
   if (url.pathname.endsWith('/tables')) return res.end(JSON.stringify({ tables: Object.entries(rows).map(([name, records]) => ({ name, fields: Object.keys(records[0].fields).map(name => ({ name })) })) }));
   res.end(JSON.stringify({ records: rows[decodeURIComponent(url.pathname.split('/').pop())] || [] }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const table = [], path = '/api/food-service', schedule = id => `/api/inspections/schedule/companies/${id}`;
  const reset = async () => { await api('admin', 'POST', '/api/__test__/reads', { reset: true }); await api('admin', 'POST', '/api/__test__/writes', { reset: true }); };
  const budget = async (action, reads, writes) => {
   const r = (await api('admin', 'POST', '/api/__test__/reads', {})).json, w = (await api('admin', 'POST', '/api/__test__/writes', {})).json;
   table.push({ action, reads: r.total, writes: w.total }); assert.equal(r.total, reads, `${action}: ${JSON.stringify(r)}`); assert.equal(w.total, writes, `${action}: ${JSON.stringify(w)}`); return w;
  };
  let submitTick = 0;
  const action = async (label, method, url, body, writes = 1, status = 200, who = 'admin') => {
   if (method === 'POST' && url === '/api/visits/reports' && label !== 'idempotent retry') await api('admin', 'POST', '/api/__test__/clock', { iso: new Date(Date.parse('2098-11-03T14:00:00Z') + ++submitTick * 1000).toISOString() });
   await reset(); const r = await api(who, method, url, body); assert.equal(r.status, status, `${label}: ${JSON.stringify(r.json)}`); await budget(label, 0, writes); return r.json;
  };
  const pin = iso => api('admin', 'POST', '/api/__test__/clock', { iso });
  const settle = async () => {
   let previous = -1, stable = 0;
   for (let i = 0; i < 150; i++) {
    const ready = await api('admin', 'GET', path), factories = await api('admin', 'GET', '/api/visits/factories');
    const reads = (await api('admin', 'POST', '/api/__test__/reads', {})).json;
    stable = ready.status === 200 && factories.status === 200 && reads.total === previous ? stable + 1 : 0; previous = reads.total;
    if (stable >= 5) return reads; await sleep(100);
   } throw Error('Food-service boot did not settle');
  };
  const clearPush = () => api('admin', 'POST', '/api/__test__/push-log/clear', {});
  const pushes = async () => (await api('admin', 'GET', '/api/__test__/push-log')).json.log;
  try {
   await pin('2098-11-03T14:00:00Z');
   await api('admin', 'POST', '/api/__test__/sources-api-base', { url: `http://127.0.0.1:${mock.address().port}` });
   const mapping = { companies: { table: 'Companies', name: 'Name', type: 'Type', factoryValues: ['Factory'], foodServiceValues: ['bakery'] }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: [] };
   assert.equal((await api('admin', 'PUT', '/api/sources/connection', { sourceType: 'airtable', baseId: 'appTEST118', access: 'read', mapping, apiKey: 'fake-key-118' })).status, 200);
   for (let i = 0; i < 100; i++) { if ((await api('admin', 'POST', '/api/__test__/source-raw', {})).json.connection?.backupHashes?.factory118a) break; await sleep(50); }
   assert.equal((await api('admin', 'POST', '/api/__test__/source-fees', { agencyId, fees: { mashgiach: { place118a: { amount: 42, currency: 'USD' } } } })).status, 200);
   await api('admin', 'GET', '/api/inspections/reports'); await settle();
   for (const who of Object.keys(people)) {
    await api(who, 'GET', '/api/visits/factories');
    await api(who, 'POST', '/api/push/subscribe', { subscription: { endpoint: `https://push.test.invalid/118-${people[who].id}`, keys: { p256dh: 'p', auth: 'a' } } });
   }
   const worker = { id: `${agencyId}-worker`, email: `${agencyId}-worker@test.local`, name: 'Test worker', role: 'worker', agencyId, venueId };
   await ctx.api('POST', '/api/__test__/inject-fixture', { users: [worker] });
   const token = (await ctx.api('POST', '/api/__test__/mint-token', { userId: worker.id })).json.token;
   assert.equal((await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
   const initial = await action('GET food-service', 'GET', path, undefined, 0);
   assert.deepEqual(initial.templates, []); assert.equal(initial.places.length, 1); assert.equal(initial.places[0].name, '  מקום 🥯 '); assert.equal(initial.places[0].type, ' Bakery ');
   assert.equal(initial.places[0].typeMatched, true);
   assert.equal(initial.places[0].marked, false);
   assert.equal((await api('foreign', 'GET', path)).json.places.length, 0);
   const item = { id: 'i_1234567890', label: '  בדיקה 🥯 ', type: 'yes_no', required: true, help: 'Test help', problemIf: 'no' };
   const draft = { name: 'Test checklist', items: [item] };
   const t1 = (await action('create template', 'POST', `${path}/templates`, draft, 1, 201)).template;
   assert.equal(t1.version, 1);
   assert.deepEqual((await action('same template again', 'POST', `${path}/templates`, draft, 0, 201)).template, t1);
   const t2 = (await action('edit template', 'PUT', `${path}/templates/${t1.id}`, { ...draft, name: 'Test checklist edited' })).template; assert.equal(t2.version, 2);
   await action('same edit', 'PUT', `${path}/templates/${t1.id}`, { ...draft, name: t2.name }, 0);
   const empty = (await action('create empty template', 'POST', `${path}/templates`, { name: 'Test empty', items: [] }, 1, 201)).template;
   await action('reorder templates', 'PUT', `${path}/templates-order`, { order: [empty.id, t1.id] });
   await action('assign template', 'PUT', `${path}/places/place118a/template`, { templateId: t1.id });
   await action('mark connected place', 'PUT', `${path}/marked`, { add: ['place118b'] });
   await action('unmark connected place', 'PUT', `${path}/marked`, { remove: ['place118b'] });
   await action('mark connected again', 'PUT', `${path}/marked`, { add: ['place118b'] });
   await action('cannot unmark type match', 'PUT', `${path}/marked`, { remove: ['place118a'] }, 0, 400);
   const manual = (await action('add manual place', 'POST', `${path}/places`, { name: 'Test manual', address: 'Test address' }, 1, 201)).place; assert.match(manual.id, /^fs_[a-z0-9]{20}$/);
   await action('rename manual place', 'PUT', `${path}/places/${manual.id}`, { name: 'Test manual edited', address: 'Test address' });
   const manualRow = (await api('admin', 'GET', path)).json.places.find(p => p.id === manual.id);
   assert.ok(manualRow);
   assert.equal(manualRow.marked, false);
   assert.equal(manualRow.typeMatched, false);
   const scheduledManual = (await action('add scheduled manual place', 'POST', `${path}/places`, { name: 'Test scheduled manual' }, 1, 201)).place;
   await action('schedule second manual place', 'PUT', schedule(scheduledManual.id), { schedule: { kind: 'every', n: 7, unit: 'day', start: '2098-11-01' } });
   await action('assign second manual place', 'PUT', `${schedule(scheduledManual.id)}/people`, { mashgiachIds: [people.mash.id], coordinatorIds: [people.coord.id] });
   await action('mute second manual place', 'PUT', `${schedule(scheduledManual.id)}/mute`, { muted: true });
   const scheduledBefore = (await api('admin', 'GET', '/api/inspections/schedule')).json;
   assert.ok(JSON.stringify(scheduledBefore).includes(scheduledManual.id));
   await action('remove scheduled manual place', 'DELETE', `${path}/places/${scheduledManual.id}`, undefined, 2);
   const scheduledAfter = (await api('admin', 'GET', '/api/inspections/schedule')).json;
   assert.equal(JSON.stringify(scheduledAfter).includes(scheduledManual.id), false);
   assert.equal((await api('admin', 'GET', path)).json.places.some(p => p.id === scheduledManual.id), false);
   await action('assign people', 'PUT', `${schedule('place118a')}/people`, { mashgiachIds: [people.mash.id], coordinatorIds: [people.coord.id] });
   await action('set food-service schedule', 'PUT', schedule('place118a'), { schedule: { kind: 'every', n: 7, unit: 'day', start: '2098-11-01' } });
   const adminTemplates = (await api('admin', 'GET', path)).json.templates;
   const coordinatorFood = await action('coordinator template scope', 'GET', path, undefined, 0, 200, 'coord');
   assert.deepEqual(adminTemplates.map(t => t.id), [empty.id, t1.id]);
   assert.deepEqual(coordinatorFood.places.map(p => p.id), ['place118a']);
   assert.deepEqual(coordinatorFood.templates.map(t => t.id), adminTemplates.filter(t => t.id === t1.id).map(t => t.id));
   assert.equal(coordinatorFood.templates.some(t => t.id === empty.id), false);
   const visits = await action('GET food-service visits', 'GET', '/api/visits/food-service', undefined, 0, 200, 'mash'); assert.equal(visits.places[0].id, 'place118a');
   await action('assigned-only visit setting', 'PUT', '/api/inspections/schedule/settings', { mashgichimSeeAll: false });
   assert.deepEqual((await api('mash', 'GET', '/api/visits/food-service')).json.places.map(p => p.id), ['place118a']);
   assert.deepEqual((await api('assign', 'GET', '/api/visits/food-service')).json.places, []);
   assert.equal((await api('mash', 'GET', '/api/visits/food-service/place118b')).status, 404);
   await action('restore see-all visit setting', 'PUT', '/api/inspections/schedule/settings', { mashgichimSeeAll: true });
   const detail = await action('GET food-service visit detail', 'GET', '/api/visits/food-service/place118a', undefined, 0, 200, 'mash'); assert.deepEqual(detail.fee, { amount: 42, currency: 'USD' });
   assert.equal((await api('admin', 'GET', '/api/visits/factories')).json.companies.length, 2);
   assert.equal((await api('admin', 'GET', '/api/factories')).json.companies.length, 2);
   assert.equal((await api('admin', 'GET', '/api/visits/factories/place118a')).status, 404);
   const photo = 'data:image/png;base64,YQ==';
   const body = { kind: 'food_service', clientReportId: 'report-118-food-photo', companyId: 'place118a', startedAt: '2098-11-03T13:00:00Z', templateId: t1.id, templateVersion: 2, answers: [{ itemId: item.id, value: false, photo }], note: 'Test report' };
   await clearPush();
   const first = await action('submit food-service with photo + lastVisit', 'POST', '/api/visits/reports', body, 3, 201, 'mash'); assert.deepEqual(first.fee, detail.fee); assert.equal(first.report.kind, 'food_service'); assert.equal(first.report.templateName, t2.name); assert.equal(first.report.hasAlerts, true);
   const targets = [people.admin.id, people.coord.id].sort(); let log = await pushes(); assert.deepEqual(log.map(p => p.recipientUserId).sort(), targets); assert.ok(log.every(p => p.title === '⚠ Problem found' && p.body === '  מקום 🥯  — 1 problem · Shift mash'));
   await action('idempotent retry', 'POST', '/api/visits/reports', body, 0, 200, 'mash'); assert.equal((await pushes()).length, log.length);
   const next = (await api('admin', 'GET', path)).json.places.find(p => p.id === 'place118a'); assert.equal(next.nextDue, '2098-11-10');
   await clearPush();
   const factoryBody = { clientReportId: 'report-118-factory-photo', companyId: 'factory118a', startedAt: body.startedAt, listVersion: '', marks: [{ kind: 'ingredient', itemId: 'ingredient118', status: 'checked', photo }], offList: [] };
   await action('factory with photo + lastVisit (same budget)', 'POST', '/api/visits/reports', factoryBody, 3, 201, 'mash');
   await clearPush();
   await action('normal food-service report', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-118-normal', answers: [{ itemId: item.id, value: true }] }, 2, 201, 'mash');
   assert.deepEqual((await pushes()).map(p => p.recipientUserId).sort(), targets); assert.ok((await pushes()).every(p => p.title === 'New report'));
   await action('indefinite mute', 'PUT', `${schedule('place118a')}/mute`, { muted: true }); await clearPush();
   await action('muted normal report', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-118-muted-ok', answers: [{ itemId: item.id, value: true }] }, 2, 201, 'mash'); assert.deepEqual(await pushes(), []);
   await action('muted problem report', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-118-muted-problem', answers: [{ itemId: item.id, value: false }] }, 2, 201, 'mash'); assert.ok((await pushes()).every(p => p.title === '⚠ Problem found' && p.body.includes('1 problem'))); assert.equal((await pushes()).length, 2);
   await action('mute factory', 'PUT', `${schedule('factory118a')}/mute`, { muted: true }); await clearPush();
   await action('muted factory Alert breaks through', 'POST', '/api/visits/reports', { ...factoryBody, clientReportId: 'report-118-factory-alert', marks: [{ kind: 'ingredient', itemId: 'ingredient118', status: 'alert', note: 'Test issue' }] }, 2, 201, 'mash'); assert.equal((await pushes()).length, 1); assert.equal((await pushes())[0].title, '⚠ Problem found');
   await action('mute end date passed', 'PUT', `${schedule('place118a')}/mute`, { muted: true, until: '2098-11-02' }); await clearPush();
   await action('expired mute normal report', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-118-expired-mute', answers: [{ itemId: item.id, value: true }] }, 2, 201, 'mash'); assert.equal((await pushes()).length, 2); assert.ok((await pushes()).every(p => p.title === 'New report'));
   await clearPush();
   await action('admin submit excludes sender', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-118-admin-sender', answers: [{ itemId: item.id, value: true }] }, 2, 201);
   assert.deepEqual((await pushes()).map(p => p.recipientUserId), [people.coord.id]);
   await clearPush();
   await action('coordinator submit excludes sender', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-118-coord-sender', answers: [{ itemId: item.id, value: true }] }, 2, 201, 'coord');
   assert.deepEqual((await pushes()).map(p => p.recipientUserId), [people.admin.id]);
   const manualDetail = await action('manual visit has no fee', 'GET', `/api/visits/food-service/${manual.id}`, undefined, 0); assert.equal(manualDetail.fee, null);
   const noTemplate = await action('connected general report without checklist', 'POST', '/api/visits/reports', { ...body, companyId: 'place118b', clientReportId: 'report-118-no-template', templateId: null, templateVersion: null, answers: [], photo }, 3, 201, 'mash'); assert.equal(noTemplate.fee, null);
   await reset();
   const inbox = (await api('admin', 'GET', '/api/inspections/reports')).json; assert.ok(inbox.reports.some(r => r.id === first.report.id && r.kind === 'food_service' && r.hasAlerts));
   for (const type of ['', 'factory', 'food_service']) for (const status of ['', 'new', 'seen', 'follow_up']) for (const company of ['', 'place118a']) for (const mash of ['', people.mash.id]) for (const date of ['', 'from=2098-11-03&to=2098-11-03']) {
    const q = new URLSearchParams(); if (type) q.set('type', type); if (status) q.set('status', status); if (company) q.set('companyId', company); if (mash) q.set('mashgiachId', mash);
    const result = await api('admin', 'GET', `/api/inspections/reports?${q}&${date}`); assert.equal(result.status, 200);
    assert.ok(result.json.reports.every(r => (!type || r.kind === type) && (!status || r.status === status) && (!company || r.companyId === company) && (!mash || r.mashgiachId === mash)));
   }
   await api('admin', 'GET', '/api/inspections/reports/filters'); await budget('warm inbox + all 96 filter combinations', 0, 0);
   await reset();
   for (const r of inbox.reports.slice(0, 3)) { const opened = await api('admin', 'GET', `/api/inspections/reports/${r.id}`); assert.equal(opened.status, 200); assert.equal(opened.json.report.status, 'seen'); }
   assert.equal((await api('admin', 'POST', '/api/__test__/inspections/flush-seen', {})).json.writes, 1); await budget('open 3 details + one seen flush', 0, 1);
   await reset(); for (const r of inbox.reports.slice(0, 3)) await api('admin', 'GET', `/api/inspections/reports/${r.id}`); await api('admin', 'POST', '/api/__test__/inspections/flush-seen', {}); await budget('reopen seen details', 0, 0);
   const follow = `/api/inspections/reports/${first.report.id}/follow-up`;
   await action('follow-up on with note', 'PUT', follow, { on: true, note: 'Test follow-up note' });
   await action('follow-up off', 'PUT', follow, { on: false });
   await action('follow-up survives restart', 'PUT', follow, { on: true, note: 'Keep this note' });
   const scoped = (await api('coord', 'GET', '/api/inspections/reports')).json.reports; assert.ok(scoped.length > 0 && scoped.every(r => r.companyId === 'place118a'));
   assert.deepEqual((await api('coord', 'GET', '/api/inspections/reports/filters')).json.companies, [{ id: 'place118a', name: '  מקום 🥯 ' }]);
   assert.equal((await api('coord', 'GET', `/api/inspections/reports/${noTemplate.report.id}`)).status, 404); assert.equal((await api('coord', 'PUT', `/api/inspections/reports/${noTemplate.report.id}/follow-up`, { on: true })).status, 404);
   assert.equal((await api('coord', 'GET', path)).json.places.length, 1); assert.deepEqual((await api('coord', 'GET', path)).json.candidates, []);
   assert.equal((await api('coord', 'POST', `${path}/templates`, draft)).status, 403);
   // Only this food-service place becomes overdue; the check persists once and sends once.
   await pin('2098-11-11T14:00:00Z'); await clearPush(); await reset();
   let check = await api('admin', 'POST', '/api/__test__/inspections/check', {}); assert.equal(check.json.sent.filter(r => r.companyId === 'place118a').length, 1); await budget('food-service first overdue alert', 0, 1);
   await reset(); check = await api('admin', 'POST', '/api/__test__/inspections/check', {}); assert.equal(check.json.sent.length, 0); await budget('repeat overdue check', 0, 0);
   await action('template delete clears assignments', 'DELETE', `${path}/templates/${t1.id}`);
   assert.equal((await api('admin', 'GET', path)).json.places.find(p => p.id === 'place118a').templateId, null);
   const snapshot = (await api('admin', 'GET', `/api/inspections/reports/${first.report.id}`)).json.report; assert.equal(snapshot.checklist[0].label, item.label); assert.equal(snapshot.checklist[0].failed, true);
   await reset(); assert.deepEqual((await api('admin', 'GET', `/api/inspections/reports/${first.report.id}/photos`)).json.photos, { [`item:${item.id}`]: photo }); await budget('lazy food-service item photos', 1, 0);
   const spare = (await action('add spare manual place', 'POST', `${path}/places`, { name: 'Test spare manual' }, 1, 201)).place;
   await action('remove manual place', 'DELETE', `${path}/places/${spare.id}`);
   const before = (await api('admin', 'GET', path)).json, reportBefore = (await api('admin', 'GET', '/api/inspections/reports')).json;
   await api('admin', 'POST', '/api/__test__/inspections/flush-seen', {});
   await ctx.restartServer(); const boot = await settle(), agencyCount = (await ctx.getDoc()).agencies.length;
   assert.equal(boot.byCollection.inspectionFoodService, agencyCount); assert.equal(boot.byCollection.inspectionInbox, agencyCount);
   table.push({ action: `boot new docs (${agencyCount} agencies)`, reads: boot.byCollection.inspectionFoodService + boot.byCollection.inspectionInbox, writes: 0 });
   await pin('2098-11-11T14:00:00Z');
   assert.deepEqual((await api('admin', 'GET', path)).json, before); assert.deepEqual((await api('admin', 'GET', '/api/inspections/reports')).json, reportBefore); assert.deepEqual(await pushes(), []);
   // Exercise the byte guard using valid templates, and verify a refused save adds nothing.
   const largeItems = Array.from({ length: 60 }, (_, i) => ({ id: `i_${String(i).padStart(10, '0')}`, label: 'א'.repeat(200), help: 'ב'.repeat(300), type: 'text', required: false }));
   let refused = false;
   for (let i = 0; i < 30; i++) {
    const beforeCount = (await api('admin', 'GET', path)).json.templates.length; await reset();
    const r = await api('admin', 'POST', `${path}/templates`, { name: `Test large ${i}`, items: largeItems });
    if (r.status === 400) { await budget('900000-byte guard', 0, 0); assert.equal((await api('admin', 'GET', path)).json.templates.length, beforeCount); refused = true; break; }
    assert.equal(r.status, 201, JSON.stringify(r.json));
   } assert.equal(refused, true);
   const blockedBefore = (await api('admin', 'GET', path)).json;
   await reset(); await ctx.api('POST', '/api/__test__/staged', { enabled: true });
   assert.equal((await api('admin', 'POST', `${path}/places`, { name: 'Blocked test place' })).status, 503);
   assert.equal((await api('admin', 'PUT', follow, { on: false })).status, 503);
   await ctx.api('POST', '/api/__test__/staged', { enabled: false }); await budget('staged write block', 0, 0); assert.deepEqual((await api('admin', 'GET', path)).json, blockedBefore);
   console.table(table); return 'Exact read/write table printed; food-service, inbox, push isolation, guards and restart verified.';
  } finally { await ctx.api('POST', '/api/__test__/staged', { enabled: false }); await pin(null); await new Promise(r => mock.close(r)); }
 },
};
