import assert from 'node:assert/strict';
import { createGoogleSheetsApi } from '../../src/server/sources/google-sheets.ts';

const headers = ['ID', 'Fee', 'Company', 'Address', 'Formula'];
const mapping = { companies: { table: 'Companies', pk: 'ID', name: 'Company', address: 'Address', companyFee: 'Fee' },
    ingredients: { table: '' }, products: { table: '' }, group1Values: [] };
const target = { metadataId: 19, table: 'Companies', section: 'companies', spreadsheetId: 'pilot', recordId: 'a', agencyId: 'agency', actorId: 'admin' };
const gridCell = raw => ({ userEnteredValue: typeof raw === 'string' && raw.startsWith('=') ? { formulaValue: raw }
    : typeof raw === 'number' ? { numberValue: raw } : { stringValue: raw } });
function fixture(options = {}) {
    const state = { headers: [...headers], rows: [
        { tag: 19, cells: ['a', 100, 'Original', 'Main', '=1+1'] },
        { tag: 32, cells: ['b', 70, 'Other', 'Second', '=2+2'] },
    ], names: new Map(), reads: 0, writes: 0, audit: [] };
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.includes(':getByDataFilter?')) {
            state.reads++;
            options.beforeRead?.(state);
            assert.deepEqual(body.dataFilters, [{ developerMetadataLookup: { metadataId: 19,
                metadataKey: 'recordId', metadataValue: 'a', locationType: 'ROW' } }, { a1Range: "'Companies'!1:1" }]);
            const response = Response.json({ namedRanges: [...state.names.values()], sheets: [{ properties: { title: 'Companies', sheetId: 7 },
                data: [{ rowData: [{ values: state.headers.map(gridCell) }] }, ...state.rows.flatMap((row,i) => row.tag === 19
                    ? [{ startRow: i+1, rowData: [{ values: row.cells.map(gridCell) }] }] : [])] }] });
            options.afterRead?.(state);
            return response;
        }
        if (url.endsWith(':batchUpdate') && body.requests) {
            for (const r of body.requests) {
                if (r.addNamedRange) {
                    const n = r.addNamedRange.namedRange;
                    assert.equal(n.range.endRowIndex, n.range.startRowIndex + 1);
                    assert.equal(n.range.endColumnIndex, n.range.startColumnIndex + 1);
                    state.names.set(n.namedRangeId, n);
                } else state.names.delete(r.deleteNamedRange.namedRangeId);
            }
            return Response.json({});
        }
        assert.ok(url.endsWith('/values:batchUpdate'));
        const first = state.writes++ === 0;
        if (first) options.beforeWrite?.(state);
        const responses = [];
        for (const { range, values } of body.data) {
            assert.equal(values.length, 1);
            assert.equal(values[0].length, 1);
            const n = [...state.names.values()].find(n => n.name === range);
            if (!n) return Response.json({}, {status:400});
            responses.push({ updatedRange: "'Companies'!" + String.fromCharCode(65 + n.range.startColumnIndex) + (n.range.startRowIndex + 1) });
            state.rows[n.range.startRowIndex - 1].cells[n.range.startColumnIndex] = values[0][0];
        }
        if (first) options.afterWrite?.(state);
        return Response.json({ totalUpdatedCells: body.data.length, responses });
    };
    const api = createGoogleSheetsApi({ spreadsheetId: 'pilot', mapping, fetchImpl });
    const save = (fields = { companyFee: 200 }) => api.updateTaggedRow({ mapping, section: 'companies', idHeader: 'ID',
        fields, links: { resolve: () => [], sourceKey: () => undefined } }, target, async e => state.audit.push(structuredClone(e)));
    return { state, save, fetchImpl };
}
function moveFee(s, other = 2) {
    for (const row of [s.headers, ...s.rows.map(r => r.cells)]) [row[1],row[other]] = [row[other],row[1]];
}
const gate = fixture();
await gate.save({ name: 'Bakery', address: 'Market', companyFee: 200 });
assert.deepEqual(gate.state.rows.map(r => r.cells), [['a',200,'Bakery','Market','=1+1'],['b',70,'Other','Second','=2+2']]);
assert.deepEqual(gate.state.audit.map(e => e.outcome), ['attempted','confirmed']);
assert.equal(gate.state.names.size, 0);
assert.equal(gate.state.writes, 1);

