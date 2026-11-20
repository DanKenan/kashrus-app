import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { createGoogleSheetsApi } from '../../src/server/sources/google-sheets.ts';

const headers = ['ID', 'Fee', 'Company', 'Address', 'Formula'];
const mapping = { companies: { table: 'Companies', pk: 'ID', name: 'Company', address: 'Address', companyFee: 'Fee' },
    ingredients: { table: '' }, products: { table: '' }, group1Values: [] };
const target = { metadataId: 19, table: 'Companies', section: 'companies', spreadsheetId: 'pilot', recordId: 'a', agencyId: 'agency', actorId: 'admin' };
const gridCell = (raw, { formula = false, date = false } = {}) => ({
    ...(raw === null ? {} : { userEnteredValue: formula ? { formulaValue: raw }
        : typeof raw === 'boolean' ? { boolValue: raw } : typeof raw === 'number' ? { numberValue: raw } : { stringValue: raw } }),
    ...(date && { effectiveFormat: { numberFormat: { type: 'DATE' } } }),
});
const quoteTab = title => "'" + title.replaceAll("'", "''") + "'";
function fixture(options = {}) {
    const title = options.title || 'Companies';
    const state = { headers: options.headers || [...headers], rows: options.rows || [
        { tag: 19, cells: ['a', 100, 'Original', 'Main', '=1+1'] },
        { tag: 32, cells: ['b', 70, 'Other', 'Second', '=2+2'] },
    ], sheetId: options.sheetId ?? 7, names: new Map(), creationRequests: [], reads: 0, writes: 0, audit: [] };
    const formulas = options.formulas ?? new Set(['Formula']);
    const dates = options.dates ?? new Set();
    const tracked = options.tracked || new Map([[19, 'a']]);
    const returnedName = ({ namedRangeId, name, range }) => ({ namedRangeId, name,
        range: options.returnedRange ? options.returnedRange(range) : range });
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.includes(':getByDataFilter?')) {
            state.reads++;
            options.beforeRead?.(state);
            const tag = body.dataFilters[0].developerMetadataLookup.metadataId;
            assert.deepEqual(body.dataFilters, [{ developerMetadataLookup: { metadataId: tag,
                metadataKey: 'recordId', metadataValue: tracked.get(tag) ?? state.rows.find(row => row.tag === tag)?.cells[0], locationType: 'ROW' } }, { a1Range: quoteTab(title) + '!1:1' }]);
            const response = Response.json({ namedRanges: [...state.names.values()].map(returnedName),
                sheets: [{ properties: { title, sheetId: state.sheetId },
                data: [{ rowData: [{ values: state.headers.map(raw => gridCell(raw)) }] }, ...state.rows.flatMap((row,i) => row.tag === tag
                    ? [{ startRow: i+1, rowData: [{ values: row.cells.map((raw, col) => gridCell(raw, {
                        formula: row.formulaCols?.includes(col) || (formulas.has(state.headers[col]) && String(raw).startsWith('=')) ||
                            (!options.title && String(raw).startsWith('=') && state.headers[col] === 'Fee'),
                        date: dates.has(state.headers[col]),
                    })) }] }] : [])] }] });
            options.afterRead?.(state);
            return response;
        }
        if (url.endsWith(':batchUpdate') && body.requests) {
            const replies = [];
            for (const r of body.requests) {
                if (r.addNamedRange) {
                    const n = r.addNamedRange.namedRange;
                    assert.equal(n.range.endRowIndex, n.range.startRowIndex + 1);
                    assert.equal(n.range.endColumnIndex, n.range.startColumnIndex + 1);
                    state.names.set(n.namedRangeId, n);
                    state.creationRequests.push(structuredClone(n.range));
                    replies.push({ addNamedRange: { namedRange: returnedName(n) } });
                } else state.names.delete(r.deleteNamedRange.namedRangeId);
            }
            return Response.json({ replies });
        }
        assert.ok(url.endsWith('/values:batchUpdate'));
        assert.equal(body.valueInputOption, 'RAW');
        const first = state.writes++ === 0;
        if (first) options.beforeWrite?.(state);
        const responses = [];
        for (const { range, values } of body.data) {
            assert.equal(values.length, 1);
            assert.equal(values[0].length, 1);
            const n = [...state.names.values()].find(n => n.name === range);
            if (!n) return Response.json({}, {status:400});
            responses.push({ updatedRange: quoteTab(title) + '!' + String.fromCharCode(65 + n.range.startColumnIndex) + (n.range.startRowIndex + 1) });
            state.rows[n.range.startRowIndex - 1].cells[n.range.startColumnIndex] = values[0][0];
        }
        if (first) options.afterWrite?.(state);
        return Response.json({ totalUpdatedCells: body.data.length, responses });
    };
    const api = createGoogleSheetsApi({ spreadsheetId: 'pilot', mapping, fetchImpl });
    const save = (fields = { companyFee: 200 }) => api.updateTaggedRow({ mapping, section: 'companies', idHeader: 'ID',
        fields, links: { resolve: () => [], sourceKey: () => undefined } }, target, async e => state.audit.push(structuredClone(e)));
    return { state, save, fetchImpl, dates };
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
await assert.rejects(movedBefore.save(), /Refresh and review/);
assert.equal(movedBefore.state.writes, 0);
assert.deepEqual(movedBefore.state.rows[0].cells, ['a','Original',100,'Main','=1+1']);

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
const { createSourceStore } = await import('../../src/server/sources/store.ts');
const { SourceCompanyEditor } = await import('../../src/components/SourceCompanyEditor.tsx');
const { SheetRecordEditor } = await import('../../src/components/SheetRecordEditor.tsx');
const { mount } = await import('./lib/mini-render.mjs');
let responseRange, blockedAddError;
const { state, fetchImpl } = fixture({ returnedRange: range => responseRange ? { ...responseRange } : range });
const files = new Map([['pilot', { state, fetchImpl, title: 'Companies' }]]);
const app = express(), directory = await mkdtemp(join(tmpdir(),'sheets-edit-'));
app.use(express.json());
const priorFetch = globalThis.fetch, priorDocument = globalThis.document;
const secret = randomUUID();
const routeDeps = { dataDir: directory, secret: () => secret, staged: () => false, testMode: false,
    db: () => null, timeZone: () => 'UTC', requireAdmin: (req,res) => {
        if (req.headers['x-test-role'] === 'reader') { res.status(403).json({ error:'Admin required' }); return null; }
        return { id:'admin',agencyId:req.headers['x-test-agency'] || 'agency' };
    } };
