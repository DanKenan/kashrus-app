import { deflateRawSync } from 'node:zlib';
export function zip(files, inflatedSize) {
    const chunks = [], directory = [];
    let offset = 0;
    for (const [name, value] of Object.entries(files)) {
        const n = Buffer.from(name), b = Buffer.from(value), compressed = deflateRawSync(b), h = Buffer.alloc(30), c = Buffer.alloc(46);
        h.writeUInt32LE(0x04034b50);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(8, 8);
        h.writeUInt32LE(compressed.length, 18);
        h.writeUInt32LE(b.length, 22);
        h.writeUInt16LE(n.length, 26);
        c.writeUInt32LE(0x02014b50);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(8, 10);
        c.writeUInt32LE(compressed.length, 20);
        c.writeUInt32LE(inflatedSize || b.length, 24);
        c.writeUInt16LE(n.length, 28);
        c.writeUInt32LE(offset, 42);
        chunks.push(h, n, compressed);
        directory.push(c, n);
        offset += h.length + n.length + compressed.length;
    }
    const central = Buffer.concat(directory), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, central, end]);
}
export function workbookFixture() {
    return { 'xl/workbook.xml': '<workbook><sheets><sheet name="Companies" r:id="r1"/><sheet name="Ingredients" r:id="r2"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Golden Grain Bakery</t></si><si><r><t>Annual</t></r><r><t> Fee</t></r></si></sst>',
        'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
        'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="C1" t="inlineStr"><is><t>Date</t></is></c><c r="D1" t="inlineStr"><is><t>Formula</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1200.50</v></c><c r="C2" s="1"><v>25569</v></c><c r="D2" t="inlineStr"><is><t>=SUM(A1)</t></is></c></row></sheetData></worksheet>',
        'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Company</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>Demo Flour</t></is></c><c r="B2" t="inlineStr"><is><t>Golden Grain Bakery</t></is></c></row></sheetData></worksheet>' };
}