for (const same of [200,'$200.00']) {
    const f = fixture();
    f.state.rows[0].cells[1] = same;
    await assert.rejects(f.save(), /No mapped values changed/);
    assert.equal(f.state.writes, 0);
    assert.deepEqual(f.state.audit.map(e => e.outcome), ['rejected']);
}
const movedNoChange = fixture({ afterRead(s) { if (s.reads === 1) moveFee(s); } });
movedNoChange.state.rows[0].cells[1] = 200;
await assert.rejects(movedNoChange.save(), /No mapped values changed/);
assert.equal(movedNoChange.state.writes,0);
assert.deepEqual(movedNoChange.state.rows[0].cells,['a','Original',200,'Main','=1+1']);
const formula = fixture();
formula.state.rows[0].cells[1] = '=1+1';
await assert.rejects(formula.save(), /Formula/);
assert.equal(formula.state.writes, 0);
const pasted = fixture();
pasted.state.rows[0].cells[0] = 'replacement';
await assert.rejects(pasted.save(), /Refresh and review/);
assert.equal(pasted.state.writes, 0);
const sorted = fixture({ beforeRead(s) { if (s.reads === 2) { s.rows.reverse(); s.rows[1].cells[2] = 'Concurrent'; } } });
await sorted.save();
assert.deepEqual(sorted.state.rows.map(r => r.cells), [['b',70,'Other','Second','=2+2'],['a',200,'Concurrent','Main','=1+1']]);
const replaced = fixture({ beforeRead(s) { if (s.reads === 3) s.rows.splice(0,1,{ tag: 77, cells: ['a',90] }); } });
await assert.rejects(replaced.save(), /Refresh and review/);
assert.equal(replaced.state.writes, 0);
const movedBefore = fixture({ beforeRead(s) { if (s.reads === 2) moveFee(s); } });
await movedBefore.save();
assert.deepEqual(movedBefore.state.rows[0].cells, ['a','Original',200,'Main','=1+1']);

for (const other of [2,4]) {
    const f = fixture({ beforeWrite: s => moveFee(s,other) });
    await assert.rejects(f.save(), /could not be confirmed.*Refresh and review/);
    assert.equal(f.state.writes, 1);
    assert.equal(f.state.rows[0].cells[1], 200);
    assert.equal(f.state.rows[0].cells[other], 100);
    assert.deepEqual(f.state.audit.map(e => e.outcome), ['attempted','unconfirmed']);
    assert.equal(f.state.audit.at(-1).writeEvidence[0].readBack.header, headers[other]);
    assert.equal(f.state.names.size, 0);
}
const follows = fixture({ beforeWrite(s) {
    moveFee(s);
    for (const n of s.names.values()) {
        n.range.startColumnIndex = 2;
        n.range.endColumnIndex = 3;
    }
} });
await assert.rejects(follows.save(), /Refresh and review/);
assert.deepEqual(follows.state.rows[0].cells, ['a','Original',200,'Main','=1+1']);
assert.equal(follows.state.writes,1);
const formulaAfterValidation = fixture({ beforeRead(s) { if (s.reads === 3) s.rows[0].cells[1] = '=9+1'; } });
await assert.rejects(formulaAfterValidation.save(), /Refresh and review/);
assert.equal(formulaAfterValidation.state.writes,0);
const replacedAtDispatch = fixture({ beforeWrite(s) {
    s.rows[0] = { tag:77,cells:['c',90,'Replacement'] };
    s.names.clear(); // Deleting the bound row invalidates its single-cell name.
} });
await assert.rejects(replacedAtDispatch.save(), /Refresh and review/);
assert.equal(replacedAtDispatch.state.rows[0].cells[1],90);
const intervening = fixture({ beforeWrite: s => moveFee(s), beforeRead(s) {
    if (s.reads === 4) s.rows[0].cells[1] = 'Human edit';
} });
await assert.rejects(intervening.save(), /Refresh and review/);
assert.equal(intervening.state.rows[0].cells[1], 'Human edit');
assert.equal(intervening.state.writes, 1);

