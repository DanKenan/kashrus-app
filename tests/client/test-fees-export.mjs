import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { csv, xlsx, crc32 } from '../../src/server/inspections/export.ts';
const table = { by: 'place', rows: [{ name: 'Test "quoted", cafe\nשם & <', visits: 2, perVisit: 4, paid: 8, companies: 12.34, left: 4.34 }], totals: { visits: 2, paid: 8, companies: 12.34, left: 4.34 } };
const c = csv(table); assert.equal(c.subarray(0, 3).toString('hex'), 'efbbbf'); assert.ok(c.toString().includes('"Test ""quoted"", cafe\nשם & <"')); assert.ok(c.toString().endsWith('Totals,2,,8,12.34,4.34\r\n'));
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
 const data = inflateRawSync(b.subarray(start, start + size)); assert.equal(crc32(data), crc); assert.equal(data.length, b.readUInt32LE(offset + 24)); files[name] = data.toString();
 offset += 46 + length + b.readUInt16LE(offset + 30) + b.readUInt16LE(offset + 32);
}
assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
assert.ok(files['xl/worksheets/sheet1.xml'].includes('Test &quot;quoted&quot;, cafe\nשם &amp; &lt;')); assert.ok(files['xl/worksheets/sheet1.xml'].includes('<v>12.34</v>')); assert.ok(files['xl/worksheets/sheet1.xml'].includes('Totals'));
console.log('fees export: RFC 4180 quoting, BOM, ZIP directory, inflation, CRC and worksheet rows passed');
