import assert from 'node:assert/strict';
import { createGoogleSheetsApi } from '../../src/server/sources/google-sheets.ts';

const headers = ['ID', 'Fee', 'Company', 'Formula'];
const edit = { metadataId: 19, table: 'Companies', headers, idHeader: 'ID', feeHeader: 'Fee', recordId: 'a', fee: 200 };
function fixture(interleave, response = 'ok') {
    const state = { headers: [...headers], rows: [
        { tag: 19, cells: ['a', 100, 'Original', '=1+1'] },
        { tag: 32, cells: ['b', 70, 'Other', '=2+2'] },
    ], writes: 0 };
    const api = createGoogleSheetsApi({ spreadsheetId: 'pilot', fetchImpl: async (url, init) => {
        if (!init.body) return Response.json({ values: [state.headers] });
        const body = JSON.parse(init.body);
        if (url.endsWith('/values:batchGetByDataFilter')) {
            assert.deepEqual(body.dataFilters, [{ developerMetadataLookup: { metadataId: 19 } }]);
            return Response.json({ valueRanges: state.rows.filter(r => r.tag === 19)
                .map(r => ({ valueRange: { values: [r.cells] } })) });
        }
        assert.ok(url.endsWith('/values:batchUpdateByDataFilter'));
        assert.deepEqual(body, { valueInputOption: 'RAW', data: [{
            dataFilter: { developerMetadataLookup: { metadataId: 19 } }, values: [[null, 200]],
        }] });
        state.writes++;
        interleave?.(state);
        const row = state.rows.find(r => r.tag === 19);
        if (row) body.data[0].values[0].forEach((v, index) => { if (v !== null) row.cells[index] = v; });
        if (response === 'superseded') row.cells[1] = 300;
        if (response !== 'ok') throw Error('response lost');
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
await assert.rejects(replaced.save, /updated cells/);
assert.equal(replaced.state.rows[0].cells[1], 90);
for (const response of ['lost', 'superseded']) {
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

// Negative controls: row metadata cannot enforce a column-order precondition
// or detect a partial sort that leaves the visible ID in place.
const moved = fixture(s => {
    for (const row of [s.headers, ...s.rows.map(r => r.cells)]) [row[1], row[2]] = [row[2], row[1]];
});
await moved.save();
assert.equal(moved.state.rows[0].cells[moved.state.headers.indexOf('Company')], 200);
const partial = fixture(s => {
    const [a, b] = s.rows;
    [a.cells, b.cells] = [[a.cells[0], ...b.cells.slice(1)], [b.cells[0], ...a.cells.slice(1)]];
});
await partial.save();
assert.deepEqual(partial.state.rows[0].cells, ['a', 200, 'Other', '=2+2']);
console.log('Sparse save, sort, replacement, conflict, formula and lost response passed. Forced column move and partial sort reproduced pilot blockers.');