// A human's edit between the final read and dispatch makes our earlier Company
// snapshot unsafe to restore, even when the misplaced Fee still equals 200.
const stale = fixture({ beforeWrite(s) {
    s.rows[0].cells[2] = 'Updated by human';
    moveFee(s);
} });
await assert.rejects(stale.save(), /could not be confirmed.*Refresh and review/);
assert.equal(stale.state.writes, 1);
assert.equal(stale.state.rows[0].cells[stale.state.headers.indexOf('Company')], 200);
assert.deepEqual(stale.state.audit.map(e => e.outcome), ['attempted','unconfirmed']);
const incident = stale.state.audit.at(-1);
assert.equal(incident.recordId, 'a');
assert.equal(incident.metadataId, 19);
assert.deepEqual(incident.writeEvidence, [{ field:'companyFee', intendedHeader:'Fee', attemptedValue:200,
    receipt:{updatedRange:"'Companies'!B2"}, readBack:{basis:'receipt',header:'Company',rowNumber:2,raw:200} }]);

const mixed = fixture({ afterWrite(s) { s.rows[0].cells[1] = 175; } });
await assert.rejects(mixed.save({ name:'Bakery', address:'Market', companyFee:200 }), /could not be confirmed.*Refresh and review/);
assert.equal(mixed.state.writes, 1);
assert.deepEqual(mixed.state.rows[0].cells, ['a',175,'Bakery','Market','=1+1']);
assert.deepEqual(mixed.state.audit.map(e => e.outcome), ['attempted','unconfirmed']);
assert.equal(mixed.state.audit[0].operationId, mixed.state.audit[1].operationId);
assert.deepEqual(mixed.state.audit[1].writeEvidence.map(e => [e.field,e.attemptedValue,e.readBack.raw]),
    [['name','Bakery','Bakery'],['address','Market','Market'],['companyFee',200,175]]);

for (const mode of ['lost','superseded','wrong-value','identity']) {
    const f = fixture({ afterWrite(s) {
        if (mode === 'identity') s.rows[0].cells[0] = 'replacement';
        if (mode === 'superseded' || mode === 'wrong-value') s.rows[0].cells[1] = 300;
        if (mode === 'lost' || mode === 'superseded') throw Error('lost');
    } });
    if (mode === 'lost') await f.save();
    else await assert.rejects(f.save(), /Refresh and review/);
    assert.equal(f.state.writes, 1);
}
const partial = fixture({ beforeWrite(s) {
    const [a,b] = s.rows;
    [a.cells,b.cells] = [[a.cells[0],...b.cells.slice(1)],[b.cells[0],...a.cells.slice(1)]];
} });
await partial.save();
assert.deepEqual(partial.state.rows[0].cells, ['a',200,'Other','Second','=2+2']);
console.log('Sheets adapter: typed Name, Address and Fee, unchanged values, formulas, sorts, identity changes, forced column moves, read-only failure evidence and lost responses passed. Partial-sort limitation reproduced.');

// Exercise the real OAuth callback, connection, tagging, editor, HTTP PATCH,
// persistent audit and refreshed factory list. Only the Google service is simulated.
const { default: express } = await import('express');
const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { randomUUID } = await import('node:crypto');
const { registerSourceRoutes } = await import('../../src/server/sources/routes.ts');
const { SourceCompanyEditor } = await import('../../src/components/SourceCompanyEditor.tsx');
const { mount } = await import('./lib/mini-render.mjs');
const { state, fetchImpl } = fixture(), app = express(), directory = await mkdtemp(join(tmpdir(),'sheets-edit-'));
app.use(express.json());
const priorFetch = globalThis.fetch, priorDocument = globalThis.document;
const secret = randomUUID();
registerSourceRoutes(app, { dataDir: directory, secret: () => secret, staged: () => false, testMode: false,
    db: () => null, timeZone: () => 'UTC', requireAdmin: (req,res) => {
        if (req.headers['x-test-role'] === 'reader') { res.status(403).json({ error:'Admin required' }); return null; }
        return { id:'admin',agencyId:'agency' };
    } });
