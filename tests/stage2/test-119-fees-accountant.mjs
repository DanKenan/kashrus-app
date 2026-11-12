import assert from 'node:assert/strict';
import http from 'node:http';
import { shiftFixture } from './test-101-shifts-crud.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export default {
 name: 'Test 119: inspection fees, pay, accountant and privacy',
 whatItProves: 'Per-visit pay, agency-owned fees/accountant, role scope, exports, scheduled empty periods, private company information and exact memory-path budgets.',
 async run(baseUrl, ctx) {
  const { api, agencyId, people, tokens } = await shiftFixture(baseUrl, ctx, '119');
  const rows = { Companies: [
   { id: 'cafe119', fields: { Name: 'Main Street Cafe', Type: 'Cafe' } },
   { id: 'bakery119', fields: { Name: 'Golden Crust Bakery', Type: 'Bakery' } },
   { id: 'snacks119', fields: { Name: 'Northfield Snacks', Type: 'Factory' } },
  ], Ingredients: [{ id: 'ingredient119', fields: { Name: 'Test ingredient', Company: ['snacks119'] } }], Products: [{ id: 'product119', fields: { Name: 'Test product', Company: ['snacks119'] } }] };
  const mock = http.createServer((req, res) => {
   res.setHeader('Content-Type', 'application/json'); const url = new URL(req.url, 'http://localhost');
   if (url.pathname.endsWith('/whoami')) return res.end(JSON.stringify({ scopes: ['data.records:read'] }));
   if (url.pathname.endsWith('/tables')) return res.end(JSON.stringify({ tables: Object.entries(rows).map(([name, records]) => ({ name, fields: Object.keys(records[0].fields).map(name => ({ name })) })) }));
   res.end(JSON.stringify({ records: rows[decodeURIComponent(url.pathname.split('/').pop())] || [] }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const table = [], feesPath = id => `/api/inspections/fees/${id}`, infoPath = '/api/inspections/company-info/cafe119';
  const accountant = { name: 'Test accountant', email: 'accountant119@example.test', timing: { mode: 'dates', days: [1] } };
  const pin = iso => api('admin', 'POST', '/api/__test__/clock', { iso });
  const reset = async () => { await api('admin', 'POST', '/api/__test__/reads', { reset: true }); await api('admin', 'POST', '/api/__test__/writes', { reset: true }); };
  const budget = async (action, reads, writes) => {
   const r = (await api('admin', 'POST', '/api/__test__/reads', {})).json, w = (await api('admin', 'POST', '/api/__test__/writes', {})).json;
   table.push({ action, reads: r.total, writes: w.total }); assert.equal(r.total, reads, `${action}: ${JSON.stringify(r)}`); assert.equal(w.total, writes, `${action}: ${JSON.stringify(w)}`);
  };
  const action = async (label, method, path, body, writes = 1, status = 200, who = 'admin', reads = 0) => {
   await reset(); const r = await api(who, method, path, body); assert.equal(r.status, status, `${label}: ${JSON.stringify(r.json)}`); await budget(label, reads, writes); return r.json;
  };
  const raw = async (who, path, method = 'GET', body) => {
   const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
   return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const settle = async () => { let previous = -1, stable = 0;
   for (let i = 0; i < 200; i++) { const ready = await api('admin', 'GET', '/api/inspections/fees'); const r = (await api('admin', 'POST', '/api/__test__/reads', {})).json; stable = ready.status === 200 && ready.json.places?.some(p => p.id === 'cafe119') && r.total === previous ? stable + 1 : 0; previous = r.total; if (stable >= 5) return r; await sleep(100); } throw Error('Fees boot did not settle');
  };
  const feeA = { company: { amount: 60, per: 'visit' }, mashgiach: { amount: 50 } };
  const query = 'from=2026-10-01&to=2026-10-31';
  try {
   await pin('2026-10-20T14:00:00Z');
   for (const [who, name] of [['mash', 'R. Dovid Stern'], ['assign', 'R. Moshe Klein'], ['elsewhere', 'R. Eli Weiss']]) {
    people[who] = { ...people[who], id: people[who].id + '-demo', email: who + '-119@example.test', name };
    await ctx.api('POST', '/api/__test__/inject-fixture', { users: [people[who]] });
    tokens[who] = (await ctx.api('POST', '/api/__test__/mint-token', { userId: people[who].id })).json.token;
   }
   await api('admin', 'POST', '/api/__test__/sources-api-base', { url: `http://127.0.0.1:${mock.address().port}` });
   const mapping = { companies: { table: 'Companies', name: 'Name', type: 'Type', factoryValues: ['Factory'], foodServiceValues: ['Cafe', 'Bakery'] }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: [] };
   assert.equal((await api('admin', 'PUT', '/api/sources/connection', { sourceType: 'airtable', baseId: 'appTEST119', access: 'read', mapping, apiKey: 'fake-key-119' })).status, 200);
   for (let i = 0; i < 100; i++) { if ((await api('admin', 'POST', '/api/__test__/source-raw', {})).json.connection?.backupHashes?.snacks119) break; await sleep(50); }
   await settle(); await api('admin', 'GET', '/api/inspections/reports');
   const empty = await action('browse fees', 'GET', '/api/inspections/fees', undefined, 0); assert.equal(empty.settings.feeEditors, 'admins'); assert.equal(empty.canEdit, true); assert.equal(empty.accountant, null);
   await action('edit fee', 'PUT', feesPath('cafe119'), feeA);
   await action('unchanged fee', 'PUT', feesPath('cafe119'), feeA, 0);
   await action('yearly company fee', 'PUT', feesPath('bakery119'), { company: { amount: 1200, per: 'year' }, mashgiach: { amount: 80 } });
   await action('factory fee', 'PUT', feesPath('snacks119'), { company: { amount: 200, per: 'visit' }, mashgiach: { amount: 150 } });
   for (const [id, who] of [['cafe119', 'mash'], ['bakery119', 'assign'], ['snacks119', 'elsewhere']]) await api('admin', 'PUT', `/api/inspections/schedule/companies/${id}/people`, { mashgiachIds: [people[who].id], coordinatorIds: id === 'cafe119' ? [people.coord.id] : [] });
   await api('admin', 'PUT', '/api/inspections/schedule/settings', { mashgichimSeeAll: false });
   await action('coordinator cannot edit by default', 'PUT', feesPath('cafe119'), feeA, 0, 403, 'coord');
   await action('fee setting', 'PUT', '/api/inspections/fee-settings', { feeEditors: 'admins_and_coordinators' });
   await action('unchanged setting', 'PUT', '/api/inspections/fee-settings', { feeEditors: 'admins_and_coordinators' }, 0);
   const scoped = await action('coordinator browse', 'GET', '/api/inspections/fees', undefined, 0, 200, 'coord'); assert.equal(scoped.canEdit, true); assert.equal(scoped.accountant, undefined); assert.deepEqual(scoped.places.map(p => p.id), ['cafe119']);
   await action('coordinator unchanged fee', 'PUT', feesPath('cafe119'), feeA, 0, 200, 'coord');
   await action('coordinator other place', 'PUT', feesPath('bakery119'), feeA, 0, 404, 'coord');
   await action('accountant edit', 'PUT', '/api/inspections/accountant', accountant);
   await action('unchanged accountant', 'PUT', '/api/inspections/accountant', accountant, 0);
   await action('none send', 'POST', '/api/inspections/accountant/send', { kind: 'now', from: '2026-10-01', to: '2026-10-31' }, 0).then(r => assert.deepEqual(r, { sent: false, reason: 'not_set_up' }));
   const baseBody = { companyId: 'cafe119', kind: 'food_service', startedAt: '2026-10-20T14:00:00Z', templateId: null, templateVersion: null, answers: [] };
   const saved = [];
   let tick = 0;
   for (const [id, count, who] of [['cafe119', 9, 'mash'], ['bakery119', 1, 'assign'], ['snacks119', 6, 'elsewhere']]) {
    for (let i = 0; i < count; i++) {
     await pin(new Date(Date.parse('2026-10-20T14:00:00Z') + ++tick * 1000).toISOString());
     await api('admin', 'POST', '/api/__test__/source-fees', { agencyId, fees: { mashgiach: { snacks119: { amount: i === 0 ? 180 : 150, currency: 'USD' } } } });
     const body = id === 'snacks119' ? { clientReportId: `report-119-${id}-${i}`, companyId: id, startedAt: baseBody.startedAt, listVersion: '', marks: [], offList: [] } : { ...baseBody, companyId: id, clientReportId: `report-119-${id}-${i}` };
     const r = await action(i === 0 && id === 'snacks119' ? 'mismatched report (same batch)' : `report ${id} ${i}`, 'POST', '/api/visits/reports', body, 2, 201, who);
     saved.push(r.report); assert.equal(r.fee.amount, id === 'cafe119' ? 50 : id === 'bakery119' ? 80 : 150);
    }
   }
   for (const by of ['place', 'mashgiach']) {
    const pay = await action(`pay by ${by}`, 'GET', `/api/inspections/pay?${query}&by=${by}`, undefined, 0);
    assert.deepEqual(pay.totals, { visits: 16, paid: 1430, companies: 1840, left: 410 }); assert.equal(pay.mismatches, 1); assert.equal(pay.noFee, 0);
    if (by === 'mashgiach') assert.deepEqual(pay.rows.map(r => r.name).sort(), ['R. Dovid Stern', 'R. Eli Weiss', 'R. Moshe Klein'].sort());
    for (const format of ['csv', 'xlsx']) { await reset(); const r = await raw('admin', `/api/inspections/pay/export?${query}&by=${by}&format=${format}`); assert.equal(r.response.status, 200); assert.ok(r.response.headers.get('content-disposition').includes('.' + format)); assert.ok(r.bytes.length > 100); if (format === 'csv') assert.ok(r.bytes.toString().includes('1430,1840,410')); else assert.equal(r.bytes.readUInt32LE(), 0x04034b50); await budget(`export ${format} ${by}`, 0, 0); }
   }
   const openChecks = await action('open amount check filter', 'GET', '/api/inspections/reports?amountCheck=open', undefined, 0); assert.equal(openChecks.reports.length, 1);
   const coordOnlyCafe = await action('coordinator open checks limited to own place', 'GET', '/api/inspections/reports?amountCheck=open', undefined, 0, 200, 'coord'); assert.deepEqual(coordOnlyCafe.reports, []);
   await api('admin', 'PUT', '/api/inspections/schedule/companies/snacks119/people', { mashgiachIds: [people.elsewhere.id], coordinatorIds: [people.coord.id] });
   const coordWithSnacks = await action('coordinator open checks with assigned place', 'GET', '/api/inspections/reports?amountCheck=open', undefined, 0, 200, 'coord'); assert.deepEqual(coordWithSnacks.reports.map(r => r.id), [saved[10].id]);
   await api('admin', 'PUT', '/api/inspections/schedule/companies/snacks119/people', { mashgiachIds: [people.elsewhere.id], coordinatorIds: [] });
   const mismatch = saved[10];
   const detail = (await api('admin', 'GET', `/api/inspections/reports/${mismatch.id}`)).json.report;
   assert.deepEqual(detail.feeCheck, { reportAmount: 180, setAmount: 150, paidAmount: 150, decided: null });
   await api('admin', 'POST', '/api/__test__/inspections/flush-seen', {});
   await action('invalid decision', 'POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, { amount: 177 }, 0, 400);
   await action('data amount cannot override admin fee', 'POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, { amount: 180 }, 0, 400);
   await action('keep acknowledges stamped fee', 'POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, {});
   assert.equal((await api('admin', 'GET', `/api/inspections/pay?${query}`)).json.totals.paid, 1430);
   assert.equal((await api('admin', 'GET', '/api/inspections/reports?amountCheck=open')).json.reports.length, 0);
   await action('change place admin fee', 'PUT', feesPath('snacks119'), { company: { amount: 200, per: 'visit' }, mashgiach: { amount: 180 } });
   await action('decision uses current admin fee', 'POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, { amount: 180 });
   assert.equal((await api('admin', 'GET', `/api/inspections/pay?${query}`)).json.mismatches, 0);
   assert.equal((await api('admin', 'GET', `/api/inspections/pay?${query}`)).json.totals.paid, 1460);
   assert.equal((await api('admin', 'GET', `/api/inspections/reports/${mismatch.id}`)).json.report.feeCheck.decided.amount, 180);
   await action('restore place admin fee', 'PUT', feesPath('snacks119'), { company: { amount: 200, per: 'visit' }, mashgiach: { amount: 150 } });
   await action('restore decision to set fee', 'POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, { amount: 150 });
   await action('coordinator decision outside scope', 'POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, { amount: 150 }, 0, 404, 'coord');
   await api('admin', 'PUT', '/api/inspections/schedule/companies/snacks119/people', { mashgiachIds: [people.elsewhere.id], coordinatorIds: [people.coord.id] });
   await action('coordinator scoped fee decision', 'POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, {}, 1, 200, 'coord');
   assert.equal((await api('coord', 'GET', `/api/inspections/reports/${mismatch.id}`)).json.report.feeCheck.decided.byName, people.coord.name);
   await action('admin restores set decision', 'POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, { amount: 150 });
   await api('admin', 'PUT', '/api/inspections/schedule/companies/snacks119/people', { mashgiachIds: [people.elsewhere.id], coordinatorIds: [] });
   await api('admin', 'POST', '/api/__test__/inspections/flush-seen', {});
   const preview = await action('preview', 'GET', `/api/inspections/accountant/preview?${query}`, undefined, 0); assert.equal(preview.to, accountant.email); assert.ok(preview.subject.endsWith('October 2026')); assert.equal(preview.attachments.length, 2); assert.ok(preview.attachments.every(a => a.bytes > 100)); assert.ok(preview.html.includes('$1,430.00'));
   await action('company info', 'PUT', infoPath, { address: 'Test address', phone: '555-0100', contacts: [{ name: 'Test contact', role: 'Manager', email: 'private119@example.test', phone: '555-0199-contact-private' }] });
   const info = await action('read company info', 'GET', infoPath, undefined, 0); assert.match(info.contacts[0].id, /^c_[a-z0-9]{10}$/);
   await action('unchanged contacts', 'PUT', infoPath, info, 0);
   await action('coordinator read company info', 'GET', infoPath, undefined, 0, 200, 'coord');
   await action('coordinator cannot write contacts', 'PUT', infoPath, info, 0, 403, 'coord');
   await action('contact cap', 'PUT', infoPath, { ...info, contacts: Array.from({ length: 21 }, () => ({ name: 'Test', role: 'Test', email: '', phone: '' })) }, 0, 400);
   const twenty = await action('20 contacts accepted', 'PUT', infoPath, { ...info, contacts: Array.from({ length: 20 }, (_, i) => ({ name: `Test ${i}`, role: 'Test role', email: 'private119@example.test', phone: '555-0199-contact-private' })) }); assert.equal(twenty.contacts.length, 20);
   await action('replace contacts whole', 'PUT', infoPath, { ...twenty, contacts: [twenty.contacts[0]] });
   // Sentinel values must never occur in any raw mashgiach response, including successful submission.
   await action('company privacy sentinel', 'PUT', feesPath('cafe119'), { ...feeA, company: { amount: 60.17, per: 'visit' } });
   await action('other fee privacy sentinel', 'PUT', feesPath('bakery119'), { company: { amount: 1200, per: 'year' }, mashgiach: { amount: 77.31 } });
   const newRoutes = [ ['GET', '/api/inspections/fees'], ['PUT', feesPath('cafe119'), feeA], ['PUT', '/api/inspections/fee-settings', { feeEditors: 'admins' }], ['PUT', '/api/inspections/accountant', accountant], ['GET', `/api/inspections/pay?${query}`], ['GET', `/api/inspections/pay/export?${query}&format=csv`], ['GET', `/api/inspections/accountant/preview?${query}`], ['POST', '/api/inspections/accountant/send', { kind: 'test' }], ['POST', `/api/inspections/reports/${mismatch.id}/fee-decision`, { amount: 150 }], ['GET', infoPath], ['PUT', infoPath, info] ];
   const readRoutes = ['/api/visits/factories', '/api/visits/factories/snacks119', '/api/factories', '/api/factories/snacks119/items?kind=ingredient', '/api/food-service', '/api/visits/food-service', '/api/visits/food-service/cafe119', '/api/visits/food-service/bakery119', '/api/visits/reports/mine', '/api/visits/reports/mine?amountCheck=open', '/api/inspections/alerts', '/api/inspections/schedule', '/api/visits/places/cafe119/info', '/api/visits/places/bakery119/info', '/api/inspections/reports', '/api/inspections/reports?amountCheck=open', `/api/inspections/reports/${mismatch.id}`, `/api/inspections/reports/${mismatch.id}/photos`];
   await pin('2026-10-21T14:00:00Z');
   const privacyBody = { ...baseBody, clientReportId: 'report-119-privacy' };
   for (const [method, path, body] of [...readRoutes.map(p => ['GET', p]), ...newRoutes, ['POST', '/api/visits/reports', privacyBody]]) {
    const r = await raw('mash', path, method, body), text = r.bytes.toString();
    for (const sentinel of ['60.17', '77.31', 'private119@example.test', '555-0199-contact-private', 'accountant119@example.test']) assert.equal(text.includes(sentinel), false, `${path}: ${sentinel}`);
    for (const key of ['left', 'companyPays', 'dataFee', 'feeMismatch', 'feeCheck', 'decisions', 'accountant', 'contacts']) assert.equal(new RegExp(`"${key}"\\s*:`).test(text), false, `${path}: ${key}`);
    const inspect = value => { if (!value || typeof value !== 'object') return; assert.equal(Object.hasOwn(value, 'per'), false, path); assert.equal(!!value.company && typeof value.company === 'object' && Object.hasOwn(value.company, 'amount'), false, path); for (const child of Object.values(value)) inspect(child); };
    if (r.response.headers.get('content-type')?.includes('json')) inspect(JSON.parse(text));
    if (newRoutes.some(n => n[0] === method && n[1] === path)) assert.ok([403, 404].includes(r.response.status), `${path}: role gate`);
   }
   for (const [method, path, body] of newRoutes.filter(n => !n[1].includes('/fees') && !n[1].includes('company-info') && !n[1].includes('fee-decision'))) assert.equal((await api('coord', method, path, body)).status, 403, path);
   assert.equal((await api('foreign', 'GET', '/api/inspections/fees')).json.places.length, 0);
   await action('restore company fee', 'PUT', feesPath('cafe119'), feeA);
   await action('restore other fee', 'PUT', feesPath('bakery119'), { company: { amount: 1200, per: 'year' }, mashgiach: { amount: 80 } });
   await pin('2026-11-01T12:00:00Z');
   await action('transport none scheduled', 'POST', '/api/__test__/inspections/check', {}, 0);
   await api('admin', 'POST', '/api/__test__/inspections/email-transport', { name: 'test' });
   await action('test send', 'POST', '/api/inspections/accountant/send', { kind: 'test', from: '2026-10-01', to: '2026-10-31' }, 0).then(r => assert.equal(r.sent, true));
   let messages = (await api('admin', 'GET', '/api/__test__/outbox')).json.messages; assert.equal(messages.length, 1); assert.deepEqual((await api('foreign', 'GET', '/api/__test__/outbox')).json.messages, []); assert.equal(messages[0].to, accountant.email); assert.ok(messages[0].attachments.every(a => a.contentBase64.length > 100));
   await action('scheduled run', 'POST', '/api/__test__/inspections/check', {}, 1, 200, 'admin', 18); assert.equal((await api('admin', 'GET', '/api/__test__/outbox')).json.messages.length, 2);
   await action('repeat scheduled run', 'POST', '/api/__test__/inspections/check', {}, 0);
   await pin('2026-12-01T12:00:00Z'); await action('empty-month scheduled run', 'POST', '/api/__test__/inspections/check', {}, 1, 200, 'admin', 1); assert.equal((await api('admin', 'GET', '/api/__test__/outbox')).json.messages.length, 2);
   await action('repeat empty-month run', 'POST', '/api/__test__/inspections/check', {}, 0);
   await action('manual empty period', 'POST', '/api/inspections/accountant/send', { kind: 'now', from: '2026-11-01', to: '2026-11-30' }, 0).then(r => assert.equal(r.reason, 'no_visits'));
   await action('accountant after-report mode', 'PUT', '/api/inspections/accountant', { ...accountant, timing: { mode: 'after_report' } });
   await pin('2026-12-02T12:00:00Z');
   await action('after-report send plus lastSent', 'POST', '/api/visits/reports', { ...baseBody, clientReportId: 'report-119-after-report' }, 3, 201, 'mash', 2);
   await pin('2026-12-02T12:01:00Z');
   await action('after-report debounce', 'POST', '/api/visits/reports', { ...baseBody, clientReportId: 'report-119-after-report-debounce' }, 2, 201, 'mash');
   await action('accountant every-days mode', 'PUT', '/api/inspections/accountant', { ...accountant, timing: { mode: 'every_days', everyDays: 2 } });
   await pin('2026-12-05T12:00:00Z'); await action('every-days run', 'POST', '/api/__test__/inspections/check', {}, 1, 200, 'admin', 1);
   await action('clear accountant', 'PUT', '/api/inspections/accountant', null);
   await action('no accountant', 'POST', '/api/inspections/accountant/send', { kind: 'now' }, 0).then(r => assert.equal(r.reason, 'no_accountant'));
   await action('clear company info contacts', 'PUT', infoPath, { address: '', phone: '', contacts: [] });
   await api('admin', 'POST', '/api/__test__/inspections/email-transport', { name: 'none' });
   await reset(); await ctx.api('POST', '/api/__test__/staged', { enabled: true });
   assert.equal((await api('admin', 'PUT', feesPath('cafe119'), { company: null, mashgiach: null })).status, 503);
   assert.equal((await api('admin', 'PUT', infoPath, { address: 'Blocked', phone: '', contacts: [] })).status, 503);
   await ctx.api('POST', '/api/__test__/staged', { enabled: false }); await budget('staged writes blocked', 0, 0);
   await ctx.restartServer(); const boot = await settle(), agencyCount = (await ctx.getDoc()).agencies.length;
   assert.equal(boot.byCollection.inspectionFees, agencyCount); assert.equal(boot.byCollection.inspectionCompanyInfo, agencyCount);
   table.push({ action: `boot new docs (${agencyCount} agencies)`, reads: boot.byCollection.inspectionFees + boot.byCollection.inspectionCompanyInfo, writes: 0 });
   const restoredInfo = await api('admin', 'GET', infoPath); assert.equal(restoredInfo.status, 200, JSON.stringify(restoredInfo.json)); assert.equal(restoredInfo.json.contacts.length, 0);
   assert.equal((await api('admin', 'GET', '/api/inspections/fees')).json.places.find(p => p.id === 'cafe119').company.amount, 60);
   // Evict a past month from the bounded boot window, then measure on-demand month reads.
   await pin('2026-05-15T14:00:00Z');
   for (let i = 0; i < 5; i++) assert.equal((await api('mash', 'POST', '/api/visits/reports', { ...baseBody, clientReportId: `report-119-old-month-${i}` })).status, 201);
   await pin('2027-01-15T14:00:00Z');
   for (let i = 0; i < 201; i++) assert.equal((await api('mash', 'POST', '/api/visits/reports', { ...baseBody, clientReportId: `report-119-current-month-${i}` })).status, 201);
   await ctx.restartServer(); await settle(); await pin('2027-01-15T14:00:00Z');
   const completedMonth = await action('complete boundary month pay', 'GET', '/api/inspections/pay?from=2027-01-01&to=2027-01-31', undefined, 0, 200, 'admin', 1); assert.equal(completedMonth.totals.visits, 201);
   await action('cached boundary month pay', 'GET', '/api/inspections/pay?from=2027-01-01&to=2027-01-31', undefined, 0);
   const past = await action('cold past month pay', 'GET', '/api/inspections/pay?from=2026-05-01&to=2026-05-31', undefined, 0, 200, 'admin', 5); assert.equal(past.totals.visits, 5);
   await action('cached past month pay', 'GET', '/api/inspections/pay?from=2026-05-01&to=2026-05-31&by=mashgiach', undefined, 0);
   await action('cached past month preview', 'GET', '/api/inspections/accountant/preview?from=2026-05-01&to=2026-05-31', undefined, 0);
   console.table(table); return 'Fees/pay/export/accountant/company info, privacy sentinels, scheduled jobs, persistence and exact budgets passed.';
  } finally { await ctx.api('POST', '/api/__test__/staged', { enabled: false }); await pin(null); await new Promise(r => mock.close(r)); }
 },
};
