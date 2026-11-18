import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGoogleSheetsConnector, createGoogleSheetsApi } from '../../src/server/sources/google-sheets.ts';
import { createExcelConnector, createExcelApi } from '../../src/server/sources/excel.ts';
import { createSupabaseConnector } from '../../src/server/sources/supabase.ts';
import { sourceFetch } from '../../src/server/sources/http.ts';
const mapping = { companies: { table: 'Companies', name: 'Name' }, ingredients: { table: '' }, products: { table: '' }, group1Values: [] };
const requests = [];
const matrix = [['ID','Name','Formula'],['key','Demo Bakery',42]];
let invalid = '';
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
        return res.end(JSON.stringify({ definitions: { Companies: { properties: { id: {description:'Note: This is a Primary Key.<pk/>'}, Name: {} } } } }));
    if (u.pathname === '/rest/v1/Companies') {
        if (req.method === 'GET') {
            assert.equal(u.searchParams.get('order'), '"id".asc');
            const start = Number(u.searchParams.get('offset'));
            const size = Math.min(100,350-start);
            res.setHeader('Content-Range', start + '-' + (start+size-1) + '/350');
            return res.end(JSON.stringify(Array.from({length:size},(_,i)=>({id:invalid === 'missing' ? null : invalid === 'duplicate' ? 1 : start+i, Name:'Demo '+i}))));
        }
        return res.end(JSON.stringify([{ id: 'new', Name: 'Edited demo' }]));
    }
    if (u.pathname.includes('/drive/v3/files'))
        return res.end(JSON.stringify({ files: [{ id: 'g1', name: 'Demo sheets' }] }));
    if (u.pathname.includes('/v4/spreadsheets/') && !u.pathname.includes('/values/'))
        return res.end(JSON.stringify({ sheets: [{ properties: { title: 'Companies' } },{properties:{title:'Notes'}}] }));
    if (u.pathname.includes('/values/'))
        return res.end(JSON.stringify(req.method === 'GET' ? { values: u.pathname.includes('Notes') ? [['Memo'],['Reminder']] : matrix, rowIndex:3, columnIndex:2 } : { updates: { updatedRange: 'Companies!D5' } }));
    if (u.pathname.endsWith('/worksheets'))
        return res.end(JSON.stringify({ value: [{ name: 'Companies' },{name:'Notes'}] }));
    if (u.pathname.includes('/usedRange'))
        return res.end(JSON.stringify({ values: u.pathname.includes('Notes') ? [['Memo'],['Reminder']] : matrix, rowIndex:3, columnIndex:2 }));
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
    const googleId = (await g.readRows('Companies'))[0].id;
    matrix.splice(1,0,['inserted','Other',true]);
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
    assert.deepEqual((await e.listTables())[0].columns, matrix[0]);
    const excelId = (await e.readRows('Companies'))[1].id;
    assert.notEqual(googleId,excelId);
    matrix.reverse(); matrix.unshift(matrix.pop());
    for (const adapter of [g,e]) {
        assert.equal(adapter.writeRow,undefined);
        assert.equal((await adapter.samples(await adapter.listTables())).Notes[0].fields.Memo,'Reminder');
        assert.ok((await adapter.loadAll()).companies.some(c => c.name === 'Demo Bakery'));
        await assert.rejects(adapter.readRows('Notes'),/ID column/);
    }
    assert.equal((await createExcelApi({ mapping, apiBase, workbookId: 'e1', accessToken: 'fake' }).files()).length, 1);
    const { keyRows, matrixRows } = await import('../../src/server/sources/tabular.ts');
    const keys = matrix => {const {rows,columns}=matrixRows(matrix);return keyRows(rows,columns,['excel','book','companies']);};
    assert.throws(()=>keys([['Name'],['Same']]),/ID column/);
    const initial = keys([['ID','Name'],['a','Same']])[0];
    const renamed = keys([['ID','Name'],['b','Same'],['a','New name']]);
    assert.equal(renamed[1].id,initial.id);
    assert.notEqual(renamed[0].id,initial.id);
    const s = createSupabaseConnector({ mapping, apiBase, url: 'https://' + 'a'.repeat(20) + '.supabase.co', apiKey: 'fake' });
    assert.deepEqual((await s.listTables())[0], { name: 'Companies', columns: ['id', 'Name'] });
    const records = await s.readRows('Companies');
    assert.equal(records.length,350);
    const second = createSupabaseConnector({mapping, apiBase, url:'https://'+'b'.repeat(20)+'.supabase.co'});
    assert.notEqual((await second.readRows('Companies'))[1].id,records[1].id);
    await assert.rejects(second.writeRow('Companies',{id:records[1].id,fields:{Name:'Stale'}}),/does not belong/);
    await s.writeRow('Companies', { fields: { Name: 'New demo' } });
    await s.writeRow('Companies', { id: records[1].id, fields: { Name: 'Edited demo' } });
    for (invalid of ['missing','duplicate']) await assert.rejects(s.readRows('Companies'), /record key/);
    assert.ok(requests.some(r => r.method === 'PATCH' && r.query === '?id=eq.1'));
    await assert.rejects(() => sourceFetch(apiBase + '/slow', {}, fetch, 20), /request failed/);
    assert.throws(() => createSupabaseConnector({ mapping, url: 'http://localhost', apiKey: 'fake' }), /Invalid Supabase URL/);
    console.log('Google, Excel and Supabase metadata, reads, writes, paging, refresh-once and timeout passed');
}
finally {
    mock.closeAllConnections();
    await new Promise(r => mock.close(r));
}
