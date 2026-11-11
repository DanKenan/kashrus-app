import assert from 'node:assert/strict';
import http from 'node:http';
import { shiftFixture } from './test-101-shifts-crud.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export default {
  name: 'Test 117: inspection schedule, people and overdue alerts',
  whatItProves: 'Calendar due dates, agency/assignment scope, exact read/write budgets, batched alerts, report lastVisit and durable restart state.',
  async run(baseUrl, ctx) {
    const { api, agencyId, people } = await shiftFixture(baseUrl, ctx, '117');
    const schedulePath = '/api/inspections/schedule', companyPath = id => `${schedulePath}/companies/${id}`;
    const rows = { Companies: [{ id: 'factory117a', fields: { Name: 'Zebra Exact', Brand: 'Brand Exact', Plant: 'Plant Exact' } }, { id: 'factory117b', fields: { Name: 'Alpha Exact' } }], Ingredients: [{ id: 'ingredient117', fields: { Name: 'Test ingredient', Company: ['factory117a'] } }], Products: [{ id: 'product117', fields: { Name: 'Test product', Company: ['factory117a'] } }] };
    const mock = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.endsWith('/whoami')) return res.end(JSON.stringify({ scopes: ['data.records:read'] }));
      if (url.pathname.endsWith('/tables')) return res.end(JSON.stringify({ tables: Object.entries(rows).map(([name, records]) => ({ name, fields: Object.keys(records[0].fields).map(name => ({ name })) })) }));
      res.end(JSON.stringify({ records: rows[decodeURIComponent(url.pathname.split('/').pop())] || [] }));
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    const table = [];
    const reset = async () => { await api('admin', 'POST', '/api/__test__/reads', { reset: true }); await api('admin', 'POST', '/api/__test__/writes', { reset: true }); };
    const budget = async (action, reads, writes) => {
      const r = (await api('admin', 'POST', '/api/__test__/reads', {})).json, w = (await api('admin', 'POST', '/api/__test__/writes', {})).json;
      table.push({ action, reads: r.total, writes: w.total });
      assert.equal(r.total, reads, `${action}: ${JSON.stringify(r)}`); assert.equal(w.total, writes, `${action}: ${JSON.stringify(w)}`);
    };
    const change = async (action, path, body, writes = 1, who = 'admin', status = 200) => {
      await reset(); const r = await api(who, 'PUT', path, body); assert.equal(r.status, status, `${action}: ${JSON.stringify(r.json)}`); await budget(action, 0, writes); return r.json;
    };
    const pin = iso => api('admin', 'POST', '/api/__test__/clock', { iso });
    const check = async (action, writes, count) => {
      await reset(); const r = await api('admin', 'POST', '/api/__test__/inspections/check', {});
      assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.writes, writes); assert.equal(r.json.sent.length, count); await budget(action, 0, writes); return r.json.sent;
    };
    const settle = async () => {
      let stable = 0, old = -1;
      for (let i = 0; i < 150; i++) {
        const ready = await api('admin', 'GET', schedulePath), factories = await api('admin', 'GET', '/api/visits/factories');
        const reads = (await api('admin', 'POST', '/api/__test__/reads', {})).json;
        stable = reads.total === old && ready.status === 200 && factories.json.companies?.length === 2 ? stable + 1 : 0;
        old = reads.total;
        if (stable >= 5) return reads;
        await sleep(100);
      }
      throw Error('Inspection boot did not settle');
    };
    try {
      await pin('2098-11-03T14:00:00Z');
      await api('admin', 'POST', '/api/__test__/sources-api-base', { url: `http://127.0.0.1:${mock.address().port}` });
      const mapping = { companies: { table: 'Companies', name: 'Name', brand: 'Brand', plant: 'Plant' }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: [] };
      assert.equal((await api('admin', 'PUT', '/api/sources/connection', { sourceType: 'airtable', baseId: 'appTEST117', access: 'read', mapping, apiKey: 'fake-key-117' })).status, 200);
      for (let i = 0; i < 100; i++) { if ((await api('admin', 'POST', '/api/__test__/source-raw', {})).json.connection?.backupHashes?.factory117b) break; await sleep(50); }
      await api('admin', 'GET', '/api/inspections/reports');
      for (const who of Object.keys(people)) await api(who, 'GET', '/api/visits/factories');
      await settle(); await reset();
      const initial = (await api('admin', 'GET', schedulePath)).json;
      assert.equal(initial.companies.length, 2); assert.deepEqual(initial.companies.map(c => c.name), ['Alpha Exact', 'Zebra Exact']);
      assert.equal(initial.companies.find(c => c.id === 'factory117a').brand, 'Brand Exact'); assert.equal(initial.companies.find(c => c.id === 'factory117a').plant, 'Plant Exact');
      assert.ok(initial.companies.every(c => c.status === 'none' && c.schedule === null));
      assert.equal(initial.people.coordinators.length, 2);
      assert.equal((await api('admin', 'GET', '/api/inspections/alerts')).json.alerts.length, 0);
      await api('mash', 'GET', '/api/visits/factories'); await budget('browse schedule / alerts / factories', 0, 0);
      const s = { kind: 'every', n: 30, unit: 'day', start: '2098-11-03' };
      await change('set schedule', companyPath('factory117a'), { schedule: s });
      await change('same schedule', companyPath('factory117a'), { schedule: s }, 0);
      await change('second schedule', companyPath('factory117b'), { schedule: s });
      await change('people', companyPath('factory117a') + '/people', { mashgiachIds: [people.mash.id], coordinatorIds: [people.coord.id] });
      for (const bad of ['missing', people.foreign.id, people.coord.id]) await change('invalid assignee', companyPath('factory117a') + '/people', { mashgiachIds: [bad], coordinatorIds: [] }, 0, 'admin', 400);
      for (const schedule of [{ ...s, n: 0 }, { kind: 'dates', dates: ['2098-02-30'] }, { ...s, extra: true }]) await change('invalid schedule', companyPath('factory117a'), { schedule }, 0, 'admin', 400);
      await change('settings', schedulePath + '/settings', { countFrom: 'planned', mashgichimSeeAll: false });
      await change('coordinator cannot change settings', schedulePath + '/settings', { countFrom: 'last_visit' }, 0, 'coord', 403);
      await change('same settings', schedulePath + '/settings', { countFrom: 'planned', mashgichimSeeAll: false }, 0);
      assert.equal((await api('coord', 'GET', schedulePath)).json.companies.length, 1);
      assert.deepEqual((await api('coord', 'GET', schedulePath)).json.people, { mashgichim: [], coordinators: [] });
      assert.equal((await api('coordOff', 'GET', schedulePath)).json.companies.length, 0);
      await change('coordinator outside scope', companyPath('factory117b'), { schedule: null }, 0, 'coord', 404);
      await change('coordinator cannot assign', companyPath('factory117a') + '/people', { mashgiachIds: [], coordinatorIds: [] }, 0, 'coord', 403);
      await reset();
      assert.equal((await api('coord', 'POST', '/api/__test__/inspections/check', {})).status, 403);
      await budget('coordinator cannot run check', 0, 0);
      let factories = (await api('mash', 'GET', '/api/visits/factories')).json.companies;
      assert.deepEqual(factories.map(c => [c.id, c.assigned]), [['factory117a', true]]);
      assert.equal((await api('mash', 'GET', '/api/visits/factories/factory117b')).status, 404);
      const report = (companyId, clientReportId) => ({ companyId, clientReportId, listVersion: 'old', startedAt: '2098-11-03T13:00:00Z', marks: [], offList: [] });
      assert.equal((await api('mash', 'POST', '/api/visits/reports', report('factory117b', 'report-117-denied'))).status, 404);
      await change('see all', schedulePath + '/settings', { mashgichimSeeAll: true });
      factories = (await api('mash', 'GET', '/api/visits/factories')).json.companies;
      assert.deepEqual(factories.map(c => [c.id, c.assigned]), [['factory117a', true], ['factory117b', false]]);
      const first = await check('first alerts, two companies', 1, 2);
      const companyAlert = first.find(c => c.companyId === 'factory117a'); assert.equal(companyAlert.kind, 'first');
      assert.deepEqual(companyAlert.userIds.sort(), [people.admin.id, people.mash.id, people.coord.id].sort());
      assert.deepEqual(first.find(c => c.companyId === 'factory117b').userIds, [people.admin.id]);
      await check('second check same day', 0, 0);
      await pin('2098-11-09T14:00:00Z'); await check('six days', 0, 0);
      await pin('2098-11-10T14:00:00Z'); assert.ok((await check('seven day reminders', 1, 2)).every(c => c.kind === 'reminder'));
      await change('mute indefinitely', companyPath('factory117a') + '/mute', { muted: true });
      await change('same mute', companyPath('factory117a') + '/mute', { muted: true }, 0);
      await change('mute other company', companyPath('factory117b') + '/mute', { muted: true, until: '2098-12-01' });
      await pin('2098-11-17T14:00:00Z'); await check('muted check', 0, 0);
      const alerts = (await api('mash', 'GET', '/api/inspections/alerts')).json.alerts;
      assert.deepEqual(alerts.map(a => [a.companyId, a.muted]), [['factory117a', true]]);
      assert.ok((await api('admin', 'GET', schedulePath)).json.companies.every(c => c.status === 'overdue'));
      await reset(); const submitted = await api('mash', 'POST', '/api/visits/reports', report('factory117a', 'report-117-visit'));
      assert.equal(submitted.status, 201, JSON.stringify(submitted.json)); await budget('plain report plus lastVisit', 0, 2);
      await reset(); assert.equal((await api('mash', 'POST', '/api/visits/reports', report('factory117a', 'report-117-visit'))).status, 200); await budget('cached report retry', 0, 0);
      await change('unmute after report', companyPath('factory117a') + '/mute', { muted: false });
      await check('report moves due date', 0, 0);
      const otherReport = await api('admin', 'POST', '/api/visits/reports', report('factory117b', 'report-117-other'));
      assert.equal(otherReport.status, 201);
      await pin('2098-11-16T14:00:00Z'); await reset();
      const baseline = await api('admin', 'POST', '/api/visits/reports', report('factory117b', 'report-117-baseline'));
      assert.equal(baseline.status, 201); await budget('plain report without lastVisit change', 0, 1);
      await pin('2098-11-17T14:00:00Z');
      const inbox = (await api('coord', 'GET', '/api/inspections/reports')).json.reports;
      assert.deepEqual(inbox.map(r => r.companyId), ['factory117a']);
      for (const suffix of ['', '/photos']) assert.equal((await api('coord', 'GET', `/api/inspections/reports/${otherReport.json.report.id}${suffix}`)).status, 404);
      await change('explicit date schedule', companyPath('factory117b'), { schedule: { kind: 'dates', dates: ['2098-11-18'] } });
      await change('unmute second company', companyPath('factory117b') + '/mute', { muted: false });
      await pin('2098-11-18T14:00:00Z');
      await check('new due-date alert', 1, 1);
      // Persist an indefinite mute as well as an unmuted overdue alert across boot.
      await change('persist indefinite mute', companyPath('factory117a') + '/mute', { muted: true });
      const before = (await api('admin', 'GET', schedulePath)).json;
      assert.equal(before.companies.find(c => c.id === 'factory117a').lastVisit.reportId, submitted.json.report.id); assert.equal(before.companies.find(c => c.id === 'factory117a').nextDue, '2098-12-03');
      await ctx.restartServer();
      const boot = await settle(), agencyCount = (await ctx.getDoc()).agencies.length;
      assert.equal(boot.byCollection.inspectionSchedules, agencyCount, JSON.stringify(boot));
      table.push({ action: `schedule boot (${agencyCount} agencies)`, reads: boot.byCollection.inspectionSchedules, writes: 0 });
      await pin('2098-11-18T14:00:00Z');
      const after = (await api('admin', 'GET', schedulePath)).json;
      assert.deepEqual(after, before);
      await check('restart check', 0, 0);
      await reset(); await api('admin', 'GET', schedulePath); await api('admin', 'GET', '/api/inspections/alerts'); await api('mash', 'GET', '/api/visits/factories'); await budget('browse after restart', 0, 0);
      console.table(table);
      return 'Exact measured table printed; schedule state and lastVisit survive restart; agency boot 1 schedule read each; alerts use 1 write per agency.';
    } finally { await pin(null); await new Promise(r => mock.close(r)); }
  },
};
