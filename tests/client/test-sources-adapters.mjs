import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGoogleSheetsConnector, createGoogleSheetsApi } from '../../src/server/sources/google-sheets.ts';
import { createExcelConnector, createExcelApi } from '../../src/server/sources/excel.ts';
import { createSupabaseConnector } from '../../src/server/sources/supabase.ts';
import { sourceFetch } from '../../src/server/sources/http.ts';
const mapping = { companies: { table: 'Companies', name: 'Name' }, ingredients: { table: '' }, products: { table: '' }, group1Values: [] };
const requests = [];
let fail401 = true, refreshes = 0;
const mock = createServer(async (req, res) => {
    let body = '';
    for await (const c of req)
        body += c;
    const u = new URL(req.url, 'http://local');
    requests.push({ path: u.pathname, query: u.search, method: req.method, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/slow') {
        res.writeHead(200);
        res.write('{');
        return setTimeout(() => res.end('}'), 100);
    }
    if (req.headers.authorization === 'Bearer old' && fail401) {
        fail401 = false;
        res.statusCode = 401;
        return res.end('{}');
    }
    if (u.pathname === '/rest/v1/')
        return res.end(JSON.stringify({ definitions: { Companies: { properties: { id: {}, Name: {} } } } }));
    if (u.pathname === '/rest/v1/Companies') {
        if (req.method === 'GET') {
            const start = Number(req.headers.range?.split('-')[0] || 0);
            return res.end(JSON.stringify(start === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: String(i), Name: 'Demo ' + i })) : [{ id: '1000', Name: 'Last demo' }]));
        }
        return res.end(JSON.stringify([{ id: 'new', Name: 'Edited demo' }]));
    }
    if (u.pathname.includes('/drive/v3/files'))
        return res.end(JSON.stringify({ files: [{ id: 'g1', name: 'Demo sheets' }] }));
    if (u.pathname.includes('/v4/spreadsheets/') && !u.pathname.includes('/values/'))
        return res.end(JSON.stringify({ sheets: [{ properties: { title: 'Companies' } }] }));
    if (u.pathname.includes('/values/'))
        return res.end(JSON.stringify(req.method === 'GET' ? { values: [['Name'], ['Demo Bakery']] } : { updates: { updatedRange: 'Companies!A3:A3' } }));
    if (u.pathname.endsWith('/worksheets'))
        return res.end(JSON.stringify({ value: [{ name: 'Companies' }] }));
    if (u.pathname.includes('/usedRange'))
        return res.end(JSON.stringify({ values: [['Name'], ['Demo Bakery']] }));
    if (u.pathname.includes('/range('))
        return res.end('{}');
    if (u.pathname.includes('/search(') || u.pathname.endsWith('/sharedWithMe'))
        return res.end(JSON.stringify({ value: [{ id: 'e1', name: 'Demo.xlsx' }] }));
    res.statusCode = 404;
    res.end('{}');
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${mock.address().port}`;
try {
    const config = { mapping, apiBase, spreadsheetId: 'g1', token: async (force) => { if (force) {
            refreshes++;
            return 'fresh';
        } return fail401 ? 'old' : 'fresh'; } };
    const g = createGoogleSheetsConnector(config);
    assert.equal((await g.listTables())[0].name, 'Companies');
    assert.equal(refreshes, 1);
    assert.equal((await g.readRows('Companies'))[0].fields.Name, 'Demo Bakery');
    await g.writeRow('Companies', { fields: { Name: 'New demo' } });
    await g.writeRow('Companies', { id: 'r2', fields: { Name: 'Edited demo' } });
    assert.equal((await createGoogleSheetsApi(config).files())[0].id, 'g1');
    fail401 = true;
    let msRefresh = 0;
    const ms = createExcelConnector({ mapping, apiBase, workbookId: 'e1', token: async (force) => { if (force) {
            msRefresh++;
            return 'fresh';
        } return fail401 ? 'old' : 'fresh'; } });
    await ms.listTables();
    assert.equal(msRefresh, 1);
    const e = createExcelConnector({ mapping, apiBase, workbookId: 'e1', accessToken: 'fake' });
    assert.deepEqual((await e.listTables())[0].columns, ['Name']);
    assert.equal((await e.readRows('Companies'))[0].id, 'r2');
    await e.writeRow('Companies', { fields: { Name: 'New demo' } });
    await e.writeRow('Companies', { id: 'r2', fields: { Name: 'Edited demo' } });
    assert.equal((await createExcelApi({ mapping, apiBase, workbookId: 'e1', accessToken: 'fake' }).files()).length, 1);
    const s = createSupabaseConnector({ mapping, apiBase, url: 'https://' + 'a'.repeat(20) + '.supabase.co', apiKey: 'fake' });
    assert.deepEqual((await s.listTables())[0], { name: 'Companies', columns: ['id', 'Name'] });
    assert.equal((await s.readRows('Companies')).length, 1001);
    await s.writeRow('Companies', { fields: { Name: 'New demo' } });
    await s.writeRow('Companies', { id: 'new', fields: { Name: 'Edited demo' } });
    assert.ok(requests.some(r => r.headers.range === '1000-1999'));
    assert.ok(requests.some(r => r.method === 'PATCH' && r.query === '?id=eq.new'));
    assert.ok(requests.filter(r => r.path.includes('/values/') && r.method !== 'GET').every(r => r.query.includes('valueInputOption=RAW')));
    assert.ok(requests.some(r => r.path.includes("range(address='A3:A3')") || decodeURIComponent(r.path).includes("range(address='A3:A3')")));
    await assert.rejects(() => sourceFetch(apiBase + '/slow', {}, fetch, 20), /request failed/);
    assert.throws(() => createSupabaseConnector({ mapping, url: 'http://localhost', apiKey: 'fake' }), /Invalid Supabase URL/);
    console.log('Google, Excel and Supabase metadata, reads, writes, paging, refresh-once and timeout passed');
}
finally {
    mock.closeAllConnections();
    await new Promise(r => mock.close(r));
}