const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',() => resolve(s)); });
const local = 'http://127.0.0.1:' + server.address().port;
const previousClient = process.env.GOOGLE_OAUTH_CLIENT_ID, previousSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
try {
    process.env.GOOGLE_OAUTH_CLIENT_ID = randomUUID();
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = randomUUID();
    globalThis.document = { activeElement:null, addEventListener() {}, removeEventListener() {} };
    globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith('/api/')) return priorFetch(local + url, init);
        if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: randomUUID(), refresh_token: randomUUID() });
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ email: 'fixture@example.test' });
        assert.ok(url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/pilot'));
        if (!init.body) return Response.json(url.includes('/values/') ? { values:[state.headers,...state.rows.map(r=>r.cells)] } :
            { sheets:[{properties:{title:'Companies',sheetId:7}}] });
        if (url.endsWith('/developerMetadata:search')) return Response.json({});
        const body = JSON.parse(init.body);
        if (body.requests?.[0]?.createDeveloperMetadata) {
            assert.deepEqual(body.requests.map(r => r.createDeveloperMetadata.developerMetadata.metadataValue), ['a','b']);
            return Response.json({ replies: state.rows.map((r,i) => ({createDeveloperMetadata:{ developerMetadata:{
                ...body.requests[i].createDeveloperMetadata.developerMetadata, metadataId:r.tag }}})) });
        }
        return fetchImpl(url,init);
    };
    async function api(path, method='GET', body) {
        const response = await priorFetch(local+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const data = await response.json();
        assert.equal(response.status,200,JSON.stringify(data));
        return data;
    }
    const start = await api('/api/sources/oauth/google_sheets/start','POST',{access:'readwrite'});
    const stateParam = new URL(start.url).searchParams.get('state');
    const callback = await priorFetch(local+'/api/sources/oauth/google_sheets/callback?code=fixture&state='+stateParam,{redirect:'manual'});
    assert.match(callback.headers.get('location'),/signin=ok/);
    await api('/api/sources/connection','PUT',{ sourceType:'google_sheets', baseId:'pilot', access:'readwrite',mapping });
    const connection = await api('/api/sources/sheets-editing','PUT',{enabled:true});
    assert.equal(connection.sheetsFeeEditing,true);
    const company = (await api('/api/factories')).companies.find(c=>c.name==='Original');
    let saved = false;
    const editor = mount(SourceCompanyEditor, { company, sheetMapping:connection.mapping.companies, source:'Google Sheets',
        onSaved(){saved=true;},onClose(){} });
    await editor.render();
    const inputs = editor.find(e=>e.type==='input');
    assert.equal(inputs.length,3);
    for (const [i,value] of ['New company','New address','300'].entries()) {
        editor.find(e=>e.type==='input')[i].props.onChange({target:{value}});
        await editor.render();
    }
    await editor.submit();
    assert.ok(saved,editor.text());
    assert.deepEqual(state.rows.map(r=>r.cells),[['a',300,'New company','New address','=1+1'],['b',70,'Other','Second','=2+2']]);
    const published = (await api('/api/factories')).companies.find(c=>c.id===company.id);
    assert.deepEqual([published.name,published.address,published.companyFee],['New company','New address',300]);
    const auditDir = join(directory,'source-connections','sourceFeeAudit');
    const entries = await readdir(auditDir);
    assert.equal(entries.length,1);
    const audit = JSON.parse(await readFile(join(auditDir,entries[0]),'utf8'));
    assert.equal(audit.outcome,'confirmed');
    assert.deepEqual(audit.previous,{name:'Original',address:'Main',companyFee:100});
    const endpoint = local + '/api/sources/rows/companies/' + company.id;
    for (const [role, fields, status] of [
        ['reader',{name:'Forbidden'},403], ['admin',{pk:'new-id'},409], ['admin',{Formula:'x'},409],
        ['admin',{companyFee:300},409],
    ]) {
        const res = await priorFetch(endpoint, { method:'PATCH', headers:{'Content-Type':'application/json','x-test-role':role},
            body:JSON.stringify({fields}) });
        assert.equal(res.status,status);
        assert.equal(state.writes,1);
    }
    console.log('Local HTTP flow passed: simulated Google OAuth, connect, enable editing, submit company form, verify sheet cells, audit and refreshed app values.');
} finally {
    globalThis.fetch = priorFetch;
    globalThis.document = priorDocument;
    if (previousClient === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID; else process.env.GOOGLE_OAUTH_CLIENT_ID=previousClient;
    if (previousSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET; else process.env.GOOGLE_OAUTH_CLIENT_SECRET=previousSecret;
    await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
}
