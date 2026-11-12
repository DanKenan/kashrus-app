import assert from 'node:assert/strict';
import { parseUpload, parseCsv, parseXlsx, uploadRowsError } from '../../src/server/sources/upload.ts';
import { safeCellText } from '../../src/server/inspections/export.ts';
import { zip, workbookFixture } from './source-upload-fixtures.mjs';
assert.deepEqual(parseCsv('\uFEFFName;Note\r\n"Golden; Grain";"line 1\nline ""2"""\r\n'), [['Name', 'Note'], ['Golden; Grain', 'line 1\nline "2"']]);
const file = parseUpload(Buffer.from('Name,Name,,Formula\r\n"  Demo\u0000 Bakery  ",second,,=SUM(A1)\r\n'), 'Companies.csv');
assert.deepEqual(file.tabs[0].columns, ['Name', 'Name (2)', 'Column 3', 'Formula']);
assert.equal(file.tabs[0].rows[0].id, 'r2');
assert.equal(file.tabs[0].rows[0].fields.Name, 'Demo Bakery');
assert.equal(file.tabs[0].rows[0].fields.Formula, '=SUM(A1)');
for (const text of ['=cmd', '+cmd', '-cmd', '@cmd']) {
    assert.equal(parseUpload(Buffer.from('Name\n' + text), 'x.csv').tabs[0].rows[0].fields.Name, text);
    assert.equal(safeCellText(text), "'" + text);
}
assert.equal(parseUpload(Buffer.from('Name\n' + 'x'.repeat(3000)), 'x.csv').tabs[0].rows[0].fields.Name.length, 2000);
assert.throws(() => parseCsv('Name\n"unclosed'), /Invalid CSV/);
assert.throws(() => parseUpload(Buffer.from('Name\n' + Array(5001).fill('Demo').join('\n')), 'x.csv'), { message: uploadRowsError });
const xlsx = parseXlsx(zip(workbookFixture()));
assert.equal(xlsx.length, 2);
assert.equal(xlsx[0].rows[0].fields['Annual Fee'], '1200.50');
assert.equal(xlsx[0].rows[0].fields.Date, '1970-01-01T00:00:00.000Z');
assert.equal(xlsx[0].rows[0].fields.Formula, '=SUM(A1)');
assert.equal(xlsx[1].rows[0].fields.Name, 'Demo Flour');
assert.throws(() => parseXlsx(zip(workbookFixture(), 31 * 1024 * 1024)), /too large/);
const many = workbookFixture();
many['xl/worksheets/sheet1.xml'] = '<worksheet>' + Array(5002).fill('<row><c r="A1" t="inlineStr"><is><t>Demo</t></is></c></row>').join('') + '</worksheet>';
assert.throws(() => parseXlsx(zip(many)), { message: uploadRowsError });
assert.throws(() => parseUpload(Buffer.from('demo'), 'old.xls'), /CSV or XLSX/);
console.log('upload CSV, deflated multi-sheet XLSX, dates, literal formulas and limits passed');
const { emptyWorkbook } = await import('../../src/server/sources/xlsx-template.ts');
const { defaultHeaders } = await import('../../src/server/sources/google-sheets.ts');
const created = parseXlsx(emptyWorkbook(defaultHeaders));
assert.deepEqual(created.map(t => t.name), ['Companies', 'Ingredients', 'Products']);
assert.deepEqual(created[0].columns, defaultHeaders.Companies);
assert.ok(created.every(t => t.rows.length === 0));

const early = workbookFixture();
early['xl/worksheets/sheet1.xml'] = early['xl/worksheets/sheet1.xml'].replace('<v>25569</v>', '<v>1</v>');
assert.equal(parseXlsx(zip(early))[0].rows[0].fields.Date, '1900-01-01T00:00:00.000Z');
