// Small, stored ZIP workbook for Graph's upload API. No macros or formulas.
export function emptyWorkbook(tabs: Record<string, string[]>): Buffer {
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const names = Object.keys(tabs), files: Record<string, string> = {
        '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${escape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    };
    names.forEach((n, i) => files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${tabs[n].map((v, j) => `<c r="${String.fromCharCode(65 + j)}1" t="inlineStr"><is><t>${escape(v)}</t></is></c>`).join('')}</row></sheetData></worksheet>`);
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const v of b) {
        c ^= v;
        for (let j = 0; j < 8; j++)
            c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    } return (c ^ 0xffffffff) >>> 0; };
    const chunks: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    for (const [name, value] of Object.entries(files)) {
        const n = Buffer.from(name), b = Buffer.from(value), h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50);
        h.writeUInt16LE(20, 4);
        h.writeUInt32LE(crc(b), 14);
        h.writeUInt32LE(b.length, 18);
        h.writeUInt32LE(b.length, 22);
        h.writeUInt16LE(n.length, 26);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt32LE(crc(b), 16);
        c.writeUInt32LE(b.length, 20);
        c.writeUInt32LE(b.length, 24);
        c.writeUInt16LE(n.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, n);
        chunks.push(h, n, b);
        offset += h.length + n.length + b.length;
    }
    const c = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(names.length + 4, 8);
    end.writeUInt16LE(names.length + 4, 10);
    end.writeUInt32LE(c.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, c, end]);
}
