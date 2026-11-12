import assert from 'node:assert/strict';
import http from 'node:http';
import { shiftFixture } from './test-101-shifts-crud.mjs';
import { zip, workbookFixture } from '../client/source-upload-fixtures.mjs';
export default {
    name: 'Test 120: other data sources, OAuth, uploads and budgets',
    whatItProves: 'Agency-scoped OAuth and data copies, mapped address and P5 fees, guarded list edits, secret redaction, report isolation and memory browse budgets.',
    async run(baseUrl, ctx) {
        const { api, tokens, people } = await shiftFixture(baseUrl, ctx, '120');
        const sentinel = ['fake-120-key-sentinel', 'fake-120-refresh-sentinel', 'fake-120-access-sentinel', 'fake-client-secret'];
        const columns = ['Name', 'Address', 'Annual Fee', 'Supervision Fee'];
        const rows = { Companies: [columns, ['Golden Grain Bakery', '100 Demo Street', '$1,200', '80']], Ingredients: [['Name', 'Company'], ['Demo Flour', 'Golden Grain Bakery']], Products: [['Name', 'Company'], ['Demo Loaf', 'Golden Grain Bakery']] };
        let calls = 0, writes = 0, created = 0;
        const seen = [];
        const mock = http.createServer(async (req, res) => {
            calls++;
            let text = '';
            for await (const c of req)
                text += c;
            const url = new URL(req.url, 'http://local');
            const path = decodeURIComponent(url.pathname);
            seen.push({ path, method: req.method, text });
            res.setHeader('Content-Type', 'application/json');
            const send = v => res.end(JSON.stringify(v));
            if (path === '/oauth/token')
                return send({ access_token: sentinel[2], refresh_token: sentinel[1], expires_in: 3600 });
            if (path === '/oauth/userinfo')
                return send({ email: 'demo-account120@example.test' });
            if (path === '/drive/v3/files')
                return send({ files: [{ id: 'main', name: 'Demo main' }, { id: 'separate', name: 'Demo separate' }] });
            if (path === '/v4/spreadsheets' && req.method === 'POST') {
                created++;
                return send({ spreadsheetId: 'created', properties: { title: 'Demo new' } });
            }
            if (path.startsWith('/v4/spreadsheets/') && !path.includes('/values/'))
                return send({ sheets: Object.keys(rows).map(title => ({ properties: { title } })) });
            if (path.includes('/values/')) {
                const table = path.split('/values/')[1].split('!')[0].replace(/:append$/, '').replace(/^'|'$/g, '');
                if (req.method === 'GET')
                    return send({ values: rows[table] || [] });
                writes++;
                return send({ updates: { updatedRange: `${table}!A3:D3` } });
            }
            if (path.includes('/search(') || path.endsWith('/sharedWithMe'))
                return send({ value: [{ id: 'main', name: 'Demo workbook.xlsx' }] });
            if (path.endsWith('/content') && req.method === 'PUT') {
                created++;
                return send({ id: 'created', name: 'Demo workbook.xlsx' });
            }
            if (path.endsWith('/worksheets'))
                return send({ value: Object.keys(rows).map(name => ({ name })) });
            if (path.includes('/usedRange'))
                return send({ values: rows[path.split('/worksheets/')[1].split('/')[0]] || [] });
            if (path.includes('/range(')) {
                writes++;
                return send({});
            }
            if (path === '/rest/v1/')
                return send({ definitions: Object.fromEntries(Object.entries(rows).map(([table, data]) => [table, { properties: Object.fromEntries(['id', ...data[0]].map(c => [c, {}])) }])) });
            if (path.startsWith('/rest/v1/')) {
                const table = path.split('/').pop();
                if (req.method === 'GET')
                    return send((rows[table] || []).slice(1).map((r, i) => ({ id: `r${i + 2}`, ...Object.fromEntries(rows[table][0].map((c, j) => [c, r[j]])) })));
                writes++;
                return send([{ id: 'r2', ...Object.fromEntries((rows[table]?.[0] || []).map((c, j) => [c, rows[table][1][j]])), ...JSON.parse(text) }]);
            }
            res.statusCode = 404;
            send({ error: 'Mock route missing' });
        });
        await new Promise(r => mock.listen(0, '127.0.0.1', r));
        const apiBase = `http://127.0.0.1:${mock.address().port}`, table = [];
        const reset = async () => { await api('admin', 'POST', '/api/__test__/reads', { reset: true }); await api('admin', 'POST', '/api/__test__/writes', { reset: true }); };
        const measure = async (label, fn, expectedWrites = 0) => { await reset(); const result = await fn(); const r = (await api('admin', 'POST', '/api/__test__/reads', {})).json, w = (await api('admin', 'POST', '/api/__test__/writes', {})).json; const billedWrites = w.total + (w.deletes || 0); table.push({ action: label, reads: r.total, writes: billedWrites, deletes: w.deletes || 0 }); assert.equal(r.total, 0, `${label} reads ${JSON.stringify(r)}`); if (expectedWrites !== null)
            assert.equal(billedWrites, expectedWrites, `${label} writes ${JSON.stringify(w)}`); return result; };
        const request = async (method, path, body, status = 200, who = 'admin') => { const r = await api(who, method, path, body); assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(r.json)}`); if (!path.endsWith('/picker-token'))
            for (const s of sentinel)
                assert.equal(JSON.stringify(r.json).includes(s), false, `${path} leaked sentinel`); return r.json; };
        const rawUpload = async (name, bytes, type) => { const r = await fetch(`${baseUrl}/api/sources/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': type }, body: bytes }); const json = await r.json(); assert.equal(r.status, 200, JSON.stringify(json)); return json; };
        const signIn = async (p, access) => { const start = await request('POST', `/api/sources/oauth/${p}/start`, { access }), url = new URL(start.url); assert.equal(url.origin, apiBase); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); const callback = `/api/sources/oauth/${p}/callback?state=${url.searchParams.get('state')}&code=fake-code`; const r = await measure(`${p} OAuth callback`, () => fetch(baseUrl + callback, { redirect: 'manual' }), 1); assert.equal(r.status, 302); assert.match(r.headers.get('location'), /signin=ok/); const replay = await fetch(baseUrl + callback, { redirect: 'manual' }); assert.match(replay.headers.get('location'), /signin=failed/); return url; };
        const mapping = { companies: { table: 'Companies', name: 'Name', address: 'Address', companyFee: 'Annual Fee', mashgiachFee: 'Supervision Fee' }, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: 'Products', name: 'Name', companyLink: 'Company' }, group1Values: [] };
        const save = async (p, access = 'read', m = mapping) => measure(`${p} mapping`, () => request('PUT', '/api/sources/connection', { sourceType: p, baseId: p === 'supabase' ? 'https://' + 'a'.repeat(20) + '.supabase.co' : p === 'upload' ? 'upload' : 'main', access, mapping: m, ...(p === 'supabase' ? { apiKey: sentinel[0] } : {}) }), 1);
        const browse = async (p) => { const data = await measure(`${p} browse factories/items`, async () => { const factories = await request('GET', '/api/factories'); const c = factories.companies[0]; assert.equal(c.name, 'Golden Grain Bakery'); assert.equal(c.address, '100 Demo Street'); await request('GET', `/api/factories/${c.id}/items`); return factories; }); return data; };
        try {
            // Hydrate inspection settings once for this freshly injected agency. Source browsing is measured after boot.
            await request('GET', '/api/inspections/fees');
            await request('POST', '/api/__test__/sources-oauth-config', { enabled: false });
            for (const p of ['google_sheets', 'excel', 'supabase'])
                await request('POST', '/api/__test__/sources-api-base', { provider: p, apiBase });
            assert.equal((await request('GET', '/api/sources/providers')).google_sheets.setUp, false);
            const before = calls;
            for (const p of ['google_sheets', 'excel'])
                for (const [method, path, body] of [['POST', `/api/sources/oauth/${p}/start`, { access: 'read' }], ['GET', `/api/sources/oauth/${p}/account`], ['GET', `/api/sources/files?provider=${p}`], ['GET', `/api/sources/tabs?provider=${p}&fileId=main`], ['POST', '/api/sources/create-file', { provider: p }]]) {
                    const r = await request(method, path, body, 409);
                    assert.equal(r.notSetUp, true);
                }
            await request('POST', '/api/sources/oauth/google_sheets/picker-token', {}, 409);
            assert.equal(calls, before);
            await request('POST', '/api/__test__/sources-oauth-config', { enabled: true });
            assert.equal((await request('GET', '/api/sources/providers')).excel.setUp, true);
            await signIn('google_sheets', 'readwrite');
            await measure('providers/files/tabs', async () => { await request('GET', '/api/sources/providers'); await request('GET', '/api/sources/files?provider=google_sheets'); const t = await request('GET', '/api/sources/tabs?provider=google_sheets&fileId=main'); assert.equal(t.tables.length, 3); await request('GET', '/api/sources/oauth/google_sheets/account'); });
            const pick = await request('POST', '/api/sources/oauth/google_sheets/picker-token', {});
            assert.equal(pick.accessToken, sentinel[2]);
            const separate = { ...mapping, ingredients: { ...mapping.ingredients, file: { id: 'separate', name: 'Demo separate' } } };
            await save('google_sheets', 'readwrite', separate);
            await browse('google_sheets');
            assert.ok(seen.some(r => r.path.includes('/separate/values/')));
            await measure('Google rows POST/PATCH', async () => { await request('POST', '/api/sources/rows/companies', { fields: { name: 'Golden Grain Bakery' } }); await request('PATCH', '/api/sources/rows/companies/r2', { fields: { address: '100 Demo Street' } }); });
            assert.equal((await request('POST', '/api/sources/create-file', { provider: 'google_sheets' })).file.id, 'created');
            assert.equal(created, 1);
            await measure('Google access read', () => request('PUT', '/api/sources/access', { access: 'read' }), 1);
            let at = writes;
            await request('POST', '/api/sources/rows/companies', { fields: { name: 'Blocked demo' } }, 403);
            assert.equal(writes, at);
            await signIn('excel', 'read');
            await save('excel');
            await browse('excel');
            const change = await measure('Excel access upgrade', () => request('PUT', '/api/sources/access', { access: 'readwrite' }), 1);
            assert.equal(change.needsSignIn, true);
            await request('POST', '/api/sources/rows/companies', { fields: { name: 'Blocked demo' } }, 403);
            const ms = await signIn('excel', 'readwrite');
            assert.match(ms.searchParams.get('scope'), /Files.ReadWrite.All/);
            await save('excel', 'readwrite');
            await measure('Excel files/tabs', async () => { await request('GET', '/api/sources/files?provider=excel'); assert.equal((await request('GET', '/api/sources/tabs?provider=excel&fileId=main')).tables.length, 3); });
            await measure('Excel row PATCH', () => request('PATCH', '/api/sources/rows/companies/r2', { fields: { name: 'Golden Grain Bakery' } }));
            await request('POST', '/api/sources/create-file', { provider: 'excel' });
            assert.equal(created, 2);
            const badBefore = calls;
            await request('POST', '/api/sources/supabase/test', { url: 'https://example.test', apiKey: sentinel[0] }, 400);
            assert.equal(calls, badBefore);
            assert.equal((await request('POST', '/api/sources/supabase/test', { url: 'https://' + 'a'.repeat(20) + '.supabase.co', apiKey: sentinel[0] })).ok, true);
            await save('supabase', 'readwrite');
            await browse('supabase');
            await measure('Supabase tabs', () => request('GET', '/api/sources/tabs?provider=supabase'));
            await measure('Supabase row POST', () => request('POST', '/api/sources/rows/companies', { fields: { name: 'Golden Grain Bakery' } }));
            // Warm P5's agency-local stores before measuring source actions.
            await request('GET', '/api/inspections/fees');
            const fees = await request('GET', '/api/inspections/fees');
            assert.deepEqual(fees.places.find(p => p.id === 'r2').company, { amount: 1200, per: 'year', source: 'data' });
            const info = await request('GET', '/api/inspections/company-info/r2');
            assert.equal(info.address, '100 Demo Street');
            await request('PUT', '/api/inspections/fees/r2', { company: { amount: 1500, per: 'year' }, mashgiach: { amount: 75 } });
            assert.equal((await request('GET', '/api/inspections/fees')).places.find(p => p.id === 'r2').company.amount, 1500);
            await request('PUT', '/api/inspections/schedule/companies/r2/people', { mashgiachIds: [people.mash.id], coordinatorIds: [] });
            const visit = await request('GET', '/api/visits/factories/r2', undefined, 200, 'mash');
            at = writes;
            const report = await request('POST', '/api/visits/reports', { clientReportId: 'report-120-demo', companyId: 'r2', listVersion: visit.listVersion, startedAt: new Date().toISOString(), marks: [], offList: [] }, 201, 'mash');
            assert.equal(writes, at, 'inspection report must not write source');
            const reportId = report.id || report.report?.id;
            const detail = await request('GET', `/api/inspections/reports/${reportId}`);
            assert.equal(detail.report.feeCheck.reportAmount, 80);
            await measure('disconnect remote', () => request('DELETE', '/api/sources/connection'), 1);
            const csv = 'Name,Address,Annual Fee,Supervision Fee\nGolden Grain Bakery,100 Demo Street,"$1,200",80\n';
            await measure('upload CSV', () => rawUpload('Companies.csv', Buffer.from(csv), 'text/csv'), 2);
            await measure('upload XLSX second file', () => rawUpload('Ingredients.xlsx', zip(workbookFixture()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 2);
            const uploaded = { ...mapping, ingredients: { table: 'Ingredients', name: 'Name', companyLink: 'Company' }, products: { table: '' } };
            await save('upload', 'read', uploaded);
            await browse('upload');
            await measure('upload tabs', () => request('GET', '/api/sources/tabs?provider=upload'));
            await request('PUT', '/api/sources/access', { access: 'readwrite' }, 400);
            await request('POST', '/api/sources/rows/companies', { fields: { name: 'Blocked demo' } }, 409);
            const routes = [['GET', '/api/sources/providers'], ['POST', '/api/sources/oauth/google_sheets/start', { access: 'read' }], ['POST', '/api/sources/oauth/excel/start', { access: 'read' }], ['GET', '/api/sources/oauth/google_sheets/account'], ['GET', '/api/sources/oauth/excel/account'], ['POST', '/api/sources/oauth/google_sheets/picker-token', {}], ['GET', '/api/sources/files?provider=excel'], ['GET', '/api/sources/tabs?provider=upload'], ['POST', '/api/sources/supabase/test', { url: 'https://' + 'a'.repeat(20) + '.supabase.co', apiKey: sentinel[0] }], ['POST', '/api/sources/upload'], ['POST', '/api/sources/upload/reset', {}], ['POST', '/api/sources/create-file', { provider: 'excel' }], ['PUT', '/api/sources/access', { access: 'readwrite' }], ['DELETE', '/api/sources/connection'], ['POST', '/api/sources/rows/companies', { fields: { name: 'Blocked demo' } }], ['PATCH', '/api/sources/rows/companies/r2', { fields: { name: 'Blocked demo' } }]];
            for (const who of ['coord', 'mash'])
                for (const [m, p, b] of routes)
                    await request(m, p, b, 403, who);
            await measure('disconnect upload parts', () => request('DELETE', '/api/sources/connection'), 2);
            assert.equal((await request('GET', '/api/sources/connection')).sourceType, null);
            assert.equal((await request('GET', '/api/sources/oauth/google_sheets/account')).signedIn, false);
            console.table(table);
            return 'OAuth, separate files, three-tab workbook, Supabase, two-file copy, P5 defaults, guarded writes and exact memory-path budgets';
        }
        finally {
            mock.closeAllConnections();
            await new Promise(r => mock.close(r));
            await api('admin', 'POST', '/api/__test__/sources-oauth-config', { enabled: false });
        }
    }
};
