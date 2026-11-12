import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { csv, xlsx, crc32 } from '../../src/server/inspections/export.ts';
const independentCrc = bytes => { const table = Array.from({ length: 256 }, (_, i) => { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }); let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const table = { by: 'place', rows: [{ name: 'Test "quoted", cafe\nשם & <', visits: 2, perVisit: 4, paid: 8, companies: 12.34, left: 4.34 }], totals: { visits: 2, paid: 8, companies: 12.34, left: 4.34 } };
const c = csv(table); assert.equal(c.subarray(0, 3).toString('hex'), 'efbbbf'); assert.ok(c.toString().includes('"Test ""quoted"", cafe\nשם & <"')); assert.ok(c.toString().endsWith('Totals (2 visits),2,,8,12.34,4.34\r\n'));
assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
const b = xlsx(table), end = b.length - 22;
assert.equal(b.readUInt32LE(end), 0x06054b50);
let offset = b.readUInt32LE(end + 16); const files = {};
for (let i = 0; i < b.readUInt16LE(end + 10); i++) {
 assert.equal(b.readUInt32LE(offset), 0x02014b50);
 const length = b.readUInt16LE(offset + 28), size = b.readUInt32LE(offset + 20), local = b.readUInt32LE(offset + 42), crc = b.readUInt32LE(offset + 16);
 const name = b.subarray(offset + 46, offset + 46 + length).toString();
 assert.equal(b.readUInt32LE(local), 0x04034b50); assert.equal(b.readUInt16LE(local + 8), 8);
 const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
 const data = inflateRawSync(b.subarray(start, start + size)); assert.equal(independentCrc(data), crc); assert.equal(data.length, b.readUInt32LE(offset + 24)); files[name] = data.toString();
 offset += 46 + length + b.readUInt16LE(offset + 30) + b.readUInt16LE(offset + 32);
}
assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
assert.ok(files['xl/worksheets/sheet1.xml'].includes('Test &quot;quoted&quot;, cafe\nשם &amp; &lt;')); assert.ok(files['xl/worksheets/sheet1.xml'].includes('<v>12.34</v>')); assert.ok(files['xl/worksheets/sheet1.xml'].includes('Totals'));
console.log('fees export: RFC 4180 quoting, BOM, ZIP directory, inflation, CRC and worksheet rows passed');

for (const name of ['=SUM(1,2)', ' +1', '\t@SUM(A1)', '\r-1']) {
 const hostile = { ...table, rows: [{ ...table.rows[0], name, paid: -8 }], totals: { ...table.totals, paid: -8 } };
 const content = csv(hostile).toString(); assert.ok(content.includes("'" + name.replace(/"/g, '""'))); assert.ok(content.includes(',-8,'));
 const archive = xlsx(hostile), eocd = archive.length - 22; let cursor = archive.readUInt32LE(eocd + 16); const entries = {};
 for (let i = 0; i < archive.readUInt16LE(eocd + 10); i++) {
  assert.equal(archive.readUInt32LE(cursor), 0x02014b50); const local = archive.readUInt32LE(cursor + 42), length = archive.readUInt16LE(cursor + 28), size = archive.readUInt32LE(cursor + 20);
  const filename = archive.subarray(cursor + 46, cursor + 46 + length).toString(), start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const inflated = inflateRawSync(archive.subarray(start, start + size)); assert.equal(independentCrc(inflated), archive.readUInt32LE(cursor + 16)); entries[filename] = inflated.toString(); cursor += 46 + length + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
 }
 assert.match(entries['[Content_Types].xml'], /PartName="\/xl\/worksheets\/sheet1.xml"/);
 assert.match(entries['_rels/.rels'], /Target="xl\/workbook.xml"/); assert.match(entries['xl/_rels/workbook.xml.rels'], /Target="worksheets\/sheet1.xml"/); assert.match(entries['xl/workbook.xml'], /sheetId="1" r:id="rId1"/);
 const sheet = entries['xl/worksheets/sheet1.xml']; assert.match(sheet, /<c r="A2" t="inlineStr">/); assert.ok(sheet.includes('&apos;' + name.replace(/\r/g, '')) || sheet.includes('&apos;' + name));
 assert.match(sheet, /<c r="D2"><v>-8<\/v><\/c>/); assert.match(sheet, /<c r="D3"><v>-8<\/v><\/c>/); assert.match(sheet, /Totals \(2 visits\)/); assert.doesNotMatch(sheet, /<f[ >]/);
 for (const xml of Object.values(entries)) { const stack = []; for (const token of xml.match(/<[^>]+>/g)) { if (token.startsWith('<?') || token.endsWith('/>')) continue; if (token.startsWith('</')) assert.equal(stack.pop(), token.slice(2, -1)); else stack.push(token.slice(1).match(/^[^ >]+/)[0]); } assert.equal(stack.length, 0); }
}