const { inspectionSource } = registerSourceRoutes(app, routeDeps);
const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',() => resolve(s)); });
const local = 'http://127.0.0.1:' + server.address().port;
const previousClient = process.env.GOOGLE_OAUTH_CLIENT_ID, previousSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
try {
    process.env.GOOGLE_OAUTH_CLIENT_ID = randomUUID();
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = randomUUID();
    globalThis.document = { activeElement:null, addEventListener() {}, removeEventListener() {} };
    let googleWrites = 0, addBatches = 0, addFailure, holdLayout, afterLayout, holdBatch;
    let nextTag = 1000;
    function rowTag(tab, row, index) {
        return { metadataId:row.tag, metadataKey:'recordId', metadataValue:row.tagValue ?? row.cells[0],
            visibility:'DOCUMENT', location:{ dimensionRange:{ sheetId:tab.sheetId, dimension:'ROWS', startIndex:index+1, endIndex:index+2 } } };
    }
    function displayedValue(file, raw, col) {
        if (typeof raw !== 'number' || !file.dates?.has(file.state.headers[col])) return raw;
        const [year, month, day] = new Date(Date.UTC(1899,11,30) + raw * 86400000).toISOString().slice(0,10).split('-');
        return [day,month,year].join('/');
    }
    globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith('/api/')) return priorFetch(local + url, init);
        if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: randomUUID(), refresh_token: randomUUID() });
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ email: 'fixture@example.test' });
        const [, fileId] = /^https:\/\/sheets.googleapis.com\/v4\/spreadsheets\/([^/:?]+)/.exec(url) || [];
        const file = files.get(fileId);
        assert.ok(file, 'unexpected spreadsheet: ' + url);
        const { state: tab, title } = file;
        const query = new URL(url).searchParams;
        if (!init.body) {
            if (url.includes('/values/')) {
                assert.equal(decodeURIComponent(new URL(url).pathname.split('/values/')[1]), quoteTab(title));
                const unformatted = query.get('valueRenderOption') === 'UNFORMATTED_VALUE';
                return Response.json({ values:[tab.headers,...tab.rows.map(r => r.cells.map((raw, col) =>
                    unformatted ? raw : displayedValue(file,raw,col)))] });
            }
            const props = { properties:{title,sheetId:tab.sheetId} };
            if (!query.has('ranges')) return Response.json({ sheets:[props] });
            assert.equal(query.get('ranges'),quoteTab(title));
            const mask = query.get('fields');
            assert.equal([...mask].filter(char => char === '(').length,[...mask].filter(char => char === ')').length);
            assert.match(mask,/formattedValue,effectiveValue/);
            assert.match(mask,/rowMetadata\(developerMetadata\(metadataKey,metadataValue\)\)/);
            if (file.dates?.size) assert.match(mask,/effectiveFormat\(numberFormat\(type\)\)/);
            const rowData = [{ values:tab.headers.map(raw => ({ formattedValue:raw, effectiveValue:{stringValue:raw} })) },
                ...tab.rows.map(row => ({ values:row.cells.map((raw, col) => {
                    const date = typeof raw === 'number' && file.dates?.has(tab.headers[col]);
                    const { userEnteredValue } = gridCell(raw);
                    return { formattedValue:displayedValue(file,raw,col),
                        effectiveValue:userEnteredValue, ...(date && {effectiveFormat:{numberFormat:{type:'DATE'}}}) };
                }) }))];
            const rowMetadata = [{}, ...tab.rows.map((row, index) =>
                row.tag ? { developerMetadata:[rowTag(tab, row, index)] } : {})];
            return Response.json({ sheets:[{ ...props, data:[{rowData,rowMetadata}] }] });
        }
        if (url.endsWith(':batchUpdate') || url.endsWith('/values:batchUpdate')) googleWrites++;
        const body = JSON.parse(init.body);
        if (url.includes(':getByDataFilter?') && body.dataFilters.length === 1) {
            assert.deepEqual(body.dataFilters, [{ a1Range:quoteTab(title) + '!1:1' }]);
            if (holdLayout) {
                const hold = holdLayout;
                holdLayout = undefined;
                await hold();
            }
            const response = Response.json({ sheets:[{ properties:{ title, ...(tab.sheetId && { sheetId:tab.sheetId }),
                sheetType:'GRID', gridProperties:{ rowCount:1000 } },
                data:[{ rowData:[{ values:tab.headers.map(raw => gridCell(raw)) }] }] }] });
            if (afterLayout) {
                const change = afterLayout;
                afterLayout = undefined;
                change();
            }
            return response;
        }
        if (url.endsWith('/developerMetadata:search')) {
            const key = body.dataFilters[0].developerMetadataLookup.metadataValue;
            return Response.json({ matchedDeveloperMetadata: key ? tab.rows.flatMap((row,index) =>
                row.tag && (row.tagValue ?? row.cells[0]) === key ? [{ developerMetadata:rowTag(tab,row,index) }] : []) : [] });
        }
        if (body.requests?.[0]?.insertDimension) {
            addBatches++;
            const [insert, write, create] = body.requests;
            assert.equal(body.requests.length,3);
            const range = { sheetId:tab.sheetId, dimension:'ROWS', startIndex:1, endIndex:2 };
            assert.deepEqual(insert.insertDimension, { range, inheritFromBefore:false });
            assert.deepEqual(write.updateCells.start, { sheetId:tab.sheetId, rowIndex:1, columnIndex:0 });
            assert.equal(write.updateCells.fields,'userEnteredValue');
            const cells = write.updateCells.rows[0].values.map(({ userEnteredValue:v }) =>
                v?.stringValue ?? v?.boolValue ?? v?.numberValue ?? null);
            const tag = create.createDeveloperMetadata.developerMetadata;
            assert.deepEqual(tag, { metadataKey:'recordId', metadataValue:cells[0], visibility:'DOCUMENT',
                location:{ dimensionRange:range } });
            const failure = addFailure;
            addFailure = undefined;
            if (holdBatch) {
                const hold = holdBatch;
                holdBatch = undefined;
                await hold();
            }
            if (failure === 'rejected') return Response.json({}, { status:400 });
            if (failure === 'timeout') return Response.json({}, { status:408 });
            const inserted = { tag:nextTag++, tagValue:tag.metadataValue, cells };
            tab.rows.unshift(inserted);
            if (failure === 'lost') throw Error('Lost response after committing');
            if (failure === 'missing-receipt') return Response.json({ replies:[{},{},{}] });
            if (failure === 'changed-value') inserted.cells[1] += ' changed';
            return Response.json({ replies:[{},{},{ createDeveloperMetadata:{ developerMetadata:rowTag(tab,inserted,0) } }] });
        }
        if (body.requests?.[0]?.createDeveloperMetadata) {
            assert.deepEqual(body.requests.map(r => r.createDeveloperMetadata.developerMetadata.metadataValue), tab.rows.map(r => r.cells[0]));
            return Response.json({ replies: tab.rows.map((r,i) => ({createDeveloperMetadata:{ developerMetadata:{
                ...body.requests[i].createDeveloperMetadata.developerMetadata, metadataId:r.tag }}})) });
        }
        return file.fetchImpl(url,init);
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
    const rowPath = '/api/sources/rows/companies/' + company.id;
    const endpoint = local + rowPath;
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

    moveFee(state, 3);
    state.rows[0].cells[3] = 100;
    const before = state.rows.map(r => [...r.cells]);
    const expected = structuredClone(before);
    expected[0][3] = 999;
    const d2 = { startRowIndex: 1, endRowIndex: 2, startColumnIndex: 3, endColumnIndex: 4 };
    state.sheetId = 0;
    responseRange = d2;
    const { reads, writes } = state;
    state.creationRequests.length = 0;
    const result = await api(rowPath, 'PATCH', { fields: { companyFee: 999 } });
    assert.deepEqual(state.creationRequests, [{ sheetId: 0, ...d2 }]);
    assert.equal(state.writes, writes + 1);
    assert.deepEqual(state.rows.map(r => r.cells), expected);
    assert.equal(state.reads, reads + 4); // Initial snapshot, validation, fresh binding, and post-write readback.
    assert.equal(result.saved, true);
    const savedAudits = await Promise.all((await readdir(auditDir)).map(async file =>
        JSON.parse(await readFile(join(auditDir, file), 'utf8'))));
    const feeAudit = savedAudits.find(entry => entry.requested.companyFee === 999);
    assert.equal(feeAudit?.outcome, 'confirmed');
    assert.equal(feeAudit.verified, true);
    assert.deepEqual(feeAudit.previous, { companyFee: 100 });

    for (const [label, sheetId, grid] of [
        ['different sheet ID', 0, { ...d2, sheetId: 7 }],
        ['null sheet ID', 0, { ...d2, sheetId: null }],
        ['wrong row', 0, { ...d2, startRowIndex: 2, endRowIndex: 3 }],
        ['wrong column', 0, { ...d2, startColumnIndex: 2, endColumnIndex: 3 }],
        ['omitted sheet ID for a nonzero tab', 7, d2],
    ]) {
        state.sheetId = sheetId;
        responseRange = grid;
        const beforeWrites = state.writes;
        state.creationRequests.length = 0;
        const res = await priorFetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { companyFee: 100 } }) });
        assert.equal(res.status, 409, label);
        assert.match((await res.json()).error, /The sheet rejected the change/, label);
        assert.deepEqual(state.creationRequests, [{ sheetId, ...d2 }], label);
        assert.equal(state.writes, beforeWrites, label);
        assert.deepEqual(state.rows.map(r => r.cells), expected, label);
    }
    console.log('Sheets range regression passed: omitted tab zero writes only D2, and mismatched coordinates return HTTP 409 before dispatch.');

    const phaseB = {
        companies: { table: 'Clients', file: { id: 'clients', name: 'Clients' }, pk: 'ID', name: 'Name',
            address: 'Address', type: 'Type', brand: 'Brand', plant: 'Plant', companyFee: 'Annual',
            mashgiachFee: 'Supervision', Notes: 'Notes', factoryValues: ['Factory'], foodServiceValues: ['Kitchen'] },
        ingredients: { table: "Schedule A's items", file: { id: 'schedule-a', name: 'A' }, pk: 'ID', name: 'Name',
            companyLink: 'Companies', brand: 'Brand', certification: 'Cert', agency: 'Agency', status: 'Status',
            plant: 'Plant', expiresOn: 'Expiry', Deposit: 'Deposit', Label: 'Formula' },
        products: { table: 'Schedule B', file: { id: 'schedule-b', name: 'B' }, pk: 'ID', name: 'Name',
            companyLink: 'Companies', brand: 'Brand', certification: 'Cert', agency: 'Agency', status: 'Status',
            plant: 'Plant', symbolRequired: 'Symbol', code: 'UPC', 'Approved on': 'Approval date', Verified: 'Verified',
            'Other companies': 'Other companies', Private: 'Private' },
        group1Values: [],
        editableCustomFields: { companies: { Notes: 'text' }, ingredients: { Deposit: 'money', Label: 'text' },
            products: { 'Approved on': 'date', Verified: 'boolean', 'Other companies': 'companyLink' } },
    };
    const companiesTab = fixture({ title: 'Clients', sheetId: 0, tracked: new Map([[19,'x'],[32,'y'],[48,'z']]),
        headers: ['ID','Name','Address','Type','Brand','Plant','Annual','Supervision','Notes','Unmapped'],
        rows: [
            { tag:19, cells:['x','Company X','Old road','Factory','Old brand','Old plant',100,20,'Original','Keep'] },
            { tag:32, cells:['y','Company Y','','Factory'] },
            { tag:48, cells:['z','Company Z','','Other'] },
        ] });
    let disrupt = false;
    const ingredientsTab = fixture({ title: phaseB.ingredients.table, sheetId: 2, tracked: new Map([[42,'i'],[43,'j']]),
        headers: ['ID','Name','Companies','Brand','Cert','Agency','Status','Plant','Expiry','Deposit','Formula','Other'],
        dates: new Set(['Expiry']),
        rows: [
            { tag:42, cells:['i','Flour','Company X','Old brand','OU-P','OU','pareve','Old plant',45400,100,'=1+1','Keep'] },
            { tag:43, cells:['j','Salt','y','','OU-P','','','','2028-06-07',0,'=2+2','Keep'] },
        ],
        beforeRead(tab) {
            if (disrupt && tab.reads === disrupt) tab.rows[1].cells[4] = 'Unexpected';
        },
    });
    const productsTab = fixture({ title: 'Schedule B', sheetId: 5, tracked: new Map([[42,'p']]),
        headers: ['ID','Name','Companies','Brand','Cert','Agency','Status','Plant','Symbol','UPC','Approval date','Verified','Other companies','Private'],
        rows: [{ tag:42, cells:['p','Cereal','x','Old brand','OK-D','OK','Dairy','Old plant','No','0099','2025-01-01',false,'y','Keep'] }],
    });
    for (const [section, tab] of [['companies',companiesTab],['ingredients',ingredientsTab],['products',productsTab]]) {
        files.set(phaseB[section].file.id, { ...tab, title: phaseB[section].table });
    }
    await api('/api/sources/connection','PUT',{ sourceType:'google_sheets', baseId:'clients', access:'readwrite',mapping:phaseB });
    const expanded = await api('/api/sources/sheets-editing','PUT',{enabled:true});
    assert.deepEqual(expanded.sheetsEditSections, ['companies','ingredients','products']);
    const list = async section => (await api('/api/sources/sheet-editor/' + section)).rows;
    const [companyX, companyY, companyZ] = await list('companies');
    const [ingredient] = await list('ingredients');
    const [product] = await list('products');
    const editPath = (section, row) => '/api/sources/sheet-editor/' + section + '/' + row.id;
    const writePath = (section, row) => '/api/sources/rows/' + section + '/' + row.id;
    const readEditor = (section, row) => api(editPath(section,row));
    async function patch(section, row, fields, { editor, status = 200, headers = {} } = {}) {
        const prior = editor ?? await readEditor(section,row);
        const expected = Object.fromEntries(prior.fields.filter(field => Object.hasOwn(fields, field.field)).map(field => [field.field,field.revision]));
        const response = await priorFetch(local + writePath(section,row), { method:'PATCH',
            headers: { 'Content-Type':'application/json', ...headers }, body:JSON.stringify({fields,expected}) });
        const data = await response.json();
        const allowed = Array.isArray(status) ? status : [status];
        assert.ok(allowed.includes(response.status),JSON.stringify({ status:response.status, data }));
        return data;
    }
    const companyEditor = await readEditor('companies',companyX);
    assert.deepEqual(companyEditor.fields.find(f => f.field === 'type').choices,['Factory','Kitchen']);
    const companyBefore = structuredClone(companiesTab.state.rows[0].cells);
    const factoryBefore = await api('/api/factories/' + companyX.id + '/items');
    assert.equal(factoryBefore.ingredients[0].expiresOn,'2024-04-18');
    const writesBeforeTypo = googleWrites;
    assert.match((await patch('companies',companyX,{type:'Facotry'},{editor:companyEditor,status:400})).error,/configured values/);
    assert.equal(googleWrites,writesBeforeTypo);
    assert.deepEqual(companiesTab.state.rows[0].cells,companyBefore);
    assert.deepEqual(await api('/api/factories/' + companyX.id + '/items'),factoryBefore);
    assert.ok((await api('/api/factories')).companies.some(row => row.id === companyX.id));
    assert.match((await patch('companies', companyX, { name:'Renamed X' }, { editor:companyEditor, status:409 })).error, /would leave company links/);
    assert.equal(companiesTab.state.writes,0);
    const ingredientEditor = await readEditor('ingredients',ingredient);
    assert.equal(ingredientEditor.fields.find(f => f.field === 'expiresOn').value, '2024-04-18');
    assert.deepEqual(ingredientEditor.fields.find(f => f.field === 'companyLink').value,[companyX.id]);
    assert.match(ingredientEditor.fields.find(f => f.field === 'Label').readOnly,/Formula/);
    for (const [fields, status, phrase] of [
        [{ id:'changed' },409,/mapped editable/], [{ dpm:'meat' },409,/mapped editable/],
        [{ Label:'changed' },409,/Formula/], [{ companyLink:['missing'] },409,/Unknown company ID/],
    ]) assert.match((await patch('ingredients',ingredient,fields,{ editor:ingredientEditor,status })).error,phrase);
    await patch('ingredients',ingredient,{ certification:'Refused' },{ editor:ingredientEditor,status:403,headers:{'x-test-role':'reader'} });
    await patch('ingredients',ingredient,{ certification:'Refused' },{ editor:ingredientEditor,status:409,headers:{'x-test-agency':'other-agency'} });
    const privateRead = await priorFetch(local + editPath('ingredients',ingredient),{ headers:{'x-test-agency':'other-agency'} });
    assert.equal(privateRead.status,403);
    assert.equal(ingredientsTab.state.writes,0);
    const missingRevision = await priorFetch(local + writePath('ingredients',ingredient), {
        method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fields:{certification:'Stale'}}),
    });
    assert.equal(missingRevision.status,409);
    companiesTab.state.rows.push({ tag:80, cells:['alias','z, y, x','','Other'] });
    assert.match((await patch('ingredients',ingredient,{ companyLink:[companyZ.id,companyY.id,companyX.id] },
        { editor:ingredientEditor,status:409 })).error,/Ambiguous company links/);
    companiesTab.state.rows.pop();
    assert.equal(ingredientsTab.state.writes,0);
    ingredientsTab.state.rows.reverse();
    ingredientsTab.state.rows.unshift({ tag:99, cells:['new','Inserted'] });
    const editIngredient = { name:'Wheat flour', brand:'=Raw brand', companyLink:[companyZ.id,companyY.id,companyX.id],
        certification:'  OK-D  ', agency:'Star K', status:'Dairy equipment', plant:'North', expiresOn:'2028-03-04', Deposit:12.75 };
    await patch('ingredients',ingredient,editIngredient,{ editor:ingredientEditor });
    const serial = (Date.UTC(2028,2,4) - Date.UTC(1899,11,30)) / 86400000;
    assert.deepEqual(ingredientsTab.state.rows[2].cells,
        ['i','Wheat flour','z, y, x','=Raw brand','  OK-D  ','Star K','Dairy equipment','North',serial,12.75,'=1+1','Keep']);
    assert.equal(ingredientsTab.state.rows[1].cells[1],'Salt');
    assert.equal(ingredientsTab.state.rows[0].cells[1],'Inserted');
    const reread = await readEditor('ingredients',ingredient);
    assert.equal(reread.fields.find(f => f.field === 'expiresOn').value,'2028-03-04');
    assert.equal(displayedValue(ingredientsTab,ingredientsTab.state.rows[2].cells[8],8),'04/03/2028');
    assert.deepEqual(new Set(reread.fields.find(f => f.field === 'companyLink').value),new Set([companyX.id,companyY.id,companyZ.id]));
    const factoryItems = await api('/api/factories/' + companyX.id + '/items');
    assert.deepEqual(factoryItems.ingredients.map(({ name, dpm, expiresOn }) => [name,dpm,expiresOn]),
        [['Wheat flour','dairy_equipment','2028-03-04']]);
    assert.equal(inspectionSource('agency').items(companyX.id,'ingredient')[0].expiresOn,'2028-03-04');
    const yItems = await api('/api/factories/' + companyY.id + '/items');
    assert.equal(yItems.ingredients.find(row => row.name === 'Salt').expiresOn,'2028-06-07');

    let inlineSaved;
    const inlineCompany = await mount(SheetRecordEditor, { section:'companies', row:companyX, inlineCompany:true,
        onSaved(name) { inlineSaved = name; }, onClose() { assert.fail('The inline editor closed'); } }).render();
    for (let i = 0; i < 100 && inlineCompany.text().includes('Loading fields'); i++) {
        await pause(20);
        await inlineCompany.render();
    }
    const companyFields = { name:'Renamed X', address:'New road', type:'Kitchen', brand:'New company brand',
        plant:'New company plant', companyFee:'999', mashgiachFee:'250', Notes:'=Literal note' };
    for (const [field, value] of Object.entries(companyFields)) {
        const [control] = inlineCompany.find(node => node.type === 'div' && node.props.children?.props.field?.field === field);
        assert.ok(control, `Missing inline field ${field}. ${inlineCompany.text()}`);
        control.props.children.props.onChange(value);
    }
    await inlineCompany.render();
    await inlineCompany.submit();
    assert.equal(inlineSaved,'Renamed X');
    assert.deepEqual(companiesTab.state.rows[0].cells,
        ['x','Renamed X','New road','Kitchen','New company brand','New company plant',999,250,'=Literal note','Keep']);
    assert.equal(inspectionSource('agency').state.companies.find(row => row.id === companyX.id).type,'Kitchen');
    assert.deepEqual(await api('/api/factories/' + companyX.id + '/items'),factoryItems);

    const productEditor = await readEditor('products',product);
    await patch('products',product,{ name:'Corn cereal', brand:'New product brand', code:'0000123', companyLink:[companyY.id,companyX.id],
        certification:'OU-P', agency:'OU', status:'Pareve', symbolRequired:true, plant:'West', 'Approved on':'2028-02-29',
        Verified: true, 'Other companies':[companyZ.id] },{ editor:productEditor });
    assert.deepEqual(productsTab.state.rows[0].cells,
        ['p','Corn cereal','y, x','New product brand','OU-P','OU','Pareve','West','Yes','0000123','2028-02-29',true,'z','Keep']);
    const overlap = await patch('products',product,{ certification:'Old editor' },{ editor:productEditor,status:409 });
    assert.match(overlap.error,/changed.*Refresh and review/);
    const separate = await readEditor('products',product);
    await Promise.all([
        patch('products',product,{ plant:'East' },{ editor:separate }),
        patch('products',product,{ code:'000007' },{ editor:separate }),
    ]);
    assert.deepEqual(productsTab.state.rows[0].cells.slice(8,10),['Yes','000007']);
    assert.equal(productsTab.state.rows[0].cells[7],'East');
    const commonEditor = await readEditor('products',product);
    const racing = await Promise.all(['OU-D','OK-P'].map(certification =>
        patch('products',product,{ certification },{ editor:commonEditor,status:[200,409] })));
    assert.equal(racing.filter(result => result.saved).length,1);
    assert.match(racing.find(result => result.error).error,/changed.*Refresh and review/);

    const moved = await readEditor('products',product);
    for (const cells of [productsTab.state.headers,productsTab.state.rows[0].cells]) [cells[8],cells[9]] = [cells[9],cells[8]];
    assert.match((await patch('products',product,{ code:'Changed' },{ editor:moved,status:409 })).error,/mapped column changed.*Refresh and review/);
    const missing = await readEditor('products',product);
    productsTab.state.rows[0].tag = 100;
    await patch('products',product,{ name:'Wrong row' },{ editor:missing,status:409 });
    assert.equal(productsTab.state.writes,4);

    const salt = (await list('ingredients')).find(row => row.name === 'Salt');
    const staleEditor = await readEditor('ingredients',salt);
    disrupt = ingredientsTab.state.reads + 4;
    const unconfirmed = await patch('ingredients',salt,{ certification:'New cert' },{ editor:staleEditor,status:409 });
    assert.match(unconfirmed.error,/could not be confirmed.*sheet may already have changed.*Refresh and review/);
    assert.equal(ingredientsTab.state.writes,2);
    const logs = await Promise.all((await readdir(auditDir)).map(async file => JSON.parse(await readFile(join(auditDir,file),'utf8'))));
    assert.ok(logs.some(entry => entry.section === 'products' && entry.spreadsheetId === 'schedule-b' && entry.table === 'Schedule B' && entry.outcome === 'confirmed'));
    assert.ok(logs.some(entry => entry.section === 'ingredients' && entry.spreadsheetId === 'schedule-a' &&
        entry.outcome === 'unconfirmed' && entry.writeEvidence[0].readBack.raw === 'Unexpected'));
    // Independence from process memory and distributed token contention use
    // two route registries sharing the same persistent Firestore mock.
    const { MockFirestore } = await import('../stage2/firestore-mock.mjs');
    const mockFile = process.env.FIRESTORE_MOCK_FILE;
    process.env.FIRESTORE_MOCK_FILE = join(directory,'phase-c-firestore.json');
    const auditWrites = [];
    class AddFirestore extends MockFirestore {
        runTransaction(fn) {
            return super.runTransaction(tx => {
                const set = tx.set.bind(tx);
                tx.set = (ref, entry, options) => {
                    if (entry.kind === 'add') auditWrites.push([entry.token,entry.outcome]);
                    return set(ref,entry,options);
                };
                return fn(tx);
            });
        }
    }
    const db = new AddFirestore();
    if (mockFile === undefined) delete process.env.FIRESTORE_MOCK_FILE;
    else process.env.FIRESTORE_MOCK_FILE = mockFile;
    const addDeps = { ...routeDeps, db:() => db };
    const addStore = createSourceStore(addDeps);
    await addStore.save(await createSourceStore(routeDeps).raw('agency'));
    const addServers = [];
    async function startAddServer() {
        const freshApp = express();
        freshApp.use(express.json());
        const { boot } = registerSourceRoutes(freshApp,addDeps);
        const freshServer = await new Promise(resolve => {
            const listener = freshApp.listen(0,'127.0.0.1',() => resolve(listener));
        });
        addServers.push(freshServer);
        await boot();
        return 'http://127.0.0.1:' + freshServer.address().port;
    }
    try {
        const a = await startAddServer();
        const b = await startAddServer();
        async function request(base, path, { body, method = body ? 'POST' : 'GET', status = 200, headers = {} } = {}) {
            const response = await priorFetch(base + path,{ method,
                headers:{ 'Content-Type':'application/json',...headers }, body:JSON.stringify(body) });
            const json = await response.json();
            assert.ok([status].flat().includes(response.status), JSON.stringify({ status:response.status,json }));
            return json;
        }
        const editor = (section, base = a) => request(base,'/api/sources/sheet-editor/' + section + '/new');
        const add = async (section, fields, { base = a, token = randomUUID(), revision, ...opts } = {}) => {
            if (fields && revision === undefined) revision = (await editor(section, base)).addRevision;
            return request(base,'/api/sources/rows/' + section,{ ...opts, body:{ token,fields,addRevision:revision } });
        };
        const abandon = (section, token, base = b) =>
            request(base,'/api/sources/sheet-editor/' + section + '/abandon',{body:{token}});
        const addEditor = await editor('products');
        const companyRevision = (await editor('companies')).addRevision;
        assert.match(addEditor.addRevision,/^[0-9a-f]{64}$/);
        assert.deepEqual(addEditor.fields.find(field => field.field === 'companyLink').value,[]);
        assert.ok(!addEditor.fields.some(field => field.header === 'ID' || field.field === 'Private'));
        assert.ok(addEditor.companies.some(company => company.id === companyX.id));
        let pendingQueries = 0;
        const ordinary = createGoogleSheetsApi({ spreadsheetId:'clients', mapping:phaseB, unconfirmedAdds:async () => {
            pendingQueries++;
            return new Set();
        } });
        const legacyUuid = { tag:78, cells:[randomUUID(),'Ordinary UUID','','Factory'] };
        companiesTab.state.rows.push(legacyUuid);
        assert.ok((await ordinary.readRows('Clients')).some(row => row.sourceKey === legacyUuid.cells[0]));
        assert.equal(pendingQueries,0);
        companiesTab.state.rows.pop();
        const initialAddCount = addBatches;
        await add('companies',{name:'Not permitted',type:'Factory'},{status:403,headers:{'x-test-role':'reader'}});
        await add('companies',{name:'Other agency',type:'Factory'},{revision:companyRevision,status:409,headers:{'x-test-agency':'other'}});
        await add('ingredients',{name:'Missing link',companyLink:['unknown']},{status:400});
        await add('products',{name:'Missing link',companyLink:[]},{status:400});
        await add('companies',{name:'Injected ID',type:'Factory',id:'x'},{status:400});
        await add('companies',{name:'Missing type'},{status:400});
        const duplicate = { ...companiesTab.state.rows[0], tag:undefined };
        companiesTab.state.rows.push(duplicate);
        assert.match((await add('companies',{name:'Duplicated source',type:'Factory'},{status:400})).error,/unique ID/);
        companiesTab.state.rows.pop();
        const earlyToken = randomUUID();
        let layoutStarted, releaseLayout;
        const started = new Promise(resolve => { layoutStarted = resolve; });
        const released = new Promise(resolve => { releaseLayout = resolve; });
        holdLayout = () => { layoutStarted(); return released; };
        const first = add('companies',{name:'Abandoned request',type:'Factory'},{token:earlyToken,revision:companyRevision,status:409});
        await started;
        try {
            assert.match((await add('companies',undefined,{base:b,token:earlyToken,status:400})).error,/No Add was sent/);
        } finally { releaseLayout(); }
        await first;
        assert.equal(addBatches,initialAddCount);

        addFailure = 'lost';
        const companyToken = randomUUID();
        const company = await add('companies',{name:'=New factory',type:'Factory',companyFee:125,Notes:'Stored text'},
            {token:companyToken});
        assert.match(company.recordId,/^addc[0-9a-f]{4}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const rawCompany = companiesTab.state.rows[0];
        assert.deepEqual(rawCompany.cells.slice(0,9),[company.recordId,'=New factory',null,'Factory',null,null,125,null,'Stored text']);
        assert.equal(rawCompany.tag,company.metadataId);
        assert.equal(rawCompany.tagValue,company.recordId);
        assert.equal(addBatches,initialAddCount + 1);
        assert.deepEqual(await add('companies',undefined,{base:b,token:companyToken}),company);
        assert.deepEqual(auditWrites.filter(([token]) => token === companyToken).map(([,outcome]) => outcome),
            ['attempted','confirmed']);
        await add('companies',{name:'Different',type:'Factory'},{base:b,token:companyToken,status:409});
        assert.equal(companiesTab.state.rows.filter(row => row.cells[0] === company.recordId).length,1);
        const newCompany = (await request(b,'/api/sources/sheet-editor/companies')).rows.find(row => row.name === '=New factory');
        assert.equal((await request(b,editPath('companies',newCompany))).fields.find(field => field.field === 'name').value,'=New factory');

        const [addedA, addedB] = await Promise.all([
            add('ingredients',{name:'New flour',companyLink:[newCompany.id,companyX.id],expiresOn:'2028-02-29',certification:'=OU'}),
            add('ingredients',{name:'New sugar',companyLink:[companyX.id],Deposit:17},{base:b}),
        ]);
        assert.notEqual(addedA.recordId,addedB.recordId);
        assert.notEqual(addedA.metadataId,addedB.metadataId);
        for (const entry of [addedA,addedB]) {
            const matching = ingredientsTab.state.rows.filter(row => row.cells[0] === entry.recordId);
            assert.equal(matching.length,1);
            assert.equal(matching[0].tag,entry.metadataId);
            assert.equal(matching[0].tagValue,entry.recordId);
        }
        assert.ok((await request(a,'/api/factories/' + newCompany.id + '/items')).ingredients
            .some(row => row.name === 'New flour' && row.expiresOn === '2028-02-29' && row.certificationRaw === '=OU'));

        const sameToken = randomUUID();
        const sameFields = { name:'New cereal',companyLink:[newCompany.id],code:'000093',symbolRequired:false,'Approved on':'2028-01-02' };
        const beforeSame = addBatches;
        const results = await Promise.all([a,b].map(base => add('products',sameFields,{base,token:sameToken,status:[200,409]})));
        const savedProduct = results.find(result => result.saved);
        assert.ok(savedProduct);
        assert.equal(addBatches,beforeSame + 1);
        assert.deepEqual(await add('products',undefined,{base:b,token:sameToken}),savedProduct);
        assert.equal(productsTab.state.rows.filter(row => row.cells[0] === savedProduct.recordId && row.tag === savedProduct.metadataId).length,1);
        const publishedProduct = (await request(b,'/api/factories/' + newCompany.id + '/items')).products.find(row => row.name === 'New cereal');
        const productRow = (await request(b,'/api/sources/sheet-editor/products')).rows.find(row => row.name === publishedProduct.name);
        const productFields = (await request(b,editPath('products',productRow))).fields;
        assert.equal(productFields.find(field => field.field === 'code').value,'000093');
        assert.equal(productFields.find(field => field.field === 'symbolRequired').value,false);

        addFailure = 'missing-receipt';
        const receiptToken = randomUUID();
        await add('products',{name:'Needs recovery',companyLink:[companyX.id]},{token:receiptToken,status:409});
        const restarted = await startAddServer();
        assert.ok(!(await request(restarted,'/api/sources/sheet-editor/products')).rows.some(row => row.name === 'Needs recovery'));
        assert.ok(!(await request(restarted,'/api/factories/' + companyX.id + '/items')).products.some(row => row.name === 'Needs recovery'));
        const beforeRecovery = addBatches;
        assert.equal((await add('products',undefined,{base:restarted,token:receiptToken})).saved,true);
        assert.equal(addBatches,beforeRecovery);

        for (const [mode, status, message, rowDelta] of [
            ['rejected',400,/Google Sheets rejected/,0],
            ['timeout',409,/may already be in Google Sheets/,0],
            ['changed-value',409,/may already be in Google Sheets/,1],
        ]) {
            const token = randomUUID(), before = productsTab.state.rows.length, sent = addBatches;
            addFailure = mode;
            assert.match((await add('products',{name:mode,companyLink:[companyX.id]},{token,status})).error,message);
            assert.match((await add('products',undefined,{base:b,token,status})).error,message);
            assert.equal(addBatches,sent + 1);
            assert.equal(productsTab.state.rows.length,before + rowDelta);
            const audit = await addStore.addLedger('agency',token).get();
            assert.equal(audit.outcome,mode === 'rejected' ? 'rejected' : 'unconfirmed');
            assert.equal(audit.verified,false);
            if (mode === 'timeout') {
                assert.equal((await abandon('products',token)).abandoned,true);
                assert.equal((await abandon('products',token)).abandoned,true);
                assert.equal((await addStore.addLedger('agency',token).get()).outcome,'abandoned');
                await add('products',undefined,{base:b,token,status:400});
                await add('products',{name:mode,companyLink:[companyX.id]},{base:b,token,status:400});
                assert.equal(addBatches,sent + 1);
                assert.equal(productsTab.state.rows.length,before);
            }
        }
        const audit = await addStore.addLedger('agency',companyToken).get();
        assert.deepEqual([audit.operationId,audit.actorId,audit.agencyId,audit.name,audit.recordId,audit.table,
            audit.metadataId,audit.outcome,audit.verified],
            [company.operationId,'admin','agency','=New factory',company.recordId,'Clients',company.metadataId,'confirmed',true]);
        assert.equal((await addStore.sheetAdds('schedule-b',true)).length,2);
        assert.equal(new Set((await addStore.sheetAdds('schedule-b')).map(entry => entry.operationId)).size,
            (await addStore.sheetAdds('schedule-b')).length);
        assert.ok(!Object.hasOwn(audit,'fields') && !Object.hasOwn(audit,'cells'));

        const saveMapping = async (mapping, baseId = 'clients') => {
            await request(a,'/api/sources/connection',{method:'PUT',body:{ sourceType:'google_sheets',baseId,access:'readwrite',mapping }});
            await request(a,'/api/sources/sheets-editing',{method:'PUT',body:{enabled:true}});
        };
        const otherBook = fixture({ title:'Clients', sheetId:0, headers:[...companiesTab.state.headers],
            rows:structuredClone(companiesTab.state.rows) });
        files.set('clients-copy',{...otherBook,title:'Clients'});
        const switched = { ...phaseB, companies:{ ...phaseB.companies,file:{id:'clients-copy',name:'Copy'} } };
        for (const [mapping, baseId] of [[switched,'clients-copy'], [phaseB,'clients'],
            [{ ...phaseB, companies:{ ...phaseB.companies,companyFee:'Unmapped' } },'clients']]) {
            const { addRevision } = await editor('companies');
            await saveMapping(mapping,baseId);
            assert.notEqual((await editor('companies')).addRevision,addRevision);
            const token = randomUUID(), before = googleWrites;
            const stale = await add('companies',{name:'Stale form',type:'Factory',companyFee:40},{token,revision:addRevision,status:409});
            assert.equal(stale.addRevisionStale,true);
            assert.equal(await addStore.addLedger('agency',token).get(),null);
            assert.equal(googleWrites,before);
        }

        const productState = productsTab.state;
        const swapIdAndPrivate = () => {
            const id = productState.headers.indexOf('ID'), other = productState.headers.indexOf('Private');
            for (const row of productState.rows) if (row.tag) row.tagValue ??= row.cells[id];
            for (const cells of [productState.headers, ...productState.rows.map(row => row.cells)])
                [cells[id], cells[other]] = [cells[other], cells[id]];
        };
        const movedProduct = { name:'ID column moved during Add',companyLink:[companyX.id] };
        productState.rows.push({ cells:['','Manually entered row'] });
        try {
            const error = await add('products',movedProduct,{base:restarted,status:400});
            assert.equal(error.error,'Every data row needs a unique ID.');
        } finally { productState.rows.pop(); }
        const beforeMove = googleWrites, beforeRows = productState.rows.length;
        const preflightToken = randomUUID(), revision = (await editor('products')).addRevision;
        afterLayout = swapIdAndPrivate;
        try {
            const stale = await add('products',movedProduct,{token:preflightToken,revision,status:409});
            assert.equal(stale.addRevisionStale,true);
            assert.equal((await addStore.addLedger('agency',preflightToken).get()).outcome,'rejected');
            assert.equal(googleWrites,beforeMove);
            assert.equal(productState.rows.length,beforeRows);
        } finally { swapIdAndPrivate(); }

        const movedToken = randomUUID();
        // Move the column after the final layout check while the write is in flight.
        holdBatch = swapIdAndPrivate;
        try {
            const error = await add('products',movedProduct,{token:movedToken,status:409});
            assert.match(error.error,/may already be in Google Sheets/);
            assert.equal(googleWrites,beforeMove + 1);
            assert.equal(productState.rows.length,beforeRows + 1);
            const audit = await addStore.addLedger('agency',movedToken).get();
            assert.equal(audit.outcome,'unconfirmed');
            const inserted = productState.rows[0];
            assert.equal(inserted.tagValue,audit.recordId);
            assert.equal(inserted.cells[productState.headers.indexOf('Private')],audit.recordId);
            assert.ok(!inserted.cells[productState.headers.indexOf('ID')]);
            const refreshed = await startAddServer();
            await request(refreshed,'/api/sources/refresh',{body:{},status:[200,429]});
            assert.equal((await request(refreshed,'/api/sources/connection')).status,'ok');
            const items = (await request(refreshed,'/api/factories/' + companyX.id + '/items')).products;
            assert.ok(items.some(row => row.name === 'Needs recovery'));
            assert.ok(!items.some(row => row.name === movedProduct.name));
            assert.ok(!(await request(refreshed,'/api/sources/sheet-editor/products')).rows.some(row => row.name === movedProduct.name));

            // The tag alone is enough to suppress the row even if its misplaced cell is cleared.
            inserted.cells[productState.headers.indexOf('Private')] = null;
            const adapter = createGoogleSheetsApi({spreadsheetId:'schedule-b', mapping:phaseB,
                unconfirmedAdds:async id => new Set((await addStore.sheetAdds(id,true)).map(add => add.recordId))});
            const rows = await adapter.readRows(phaseB.products.table);
            assert.ok(rows.some(row => row.fields.Name === 'Needs recovery'));
            assert.ok(!rows.some(row => row.fields.Name === movedProduct.name));

            const next = await add('products',{name:'Next product',companyLink:[companyX.id]},{base:refreshed,status:400});
            blockedAddError = next.error;
            // A different unfinished row occupies the reported position before the admin acts.
            const otherRow = { cells:['','Manually entered row'] };
            productState.rows.unshift(otherRow);
            try {
                const idColumn = productState.headers.indexOf('ID');
                assert.equal(productState.rows[0],otherRow);
                assert.equal(productState.rows[1],inserted);
                assert.ok(!otherRow.cells[idColumn] && !inserted.cells[idColumn]);
                assert.match(blockedAddError,/A previous Add left a row hidden in Shutfey on this tab/);
                assert.ok(blockedAddError.includes(`last seen at row 2 on the “${phaseB.products.table}” tab and may have moved`));
                assert.match(blockedAddError,/matches the details you entered in the previous Add.*ID cell is blank/);
                assert.match(blockedAddError,/If you can identify the row unambiguously, delete the entire row/);
                assert.match(blockedAddError,/If you’re unsure which row it is, contact support before deleting anything/);

                const rechecked = await add('products',{name:'Next product',companyLink:[companyX.id]},{base:refreshed,status:400});
                assert.ok(rechecked.error.includes(`last seen at row 3 on the “${phaseB.products.table}” tab`));
            } finally { productState.rows.shift(); }
            assert.equal(googleWrites,beforeMove + 1);
        } finally {
            if (productState.rows[0].cells[1] === movedProduct.name) productState.rows.shift();
            swapIdAndPrivate();
        }
        assert.equal((await add('products',{name:'Next product',companyLink:[companyX.id]},{base:restarted})).saved,true);

        const lateToken = randomUUID();
        let batchStarted, releaseBatch;
        const batchInFlight = new Promise(resolve => { batchStarted = resolve; });
        const batchReleased = new Promise(resolve => { releaseBatch = resolve; });
        holdBatch = () => { batchStarted(); return batchReleased; };
        const late = add('products',{name:'Late Google commit',companyLink:[companyX.id]},
            {token:lateToken,status:409});
        await batchInFlight;
        try {
            assert.equal((await abandon('products',lateToken)).abandoned,true);
        } finally { releaseBatch(); }
        await late;
        assert.equal((await addStore.addLedger('agency',lateToken).get()).outcome,'abandoned');
        assert.ok(productsTab.state.rows.some(row => row.cells[1] === 'Late Google commit'));
        const renamed = 'Renamed Schedule B';
        files.get('schedule-b').title = renamed;
        await saveMapping({ ...phaseB,products:{ ...phaseB.products,table:renamed } });
        const imported = (await request(a,'/api/factories/' + companyX.id + '/items')).products;
        assert.ok(imported.some(row => row.name === 'Needs recovery'));
        assert.ok(productsTab.state.rows.some(row => row.cells[1] === 'changed-value changed'));
        assert.ok(!imported.some(row => ['changed-value changed','Late Google commit'].includes(row.name)));
        assert.ok(!(await request(a,'/api/sources/sheet-editor/products')).rows.some(row =>
            ['changed-value changed','Late Google commit'].includes(row.name)));
        const fresh = await add('companies',{name:'Fresh Add',type:'Factory'});
        assert.equal(fresh.saved,true);
        console.log('Phase C passed through HTTP for all three sections, including stale mappings, moved ID columns, renamed tabs, abandonment and late commits.');
    } finally {
        await Promise.all(addServers.map(server => new Promise(resolve => server.close(resolve))));
    }

    const shared = fixture({ title:'Shared', tracked:new Map([[19,'bakery'],[32,'flour']]),
        headers:['ID','Name','Company'], rows:[
            { tag:19, cells:['bakery','Bakery',''] },
            { tag:32, cells:['flour','Flour','Bakery'] },
        ],
    });
    files.set('shared-review',{ ...shared, title:'Shared' });
    const overlapping = { companies:{ table:'Shared', pk:'ID', name:'Name' },
        ingredients:{ table:'Shared', file:{ id:'shared-review', name:'Shared' }, pk:'ID', name:'Name', companyLink:'Company' },
        products:{ table:'' }, group1Values:[] };
    await api('/api/sources/connection','PUT',{ sourceType:'google_sheets', baseId:'shared-review', access:'readwrite', mapping:overlapping });
    const bakery = (await api('/api/factories')).companies.find(row => row.name === 'Bakery');
    assert.equal((await api('/api/factories/' + bakery.id + '/items')).ingredients[0].name,'Flour');
    const writesBeforeOverlap = googleWrites;
    async function expectSharedTabRejection(base, path, method, body) {
        const response = await priorFetch(base + path,{ method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body) });
        assert.equal(response.status,409);
        assert.match((await response.json()).error,/separate Google Sheets tab/);
    }
    await expectSharedTabRejection(local,'/api/sources/sheets-editing','PUT',{enabled:true});

    // Exercise the PATCH guard for an agency that already enabled the shared tab on the earlier head.
    const store = createSourceStore(routeDeps);
    const savedConnection = await store.raw('agency');
    const existingTags = { headers:shared.state.headers, idHeader:'ID',
        records:shared.state.rows.map(row => ({ key:row.cells[0],metadataId:row.tag })) };
    await store.save({ ...savedConnection,sheetsTables:{ companies:existingTags,ingredients:existingTags } });
    const legacy = express();
    legacy.use(express.json());
    const { boot } = registerSourceRoutes(legacy,routeDeps);
    const legacyServer = await new Promise(resolve => { const s = legacy.listen(0,'127.0.0.1',() => resolve(s)); });
    try {
        await boot();
        const legacyBase = 'http://127.0.0.1:' + legacyServer.address().port;
        const target = { agencyId:'agency', actorId:'admin', section:'ingredients', spreadsheetId:'shared-review',
            table:'Shared', recordId:'bakery', metadataId:19 };
        const transport = createGoogleSheetsApi({ spreadsheetId:'shared-review', mapping:overlapping, fetchImpl:shared.fetchImpl });
        const editable = await transport.readTaggedEditor({ mapping:overlapping,section:'ingredients',idHeader:'ID',fields:{},
            links:{ resolve:() => [],sourceKey:() => undefined } },target);
        await expectSharedTabRejection(legacyBase,'/api/sources/sheets-editing','PUT',{enabled:true});
        await expectSharedTabRejection(legacyBase,'/api/sources/rows/ingredients/' + bakery.id,'PATCH',
            { fields:{ name:'Accidental company rename' },expected:{ name:editable.find(field => field.field === 'name').revision } });
        const intact = await priorFetch(legacyBase + '/api/factories/' + bakery.id + '/items');
        assert.equal((await intact.json()).ingredients[0].name,'Flour');
    } finally { await new Promise(resolve => legacyServer.close(resolve)); }
    assert.equal(googleWrites,writesBeforeOverlap);
    assert.deepEqual(shared.state.rows.map(row => row.cells),[['bakery','Bakery',''],['flour','Flour','Bakery']]);
    console.log('Shared tabs reject editing on enable and PATCH with zero Google writes.');
    console.log('Phase B passed through HTTP and the simulated Sheets transport for all mapped fields on separate files and tabs.');

} finally {
    globalThis.fetch = priorFetch;
    globalThis.document = priorDocument;
    if (previousClient === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID; else process.env.GOOGLE_OAUTH_CLIENT_ID=previousClient;
    if (previousSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET; else process.env.GOOGLE_OAUTH_CLIENT_SECRET=previousSecret;
    await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
}

const uiProduct = { id: 'product', name: 'Cereal' };
const uiFields = { companies: [{ id:'permanent-x', key:'x', name:'Company X' }, { id:'permanent-y', key:'y', name:'Company Y' }], fields: [
    { field:'code', header:'UPC', rule:'text', value:'0099', revision:'old-code' },
    { field:'companyLink', header:'Companies', rule:'companyLink', value:['permanent-x'], revision:'old-links' },
    { field:'plant', header:'Plant', rule:'text', value:'', revision:'old-plant', readOnly:'Formula cells are read only.' },
] };
const submissions = [];
let refreshes = 0, uiSaved = 0;
const addSubmissions = [], abandonSubmissions = [], session = new Map();
let uiAddStuck = false, uiAddStale = false, uiAddBlocked = false;
const oldSession = globalThis.sessionStorage;
globalThis.sessionStorage = {
    getItem:key => session.get(key) ?? null, setItem:(key,value) => session.set(key,value), removeItem:key => session.delete(key),
};
globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/sources/sheet-editor/products/product') return Response.json(uiFields);
    if (url === '/api/sources/sheet-editor/companies/company') return Response.json({ companies:[], fields:[
        { field:'type',header:'Type',rule:'text',value:'Factory',choices:['Factory','Kitchen'],revision:'old-type' },
    ] });
    if (url === '/api/sources/sheet-editor/products/new') return Response.json({
        addScope:['agency','admin','products','spreadsheet','Products'], addRevision:'form-revision', companies:uiFields.companies,
        fields:[{ field:'name',header:'Name',rule:'text',value:'' },
            { ...uiFields.fields[0],value:'' },{ ...uiFields.fields[1],value:[] }],
    });
    if (url === '/api/sources/rows/products') {
        addSubmissions.push(JSON.parse(init.body));
        if (addSubmissions.length === 1) throw Error('Response unavailable');
        if (uiAddStuck) return Response.json({error:'The new record could not be confirmed.'},{status:409});
        if (uiAddStale) return Response.json({error:'The mapped sheet or columns changed.',addRevisionStale:true},{status:409});
        if (uiAddBlocked) return Response.json({error:blockedAddError},{status:400});
        return Response.json({saved:true});
    }
    if (url === '/api/sources/sheet-editor/products/abandon') {
        abandonSubmissions.push(JSON.parse(init.body));
        return Response.json({abandoned:true});
    }
    if (url === '/api/sources/refresh') { refreshes++; return Response.json({ ok:true }); }
    assert.equal(url,'/api/sources/rows/products/product');
    submissions.push(JSON.parse(init.body));
    return Response.json({error:'The change could not be confirmed. The sheet may already have changed. Refresh and review.'},{status:409});
};
try {
    const view = mount(SheetRecordEditor, { section:'products', row:uiProduct, onSaved() { uiSaved++; }, onClose() {} });
    await view.render();
    assert.match(view.html(),/0099/);
    assert.match(view.html(),/type="checkbox" checked="".*Company X/);
    assert.match(view.html(),/Formula cells are read only/);
    const inputs = view.find(e => e.type === 'form')[0].props.children[0].props.children.map(e => e.props.children);
    inputs[0].props.onChange('00000123');
    inputs[1].props.onChange(['permanent-x','permanent-y']);
    await view.render();
    await view.submit();
    assert.match(view.text(),/could not be confirmed.*may already have changed/);
    assert.equal(uiSaved,0);
    await view.submit();
    assert.deepEqual(submissions,[{ fields:{ code:'00000123',companyLink:['permanent-x','permanent-y'] },
        expected:{ code:'old-code',companyLink:'old-links' } }]);
    await view.click('Refresh for review');
    assert.equal(refreshes,1);
    assert.match(view.html(),/value="0099"/);
    assert.equal(view.find(e => e.type === 'button' && e.props.type === 'submit')[0].props.disabled,true);
    const companyView = mount(SheetRecordEditor,{ section:'companies', row:{id:'company',name:'Bakery'}, onSaved() {}, onClose() {} });
    await companyView.render();
    assert.match(companyView.html(),/<select[^>]*><option value="Factory" selected="">Factory<\/option><option value="Kitchen">Kitchen<\/option><\/select>/);
    let addsSaved = 0;
    const addProps = { section:'products', onSaved() { addsSaved++; }, onClose() {} };
    const addView = mount(SheetRecordEditor,addProps);
    await addView.render();
    const addInputs = addView.find(e => e.type === 'form')[0].props.children[0].props.children.map(e => e.props.children);
    addInputs[0].props.onChange('Cereal');
    addInputs[1].props.onChange('00123');
    addInputs[2].props.onChange(['permanent-x']);
    await addView.render();
    await addView.submit();
    assert.match(addView.text(),/could not be confirmed.*Check again/);
    assert.equal(addsSaved,0);
    const reopened = mount(SheetRecordEditor,addProps);
    await reopened.render();
    assert.match(reopened.text(),/Check whether Google Sheets saved/);
    await reopened.submit();
    assert.deepEqual(addSubmissions,[
        { token:addSubmissions[0].token,fields:{ name:'Cereal',code:'00123',companyLink:['permanent-x'] },addRevision:'form-revision' },
        { token:addSubmissions[0].token },
    ]);
    assert.equal(addsSaved,1);
    assert.equal(session.size,0);
    const enterName = async (view, name) => {
        view.find(e => e.type === 'form')[0].props.children[0].props.children[0].props.children.props.onChange(name);
        await view.render();
    };
    uiAddStuck = true;
    const stuck = mount(SheetRecordEditor,addProps);
    await stuck.render();
    await enterName(stuck,'Pending record');
    await stuck.submit();
    const abandonedToken = addSubmissions.at(-1).token;
    const pending = mount(SheetRecordEditor,addProps);
    await pending.render();
    await pending.submit();
    assert.deepEqual(addSubmissions.at(-1),{token:abandonedToken});
    await pending.click('Abandon Add attempt');
    assert.equal(abandonSubmissions.length,0);
    await pending.click('Confirm abandonment');
    assert.deepEqual(abandonSubmissions,[{token:abandonedToken}]);
    assert.equal(session.size,0);
    assert.equal(pending.find(e => e.type === 'fieldset')[0].props.disabled,false);
    uiAddStuck = false;
    await enterName(pending,'Fresh record');
    await pending.submit();
    assert.notEqual(addSubmissions.at(-1).token,abandonedToken);
    assert.equal(addSubmissions.at(-1).fields.name,'Fresh record');
    assert.equal(addsSaved,2);

    uiAddStale = true;
    const stale = mount(SheetRecordEditor,addProps);
    await stale.render();
    await enterName(stale,'Stale record');
    await stale.submit();
    assert.equal(session.size,0);
    assert.equal(stale.find(e => e.type === 'fieldset')[0].props.disabled,true);
    assert.match(stale.text(),/mapped sheet or columns changed/);

    uiAddStale = false;
    uiAddBlocked = true;
    const blocked = mount(SheetRecordEditor,addProps);
    await blocked.render();
    assert.match(blocked.html(),/last seen in Google Sheets.*matches the details you entered in the previous Add.*ID cell is blank/);
    assert.match(blocked.html(),/If you can identify the row unambiguously, delete the entire row/);
    assert.match(blocked.html(),/If you’re unsure which row it is, contact support before deleting anything/);
    await enterName(blocked,'Next product');
    await blocked.submit();
    assert.equal(blocked.find(e => e.props.role === 'alert')[0].props.children,blockedAddError);
    assert.equal(session.size,0);
    assert.equal(blocked.find(e => e.type === 'fieldset')[0].props.disabled,false);
    console.log('Sheet editors recover or abandon an uncertain Add after reopening and clear stale submissions.');
} finally {
    globalThis.fetch = priorFetch;
    if (oldSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = oldSession;
}
