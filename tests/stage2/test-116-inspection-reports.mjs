import assert from 'node:assert/strict';
import http from 'node:http';
import { shiftFixture } from './test-101-shifts-crud.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export default {
  name: 'Test 116: factory visit reports',
  whatItProves: 'Agency and role isolation, exact source snapshots, memory reads, one/two-write submissions, idempotency, lazy photos and restart loading.',
  async run(baseUrl, ctx) {
    const { api, agencyId, people, tokens } = await shiftFixture(baseUrl, ctx, '116');
    const manager = { id: `manager-${agencyId}`, agencyId, role: 'manager', name: 'Factory manager', email: `manager-${agencyId}@test.local` };
    assert.equal((await ctx.api('POST', '/api/__test__/inject-fixture', { users: [manager] })).status, 200);
    tokens.manager = (await ctx.api('POST', '/api/__test__/mint-token', { userId: manager.id })).json.token;
    const rows = {
      Companies: [{ id: 'factory116', fields: { Name: 'Factory Exact', Brand: 'Brand Exact', Plant: 'Plant Exact' } }],
      Ingredients: Array.from({ length: 3 }, (_, i) => ({ id: `ingredient116-${i}`, fields: { Name: `Ingredient ${i}`, Brand: 'Brand', Company: ['factory116'], Cert: 'Certification Exact', Status: 'Status Exact' } })),
      Products: [{ id: 'product116', fields: { Name: 'Product Exact', Company: ['factory116'], Code: 'Code Exact' } }],
    };
    let calls = 0;
    const mock = http.createServer((req, res) => {
      calls++; res.setHeader('Content-Type', 'application/json');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.endsWith('/whoami')) return res.end(JSON.stringify({ scopes: ['data.records:read'] }));
      if (url.pathname.endsWith('/tables')) return res.end(JSON.stringify({ tables: Object.entries(rows).map(([name, records]) => ({ name, fields: Object.keys(records[0].fields).map(name => ({ name })) })) }));
      res.end(JSON.stringify({ records: rows[decodeURIComponent(url.pathname.split('/').pop())] || [] }));
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    try {
      await api('admin', 'POST', '/api/__test__/sources-api-base', { url: `http://127.0.0.1:${mock.address().port}` });
      const mapping = { companies: { table: 'Companies', name: 'Name', brand: 'Brand', plant: 'Plant' }, ingredients: { table: 'Ingredients', name: 'Name', brand: 'Brand', companyLink: 'Company', certification: 'Cert', status: 'Status' }, products: { table: 'Products', name: 'Name', companyLink: 'Company', code: 'Code' }, group1Values: [] };
      assert.equal((await api('admin', 'PUT', '/api/sources/connection', { sourceType: 'airtable', baseId: 'appTEST116', access: 'read', mapping, apiKey: 'fake-key-116' })).status, 200);
      for (let i = 0; i < 100; i++) {
        const raw = await api('admin', 'POST', '/api/__test__/source-raw', {});
        if (raw.json.connection?.backupHashes?.factory116) break;
        await sleep(50);
      }
      // Warm session caches before resetting the operation meters.
      for (const who of ['mash', 'admin', 'coord', 'foreign', 'manager']) await api(who, 'GET', '/api/visits/factories');
      const reset = async () => { await api('admin', 'POST', '/api/__test__/reads', { reset: true }); await api('admin', 'POST', '/api/__test__/writes', { reset: true }); };
      const budget = async (reads, writes) => {
        const r = (await api('admin', 'POST', '/api/__test__/reads', {})).json;
        const w = (await api('admin', 'POST', '/api/__test__/writes', {})).json;
        assert.equal(r.total, reads, JSON.stringify(r)); assert.equal(w.total, writes, JSON.stringify(w));
      };
      await api('admin', 'GET', '/api/inspections/reports'); // Finish this newly connected agency's empty hydration.
      await api('foreign', 'GET', '/api/visits/reports/mine');
      await reset(); const sourceCalls = calls;
      assert.equal((await api('mash', 'GET', '/api/visits/factories')).json.companies.length, 1);
      const list = (await api('mash', 'GET', '/api/visits/factories/factory116')).json;
      assert.ok(list.listVersion); assert.equal(list.company.name, 'Factory Exact');
      assert.equal(list.ingredients[0].certificationRaw, 'Certification Exact');
      await budget(0, 0); assert.equal(calls, sourceCalls);
      const photo = 'data:image/png;base64,YQ==';
      const body = { clientReportId: 'report-116-photo', companyId: 'factory116', listVersion: list.listVersion, startedAt: new Date().toISOString(), note: ' Visit note ', marks: [
        { kind: 'ingredient', itemId: list.ingredients[0].id, status: 'checked' },
        { kind: 'ingredient', itemId: list.ingredients[1].id, status: 'not_used' },
        { kind: 'product', itemId: list.products[0].id, status: 'alert', photo },
      ], offList: [{ name: ' Off-list Exact ', brand: 'Brand Exact', photo }] };
      // +1 = lastVisit in the same batch (Phase 3 schedule)
      await reset(); const first = await api('mash', 'POST', '/api/visits/reports', body);
      assert.equal(first.status, 201, JSON.stringify(first.json)); await budget(0, 3);
      assert.equal(first.json.fee, null); const id = first.json.report.id;
      assert.deepEqual(first.json.report.counts, { checked: 1, not_used: 1, alert: 1, offList: 1 });
      assert.equal(first.json.report.mashgiachId, people.mash.id);
      await reset(); const duplicate = await api('mash', 'POST', '/api/visits/reports', body);
      assert.equal(duplicate.status, 200); assert.deepEqual(duplicate.json, first.json); await budget(0, 0);
      await reset();
      assert.equal((await api('admin', 'PUT', '/api/inspections/schedule/companies/factory116/people', { mashgiachIds: [], coordinatorIds: [people.coord.id] })).status, 200);
      await budget(0, 1);
      await reset(); const plain = await api('coord', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-116-plain', listVersion: 'old-version', marks: [{ ...body.marks[0] }], offList: [] });
      assert.equal(plain.status, 201); assert.equal(plain.json.report.listChanged, true); await budget(0, 2);
      for (const extra of [
        { marks: [{ kind: 'product', itemId: list.products[0].id, status: 'alert' }] },
        { marks: [{ kind: 'product', itemId: 'unknown', status: 'checked' }] },
        { offList: Array.from({ length: 4 }, () => ({ name: 'Extra', photo })) },
      ]) { await reset(); assert.equal((await api('mash', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-116-invalid', ...extra })).status, 400); await budget(0, 0); }
      assert.equal((await api('foreign', 'GET', '/api/visits/factories/factory116')).status, 404);
      assert.equal((await api('foreign', 'POST', '/api/visits/reports', body)).status, 404);
      for (const path of ['/api/visits/factories', '/api/visits/factories/factory116', '/api/visits/reports/mine']) assert.equal((await api('manager', 'GET', path)).status, 403);
      assert.equal((await api('manager', 'POST', '/api/visits/reports', body)).status, 403);
      assert.equal((await api('mash', 'GET', '/api/inspections/reports')).status, 403);
      assert.equal((await api('coord', 'GET', `/api/inspections/reports/${id}`)).status, 403);
      assert.equal((await api('foreign', 'GET', `/api/inspections/reports/${id}`)).status, 404);
      await reset();
      const inbox = (await api('admin', 'GET', '/api/inspections/reports')).json.reports;
      assert.deepEqual(inbox.map(r => r.id), [plain.json.report.id, id]);
      assert.equal((await api('mash', 'GET', '/api/visits/reports/mine')).json.reports.length, 1);
      const detail = (await api('admin', 'GET', `/api/inspections/reports/${id}`)).json.report;
      assert.equal(detail.note, body.note); assert.equal(detail.marks[2].item.code, 'Code Exact'); assert.equal(detail.offList[0].name, ' Off-list Exact '); await budget(0, 0);
      await reset(); assert.deepEqual((await api('admin', 'GET', `/api/inspections/reports/${id}/photos`)).json.photos, { 'mark:2': photo, 'off:0': photo }); await budget(1, 0);
      await reset(); await api('admin', 'GET', `/api/inspections/reports/${id}/photos`); await api('admin', 'GET', `/api/inspections/reports/${plain.json.report.id}/photos`); await budget(0, 0);
      // The test-only hook uses the configured backend and updates the live connection too.
      const fees = { mashgiach: { factory116: { amount: 82, currency: 'USD' } } };
      await reset();
      assert.equal((await api('admin', 'POST', '/api/__test__/source-fees', { agencyId: `${agencyId}-other`, fees })).status, 403);
      await budget(0, 0);
      assert.equal((await api('admin', 'POST', '/api/__test__/source-fees', { agencyId, fees })).status, 200);
      await budget(0, 1);
      await reset();
      const liveFee = await api('admin', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-116-live-fee', marks: [], offList: [] });
      assert.equal(liveFee.status, 201); assert.deepEqual(liveFee.json.fee, { amount: 82, currency: 'USD' }); await budget(0, 2);
      await reset();
      for (let i = 0; i < 201; i++) {
        const extra = await api('admin', 'POST', '/api/visits/reports', { ...body, clientReportId: `report-116-page-${i}`, marks: [], offList: [] });
        assert.equal(extra.status, 201);
      }
      await budget(0, 402);
      await ctx.restartServer();
      for (let i = 0; i < 100; i++) {
        if ((await api('admin', 'POST', '/api/__test__/reads', {})).json.byCollection.reports >= 200) break;
        await sleep(50);
      }
      // Source backup hydration runs independently of report warm-up on the emulator.
      for (let i = 0; i < 100; i++) {
        if ((await api('admin', 'GET', '/api/visits/factories')).json.companies.length) break;
        await sleep(50);
      }
      assert.ok((await api('admin', 'GET', '/api/visits/factories')).json.companies.length);
      let bootReads = (await api('admin', 'POST', '/api/__test__/reads', {})).json;
      let settled = false;
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        const next = (await api('admin', 'POST', '/api/__test__/reads', {})).json;
        if (next.total === bootReads.total) { bootReads = next; settled = true; break; }
        bootReads = next;
      }
      assert.ok(settled, 'Source boot reads did not settle');
      assert.equal(bootReads.byCollection.inspectionReportPhotos || 0, 0);
      // Only the connected agency is warmed; at most 200 full reports, no photos.
      assert.equal(bootReads.byCollection.reports, 200 + bootReads.byCollection.sourceConnections - 1); // Other connected agencies are empty.
      await reset();
      const hydrated = (await api('admin', 'GET', '/api/inspections/reports?limit=200')).json.reports;
      assert.equal(hydrated.length, 200); await budget(0, 0);
      const last = hydrated.at(-1);
      await reset();
      const older = (await api('admin', 'GET', `/api/inspections/reports?limit=200&before=${encodeURIComponent(JSON.stringify({ submittedAt: last.submittedAt, id: last.id }))}`)).json.reports;
      assert.equal(older.length, 4); await budget(4, 0);
      await reset();
      const retry = await api('mash', 'POST', '/api/visits/reports', body); assert.equal(retry.status, 200); assert.equal(retry.json.report.id, id); await budget(1, 0);
      await reset();
      const paid = await api('admin', 'POST', '/api/visits/reports', { ...body, clientReportId: 'report-116-fee', marks: [], offList: [] });
      assert.equal(paid.status, 201, JSON.stringify(paid.json)); assert.deepEqual(paid.json.fee, { amount: 82, currency: 'USD' }); await budget(0, 2);
      return 'List/detail/mine/inbox 0R/0W; submit photos 0R/3W; plain 0R/2W; cached retry 0R/0W; uncached retry 1R/0W; Load more 4R/0W for 4 reports; photos 1R then 0R; boot at most 200 report reads per agency (empty query 1), 0 photo reads';
    } finally { await new Promise(r => mock.close(r)); }
  },
};
