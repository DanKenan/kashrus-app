import assert from 'node:assert/strict';
import { createGoogleSheetsApi } from '../../src/server/sources/google-sheets.ts';

const headers = ['ID', 'Fee', 'Company', 'Formula'];
const edit = { metadataId: 19, table: 'Companies', headers, idHeader: 'ID', feeHeader: 'Fee', recordId: 'a', fee: 200 };
function fixture(interleave, response = 'ok', afterFirstRead) {
    const state = { headers: [...headers], rows: [
        { tag: 19, cells: ['a', 100, 'Original', '=1+1'] },
        { tag: 32, cells: ['b', 70, 'Other', '=2+2'] },
    ], writes: 0 };
    const api = createGoogleSheetsApi({ spreadsheetId: 'pilot', fetchImpl: async (url, init) => {
        if (!init.body) return Response.json({ values: [state.headers] });
        const body = JSON.parse(init.body);
        if (url.endsWith('/values:batchGetByDataFilter')) {
            const [tag, header] = body.dataFilters;
            assert.deepEqual(tag, { developerMetadataLookup: { metadataId: 19 } });
            assert.deepEqual(header, { a1Range: "'Companies'!1:1" });
            const snapshot = Response.json({ valueRanges: [
                { dataFilters: [header], valueRange: { values: [state.headers] } },
                ...state.rows.filter(r => r.tag === 19).map(r => ({
                    dataFilters: [tag], valueRange: { range: "'Companies'!A2:D2", values: [r.cells] },
                })),
            ] });
            if (afterFirstRead) {
                afterFirstRead(state);
                afterFirstRead = undefined;
            }
            return snapshot;
        }
        assert.ok(url.endsWith('/values:batchUpdateByDataFilter'));
        assert.deepEqual(body, { valueInputOption: 'RAW', data: [{
            dataFilter: { developerMetadataLookup: { metadataId: 19 } }, values: [[null, 200]],
        }] });
        state.writes++;
        interleave?.(state);
        const row = state.rows.find(r => r.tag === 19);
        if (row) body.data[0].values[0].forEach((v, index) => { if (v !== null) row.cells[index] = v; });
        if (response === 'superseded' || response === 'wrong-value') row.cells[1] = 300;
        if (response === 'lost' || response === 'superseded') throw Error('response lost');
        return Response.json({ totalUpdatedRows: Number(!!row), totalUpdatedCells: Number(!!row) });
    } });
    return { state, save: () => api.saveFee(edit) };
}
const sorted = fixture(s => { s.rows.reverse(); s.rows[1].cells[2] = 'Concurrent'; });
await sorted.save();
assert.deepEqual(sorted.state.rows.map(r => r.cells), [
    ['b', 70, 'Other', '=2+2'], ['a', 200, 'Concurrent', '=1+1'],
]);
const replaced = fixture(s => s.rows.splice(0, 1, { tag: 77, cells: ['a', 90] }));
await assert.rejects(replaced.save, /Refresh and review/);
assert.equal(replaced.state.rows[0].cells[1], 90);
for (const response of ['lost', 'superseded', 'wrong-value']) {
    const f = fixture(undefined, response);
    if (response === 'lost') await f.save();
    else await assert.rejects(f.save, /review/);
    assert.equal(f.state.writes, 1);
}
const pasted = fixture();
pasted.state.rows[0].cells = ['c', 30, 'Replacement'];
await assert.rejects(pasted.save, /Record ID changed/);
assert.equal(pasted.state.writes, 0);
const formula = fixture();
formula.state.rows[0].cells[1] = '=1+1';
await assert.rejects(formula.save, /formula/);

// Column moves can corrupt another cell despite correct update counts.
// A partial sort that leaves the ID in place can still escape verification.
function moveFeeColumn(s) {
    for (const row of [s.headers, ...s.rows.map(r => r.cells)]) [row[1], row[2]] = [row[2], row[1]];
}
const unchanged = fixture(undefined, 'ok', moveFeeColumn);
unchanged.state.rows[0].cells[1] = 200;
await assert.rejects(unchanged.save, /Fee is already set to this amount/);
assert.equal(unchanged.state.writes, 0);
assert.deepEqual(unchanged.state.headers, ['ID', 'Company', 'Fee', 'Formula']);
assert.deepEqual(unchanged.state.rows[0].cells, ['a', 'Original', 200, '=1+1']);

const formatted = fixture();
formatted.state.rows[0].cells[1] = '$200.00';
await assert.rejects(formatted.save, /Fee is already set to this amount/);
assert.equal(formatted.state.writes, 0);

const moved = fixture(moveFeeColumn);
await assert.rejects(moved.save, /Fee save could not be confirmed/);
assert.equal(moved.state.rows[0].cells[moved.state.headers.indexOf('Company')], 200);
const partial = fixture(s => {
    const [a, b] = s.rows;
    [a.cells, b.cells] = [[a.cells[0], ...b.cells.slice(1)], [b.cells[0], ...a.cells.slice(1)]];
});
await partial.save();
assert.deepEqual(partial.state.rows[0].cells, ['a', 200, 'Other', '=2+2']);
console.log('Sparse save, sort, replacement, conflict, formula and lost response passed. Forced column move rejected after read-back. Partial-sort limitation reproduced.');

const superseded = fixture(s => { s.rows[0].cells[0] = 'replacement'; });
await assert.rejects(superseded.save, /Fee save could not be confirmed/);

const changedHeaders = fixture();
changedHeaders.state.headers.reverse();
await assert.rejects(changedHeaders.save, /Columns changed. Refresh/);
assert.equal(changedHeaders.state.writes, 0);
